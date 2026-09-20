"""What the face perceives and how it answers with more than words: the OMNI Live capabilities
that `sponsor_server.py` puts into every turn.

- SEE: the webcam keyframes go up as one *video* (a frame list), not loose images. yibuapi bills it
  as `video_tokens`, about half the tokens of the same frames as images, and the model reasons over
  motion ("the red glove is moving right and is about to touch ...", measured 2026-09-19).
- HEAR: a spoken turn carries the person's voice. A punch-triggered turn carries the last seconds
  of room sound instead (breathing, grunts, a crowd), so the face hears the exchange it comments on.
- SPEAK, in a tone that fits: `delivery()` turns the measured punch into a line of direction for
  the voice, so a weak shot is mocked slowly and a big one leaves it shaken.
- EXPRESS: `expression_request()` is a second, tiny call made in parallel with the spoken one. The
  model answers it with a `set_expression` tool call and the 3D head wears that expression before
  its voice arrives. Function calling and audio output do not share a response on this gateway
  (a tool call ends the turn), which is why it is its own call.

Standard library only (Python 3.9). No network code here: the relay owns the key and the calls.
"""

import json

MAX_FRAMES = 8
VIDEO_MIN_FRAMES = 4  # Qwen's frame-list video needs a handful; fewer go up as images
EXPRESSIONS = ('smug', 'amused', 'stunned', 'winded', 'defiant', 'concerned')

EXPRESSION_TOOL = {
    'type': 'function',
    'function': {
        'name': 'set_expression',
        'description': 'Set the expression the 3D face wears for the next few seconds.',
        'parameters': {
            'type': 'object',
            'properties': {
                'emotion': {'type': 'string', 'enum': list(EXPRESSIONS)},
                'intensity': {
                    'type': 'number',
                    'description': '0 to 1. How strongly it shows.',
                },
            },
            'required': ['emotion', 'intensity'],
        },
    },
}

EXPRESSION_DIRECTOR = """You control the facial expression of THE FACE: a 3D head on a laptop that people are
punching, and that trash-talks back. You get the punch telemetry measured on the device, maybe a webcam frame of
the person throwing, and maybe what they just said. Decide what its face shows for the next few seconds and call
set_expression exactly once. Say nothing.
- smug: weak or sloppy punches. It is unimpressed.
- amused: they missed, flailed, or said something funny.
- stunned: a genuinely hard punch just landed, at or near the hardest so far.
- winded: a fast combo or sustained pressure. It is gasping.
- defiant: it got hurt a moment ago and is coming back meaner.
- concerned: anyone says stop or hold, sounds or looks dizzy, hurt or out of breath, or anything turns toward
  hitting a real person. Safety beats the act, always."""


def clean_frames(data):
    return [
        f
        for f in ((data or {}).get('frames') or [])[:MAX_FRAMES]
        if isinstance(f, str) and len(f) < 400_000
    ]


def vision_parts(frames):
    """The keyframes as the model should receive them, plus the sentence that explains them."""
    urls = ['data:image/jpeg;base64,' + f for f in frames]
    if len(urls) >= VIDEO_MIN_FRAMES:
        return (
            [{'type': 'video', 'video': urls}],
            '\nThe video is the last few seconds from your point of view, in order.',
        )
    if urls:
        return (
            [{'type': 'image_url', 'image_url': {'url': u}} for u in urls],
            '\nThe frames are the last few seconds, oldest first.',
        )
    return [], '\nVision is switched off for this turn.'


def audio_message(wav_base64):
    return {
        'role': 'user',
        'content': [
            {
                'type': 'input_audio',
                'input_audio': {'data': 'data:;base64,' + wav_base64, 'format': 'wav'},
            }
        ],
    }


def usable_wav(value):
    return isinstance(value, str) and 0 < len(value) < 3_000_000


def _puncher(telemetry):
    """(speed, avg, max, count) for whoever threw the most recent punch, or None."""
    if not isinstance(telemetry, dict) or not isinstance(telemetry.get('last'), dict):
        return None
    last = telemetry['last']
    people = [p for p in telemetry.get('participants') or [] if isinstance(p, dict)]
    who = next((p for p in people if p.get('name') == last.get('name')), None)
    who = who or (people[0] if people else None)
    try:
        speed = float(last.get('speed', 0))
        return (
            speed,
            float((who or {}).get('avg', speed)),
            float((who or {}).get('max', speed)),
            int((who or {}).get('count', 1)),
        )
    except (TypeError, ValueError):
        return None


def intensity_of(telemetry):
    """'big', 'pressure', 'weak' or None: how the last exchange should land on the face. Relative to
    the person's own punches, because a webcam's metres per second are not comparable between people.
    """
    if not isinstance(telemetry, dict):
        return None
    trigger = str(telemetry.get('trigger') or '')
    measured = _puncher(telemetry)
    if 'personal-best' in trigger:
        return 'big'
    if measured:
        speed, avg, top, count = measured
        if count >= 3 and speed >= 0.97 * top and speed >= 1.25 * avg:
            return 'big'
    if 'combo' in trigger:
        return 'pressure'
    if measured:
        speed, avg, top, count = measured
        if count >= 3 and speed <= 0.8 * avg:
            return 'weak'
    return None


DELIVERY = {
    'big': 'Delivery for this line: that one genuinely rattled you. Sound shaken and a little out of '
    'breath, fewer words than usual, then the edge comes back.',
    'pressure': 'Delivery for this line: you are under pressure and short of breath, getting the '
    'words out fast between hits.',
    'weak': 'Delivery for this line: bored and slow, with a dry, unimpressed tone. '
    'This is a direction for delivery, not wording to say aloud.',
}


def delivery(data):
    """One line of direction for the voice, from what was measured. The coach keeps an even keel."""
    if (data or {}).get('mode') == 'coach':
        return ''
    kind = intensity_of((data or {}).get('telemetry'))
    return '\n' + DELIVERY[kind] if kind else ''


def expression_request(cfg, data, telemetry_text):
    """Body for the parallel call that picks the face's expression by function calling. Small on
    purpose: the newest frame only, no history, a short answer."""
    frames = clean_frames(data)
    parts = (
        [
            {
                'type': 'image_url',
                'image_url': {'url': 'data:image/jpeg;base64,' + frames[-1]},
            }
        ]
        if frames
        else []
    )
    parts.append({'type': 'text', 'text': telemetry_text})
    messages = [
        {'role': 'system', 'content': EXPRESSION_DIRECTOR},
        {'role': 'user', 'content': parts},
    ]
    text = str((data or {}).get('text') or '')[:400]
    if usable_wav((data or {}).get('audioWav')):
        messages.append(audio_message(data['audioWav']))
    elif text:
        messages.append({'role': 'user', 'content': 'They just said: ' + text})
    return {
        'model': cfg.get('model') or 'qwen3.5-omni-flash',
        'messages': messages,
        'stream': True,
        'stream_options': {'include_usage': True},
        'max_tokens': 48,
        'temperature': 0.3,
        'tools': [EXPRESSION_TOOL],
    }


def read_expression(arguments):
    """The tool call's arguments as something safe to hand the page, or None."""
    try:
        args = json.loads(arguments or '{}')
    except ValueError:
        return None
    emotion = args.get('emotion') if isinstance(args, dict) else None
    if emotion not in EXPRESSIONS:
        return None
    try:
        level = float(args.get('intensity', 0.6))
    except (TypeError, ValueError):
        level = 0.6
    return {'emotion': emotion, 'intensity': round(min(1.0, max(0.2, level)), 2)}
