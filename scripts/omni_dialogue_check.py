#!/usr/bin/env python3
"""Live OMNI conversation regression with synthetic speech and pictures only.

Checks remembered speech, a previously shown object, a correction, and a question
in room audio on a punch-triggered turn. Writes evidence under .local/.
"""

import base64
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import omni_preflight as preflight


def mug(colour):
    from PIL import Image, ImageDraw

    image = Image.new('RGB', (320, 240), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 205, 320, 240), fill='burlywood')
    draw.ellipse((188, 85, 264, 175), outline=colour, width=18)
    draw.rounded_rectangle((80, 55, 218, 204), radius=18, fill=colour)
    draw.ellipse((80, 45, 218, 75), fill=colour, outline='black', width=3)
    buffer = io.BytesIO()
    image.save(buffer, 'JPEG')
    return [base64.b64encode(buffer.getvalue()).decode()] * 4


def main():
    if len(sys.argv) > 1:
        preflight.RELAY = sys.argv[1]
    out = preflight.ROOT / '.local/omni-dialogue-evidence'
    out.mkdir(parents=True, exist_ok=True)
    history, report = [], []
    cases = [
        (
            'introduce',
            'My name is Robin. I call this my victory cup.',
            mug('blue'),
            False,
            (),
        ),
        (
            'recall',
            'What name did I tell you, and what colour was the thing I showed you?',
            [],
            False,
            ('robin', 'blue'),
        ),
        (
            'correct',
            'Actually, call me Alex now. And look, I have switched cups.',
            mug('red'),
            False,
            (),
        ),
        (
            'room-followup',
            'What name should you call me now, and what colour is my cup now?',
            [],
            True,
            ('alex', 'red'),
        ),
    ]
    for index, (name, words, frames, room, expected) in enumerate(cases):
        wav = preflight.say_wav(words)
        if not wav:
            raise RuntimeError('Synthetic speech needs macOS say.')
        got = preflight.turn(
            {
                'remember': True,
                'history': history[-12:],
                'dialogueTurn': index,
                'frames': frames,
                'roomWav' if room else 'audioWav': wav,
                'telemetry': preflight.telemetry(1.9, 'combo') if room else {},
            }
        )
        notes = got.get('perception') or {}
        record = '\n'.join(
            filter(
                None,
                [
                    'OMNI heard: ' + notes['heard'] if notes.get('heard') else '',
                    'OMNI saw: ' + notes['seen'] if notes.get('seen') else '',
                ],
            )
        )
        history.extend(
            [
                {
                    'role': 'user',
                    'content': record or 'Speech supplied; words not recovered.',
                },
                {'role': 'assistant', 'content': got['text'].strip()[:599]},
            ]
        )
        passed = (
            bool(got['pcm'])
            and not got['error']
            and bool(notes.get('heard'))
            and all(word in got['text'].lower() for word in expected)
        )
        if frames:
            passed = (
                passed
                and ('blue' if name == 'introduce' else 'red')
                in notes.get('seen', '').lower()
            )
        row = {
            'check': name,
            'pass': passed,
            'said': got['text'].strip(),
            'notes': notes,
            'first_audio_ms': got['first_audio'],
            'error': got['error'],
        }
        report.append(row)
        if got['pcm']:
            (out / (name + '.wav')).write_bytes(preflight.wav(got['pcm']))
        print(json.dumps(row), flush=True)
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    return 0 if all(row['pass'] for row in report) else 1


if __name__ == '__main__':
    sys.exit(main())
