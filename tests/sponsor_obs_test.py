"""Sentry wiring: one browser click reads as ONE trace across the HTTP service, the pipeline
subprocess and its PipelineTimer stages; nothing sensitive is attached; and everything is a no-op
without a DSN. Envelopes are captured in memory, so there is no network and no real project.
"""

import json, os, subprocess, sys, tempfile, threading, time, unittest, unittest.mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import sentry_sdk
from sentry_sdk.transport import Transport
import sponsor_obs


class Memory(Transport):
    items = []

    def capture_envelope(self, envelope):
        for item in envelope.items:
            Memory.items.append(
                (
                    item.headers.get('type'),
                    (
                        item.payload.json
                        if item.payload.json is not None
                        else item.payload.bytes
                    ),
                )
            )

    def flush(self, timeout, callback=None):
        pass

    def kill(self):
        pass


def transactions():
    return [payload for kind, payload in Memory.items if kind == 'transaction']


def served(name, timeout=5):
    """A service finishes its transaction after the answer is already on the wire, so a client
    that reads the answer and looks straight away can be early. Wait for it."""
    deadline = time.time() + timeout
    while True:
        found = [t for t in transactions() if t['transaction'] == name]
        if found or time.time() > deadline:
            return found
        time.sleep(0.02)


def streamed(kind):
    """AI spans and structured logs travel as their own batched envelope items (format v2), not inside the transaction."""
    sentry_sdk.flush()
    found = []
    for item_kind, payload in Memory.items:
        if item_kind == kind:
            found += (
                json.loads(payload) if isinstance(payload, (bytes, str)) else payload
            )['items']
    return found


TRACE, PARENT = '0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331'
# The physics interpreter (.local/newton-env) never runs the photo pipeline and lacks its dependencies.
try:
    import pipeline_timing

    PIPELINE = None
