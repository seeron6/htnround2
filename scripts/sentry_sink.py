"""A stand-in for Sentry's ingest endpoint, on this computer. It accepts what the real SDKs send
(browser and Python), says what arrived in one line per item, and keeps a summary on disk.

Two uses. Checking the wiring with no account and no network: every product can be seen leaving
the app (transaction, span, log, trace_metric, replay_recording, profile_chunk, feedback, event).
And a fallback at a table with bad Wi-Fi: the app keeps its flight recorder, locally.

    .venv/bin/python scripts/sentry_sink.py                 # listens on 127.0.0.1:9471
    SENTRY_DSN=http://local@127.0.0.1:9471/1 npm run dev    # services report to it
    # or put that DSN in .local/secrets/sentry.json and the browser reports to it too

It stores item types, names, sizes and a few numbers. Replay and profile bodies are counted, not
kept. It is loopback only and is not Sentry: nothing here is searchable, grouped or alerted on.
"""

import gzip, json, os, re, sys, time, zlib
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.local/sentry-sink'
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9471
# SENTRY_SINK_KEEP=1 also keeps every payload as sent (.local/sentry-sink/raw/), replay recordings
# inflated, so a privacy claim ("the conversation is masked") can be checked with grep.
KEEP = os.environ.get('SENTRY_SINK_KEEP') == '1'


def keep(kind, payload):
    (OUT / 'raw').mkdir(parents=True, exist_ok=True)
    if kind == 'replay_recording':
        head, _, body = payload.partition(b'\n')
        try:
            payload = head + b'\n' + zlib.decompress(body)
        except zlib.error:
            pass
    name = '%d-%s.bin' % (time.time() * 1000, re.sub(r'\W', '_', kind))
    (OUT / 'raw' / name).write_bytes(payload)


def items_of(raw):
    """Envelope: a header line, then (item header line, payload) pairs. A payload is `length`
    bytes when its header says so, else it runs to the next newline."""
    head, _, rest = raw.partition(b'\n')
    while rest:
        line, _, rest = rest.partition(b'\n')
        if not line.strip():
            continue
        header = json.loads(line)
        if isinstance(header.get('length'), int):
            payload, rest = rest[: header['length']], rest[header['length'] :].lstrip(
                b'\n'
            )
        else:
            payload, _, rest = rest.partition(b'\n')
        yield header, payload


def seconds(value):
    """The browser SDK sends epoch floats, the Python SDK ISO strings."""
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0.0


def describe(header, payload):
    kind = header.get('type', '?')
    note = {'type': kind, 'bytes': len(payload)}
    try:
        body = json.loads(payload)
    except ValueError:
        return note  # replay recordings, profiles, attachments: counted, not kept
    if kind == 'transaction':
        trace = (body.get('contexts') or {}).get('trace') or {}
        note.update(
            name=body.get('transaction'),
            op=trace.get('op'),
            trace_id=trace.get('trace_id'),
            parent=trace.get('parent_span_id'),
            status=trace.get('status'),
            ms=round(
                (seconds(body.get('timestamp')) - seconds(body.get('start_timestamp')))
                * 1000
            ),
            spans=[
                {'op': s.get('op'), 'name': s.get('description'), 'data': s.get('data')}
                for s in body.get('spans', [])
            ],
            release=body.get('release'),
            tags=body.get('tags'),
        )
    elif kind in ('span', 'log', 'trace_metric'):
        note['items'] = [
            {
                'name': item.get('name') or item.get('body'),
                'level': item.get('level'),
                'value': item.get('value'),
                'unit': item.get('unit'),
                'trace_id': item.get('trace_id'),
                'parent': item.get('parent_span_id'),
                'attributes': {
                    k: (v.get('value') if isinstance(v, dict) else v)
                    for k, v in (item.get('attributes') or {}).items()
                    if not k.startswith(
                        ('sentry.sdk', 'process.', 'server.', 'browser.', 'user_agent')
                    )
                },
            }
            for item in body.get('items', [])
        ]
    elif kind in ('event', 'feedback'):
        first = ((body.get('exception') or {}).get('values') or [{}])[0]
        note.update(
            level=body.get('level'),
            message=body.get('message') or first.get('value'),
            error=first.get('type'),
            trace_id=((body.get('contexts') or {}).get('trace') or {}).get('trace_id'),
            feedback=(body.get('contexts') or {}).get('feedback'),
        )
    elif kind == 'replay_event':
        note.update(replay_id=body.get('replay_id'), segment=body.get('segment_id'))
    return note


class Sink(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, code, body=b'{}'):
        self.send_response(code)
        # The browser SDK posts cross-origin from the app's page.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.answer(204, b'')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        encoding = self.headers.get('Content-Encoding', '')
        try:
            if encoding == 'gzip' or raw[:2] == b'\x1f\x8b':
                raw = gzip.decompress(raw)
            elif encoding == 'deflate':
                raw = zlib.decompress(raw)
        except (OSError, zlib.error):
            pass
        if '/envelope' not in self.path:
            return self.answer(404)
        OUT.mkdir(parents=True, exist_ok=True)
        with (OUT / 'envelopes.jsonl').open('a') as out:
            for header, payload in items_of(raw):
                if KEEP:
                    keep(header.get('type', 'unknown'), payload)
                note = {'at': round(time.time(), 3), **describe(header, payload)}
                out.write(json.dumps(note) + '\n')
                label = note.get('name') or note.get('message') or ''
                if note.get('items'):
                    label = ', '.join(str(i.get('name')) for i in note['items'][:6])
                print(
                    '%-16s %7d B  %s' % (note['type'], note['bytes'], label), flush=True
                )
        self.answer(200, b'{"id":"00000000000000000000000000000000"}')


if __name__ == '__main__':
    print(
        'Sentry stand-in on http://127.0.0.1:%d  ->  DSN: http://local@127.0.0.1:%d/1\n'
        'Summaries: %s' % (PORT, PORT, OUT / 'envelopes.jsonl'),
        flush=True,
    )
    ThreadingHTTPServer(('127.0.0.1', PORT), Sink).serve_forever()
