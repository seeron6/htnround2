"""The face's real turn, with Sentry switched on. Two promises:

1. Observability can never cost the demo: every test in face_voice_test.py is inherited and run
   again here with tracing, logs, metrics and profiling live.
2. What reaches Sentry for one punch is one trace that reads as one agent run, and it carries
   numbers and names only: never the reply, the person's words, a frame, or a key.

Envelopes are captured in memory. No network, no real project, no real keys.
"""

import json, sys, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import sentry_sdk
from sentry_sdk.transport import Transport
import sponsor_obs
import face_voice_test as base

service = base.service
FRAME = 'RkFDRVBJWEVMUw' * 6  # stands in for a base64 webcam frame
SAID = 'my grandmother hits harder than that'


class Memory(Transport):
    items = []

    def capture_envelope(self, envelope):
        for item in envelope.items:
            payload = item.payload
            Memory.items.append(
                (
                    item.headers.get('type'),
                    payload.json if payload.json is not None else payload.bytes,
                )
            )

    def flush(self, timeout, callback=None):
        pass

    def kill(self):
        pass


def sent(kind):
    sentry_sdk.flush()
    found = []
    for item_kind, payload in list(Memory.items):
        if item_kind != kind:
            continue
        body = json.loads(payload) if isinstance(payload, (bytes, str)) else payload
        found += body['items'] if 'items' in body else [body]
    return found


def op(span):
    return span['attributes']['sentry.op']['value']


class SentryTurn(base.FaceVoice):
    @classmethod
    def setUpClass(cls):
        assert sponsor_obs.init('sponsor-server', transport=Memory)
        sponsor_obs.instrument_http(service.Handler)
        super().setUpClass()

    def setUp(self):
        super().setUp()
        Memory.items.clear()

    def punch(self, **extra):
        """One punch-triggered turn, as the panel sends it."""
        return self.turn(
            mode='face',
            frames=[FRAME],
            text=SAID,
            telemetry={'trigger': 'combo', 'last': {'speed': 1.4}},
            **extra,
        )

    def test_sentry_a_punch_is_one_trace_that_reads_as_one_agent_run(self):
        self.keys(eleven=False)
        names = [name for name, _ in self.punch()]
        self.assertIn('expression', names)
        self.assertEqual(names[-1], 'done')
        served = [
            t
            for t in sent('transaction')
            if t['transaction'] == 'POST /sponsors/coach/turn'
        ]
        self.assertEqual(len(served), 1)
        trace = served[0]['contexts']['trace']['trace_id']
        spans = [s for s in sent('span') if s['trace_id'] == trace]
        agent = next(s for s in spans if op(s) == 'gen_ai.invoke_agent')
        self.assertEqual(agent['attributes']['gen_ai.agent.name']['value'], 'The Face')
        self.assertEqual(agent['attributes']['agent.trigger']['value'], 'combo')
        self.assertEqual(agent['attributes']['agent.voice_engine']['value'], 'omni')
        self.assertGreater(agent['attributes']['agent.reply_chars']['value'], 0)
        inside = [s for s in spans if s.get('parent_span_id') == agent['span_id']]
        self.assertEqual(
            sorted(op(s) for s in inside),
            ['gen_ai.chat', 'gen_ai.chat', 'gen_ai.execute_tool'],
        )
        tool = next(s for s in inside if op(s) == 'gen_ai.execute_tool')
        self.assertEqual(tool['attributes']['tool.emotion']['value'], 'stunned')
        reasons = sorted(
            s['attributes']['gen_ai.response.finish_reasons']['value']
            for s in inside
            if op(s) == 'gen_ai.chat'
        )
        self.assertEqual(reasons, ['stop', 'tool_calls'])
        # Both gateway calls are there as outgoing requests too, one of them from the mood thread.
        outgoing = [
            s
            for s in served[0]['spans']
            if s['op'] == 'http.client' and '/chat/completions' in s['description']
        ]
        self.assertEqual(len(outgoing), 2)
        measured = {m['name'] for m in sent('trace_metric')}
        self.assertLessEqual(
            {'coach.first_token', 'coach.turn.duration', 'coach.expression.latency'},
            measured,
        )

    def test_sentry_the_backup_voice_joins_the_same_trace_from_its_own_thread(self):
        self.keys()
        self.punch(voiceEngine='elevenlabs')
        served = next(
            t
            for t in sent('transaction')
            if t['transaction'] == 'POST /sponsors/coach/turn'
        )
        speech = [
            s
            for s in served['spans']
            if s['op'] == 'http.client' and '/v1/text-to-speech/' in s['description']
        ]
        self.assertTrue(speech, 'ElevenLabs calls are missing from the trace')
        first_audio = next(
            m for m in sent('trace_metric') if m['name'] == 'coach.voice.first_audio'
        )
        self.assertEqual(first_audio['attributes']['engine']['value'], 'elevenlabs')
        self.assertEqual(first_audio['attributes']['outcome']['value'], 'ok')

    def test_sentry_a_refused_voice_is_a_warning_with_a_reason_not_a_silent_retry(self):
        self.keys()
        base.Upstream.script = {'omni': 'refuse-voice'}
        self.punch()
        warnings = [log for log in sent('log') if log['body'] == 'coach.voice_fallback']
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]['level'], 'warn')
        self.assertEqual(warnings[0]['attributes']['to']['value'], 'elevenlabs')
        self.assertIn('not supported', warnings[0]['attributes']['reason']['value'])

    def test_sentry_never_sees_the_reply_the_persons_words_a_frame_or_a_key(self):
        self.keys()
        self.punch(voiceEngine='elevenlabs')
        self.punch()
        sentry_sdk.flush()
        everything = json.dumps(
            [
                (
                    payload.decode('utf-8', 'replace')
                    if isinstance(payload, bytes)
                    else payload
                )
                for _, payload in Memory.items
            ]
        )
        self.assertIn('invoke_agent The Face', everything)  # it did record the turn
        for private in (base.REPLY[:24], SAID, FRAME, base.OMNI_KEY, base.ELEVEN_KEY):
            self.assertNotIn(private, everything)


if __name__ == '__main__':
    unittest.main()
