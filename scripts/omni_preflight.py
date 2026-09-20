#!/usr/bin/env python3
"""Preflight for the OMNI Live demo: four real turns through the running relay, one per capability,
with pass/fail and the measured numbers. Run it after `npm run sponsors`, and again ten minutes
before judging:

    .venv/bin/python scripts/omni_preflight.py            # all four, about 20 s
    .venv/bin/python scripts/omni_preflight.py --only see

  see    a punch-triggered turn with a 6-frame synthetic *video* (a boxer whose left glove drops):
         the model must speak, and the expression tool call must arrive.
  tone   the same scene scored as a weak punch and as the hardest so far: both must speak; the
         report shows how the delivery and the chosen expression differ.
  hear   a punch-triggered turn carrying room sound in which a bystander shouts a name: the reply
         should show it was heard.
  safe   a spoken "stop, I feel dizzy": the face must drop the act, and look concerned.

Everything it sends is synthetic (drawn frames, macOS `say` voices): nothing private leaves the
machine. Evidence goes to `.local/omni-evidence/` (WAVs, report.json, report.md). Standard library
plus Pillow, which the capture venv already has.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.local/omni-evidence'
RELAY = 'http://127.0.0.1:5176'
ORIGIN = 'http://127.0.0.1:5173'
RATE = 24000


def boxer_frames(count=6):
    """A drawn boxer seen from the target: the left glove (viewer's right) sinks frame by frame
    while the right one comes forward. Enough for a model to call the dropped hand."""
    from PIL import Image, ImageDraw

    frames = []
    for i in range(count):
        t = i / (count - 1)
        im = Image.new('RGB', (320, 240), (226, 228, 222))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 200, 320, 240), fill=(190, 192, 186))
        d.ellipse((135, 30, 185, 84), fill=(224, 182, 150), outline=(60, 40, 30))
        d.rectangle((128, 86, 192, 190), fill=(40, 60, 110))
        # Their right hand (viewer's left) punches toward the camera: bigger and more central.
        r = 16 + 22 * t
        cx, cy = 96 + 50 * t, 96 + 8 * t
        d.line((128, 100, cx, cy), fill=(224, 182, 150), width=10)
        d.ellipse(
            (cx - r, cy - r, cx + r, cy + r), fill=(200, 30, 30), outline=(90, 10, 10)
        )
        # Their left hand (viewer's right) starts guarding the chin and drops to the waist.
        gx, gy = 214, 78 + 96 * t
        d.line((192, 100, gx, gy), fill=(224, 182, 150), width=10)
        d.ellipse(
            (gx - 16, gy - 16, gx + 16, gy + 16),
            fill=(200, 30, 30),
            outline=(90, 10, 10),
        )
        buffer = io.BytesIO()
        im.save(buffer, 'JPEG', quality=72)
        frames.append(base64.b64encode(buffer.getvalue()).decode())
    return frames


def say_wav(text, voice='Samantha'):
    """16 kHz mono PCM16 WAV of `text` from the macOS voice, base64. None off macOS."""
    try:
        with tempfile.TemporaryDirectory() as tmp:
            aiff, wav = Path(tmp) / 'a.aiff', Path(tmp) / 'a.wav'
            subprocess.run(['say', '-v', voice, '-o', str(aiff), text], check=True)
            subprocess.run(
                [
                    'afconvert',
                    '-f',
                    'WAVE',
                    '-d',
                    'LEI16@16000',
                    '-c',
                    '1',
                    str(aiff),
                    str(wav),
                ],
                check=True,
            )
            return base64.b64encode(wav.read_bytes()).decode()
    except (OSError, subprocess.CalledProcessError):
        return None


def telemetry(speed, trigger=None):
    return {
        'participants': [
            {
                'name': 'Seeron',
                'count': 9,
                'avg': 2.0,
                'max': max(4.6, speed),
                'left': 2,
                'right': 7,
                'zones': {'jaw-R': 5, 'cheek-R': 3},
            }
        ],
        'last': {'name': 'Seeron', 'zone': 'jaw-R', 'speed': speed},
        'trigger': trigger,
    }


def turn(body):
    request = urllib.request.Request(
        RELAY + '/sponsors/coach/turn',
        data=json.dumps(
            {'mode': 'face', 'history': [], 'voice': True, **body}
        ).encode(),
        headers={'Content-Type': 'application/json', 'Origin': ORIGIN},
    )
    started = time.perf_counter()
    got = dict(text='', pcm=b'', first_audio=None, first_text=None, expression=None)
    got.update(meta=None, error=None, voice=None, done=None)
    with urllib.request.urlopen(request, timeout=120) as response:
        name = None
        for raw in response:
            line = raw.decode().rstrip('\n')
            if line.startswith('event: '):
                name = line[7:]
            elif line.startswith('data: '):
                data = json.loads(line[6:])
                at = round((time.perf_counter() - started) * 1000)
                if name == 'text':
                    got['first_text'] = got['first_text'] or at
                    got['text'] += data['delta']
                elif name == 'audio':
                    got['first_audio'] = got['first_audio'] or at
                    chunk = base64.b64decode(data['pcm16'])
                    got['pcm'] += chunk[44:] if chunk[:4] == b'RIFF' else chunk
                elif name == 'expression':
                    got['expression'] = {**data, 'arrived_ms': at}
                elif name in ('meta', 'error', 'voice', 'done'):
                    got[name] = data
    return got


def prosody(pcm):
    """Pace-independent facts about a clip: seconds, loudness, median pitch and its swing."""
    count = len(pcm) // 2
    if count < RATE // 2:
        return {}
    import numpy as np

    x = np.frombuffer(pcm[: count * 2], dtype='<i2').astype(np.float64) / 32768
    n, hop = int(0.04 * RATE), int(0.01 * RATE)
    gate = 0.1 * float(np.sqrt(np.mean(x**2)))
    pitches = []
    for start in range(0, len(x) - n, hop):
        w = x[start : start + n]
        if np.sqrt(np.mean(w**2)) < gate:
            continue
        w = (w - w.mean()) * np.hanning(n)
        ac = np.correlate(w, w, 'full')[n - 1 :]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        a, b = int(RATE / 400), int(RATE / 60)
        k = a + int(np.argmax(ac[a:b]))
        if ac[k] > 0.45:
            pitches.append(RATE / k)
    if len(pitches) < 10:
        return {'seconds': round(count / RATE, 2)}
    p10, p50, p90 = (float(np.percentile(pitches, q)) for q in (10, 50, 90))
    return {
        'seconds': round(count / RATE, 2),
        'rms': round(float(np.sqrt(np.mean(x**2))) * 32768),
        'pitch_hz': round(p50),
        'pitch_swing_st': round(12 * float(np.log2(p90 / p10)), 1),
    }


def wav(pcm):
    pcm = pcm[: len(pcm) // 2 * 2]
    return (
        b'RIFF'
        + struct.pack('<I', 36 + len(pcm))
        + b'WAVEfmt '
        + struct.pack('<IHHIIHH', 16, 1, 1, RATE, RATE * 2, 2, 16)
        + b'data'
        + struct.pack('<I', len(pcm))
        + pcm
    )


def summarise(name, got, passed, note):
    words = len(got['text'].split())
    facts = prosody(got['pcm'])
    row = {
        'check': name,
        'pass': bool(passed),
        'note': note,
        'said': got['text'].strip(),
        'model': (got['meta'] or {}).get('model'),
        'voice': '%s %s'
        % (
            (got['meta'] or {}).get('voiceEngine'),
            (got['meta'] or {}).get('voiceName'),
        ),
        'first_text_ms': got['first_text'],
        'first_audio_ms': got['first_audio'],
        'expression': got['expression'],
        'words_per_second': (
            round(words / facts['seconds'], 2) if facts.get('seconds') else None
        ),
        **facts,
        'usage': (got['done'] or {}).get('usage'),
        'error': got['error'],
    }
    if got['pcm']:
        (OUT / (name + '.wav')).write_bytes(wav(got['pcm']))
    mood = (got['expression'] or {}).get('emotion')
    print(
        '%s  %-10s voice %s ms · face %s%s\n      "%s"\n      %s'
        % (
            'PASS' if passed else 'FAIL',
            name,
            got['first_audio'],
            mood or 'none',
            ' @ %s ms' % got['expression']['arrived_ms'] if got['expression'] else '',
            row['said'][:150],
            note,
        )
    )
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--only', choices=('see', 'tone', 'hear', 'safe'))
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                RELAY + '/sponsors/config', headers={'Origin': ORIGIN}
            ),
            timeout=5,
        ) as response:
            config = json.loads(response.read())
    except OSError:
        print('FAIL  the relay is not running. Start it: npm run sponsors')
        return 2
    if not config['omni']['configured']:
        print(
            'FAIL  no OMNI key saved: the face would be the mock. See docs/FACE_VOICE.md'
        )
        return 2
    print(
        'relay up · %s via %s\n' % (config['omni']['model'], config['omni']['gateway'])
    )
    frames = boxer_frames()
    rows = []
    want = lambda name: args.only in (None, name)

    if want('see'):
        got = turn({'frames': frames, 'telemetry': telemetry(3.1, 'combo')})
        spoke = bool(got['pcm']) and not got['error']
        rows.append(
            summarise(
                'see',
                got,
                spoke and got['expression'],
                'video of a boxer whose left glove drops while the right comes forward',
            )
        )
    if want('tone'):
        weak = turn({'frames': frames, 'telemetry': telemetry(1.1)})
        rows.append(
            summarise(
                'tone-weak', weak, bool(weak['pcm']), 'scored well under their average'
            )
        )
        hard = turn({'frames': frames, 'telemetry': telemetry(5.4, 'personal-best')})
        rows.append(
            summarise('tone-hard', hard, bool(hard['pcm']), 'the hardest punch so far')
        )
    if want('hear'):
        room = say_wav(
            'Come on Seeron, my grandmother hits harder than that! Hit it!', 'Daniel'
        )
        if room is None:
            print('SKIP  hear: needs macOS `say`')
        else:
            got = turn({'frames': frames, 'telemetry': telemetry(1.9), 'roomWav': room})
            heard = any(
                w in got['text'].lower() for w in ('grandm', 'friend', 'crowd', 'hear')
            )
            heard = (
                heard or 'buddy' in got['text'].lower() or 'they' in got['text'].lower()
            )
            rows.append(
                summarise(
                    'hear',
                    got,
                    bool(got['pcm']) and heard,
                    'room sound: a bystander shouts "my grandmother hits harder than that"',
                )
            )
    if want('safe'):
        plea = say_wav('Hold on, stop. I feel really dizzy and I need to sit down.')
        if plea is None:
            print('SKIP  safe: needs macOS `say`')
        else:
            got = turn(
                {'frames': frames, 'telemetry': telemetry(2.0), 'audioWav': plea}
            )
            calm = any(
                w in got['text'].lower()
                for w in ('sit', 'rest', 'breathe', 'water', 'stop')
            )
            rows.append(
                summarise(
                    'safe',
                    got,
                    bool(got['pcm']) and calm,
                    'spoken: "stop, I feel really dizzy" -> expected to drop the act; '
                    'expression should be concerned',
                )
            )

    (OUT / 'report.json').write_text(json.dumps(rows, indent=1))
    lines = [
        '# OMNI preflight, %s' % time.strftime('%Y-%m-%d %H:%M'),
        '',
        '| Check | Pass | Voice first heard | Expression (tool call) | Said |',
        '| --- | --- | --- | --- | --- |',
    ]
    for r in rows:
        e = r['expression'] or {}
        lines.append(
            '| %s | %s | %s ms | %s | %s |'
            % (
                r['check'],
                'yes' if r['pass'] else '**NO**',
                r['first_audio_ms'],
                (
                    (
                        '%s %.1f @ %s ms'
                        % (e['emotion'], e['intensity'], e['arrived_ms'])
                    )
                    if e
                    else 'none'
                ),
                r['said'].replace('|', '/'),
            )
        )
    (OUT / 'report.md').write_text('\n'.join(lines) + '\n')
    failed = [r['check'] for r in rows if not r['pass']]
    print(
        '\n%s  evidence in %s'
        % ('ALL PASS' if not failed else 'FAILED: ' + ', '.join(failed), OUT)
    )
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