except ImportError as missing:
    PIPELINE = (
        'the photo pipeline is not importable here (%s); run this file with .venv/bin/python too'
        % missing
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Handler.child = sponsor_obs.child_env()
        body = b'{"ok":true}'
        if self.path == '/api/crash':
            # What the real services do: swallow the exception, answer with a sentence.
            body = b'{"error":"Conversion failed. Check the server log."}'
            self.send_response(500)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        self.send_response(202)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Observability(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.pop('SENTRY_DSN', None)
        assert sponsor_obs.init('test', transport=Memory)
        sponsor_obs.instrument_http(Handler)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_1_a_request_continues_the_browsers_trace_and_carries_no_body(self):
        secret = 'data:image/png;base64,FACEPIXELS'
        request = Request(
            'http://127.0.0.1:%d/api/face-train?id=abc' % self.server.server_address[1],
            data=json.dumps({'image': secret}).encode(),
            headers={
                'Content-Type': 'application/json',
                'sentry-trace': TRACE + '-' + PARENT + '-1',
            },
        )
        Memory.items.clear()
        self.assertEqual(urlopen(request, timeout=10).status, 202)
        sent = served('POST /api/face-train')
        self.assertEqual(len(sent), 1)
        event = sent[0]
        trace = event['contexts']['trace']
        self.assertEqual(
            (trace['trace_id'], trace['parent_span_id'], trace['op']),
            (TRACE, PARENT, 'http.server'),
        )
        self.assertEqual(
            event['transaction'],
            'POST /api/face-train',
            'the query string (capture ids) stays out of the name',
        )
        self.assertEqual(trace.get('status'), 'ok')
        self.assertEqual(
            event['tags']['service'],
            'test',
            'each process is tagged with the service name it passed to init()',
        )
        self.assertNotIn('FACEPIXELS', json.dumps(event))
        self.assertNotIn('request', event)
        # The subprocess environment carries the SAME trace, so the pipeline joins it instead of starting its own.
        self.assertTrue(Handler.child['SENTRY_TRACE'].startswith(TRACE + '-'))

    @unittest.skipIf(PIPELINE, PIPELINE)
    def test_2_the_pipeline_subprocess_joins_that_trace_and_each_stage_is_a_span(self):
        from pipeline_timing import PipelineTimer

        sponsor_obs.patch_pipeline_timer()
        Memory.items.clear()
        with (
            tempfile.TemporaryDirectory() as temp,
            unittest.mock.patch.dict(
                os.environ,
                {
                    'SENTRY_TRACE': Handler.child['SENTRY_TRACE'],
                    'SENTRY_BAGGAGE': Handler.child.get('SENTRY_BAGGAGE', ''),
                },
            ),
        ):
            folder = Path(temp) / '0123abcd'
            folder.mkdir()
            with sponsor_obs.continue_from_env('build_photo_face'):
                timer = PipelineTimer(folder)
                for stage in ('cameras', 'surface', 'texture'):
                    timer.mark(stage)
                timer.finish()
            saved = json.loads((folder / 'timing.json').read_text())
        event = transactions()[0]
        self.assertEqual(event['contexts']['trace']['trace_id'], TRACE)
        self.assertEqual(event['transaction'], 'build_photo_face')
        # Every stage also leaves a structured log that carries the trace id, so a log line opens its trace in Sentry.
        logs = [l for l in streamed('log') if l['body'].startswith('stage: ')]
        self.assertEqual(
            [l['body'] for l in logs],
            ['stage: cameras', 'stage: surface', 'stage: texture'],
        )
        self.assertTrue(all(l['trace_id'] == TRACE for l in logs))
        self.assertEqual(logs[0]['attributes']['capture']['value'], '0123abcd')
        spans = [(s['op'], s['description'], s.get('status')) for s in event['spans']]
        self.assertEqual(
            spans,
            [
                ('pipeline.stage', 'cameras', 'ok'),
                ('pipeline.stage', 'surface', 'ok'),
                ('pipeline.stage', 'texture', 'ok'),
            ],
        )
        # Wrapping must not change what the timer itself records.
        self.assertEqual(
            [s['stage'] for s in saved['stages']], ['cameras', 'surface', 'texture']
        )
        self.assertEqual(saved['status'], 'complete')

    @unittest.skipIf(PIPELINE, PIPELINE)
    def test_3_a_failed_stage_is_marked_failed(self):
        from pipeline_timing import PipelineTimer

        Memory.items.clear()
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / 'feedbeef'
            folder.mkdir()
            with (
                self.assertRaises(ValueError),
                sponsor_obs.continue_from_env('build_photo_face'),
            ):
                timer = PipelineTimer(folder)
                timer.mark('cameras')
                timer.finish('failed')
                raise ValueError('Camera recovery failed.')
        event = transactions()[0]
        self.assertEqual(event['contexts']['trace']['status'], 'internal_error')
        self.assertEqual(event['spans'][0]['status'], 'internal_error')

    def test_4_the_30hz_physics_loop_is_sampled_thinly_and_everything_else_is_kept(
        self,
    ):
        self.assertEqual(
            sponsor_obs._sampler(
                {'transaction_context': {'name': 'POST /physics/step'}}
            ),
            0.02,
        )
        for name in (
            'POST /physics/open',
            'POST /api/face-train',
            'POST /api/meshy-train',
            'meshy.build',
            'build_photo_face',
            'POST /sponsors/coach/turn',
        ):
            self.assertEqual(
                sponsor_obs._sampler({'transaction_context': {'name': name}}), 1.0
            )
        # Status polls run every few seconds for as long as a build does.
        for name in (
            'GET /api/meshy-job',
            'GET /api/face-status',
            'GET /api/arm-status',
        ):
            self.assertEqual(
                sponsor_obs._sampler({'transaction_context': {'name': name}}), 0.05
            )

    def test_5_coach_calls_are_shaped_for_ai_monitoring(self):
        Memory.items.clear()
        with sentry_sdk.start_transaction(
            op='http.server', name='POST /sponsors/coach/turn'
        ):
            with sponsor_obs.ai_span(
                'qwen3.5-omni-flash',
                'yibuapi',
                messages_count=4,
                system_prompt_len=487,
                frames_attached=4,
                has_voice=True,
                temperature=0.7,
                max_tokens=140,
                audio_ms=1500,
            ) as span:
                sponsor_obs.ai_usage(
                    span,
                    {
                        'prompt_tokens': 900,
                        'completion_tokens': 40,
                        'total_tokens': 940,
                    },
                    612,
                    4,
                    finish_reason='stop',
                    model='qwen3.5-omni-flash',
                )
        spans = [
            s
            for s in streamed('span')
            if s['attributes'].get('sentry.op', {}).get('value') == 'gen_ai.chat'
        ]
        self.assertEqual(len(spans), 1)
        span = spans[0]
        self.assertEqual(span['name'], 'chat qwen3.5-omni-flash')
        self.assertEqual(
            span['trace_id'], transactions()[0]['contexts']['trace']['trace_id']
        )
        for key, value in {
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': 'qwen3.5-omni-flash',
            'gen_ai.system': 'yibuapi',
            'gen_ai.usage.input_tokens': 900,
            'gen_ai.usage.output_tokens': 40,
            'gen_ai.usage.total_tokens': 940,
            'gen_ai.response.first_token_ms': 612,
            'gen_ai.response.finish_reason': 'stop',
            'gen_ai.request.frames_attached': 4,
            'gen_ai.request.messages_count': 4,
            'gen_ai.request.has_voice': True,
            'gen_ai.request.temperature': 0.7,
            'gen_ai.request.max_tokens': 140,
            'gen_ai.request.audio_ms': 1500,
            'gen_ai.request.system_prompt_len': 487,
        }.items():
            self.assertEqual(span['attributes'][key]['value'], value)
        # Cost computed from the table in sponsor_obs.AI_PRICES ($0.10/M input + $0.30/M output for omni-flash).
        self.assertAlmostEqual(
            span['attributes']['gen_ai.usage.cost_usd']['value'],
            round(900 * 0.10 / 1e6 + 40 * 0.30 / 1e6, 6),
            places=6,
        )

    def test_6_without_a_dsn_every_call_is_a_harmless_no_op(self):
        code = (
            'import sponsor_obs as o\n'
            "assert o.init('x') is False and o.ENABLED is False\n"
            "o.capture(ValueError('x'));o.instrument_http(object);o.patch_pipeline_timer()"
            '\n'
            "assert 'SENTRY_TRACE' not in o.child_env()\n"
            "with o.continue_from_env('x') as t:assert t is None\n"
            "with o.ai_span('m','s') as s:o.ai_usage(s,None,1,0)\n"
            "with o.agent_span('a','m') as a:\n"
            "  with o.tool_span('t',parent=a) as t:assert a is None and t is None\n"
            "o.metric('m',1.5,'millisecond',k='v');o.count('c',k='v');o.warn('w',k=1)\n"
            "f=lambda:7\n"
            "assert o.traced(f,'job') is f and o.job_state({'stage':'x'}) is None\n"
            "print('noop-ok')"
        )
        env = {k: v for k, v in os.environ.items() if not k.startswith('SENTRY')}
        env['HOME'] = tempfile.gettempdir()
        with tempfile.TemporaryDirectory() as empty:
            # Run from a copy of the module in an empty folder, so no .local/secrets/sentry.json can switch it on.
            (Path(empty) / 'sponsor_obs.py').write_text(
                (ROOT / 'sponsor_obs.py').read_text()
            )
            result = subprocess.run(
                [sys.executable, '-c', code],
                cwd=empty,
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(
            result.stdout.strip().splitlines()[-1], 'noop-ok', result.stderr
        )

    def test_7_a_punch_reads_as_one_agent_run_with_its_tool_call_beside_the_reply(self):
        """The Face's turn: the spoken reply and the expression call run in different threads,
        and must still sit side by side under one invoke_agent span."""
        Memory.items.clear()
        with sentry_sdk.start_transaction(
            op='http.server', name='POST /sponsors/coach/turn'
        ):
            with (
                sponsor_obs.agent_span(
                    'The Face', 'qwen3.5-omni-flash', mode='face', trigger='combo'
                ) as turn,
                sponsor_obs.ai_span(
                    'qwen3.5-omni-flash', 'yibuapi', agent='The Face'
                ) as chat,
            ):

                def express():
                    with sponsor_obs.ai_span(
                        'qwen3.5-omni-flash',
                        'yibuapi',
                        agent='The Face',
                        parent=turn,
                        purpose='expression',
                    ) as span:
                        sponsor_obs.ai_usage(
                            span,
                            {'prompt_tokens': 300, 'completion_tokens': 12},
                            410,
                            0,
                            finish_reason='tool_calls',
                            model='qwen3.5-omni-flash',
                        )
                    with sponsor_obs.tool_span(
                        'set_expression', agent='The Face', parent=turn, emotion='smug'
                    ):
                        pass

                mood = threading.Thread(target=express)
                mood.start()
                mood.join()
                sponsor_obs.ai_usage(
                    chat,
                    {'prompt_tokens': 900, 'completion_tokens': 40},
                    1312,
                    6,
                    finish_reason='stop',
                    model='qwen3.5-omni-flash',
                )
        spans = streamed('span')
        op = lambda s: s['attributes']['sentry.op']['value']
        agent = next(s for s in spans if op(s) == 'gen_ai.invoke_agent')
        self.assertEqual(agent['name'], 'invoke_agent The Face')
        self.assertEqual(agent['attributes']['gen_ai.agent.name']['value'], 'The Face')
        inside = [s for s in spans if s.get('parent_span_id') == agent['span_id']]
        self.assertEqual(
            sorted(op(s) for s in inside),
            ['gen_ai.chat', 'gen_ai.chat', 'gen_ai.execute_tool'],
            'the expression call and its tool must be siblings of the spoken reply',
        )
        tool = next(s for s in inside if op(s) == 'gen_ai.execute_tool')
        self.assertEqual(
            tool['attributes']['gen_ai.tool.name']['value'], 'set_expression'
        )
        self.assertEqual(tool['attributes']['tool.emotion']['value'], 'smug')
        spoken = next(
            s
            for s in inside
            if s['attributes'].get('gen_ai.response.finish_reasons', {}).get('value')
            == 'stop'
        )
        # The names Sentry's AI views read: seconds, not ms, and a cost the gateway's model needs from us.
        self.assertAlmostEqual(
            spoken['attributes']['gen_ai.response.time_to_first_token']['value'], 1.312
        )
        self.assertAlmostEqual(
            spoken['attributes']['gen_ai.cost.total_tokens']['value'],
            round(900 * 0.10 / 1e6 + 40 * 0.30 / 1e6, 6),
            places=6,
        )
        self.assertEqual({s['trace_id'] for s in spans}, {agent['trace_id']})

    def test_8_a_background_build_is_its_own_transaction_in_the_clicks_trace(self):
        """A Meshy build outlives its request by minutes. It must continue that request's trace,
        show a span per stage, and a failure must mark both the stage and the job."""
        Memory.items.clear()
        done = threading.Event()

        def build(fail):
            sponsor_obs.job_state({'status': 'running', 'stage': 'upload'})
            sponsor_obs.job_state(
                {'status': 'running', 'stage': 'generating', 'progress': 40}
            )
            sponsor_obs.job_state(
                {'status': 'running', 'stage': 'generating', 'progress': 90}
            )
            if fail:
                sponsor_obs.job_state({'status': 'failed', 'message': 'Meshy said no.'})
            else:
                sponsor_obs.job_state(
                    {'status': 'complete', 'stage': 'complete', 'consumedCredits': 30}
                )
            done.set()

        for fail in (False, True):
            done.clear()
            with sentry_sdk.start_transaction(
                op='http.server', name='POST /api/meshy-train'
            ) as request:
                worker = threading.Thread(
                    target=sponsor_obs.traced(build, 'meshy.build', op='job.meshy'),
                    args=(fail,),
                )
                worker.start()
            # The request is over and sent before the job is: exactly what happens for real.
            worker.join()
            self.assertTrue(done.is_set())
            job = next(t for t in transactions() if t['transaction'] == 'meshy.build')
            self.assertEqual(job['contexts']['trace']['trace_id'], request.trace_id)
            self.assertEqual(
                job['contexts']['trace']['parent_span_id'], request.span_id
            )
            stages = [s['description'] for s in job['spans'] if s['op'] == 'job.stage']
            self.assertEqual(stages, ['upload', 'generating'])
            self.assertEqual(
                job['contexts']['trace'].get('status'),
                'internal_error' if fail else 'ok',
            )
            if fail:
                self.assertEqual(job['spans'][-1]['status'], 'internal_error')
                self.assertTrue(
                    any(
                        log['body'] == 'job failed'
                        and log['attributes']['reason']['value'] == 'Meshy said no.'
                        for log in streamed('log')
                    )
                )
            Memory.items.clear()

    def test_9_every_answer_names_its_trace_and_numbers_travel_as_metrics(self):
        Memory.items.clear()
        request = Request(
            'http://127.0.0.1:%d/api/save' % self.server.server_address[1],
            data=b'{}',
            headers={'Content-Type': 'application/json'},
        )
        with urlopen(request, timeout=10) as response:
            named = response.headers.get('X-Sentry-Trace-Id')
        answered = served('POST /api/save')[0]
        self.assertEqual(named, answered['contexts']['trace']['trace_id'])
        sponsor_obs.metric(
            'coach.first_token', 1312, 'millisecond', voice_engine='omni', skipped=None
        )
        sponsor_obs.count('coach.turn', outcome='ok')
        metrics = {m['name']: m for m in streamed('trace_metric')}
        self.assertEqual(metrics['coach.first_token']['type'], 'distribution')
        self.assertEqual(metrics['coach.first_token']['value'], 1312.0)
        self.assertEqual(metrics['coach.first_token']['unit'], 'millisecond')
        self.assertEqual(
            metrics['coach.first_token']['attributes']['voice_engine']['value'], 'omni'
        )
        self.assertNotIn('skipped', metrics['coach.first_token']['attributes'])
        self.assertEqual(metrics['coach.turn']['type'], 'counter')
        self.assertTrue(str(sponsor_obs.release()).startswith('punching-face@'))

    def test_a_swallowed_crash_still_opens_an_issue_tied_to_its_trace(self):
        Memory.items.clear()
        request = Request(
            'http://127.0.0.1:%d/api/crash' % self.server.server_address[1],
            data=b'{}',
            headers={'Content-Type': 'application/json'},
        )
        with self.assertRaises(Exception):
            urlopen(request, timeout=10)
        crashed = served('POST /api/crash')[0]
        self.assertEqual(crashed['contexts']['trace']['status'], 'internal_error')
        issue = next(payload for kind, payload in Memory.items if kind == 'event')
        self.assertEqual(issue['message'], 'POST /api/crash answered 500')
        self.assertEqual(issue['level'], 'error')
        self.assertEqual(
            issue['contexts']['trace']['trace_id'],
            crashed['contexts']['trace']['trace_id'],
        )
        self.assertNotIn(
            'Conversion failed', json.dumps(issue)
        )  # no response body either


if __name__ == '__main__':
    unittest.main()
