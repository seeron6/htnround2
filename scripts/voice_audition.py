#!/usr/bin/env python3
"""Audition voices for the face: have each one say the same taunt, save it, listen, choose.

    .venv/bin/python scripts/voice_audition.py                    # both engines
    .venv/bin/python scripts/voice_audition.py --engine omni      # which OMNI voices this key accepts
    .venv/bin/python scripts/voice_audition.py --engine elevenlabs
    .venv/bin/python scripts/voice_audition.py --voices Ethan,Ryan --line "Is that all?"

Writes `.local/voice-audition/<engine>-<voice>.wav`, a `results.json` and an `index.html` with a
player per voice. OMNI is the face's primary voice and ElevenLabs its backup (see
`elevenlabs_voice.py`), so this checks both against the keys saved on this computer:
environment first, then `.local/secrets/{omni,elevenlabs}.json`. A voice the gateway rejects costs
nothing; an accepted one costs one short sentence. Standard library only (Python 3.9).
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import elevenlabs_voice  # noqa: E402

SECRETS = ROOT / '.local/secrets'
OUT = ROOT / '.local/voice-audition'
RATE = 24000
LINE = elevenlabs_voice.SAMPLES['face']

# Same soft import as sponsor_server.py: every yibuapi call belongs in the challenge ledger.
LEDGER = ROOT / '.local/usage/yibu_api_calls.jsonl'
os.environ.setdefault('YIBU_AUDIT_LOG', str(LEDGER))
_YIBU_PKG = ROOT / '.local/third_party/yibuapi-examples/yibuapi_examples_20260918_v01'
if _YIBU_PKG.is_dir() and str(_YIBU_PKG) not in sys.path:
    sys.path.insert(0, str(_YIBU_PKG))
try:
    from yibu_audit import append_audit_record as _audit  # type: ignore
except Exception:
    _audit = None

# Qwen-Omni stock voices worth trying for an English-speaking heel. The gateway decides which
# exist: TRACKS/OMNI.md records Ethan, Serena and Dylan as accepted and Cherry/Chelsie as refused.
OMNI_CANDIDATES = (
    'Ethan',
    'Ryan',
    'Dylan',
    'Marcus',
    'Elias',
    'Roy',
    'Peter',
    'Rocky',
    'Eric',
    'Nofish',
    'Serena',
    'Jennifer',
    'Katerina',
    'Cherry',
    'Chelsie',
)


def saved(kind):
    try:
        return json.loads((SECRETS / (kind + '.json')).read_text())
    except (OSError, ValueError):
        return {}


def wav(pcm, rate=RATE):
    pcm = pcm[: len(pcm) // 2 * 2]
    return (
        b'RIFF'
        + struct.pack('<I', 36 + len(pcm))
        + b'WAVEfmt '
        + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16)
        + b'data'
        + struct.pack('<I', len(pcm))
        + pcm
    )


def loudness(pcm):
    count = len(pcm) // 2
    if not count:
        return 0
    samples = struct.unpack('<%dh' % count, pcm[: count * 2])
    return round((sum(s * s for s in samples) / count) ** 0.5)


def omni(voice, line, cfg):
    """One spoken sentence from the OMNI gateway in `voice`. Returns a result row."""
    base = (cfg.get('baseUrl') or 'https://yibuapi.com/v1').rstrip('/')
    model = cfg.get('model') or 'qwen3.5-omni-flash'
    body = {
        'model': model,
        'messages': [
            {
                'role': 'system',
                'content': 'You are a voice actor. Say the user\'s line exactly as written, once, '
                'smug and taunting. Add nothing.',
            },
            {'role': 'user', 'content': line},
        ],
        'stream': True,
        'stream_options': {'include_usage': True},
        'max_tokens': 80,
        'temperature': 0.2,
        'modalities': ['text', 'audio'],
        'audio': {'voice': voice, 'format': 'wav'},
    }
    request = urllib.request.Request(
        base + '/chat/completions',
        data=json.dumps(body).encode(),
        headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cfg['apiKey'],
            'Accept': 'text/event-stream',
        },
    )
    started = time.perf_counter()
    first, pcm, said, usage, status, error = None, b'', '', None, 200, None
    try:
        with urllib.request.urlopen(request, timeout=90) as upstream:
            for raw in upstream:
                text = raw.decode('utf-8', 'replace').strip()
                if not text.startswith('data:') or text[5:].strip() == '[DONE]':
                    continue
                try:
                    piece = json.loads(text[5:])
                except ValueError:
                    continue
                usage = piece.get('usage') or usage
                for choice in piece.get('choices') or []:
                    audio = (choice.get('delta') or {}).get('audio') or {}
                    said += audio.get('transcript') or ''
                    if audio.get('data'):
                        first = first or time.perf_counter()
                        chunk = base64.b64decode(audio['data'])
                        pcm += chunk[44:] if chunk[:4] == b'RIFF' else chunk
    except urllib.error.HTTPError as e:
        status, error = e.code, e.read(300).decode('utf-8', 'replace')
    except OSError as e:
        status, error = 0, type(e).__name__
    if _audit is not None:
        try:
            _audit(
                model=model,
                api_key=cfg['apiKey'],
                endpoint=base + '/chat/completions',
                purpose='punching-face.voice_audition',
                transport='http',
                ok=error is None,
                status_code=status,
                latency_s=time.perf_counter() - started,
                **(
                    {'response_json': {'usage': usage or {}}}
                    if error is None
                    else {'error': 'HTTP %s: %s' % (status, (error or '')[:200])}
                ),
            )
        except Exception:
            pass
    return {
        'engine': 'omni',
        'voice': voice,
        'label': voice,
        'ok': error is None and bool(pcm),
        'status': status,
        'error': (error or ('no audio came back' if not pcm else None)),
        'firstAudioMs': round((first - started) * 1000) if first else None,
        'seconds': round(len(pcm) / 2 / RATE, 2),
        'rms': loudness(pcm),
        'said': said.strip(),
        'pcm': pcm,
    }


def eleven(voice, line, cfg):
    started = time.perf_counter()
    first, pcm, error, status = None, b'', None, 200
    try:
        for chunk in elevenlabs_voice.stream_pcm(cfg, voice['id'], line, 'face'):
            first = first or time.perf_counter()
            pcm += chunk
    except elevenlabs_voice.VoiceError as e:
        error, status = e.code + ': ' + e.message, e.status or 0
    return {
        'engine': 'elevenlabs',
        'voice': voice['id'],
        'label': '%s (%s)' % (voice['name'], voice['actor']),
        'ok': error is None and bool(pcm),
        'status': status,
        'error': error,
        'firstAudioMs': round((first - started) * 1000) if first else None,
        'seconds': round(len(pcm) / 2 / RATE, 2),
        'rms': loudness(pcm),
        'said': line,
        'pcm': pcm,
    }


def page(rows, line):
    cards = ''.join(
        '<li><b>%s</b> <small>%s · first audio %s ms · %s s</small><br>'
        '<audio controls preload="none" src="%s"></audio></li>'
        % (
            html.escape(r['label']),
            r['engine'],
            r['firstAudioMs'],
            r['seconds'],
            html.escape(r['file']),
        )
        for r in rows
        if r['ok']
    )
    refused = ''.join(
        '<li>%s <small>%s — %s</small></li>'
        % (
            html.escape(r['label']),
            r['engine'],
            html.escape(str(r['error'])[:160]),
        )
        for r in rows
        if not r['ok']
    )
    return (
        '<!doctype html><meta charset="utf-8"><title>Voice audition</title>'
        '<style>body{font:15px/1.5 system-ui;margin:2rem auto;max-width:42rem;padding:0 1rem}'
        'li{margin:.8rem 0}small{color:#777}audio{width:100%%}</style>'
        '<h1>Voice audition</h1><p>Every voice says: <q>%s</q></p><ul>%s</ul>'
        '<h2>Not available</h2><ul>%s</ul>'
    ) % (html.escape(line), cards, refused or '<li>none</li>')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument(
        '--engine', choices=('omni', 'elevenlabs', 'both'), default='both'
    )
    parser.add_argument(
        '--voices', help='comma-separated OMNI voice names to try instead'
    )
    parser.add_argument('--line', default=LINE)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    if args.engine in ('omni', 'both'):
        stored = saved('omni')
        cfg = {
            'apiKey': os.environ.get('OMNI_API_KEY') or stored.get('apiKey'),
            'baseUrl': os.environ.get('OMNI_BASE_URL') or stored.get('baseUrl'),
            'model': os.environ.get('OMNI_MODEL') or stored.get('model'),
        }
        if not cfg['apiKey']:
            print('omni: no key saved, skipped', file=sys.stderr)
        else:
            names = [v.strip() for v in (args.voices or '').split(',') if v.strip()]
            for name in names or OMNI_CANDIDATES:
                rows.append(omni(name, args.line, cfg))
    if args.engine in ('elevenlabs', 'both') and not args.voices:
        stored = saved('elevenlabs')
        cfg = {
            'apiKey': os.environ.get('ELEVENLABS_API_KEY') or stored.get('apiKey'),
            'voiceId': os.environ.get('ELEVENLABS_VOICE_ID') or stored.get('voiceId'),
            'model': os.environ.get('ELEVENLABS_MODEL') or stored.get('model'),
        }
        if not cfg['apiKey']:
            print('elevenlabs: no key saved, skipped', file=sys.stderr)
        else:
            for voice in elevenlabs_voice.catalogue(cfg):
                rows.append(eleven(voice, args.line, cfg))
                if rows[-1]['status'] == 401:
                    break  # the key itself is the problem; every other voice would say the same
    for row in rows:
        pcm = row.pop('pcm')
        row['file'] = (
            '%s-%s.wav' % (row['engine'], row['label'].split(' (')[0].replace(' ', '-'))
            if row['ok']
            else None
        )
        if row['ok']:
            (OUT / row['file']).write_bytes(wav(pcm))
        print(
            '%-10s %-24s %s'
            % (
                row['engine'],
                row['label'],
                (
                    'ok   first audio %s ms, %s s, rms %s  "%s"'
                    % (
                        row['firstAudioMs'],
                        row['seconds'],
                        row['rms'],
                        row['said'][:60],
                    )
                    if row['ok']
                    else 'NO   %s %s' % (row['status'], str(row['error'])[:150])
                ),
            )
        )
    (OUT / 'results.json').write_text(json.dumps(rows, indent=1))
    (OUT / 'index.html').write_text(page(rows, args.line))
    print('\nListen: open %s' % (OUT / 'index.html'))
    return 0 if any(r['ok'] for r in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
