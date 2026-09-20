"""Exercise the CLI boundary with the real SDK, an offline transport and fake HTTP."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PROBE = r'''
import io, json, os
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from urllib.error import HTTPError
from sentry_sdk.transport import Transport
import sentry_sdk
import sponsor_obs
import openai_capture
from scripts.pipeline_failure import handle_api_limits

class Offline(Transport):
    def capture_envelope(self, envelope):
        with open(os.environ['PROBE_EVENTS'], 'a') as output:
            for item in envelope.items:
                if item.headers.get('type') in ('event', 'transaction'):
                    output.write(json.dumps({'kind': item.headers['type'], 'data': item.payload.json}) + '\n')

sponsor_obs.init('pipeline', transport=Offline)
code = os.environ['PROBE_ERROR']
error = (
    RuntimeError('unexpected reconstruction bug') if code == 'bug' else
    HTTPError('https://api.openai.com/v1/responses', 429, 'private provider text',
              {'Retry-After': '60'}, io.BytesIO(json.dumps({'error': {'code': code}}).encode()))
)
with patch.object(openai_capture, 'config', return_value=('sk-test', 'gpt-6-astra')):
    with patch.object(openai_capture, 'urlopen', side_effect=error):
        with handle_api_limits():
            with sponsor_obs.continue_from_env('build_photo_face'):
                with ThreadPoolExecutor(1) as pool:
                    pool.submit(openai_capture.request, []).result()
'''


class PipelineFailureTests(unittest.TestCase):
    def test_long_provider_wait_is_shown_without_retrying(self):
        import io
        from unittest.mock import patch
        from urllib.error import HTTPError
        import openai_capture

        failure = HTTPError(
            'https://api.openai.com/v1/responses',
            429,
            'limit',
            {'Retry-After': '1728'},
            io.BytesIO(b'{"error":{"code":"rate_limit_exceeded","type":"requests"}}'),
        )
        with (
            patch.object(
                openai_capture, 'config', return_value=('sk-test', 'gpt-6-astra')
            ),
            patch.object(openai_capture, 'urlopen', side_effect=failure) as upstream,
            patch.object(openai_capture.time, 'sleep') as sleep,
        ):
            with self.assertRaisesRegex(
                openai_capture.OpenAIRateLimitError, '29 minutes'
            ):
                openai_capture.request([])
        self.assertEqual(upstream.call_count, 1)
        sleep.assert_not_called()

    def test_provider_limits_exit_failed_without_crash_events_but_bugs_still_alert(
        self,
    ):
        for code in ('rate_limit_exceeded', 'insufficient_quota', 'bug'):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temp:
                events = Path(temp) / 'events.jsonl'
                result = subprocess.run(
                    [sys.executable, '-c', PROBE],
                    cwd=ROOT,
                    env={
                        **os.environ,
                        'SENTRY_DISABLED': '0',
                        'PROBE_ERROR': code,
                        'PROBE_EVENTS': str(events),
                    },
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                captured = [
                    json.loads(line) for line in events.read_text().splitlines()
                ]
                crashes = [item for item in captured if item['kind'] == 'event']
                traces = [
                    item['data'] for item in captured if item['kind'] == 'transaction'
                ]
                self.assertEqual(len(traces), 1)
                self.assertEqual(
                    traces[0]['contexts']['trace']['status'], 'internal_error'
                )
                self.assertNotIn('private provider text', result.stdout + result.stderr)
                if code == 'bug':
                    self.assertEqual(len(crashes), 1)
                    self.assertIn('unexpected reconstruction bug', result.stderr)
                else:
                    self.assertEqual(crashes, [])
                    self.assertNotIn('Traceback', result.stderr)
                    self.assertIn('OpenAI', result.stdout)

    def test_explicit_disable_overrides_a_saved_dsn_without_initializing_sdk(self):
        code = '''
import os, tempfile
from pathlib import Path
from unittest.mock import patch
import sponsor_obs as obs
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    secrets = root / '.local/secrets'
    secrets.mkdir(parents=True)
    (secrets / 'sentry.json').write_text('{"pythonDsn":"https://public@o0.ingest.sentry.io/1"}')
    with patch.object(obs, 'ROOT', root), patch.object(obs.sentry_sdk, 'init') as init:
        assert obs.init('pipeline') is False
        assert not obs.ENABLED
        init.assert_not_called()
'''
        result = subprocess.run(
            [sys.executable, '-c', code],
            cwd=ROOT,
            env={**os.environ, 'SENTRY_DISABLED': '1'},
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
