#!/usr/bin/env python3
"""Record the face's impact grunts in its own OMNI voice, once, so a landed punch is answered in
under 50 ms from a local cache while the model's spoken line is still ~1.3 s away.

    .venv/bin/python scripts/build_omni_reactions.py                 # the six cast voices
    .venv/bin/python scripts/build_omni_reactions.py --voices Ryan   # just one

Writes `public/omni-reactions/<Voice>/<level>.<n>.wav` (24 kHz mono, silence trimmed, levelled) and
`public/omni-reactions/index.json`, which `src/sponsors/grunts.js` reads. Levels follow the punch:
low (barely felt it), mid (felt it), high (that one landed). About 40 tiny calls for all six voices;
each is written to the yibuapi ledger when the sponsor's writer is installed. Standard library +
numpy (already in the capture venv).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public/omni-reactions'
SECRETS = ROOT / '.local/secrets'
RATE = 24000
CAST = ('Ryan', 'Ethan', 'Marcus', 'Dylan', 'Jennifer', 'Katerina')
# What the voice actor is asked to perform, and how loud the result is mastered (peak, 0..1).
SOUNDS = {
    'low': (('Tch.', 'Hm.', 'Pff.'), 0.45),
    'mid': (('Oof!', 'Ugh!', 'Unh!'), 0.7),
    'high': (('Aagh!', 'Gah!', 'Oww!'), 0.95),
}
KEEP_SECONDS = (0.12, 1.3)  # outside this a take is a miss: a click, or a sentence
DIRECTOR = (
    'You are a voice actor recording impact reactions for a boxing game. The user gives you one short '
    'vocal sound. Perform only that sound, as a real reaction to being hit: not a word read aloud, no '
    'extra words, no commentary.'
)

LEDGER = ROOT / '.local/usage/yibu_api_calls.jsonl'
os.environ.setdefault('YIBU_AUDIT_LOG', str(LEDGER))
_YIBU_PKG = ROOT / '.local/third_party/yibuapi-examples/yibuapi_examples_20260918_v01'
if _YIBU_PKG.is_dir() and str(_YIBU_PKG) not in sys.path:
    sys.path.insert(0, str(_YIBU_PKG))
try:
    from yibu_audit import append_audit_record as _audit  # type: ignore
except Exception:
    _audit = None


def record(cfg, voice, sound):
    base = (cfg.get('baseUrl') or 'https://yibuapi.com/v1').rstrip('/')
    model = cfg.get('model') or 'qwen3.5-omni-flash'
    body = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': DIRECTOR},
            {'role': 'user', 'content': sound},
        ],
        'stream': True,
        'stream_options': {'include_usage': True},
        'max_tokens': 30,
        'temperature': 0.6,
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
    started, pcm, usage, error, status = time.perf_counter(), b'', None, None, 200
    try:
        with urllib.request.urlopen(request, timeout=60) as upstream:
            for raw in upstream:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:') or line[5:].strip() == '[DONE]':
                    continue
                try:
                    piece = json.loads(line[5:])
                except ValueError:
                    continue
                if isinstance(piece.get('error'), dict):
                    error = str(piece['error'].get('message'))[:200]
                    continue
                usage = piece.get('usage') or usage
                for choice in piece.get('choices') or []:
                    data = ((choice.get('delta') or {}).get('audio') or {}).get('data')
                    if data:
                        chunk = base64.b64decode(data)
                        pcm += chunk[44:] if chunk[:4] == b'RIFF' else chunk
    except urllib.error.HTTPError as e:
        status, error = e.code, 'HTTP %d' % e.code
    except OSError as e:
        status, error = 0, type(e).__name__
    if _audit is not None:
        try:
            _audit(
                model=model,
                api_key=cfg['apiKey'],
                endpoint=base + '/chat/completions',
                purpose='punching-face.reaction_cache',
                transport='http',
                ok=error is None,
                status_code=status,
                latency_s=time.perf_counter() - started,
                **(
                    {'response_json': {'usage': usage or {}}}
                    if error is None
                    else {'error': error}
                ),
            )
        except Exception:
            pass
    return pcm, error


def master(pcm, peak):
    """Trim the silence, fade the edges so nothing clicks, and set the peak. None if it is a miss."""
    import numpy as np

    x = np.frombuffer(pcm[: len(pcm) // 2 * 2], dtype='<i2').astype(np.float64)
    if not len(x) or np.abs(x).max() < 200:
        return None
    loud = np.where(np.abs(x) > 0.04 * np.abs(x).max())[0]
    pad = int(0.015 * RATE)
    x = x[max(0, loud[0] - pad) : loud[-1] + pad]
    if not KEEP_SECONDS[0] <= len(x) / RATE <= KEEP_SECONDS[1]:
        return None
    fade = min(int(0.008 * RATE), len(x) // 4)
    ramp = np.linspace(0, 1, fade)
    x[:fade] *= ramp
    x[-fade:] *= ramp[::-1]
    x *= peak * 32767 / np.abs(x).max()
    return x.astype('<i2').tobytes()


def wav(pcm):
    return (
        b'RIFF'
        + struct.pack('<I', 36 + len(pcm))
        + b'WAVEfmt '
        + struct.pack('<IHHIIHH', 16, 1, 1, RATE, RATE * 2, 2, 16)
        + b'data'
        + struct.pack('<I', len(pcm))
        + pcm
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument(
        '--voices', help='comma-separated OMNI voices (default: the cast)'
    )
    args = parser.parse_args()
    try:
        saved = json.loads((SECRETS / 'omni.json').read_text())
    except (OSError, ValueError):
        saved = {}
    cfg = {
        'apiKey': os.environ.get('OMNI_API_KEY') or saved.get('apiKey'),
        'baseUrl': os.environ.get('OMNI_BASE_URL') or saved.get('baseUrl'),
        'model': os.environ.get('OMNI_MODEL') or saved.get('model'),
    }
    if not cfg['apiKey']:
        print('No OMNI key saved: nothing recorded.', file=sys.stderr)
        return 2
    voices = [v.strip() for v in (args.voices or '').split(',') if v.strip()] or CAST
    try:
        index = json.loads((OUT / 'index.json').read_text())
    except (OSError, ValueError):
        index = {}
    for voice in voices:
        folder = OUT / voice
        folder.mkdir(parents=True, exist_ok=True)
        for old in folder.glob('*.wav'):
            old.unlink()
        index[voice] = {}
        for level, (sounds, peak) in SOUNDS.items():
            kept = []
            for sound in sounds:
                pcm, error = record(cfg, voice, sound)
                clip = None if error else master(pcm, peak)
                if clip is None:
                    print(
                        '  %-9s %-5s %-6s miss %s' % (voice, level, sound, error or '')
                    )
                    continue
                name = '%s.%d.wav' % (level, len(kept) + 1)
                (folder / name).write_bytes(wav(clip))
                kept.append(name)
                print(
                    '  %-9s %-5s %-6s %.2f s -> %s'
                    % (voice, level, sound, len(clip) / 2 / RATE, name)
                )
            index[voice][level] = kept
    (OUT / 'index.json').write_text(json.dumps(index, indent=1, sort_keys=True) + '\n')
    total = sum(len(c) for v in index.values() for c in v.values())
    print('\n%d clips for %d voices in %s' % (total, len(index), OUT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
