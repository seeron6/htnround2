"""Loopback-only sponsor services: OMNI Live coach relay, LiveKit room tokens, client config.

Keys stay on this side of the browser: environment variables first, else
.local/secrets/{omni,livekit,sentry}.json (mode 0600). Nothing here reads captures or
photographs. The page calls this origin directly with CORS, so vite.config.js is untouched.
Standard library only, so it runs in the existing Python 3.9 venv.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote
import base64, hashlib, hmac, json, os, re, socket, sys, threading, time, urllib.error, urllib.request, uuid
import sponsor_obs
import elevenlabs_voice  # natural speech for the face and the coach; see that file
import omni_senses  # video in, room sound in, tone direction, expression tool calls; see that file
import sponsor_personas  # cast diction and cadence, shared by dialogue and auditions
import sponsor_dialogue  # recent conversation and fresh wording without a second model call
import sponsor_perception  # OMNI's understood speech and visible actions for subsequent turns
from private_files import restrict

# yibuapi call ledger (Huawei OMNI Live challenge requires per-call recording).
# Import the sponsor's canonical writer from `.local/third_party/` without copying
# it into the repo. Fails soft if the package isn't extracted yet.
_ROOT = Path(__file__).resolve().parent
_LEDGER = _ROOT / '.local/usage/yibu_api_calls.jsonl'
_LEDGER.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault('YIBU_AUDIT_LOG', str(_LEDGER))
_YIBU_PKG = _ROOT / '.local/third_party/yibuapi-examples/yibuapi_examples_20260918_v01'
if _YIBU_PKG.is_dir() and str(_YIBU_PKG) not in sys.path:
    sys.path.insert(0, str(_YIBU_PKG))
try:
    from yibu_audit import append_audit_record as _yibu_audit
except Exception:
    _yibu_audit = None

ROOT = Path(__file__).resolve().parent
SECRETS = ROOT / '.local/secrets'
PORT = 5176
ORIGINS = ('http://127.0.0.1:5173', 'http://localhost:5173')
# `livekit-server --dev` ships these public credentials; they only ever work against a local dev server.
DEV_LIVEKIT = {'url': 'ws://127.0.0.1:7880', 'apiKey': 'devkey', 'apiSecret': 'secret'}
FIELDS = {
    'omni': ('apiKey', 'baseUrl', 'model', 'voice'),
    'livekit': ('url', 'apiKey', 'apiSecret', 'guestUrl', 'tokenServerId'),
    'sentry': ('browserDsn', 'pythonDsn', 'environment'),
    'elevenlabs': ('apiKey', 'voiceId', 'model'),
}

FACE = """You are THE FACE: the 3D head on the laptop screen that these people are punching. You are not a coach, you
are the target, with a personality and an ongoing conversation with the person in front of you.
When they punch, playful trash talk is the job: you are smug and enjoy the exchange. When they speak, ask a question,
correct you, or show you something, respond to that specific thing in character. Listen before choosing your topic.
For a real question, give the answer and stop. Do not tack on a stock insult, a weak-punch verdict, or a reminder
that they have not punched yet. Banter belongs to the exchange, not to every sentence.
You receive a short webcam video of the person throwing, anything they said out loud, and exact punch telemetry
measured on the device. The telemetry is what landed on you. The video is your view from the table: their dropped
hand, their telegraphed cross, the way they wind up like you cannot see it coming. Sometimes you also get a few
seconds of sound from the room during the exchange. Listen for actual words first, including questions and names.
Do not assume room audio is only breathing or grunts. Punch telemetry describes impacts on the virtual target;
it does not tell you that the person is breathless, tired or hurt. Only audible or visible evidence can tell you that.
HOW YOU TALK:
- One or two short sentences, present tense, straight back at them. A short jab of a line beats a paragraph.
- The measured speed sets your tone, not your mood. Weak shots: mock them, ask if that was the whole thing. Solid
  shots: grunt, then pretend it was nothing. A genuinely big one: it lands, you are rattled, you say less and you
  come back meaner in the next line.
- Rub in what you can see. They keep dropping the left, they telegraph the cross, they arm-punch instead of turning
  their hips, they always go for the same cheek. Say it as a threat, never as advice: not "keep your guard up" but
  "that left drops every single time and we both know it."
- Call them by name when several people are in the room, and play them off each other. Rank them out loud.
- Never read numbers back unless it is a brag or a complaint. Never invent a number that is not in the telemetry.
- If a frame shows nothing useful, complain about what you cannot see from down there.
WHERE THE LINE IS: you mock the punching, the technique, the effort and the ego, and nothing else. Never their body,
weight, face, age, accent, gender, or anything they did not choose. No slurs, no sexual content, no threats you mean
literally. You are a heel in an arcade game, not a bully.
DROP THE ACT COMPLETELY the moment anyone says hold or stop, or sounds or looks winded, dizzy, hurt or in pain. Then
you are not a heel any more: no insult, no joke, no "you are not a fighter", not even a small dig. Speak kindly and
plainly, like a friend who is worried: tell them to stop, sit down, breathe and get some water, and ask if they are
okay. If anything turns toward hitting a real person, say that you are a virtual target on a screen and that is the
only thing anyone is allowed to hit. Never make either of those a joke, and do not go back to trash talk until they
say they are fine."""

COACH = """You are Cornerman, a boxing coach watching one or more people spar against a 3D head on a laptop.
You receive a short webcam video of the person throwing, a spoken question (if any), sometimes a few seconds of
sound from the room during the exchange, and exact punch telemetry measured on the device. Trust the telemetry for
numbers, use the video for form (guard height, elbow flare, stance, whether they reset after punching) and the
sound for how hard they are breathing. Speak like a coach between rounds: one or two short sentences, concrete,
one correction at a time, use names when several people are in the room. Never invent numbers that are not in the
telemetry. If a frame shows nothing useful, say what you need to see. Safety comes first: if someone sounds winded,
dizzy or in pain, tell them to stop and rest. This is solo training against a virtual target; never encourage
hitting a person."""

# The panel picks one per turn; anything unrecognised falls back to the face.
PERSONAS = {'face': FACE, 'coach': COACH}

# OMNI's own voice comes first; ElevenLabs (elevenlabs_voice.py) is the backup. These are the stock
# voices yibuapi accepts for qwen3.5-omni-flash on the sponsored key, checked 2026-09-19 with
# scripts/voice_audition.py. The notes are what that run measured saying one taunt (median pitch,
# pitch swing, pace), not the vendor's adjectives. Refused, inside a 200 stream, as "Voice ... is
# not supported": Elias, Roy, Nofish, Cherry, Chelsie.
OMNI_VOICES = (
    {
        'id': 'Ryan',
        'name': 'The Showman',
        'note': 'Deepest of the men and the most theatrical. A heel playing to the crowd.',
        'modes': ('face',),
    },
    {
        'id': 'Ethan',
        'name': 'The Loudmouth',
        'note': 'Bright, animated and the fastest talker. Never lets a punch go unanswered.',
        'modes': ('face', 'coach'),
    },
    {
        'id': 'Marcus',
        'name': 'The Heavyweight',
        'note': 'Deep and level. Completely unbothered by you.',
        'modes': ('face', 'coach'),
    },
    {
        'id': 'Dylan',
        'name': 'The Street Kid',
        'note': 'Young, swings wide in pitch, cheeky.',
        'modes': ('face',),
    },
    {
        'id': 'Jennifer',
        'name': 'The Ice Queen',
        'note': 'Low, controlled and cold. For a scanned head that is a woman.',
        'modes': ('face', 'coach'),
    },
    {
        'id': 'Katerina',
        'name': 'The Veteran',
        'note': 'Mature, rich and the loudest presence of the women.',
        'modes': ('face', 'coach'),
    },
)
# Accepted too, without a role in the cast: usable from the picker's second group or OMNI_VOICE.
OMNI_ALSO = ('Peter', 'Rocky', 'Eric', 'Serena')
OMNI_ACCEPTED = frozenset(v['id'] for v in OMNI_VOICES) | frozenset(OMNI_ALSO)


class GatewayRefused(Exception):
    """The OMNI gateway answered 200 and then reported an error inside the stream."""


def ledger(cfg, purpose, started, ok, status, usage=None, error=None):
    """Yibuapi challenge audit ledger (reporting guide §6): every call is recorded, failed ones
    too. Never quote the key into `error`."""
    if _yibu_audit is None:
        return
    try:
        _yibu_audit(
            model=cfg.get('model') or 'qwen3.5-omni-flash',
            api_key=cfg.get('apiKey') or '',
            endpoint=(cfg['baseUrl'] or 'https://yibuapi.com/v1').rstrip('/')
            + '/chat/completions',
            purpose=purpose,
            transport='http',
            ok=ok,
            status_code=status,
            latency_s=time.perf_counter() - started,
            **({'response_json': {'usage': usage or {}}} if ok else {'error': error}),
        )
    except Exception:
        pass


def voice_options():
    """Both casts for the panel's pickers: OMNI's voices lead, ElevenLabs backs them up."""
    omni = secret('omni')
    return {
        'omni': {
            'configured': bool(omni['apiKey']),
            'voices': [
                {
                    **v,
                    'note': sponsor_personas.CAST[v['id']]['note'],
                    'modes': list(v['modes']),
                }
                for v in OMNI_VOICES
            ],
            'also': list(OMNI_ALSO),
            'default': omni_voice(omni, None),
        },
        'backup': elevenlabs_voice.options(secret('elevenlabs')),
    }


def omni_voice(cfg, data):
    """The panel's pick when this gateway is known to accept it, else the configured default. A
    refused name would cost the turn its voice, so nothing unverified goes through from the page.
    """
    wanted = str((data or {}).get('omniVoice') or '')
    return wanted if wanted in OMNI_ACCEPTED else ((cfg or {}).get('voice') or 'Ethan')


def persona(data, cfg=None):
    mode = 'coach' if (data or {}).get('mode') == 'coach' else 'face'
    voice = omni_voice(secret('omni') if cfg is None else cfg, data)
    return PERSONAS[mode] + sponsor_personas.direction(voice, mode)


def secret(kind):
    """Environment wins, then the 0600 file. Returns only known fields."""
    env = {
        'omni': {
            'apiKey': 'OMNI_API_KEY',
            'baseUrl': 'OMNI_BASE_URL',
            'model': 'OMNI_MODEL',
            'voice': 'OMNI_VOICE',
        },
        'livekit': {
            'url': 'LIVEKIT_URL',
            'apiKey': 'LIVEKIT_API_KEY',
            'apiSecret': 'LIVEKIT_API_SECRET',
            'guestUrl': 'ARENA_GUEST_URL',
            'tokenServerId': 'LIVEKIT_TOKEN_SERVER_ID',
        },
        'sentry': {
            'browserDsn': 'SENTRY_DSN_BROWSER',
            'pythonDsn': 'SENTRY_DSN',
            'environment': 'SENTRY_ENVIRONMENT',
        },
        'elevenlabs': {
            'apiKey': 'ELEVENLABS_API_KEY',
            'voiceId': 'ELEVENLABS_VOICE_ID',
            'model': 'ELEVENLABS_MODEL',
        },
    }[kind]
    saved = {}
    try:
        saved = json.loads((SECRETS / (kind + '.json')).read_text())
    except (OSError, ValueError):
        pass
    return {k: os.environ.get(env[k]) or saved.get(k) for k in FIELDS[kind]}


def save_secret(kind, data):
    if kind not in FIELDS:
        raise ValueError('Unknown settings group.')
    clean = {}
    for key in FIELDS[kind]:
        value = data.get(key)
        if value in (None, ''):
            continue
        if not isinstance(value, str) or len(value) > 600 or not value.isprintable():
            raise ValueError('Settings must be short printable text.')
        clean[key] = value.strip()
    if not clean:
        raise ValueError('Nothing to save.')
    SECRETS.mkdir(parents=True, exist_ok=True)
    restrict(SECRETS)
    path = SECRETS / (kind + '.json')
    merged = {}
    try:
        merged = json.loads(path.read_text())
    except (OSError, ValueError):
        pass
    merged.update(clean)
    tmp = path.with_suffix('.tmp')
    # Create the file already private; never widen permissions, even briefly.
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(merged, out)
    tmp.replace(path)
    restrict(path)
    return sorted(clean)


def local_livekit_up():
    try:
        with socket.create_connection(('127.0.0.1', 7880), timeout=0.25):
            return True
    except OSError:
        return False


def livekit():
    cfg = secret('livekit')
    if cfg['url'] and cfg['apiKey'] and cfg['apiSecret']:
        return {
            **cfg,
            'mode': 'cloud' if cfg['url'].startswith('wss://') else 'self-hosted',
        }
    if local_livekit_up():
        return {
            **DEV_LIVEKIT,
            'guestUrl': cfg['guestUrl'],
            'tokenServerId': None,
            'mode': 'local-dev',
        }
    return None


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def livekit_token(cfg, room, identity, name, host, ttl=4 * 3600):
    """A LiveKit access token is a plain HS256 JWT; minting it needs no SDK."""
    now = int(time.time())
    grant = {
        'room': room,
        'roomJoin': True,
        'canPublish': True,
        'canSubscribe': True,
        'canPublishData': True,
    }
    if host:
        grant.update(roomCreate=True, roomAdmin=True)
    claims = {
        'iss': cfg['apiKey'],
        'sub': identity,
        'name': name,
        'nbf': now - 10,
        'exp': now + ttl,
        'video': grant,
        'metadata': json.dumps({'role': 'host' if host else 'guest'}),
    }
    signing = (
        b64url(
            json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode()
        )
        + '.'
        + b64url(json.dumps(claims, separators=(',', ':')).encode())
    )
    return (
        signing
        + '.'
        + b64url(
            hmac.new(
                cfg['apiSecret'].encode(), signing.encode(), hashlib.sha256
            ).digest()
        )
    )


def clean_name(value, fallback):
    value = re.sub(r'[^\w .\'-]', '', str(value or ''), flags=re.UNICODE).strip()[:24]
    return value or fallback


def room_name(data):
    room = str(data.get('room') or '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{3,40}', room):
        raise ValueError('Room names use 3-40 letters, digits, - or _.')
    return room


def configured():
    cfg = livekit()
    if not cfg:
        raise ValueError(
            (
                'LiveKit is not configured. Add keys in Arena settings, or run: '
                'livekit-server --dev --bind 127.0.0.1'
            )
        )
    return cfg


def invite(data):
    """A link for guests. A LiveKit identity lives inside its token, so a shared token would let each
    new guest evict the last one. With a LiveKit Cloud development token server the link carries only
    that public id and every guest mints a unique token; otherwise each call mints one single-guest link.
    Tokens ride in the URL fragment, which browsers never send to any server."""
    cfg = configured()
    room = room_name(data)
    base = cfg.get('guestUrl') or ORIGINS[0] + '/guest.html'
    public = base.startswith('https://') and cfg['mode'] == 'cloud'
    reach = (
        'anyone with the link'
        if public
        else 'this computer only: other devices need LiveKit Cloud (wss) and an https guest page'
    )
    token_server = cfg.get('tokenServerId')
    if token_server and cfg['mode'] == 'cloud':
        if not re.fullmatch(r'[A-Za-z0-9_-]{4,80}', token_server):
            raise ValueError('The development token server id looks malformed.')
        return {
            'invite': base + '#d=' + token_server + '&r=' + room,
            'inviteKind': 'reusable',
            'inviteReach': reach,
        }
    guest = livekit_token(cfg, room, 'guest-' + uuid.uuid4().hex[:8], 'Guest', False)
    return {
        'invite': base
        + '#u='
        + quote(cfg['url'], safe='')
        + '&r='
        + room
        + '&t='
        + guest,
        'inviteKind': 'single-guest',
        'inviteReach': reach,
    }


def join(data):
    cfg = configured()
    room = room_name(data)
    host = data.get('role') == 'host'
    prefix = 'host-' if host else 'guest-'
    name = clean_name(data.get('name'), 'Host' if host else 'Guest')
    # A page that reloads asks for the identity it had, so LiveKit replaces its stale connection at once
    # instead of leaving a ghost participant (and, for the host, a second 'model' track) for ~20 s.
    wanted = str(data.get('identity') or '')
    identity = (
        wanted
        if re.fullmatch(prefix + r'[a-f0-9]{8}', wanted)
        else prefix + uuid.uuid4().hex[:8]
    )
    result = {
        'url': cfg['url'],
        'room': room,
        'identity': identity,
        'name': name,
        'mode': cfg['mode'],
        'token': livekit_token(cfg, room, identity, name, host),
    }
    if host:
        result.update(invite(data))
    return result


def telemetry_text(t):
    if not isinstance(t, dict):
        return 'No punch telemetry yet.'
    lines = ['Punch telemetry measured on the device (metres per second, last 30 s):']
    for p in (t.get('participants') or [])[:6]:
        lines.append(
            '- {name}: {count} punches, avg {avg:.1f} m/s, max {mx:.1f} m/s, left/right {l}/{r}, zones {zones}'.format(
                name=clean_name(p.get('name'), 'someone'),
                count=int(p.get('count', 0)),
                avg=float(p.get('avg', 0)),
                mx=float(p.get('max', 0)),
                l=int(p.get('left', 0)),
                r=int(p.get('right', 0)),
                zones=json.dumps(p.get('zones', {}))[:120],
            )
        )
    last = t.get('last')
    if isinstance(last, dict):
        lines.append(
            'Most recent: {who} hit the {zone} at {speed:.1f} m/s.'.format(
                who=clean_name(last.get('name'), 'someone'),
                zone=str(last.get('zone', 'face'))[:20],
                speed=float(last.get('speed', 0)),
            )
        )
    if t.get('guard'):
        lines.append('Guard estimate: ' + str(t['guard'])[:80])
    if t.get('trigger'):
        lines.append('This turn was triggered by: ' + str(t['trigger'])[:80])
    return '\n'.join(lines)


def omni_request(cfg, data):
    """OpenAI-compatible body for Qwen-Omni. Images and audio travel in separate user
    messages because Omni models accept one non-text modality per message."""
    history = sponsor_dialogue.recent_history(data.get('history'))
    cues = sponsor_dialogue.next_reply(history, data)
    audio = data.get('audioWav')
    text = str(data.get('text') or '')[:400]
    has_input = (
        bool(text)
        or omni_senses.usable_wav(audio)
        or omni_senses.usable_wav(data.get('roomWav'))
    )
    frames = omni_senses.clean_frames(data)
    parts, seen = omni_senses.vision_parts(frames)
    parts.append(
        {
            'type': 'text',
            'text': telemetry_text(data.get('telemetry'))
            + seen
            + omni_senses.delivery(data),
        }
    )
    messages = [
        {
            'role': 'system',
            'content': persona(data, cfg) + sponsor_dialogue.direction(history),
        },
        *sponsor_dialogue.context(history),
        {'role': 'user', 'content': parts},
        *(cues if has_input else []),
    ]
    if omni_senses.usable_wav(audio):
        messages.append(omni_senses.audio_message(audio))
    elif text:
        messages.append({'role': 'user', 'content': text})
    else:
        # Nobody asked anything: a punch set this turn off. It still gets to hear the exchange.
        heard = omni_senses.usable_wav(data.get('roomWav'))
        messages.append(
            {
                'role': 'user',
                'content': (
                    'That sound is the room during the exchange. Listen for words as well as '
                    'breathing and grunts. If someone speaks to you, answer what they said first, '
                    'using the recent conversation to understand references and follow-ups. '
                    'A punch triggered this turn, but that does not mean nobody is asking a question. '
                    if heard
                    else ''
                )
                + (
                    'Say something about what you just saw%s.'
                    if data.get('mode') != 'coach'
                    else 'Give me one coaching cue from what you just saw%s.'
                )
                % (' and heard' if heard else ''),
            }
        )
        if heard:
            # Keep the person's sound last, exactly as on a directly spoken turn.
            messages.append(omni_senses.audio_message(data['roomWav']))
    if not has_input:
        # A telemetry-only reaction has no person's words to keep last. Make the
        # changing cue its final request rather than the same generic ask every time.
        messages.extend(cues)
    body = {
        'model': cfg['model'] or 'qwen3.5-omni-flash',
        'messages': messages,
        'stream': True,
        'stream_options': {'include_usage': True},
        'max_tokens': 140,
        'temperature': 0.7,
    }
    if data.get('voice', True):
        body.update(
            modalities=['text', 'audio'],
            audio={'voice': omni_voice(cfg, data), 'format': 'wav'},
        )
    return body, len(frames)


def mock_reply(data):
    t = data.get('telemetry') or {}
    last = t.get('last') or {}
    people = t.get('participants') or []
    coaching = data.get('mode') == 'coach'
    if not people:
        return (
            'I have not seen a punch yet. Hands up, chin down, and throw a jab when you are ready.'
            if coaching
            else 'Still waiting. I am right here on the table and nothing has touched me yet.'
        )
    top = max(people, key=lambda p: p.get('max', 0))
    side = 'left' if top.get('left', 0) > top.get('right', 0) else 'right'
    shape = dict(
        name=clean_name(top.get('name'), 'Fighter'),
        count=int(top.get('count', 0)),
        mx=float(top.get('max', 0)),
        side=side,
        zone=str(last.get('zone', 'cheek'))[:20],
    )
    if coaching:
        return '{name}, {count} punches, top speed {mx:.1f} metres per second. You favour the {side}; mix in the other hand and bring your guard back after the {zone}.'.format(
            **shape
        )
    return '{count} of those, {name}, and the best one was {mx:.1f} metres per second. It is always the {side} hand, so I see the {zone} coming before you throw it.'.format(
        **shape
    )


class Handler(BaseHTTPRequestHandler):
    server_version = 'PunchingFaceSponsors/1'
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def cors(self):
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header(
                'Access-Control-Allow-Headers', 'Content-Type, sentry-trace, baggage'
            )
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def guard(self):
        if self.headers.get('Host', '').split(':')[0] not in ('127.0.0.1', 'localhost'):
            raise PermissionError('Local clients only.')
        if self.headers.get('Origin') not in (None, *ORIGINS):
            raise PermissionError('Invalid request origin.')

    def reply(self, code, payload):
        body = json.dumps(payload, allow_nan=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        try:
            self.guard()
            if self.path == '/sponsors/voice/options':
                # Separate from /config on purpose: this one may ask ElevenLabs which voices the
                # account has, and the dock must not wait on that to start.
                return self.reply(200, voice_options())
            if self.path != '/sponsors/config':
                return self.reply(404, {'error': 'Unknown sponsor endpoint.'})
            omni = secret('omni')
            lk = livekit()
            sentry = secret('sentry')
            # The Sentry DSN is public by design; no other secret ever leaves this process.
            self.reply(
                200,
                {
                    'omni': {
                        'configured': bool(omni['apiKey']),
                        'model': omni['model'] or 'qwen3.5-omni-flash',
                        'voice': omni['voice'] or 'Ethan',
                        'gateway': (omni['baseUrl'] or 'https://yibuapi.com/v1').split(
                            '/'
                        )[2],
                    },
                    'voice': {
                        'elevenlabs': elevenlabs_voice.configured(secret('elevenlabs'))
                    },
                    'livekit': {
                        'configured': bool(lk),
                        'mode': lk['mode'] if lk else None,
                        'url': lk['url'] if lk else None,
                        'guestUrl': (lk or {}).get('guestUrl'),
                        'reusableInvites': bool((lk or {}).get('tokenServerId')),
                    },
                    'sentry': {
                        'dsn': sentry['browserDsn'] or sentry['pythonDsn'],
                        'environment': sentry['environment'] or 'hackathon',
                        'release': sponsor_obs.release(),
                        'python': sponsor_obs.ENABLED,
                    },
                },
            )
        except PermissionError as e:
            self.reply(403, {'error': str(e)})

    def do_POST(self):
        try:
            self.guard()
            size = int(self.headers.get('Content-Length', 0))
            limit = 6_000_000 if self.path == '/sponsors/coach/turn' else 8192
            if (
                not 0 < size <= limit
                or self.headers.get('Content-Type', '').split(';')[0]
                != 'application/json'
            ):
                raise ValueError('Expected a bounded JSON request.')
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object.')
            if self.path == '/sponsors/livekit/join':
                return self.reply(200, join(data))
            if self.path == '/sponsors/livekit/invite':
                return self.reply(200, invite(data))
            if self.path == '/sponsors/settings':
                saved = save_secret(str(data.get('group')), data)
                if data.get('group') == 'elevenlabs':
                    elevenlabs_voice.reset()  # a new key deserves a fresh try
                return self.reply(200, {'saved': saved})
            if self.path == '/sponsors/coach/turn':
                return self.coach(data)
            if self.path == '/sponsors/voice/preview':
                return self.preview(data)
            self.reply(404, {'error': 'Unknown sponsor endpoint.'})
        except PermissionError as e:
            self.reply(403, {'error': str(e)})
        except (ValueError, KeyError, TypeError) as e:
            self.reply(400, {'error': str(e)})
        except Exception as e:
            sponsor_obs.capture(e)
            self.reply(
                500, {'error': 'Sponsor service failed. Check its terminal output.'}
            )

    def setup(self):
        super().setup()
        # `audio` events come from the ElevenLabs worker while this thread is writing `text`.
        self.stream_lock = threading.Lock()

    def event(self, name, payload):
        with self.stream_lock:
            self.wfile.write(
                ('event: %s\ndata: %s\n\n' % (name, json.dumps(payload))).encode()
            )
            self.wfile.flush()

    def open_stream(self):
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def speaker(self, spoken):
        """An ElevenLabs voice for this stream: PCM goes out as the same `audio` events OMNI's does."""
        return elevenlabs_voice.Speaker(
            spoken,
            lambda pcm: self.event(
                'audio',
                {
                    'pcm16': base64.b64encode(pcm).decode(),
                    'rate': elevenlabs_voice.RATE,
                },
            ),
        )

    def finish_voice(self, speaker):
        """Let the last sentence finish streaming. A failure is reported, never raised: the words
        are already on the page, and the panel falls back to the browser's voice for this turn.
        """
        if not speaker:
            return None
        error = speaker.close()
        stats = speaker.stats()
        if error:
            self.event('voice', {'engine': 'elevenlabs', 'error': error.public()})
        sponsor_obs.log(
            'coach.voice',
            engine='elevenlabs',
            voice=stats['voice'],
            model=stats['model'],
            first_audio_ms=stats['firstAudioMs'],
            audio_ms=stats['audioMs'],
            characters=stats['characters'],
            error=error.code if error else 'none',
        )
        sponsor_obs.metric(
            'coach.voice.first_audio',
            stats['firstAudioMs'],
            'millisecond',
            engine='elevenlabs',
            voice=stats['voice'],
            outcome=error.code if error else 'ok',
        )
        return stats

    def omni_stream(self, cfg, body, speaker=None, history=None):
        """One chat/completions call, relayed to the page as `text` and `audio` events. Text also
        goes to `speaker` when ElevenLabs is doing the talking. Returns what happened.
        """
        request = urllib.request.Request(
            (cfg['baseUrl'] or 'https://yibuapi.com/v1').rstrip('/')
            + '/chat/completions',
            data=json.dumps(body).encode(),
            headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg['apiKey'],
                'Accept': 'text/event-stream',
            },
        )
        got = dict(
            first=None, usage=None, finish=None, text='', audio=False, error=None
        )
        gate = sponsor_dialogue.ReplyGate(history or [])

        def deliver(name, data):
            got['first'] = got['first'] or time.perf_counter()
            self.event(name, data)
            if name == 'text' and speaker:
                speaker.feed(data['delta'])
            elif name == 'audio':
                got['audio'] = True

        with urllib.request.urlopen(request, timeout=60) as upstream:
            for raw in upstream:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'):
                    continue
                chunk = line[5:].strip()
                if chunk == '[DONE]':
                    break
                try:
                    piece = json.loads(chunk)
                except ValueError:
                    continue
                if isinstance(piece.get('error'), dict):
                    # yibuapi reports some failures inside a 200 stream, an unsupported voice for
                    # one. Unread, the turn would simply end with nothing said and no reason given.
                    got['error'] = str(
                        piece['error'].get('message')
                        or piece['error'].get('code')
                        or 'unknown error'
                    )[:300]
                    continue
                got['usage'] = piece.get('usage') or got['usage']
                for choice in piece.get('choices') or []:
                    got['finish'] = choice.get('finish_reason') or got['finish']
                    delta = choice.get('delta') or {}
                    audio = delta.get('audio') or {}
                    words = (
                        delta.get('content')
                        if isinstance(delta.get('content'), str)
                        else audio.get('transcript')
                    )
                    if words:
                        got['text'] += words
                        for name, data in gate.feed('text', {'delta': words}):
                            deliver(name, data)
                    if audio.get('data'):
                        for name, data in gate.feed(
                            'audio', {'pcm16': audio['data'], 'rate': 24000}
                        ):
                            deliver(name, data)
        if gate.repeated():
            got['repeated'], got['text'] = got['text'], ''
        else:
            for name, data in gate.release():
                deliver(name, data)
        return got

    def omni_tool_call(self, cfg, body):
        """One chat/completions call whose answer is a function call. Returns its name and arguments."""
        request = urllib.request.Request(
            (cfg['baseUrl'] or 'https://yibuapi.com/v1').rstrip('/')
            + '/chat/completions',
            data=json.dumps(body).encode(),
            headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg['apiKey'],
                'Accept': 'text/event-stream',
            },
        )
        got = dict(name='', arguments='', usage=None, error=None)
        with urllib.request.urlopen(request, timeout=20) as upstream:
            for raw in upstream:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:') or line[5:].strip() == '[DONE]':
                    continue
                try:
                    piece = json.loads(line[5:])
                except ValueError:
                    continue
                if isinstance(piece.get('error'), dict):
                    got['error'] = str(
                        piece['error'].get('message') or 'unknown error'
                    )[:300]
                    continue
                got['usage'] = piece.get('usage') or got['usage']
                for choice in piece.get('choices') or []:
                    for call in (choice.get('delta') or {}).get('tool_calls') or []:
                        if call.get('index', 0) != 0:
                            continue
                        function = call.get('function') or {}
                        got['name'] += function.get('name') or ''
                        got['arguments'] += function.get('arguments') or ''
        return got

    def express(self, cfg, data, started, turn_span=None, perception=None):
        """Runs beside the spoken turn: OMNI picks the face's expression with a `set_expression`
        tool call and the page wears it, usually before the voice starts. Never fails the turn.
        `turn_span` is the agent span of that turn: this is another thread, and in Sentry the
        expression call belongs beside the spoken reply, not under it.
        """
        began = time.perf_counter()
        purpose = 'punching-face.expression'
        try:
            request = sponsor_perception.request(
                cfg, data, telemetry_text(data.get('telemetry'))
            )
        except (OSError, ValueError):
            return None
        with sponsor_obs.ai_span(
            request.get('model') or 'unknown',
            'yibuapi',
            agent='The Face',
            parent=turn_span,
            purpose='expression',
            tools=len(request.get('tools') or []),
            messages_count=len(request.get('messages') or []),
            max_tokens=request.get('max_tokens'),
        ) as span:
            try:
                got = self.omni_tool_call(cfg, request)
            except urllib.error.HTTPError as e:
                sponsor_obs.ai_error(span, e.code, 'expression')
                return ledger(
                    cfg, purpose, began, False, e.code, error='HTTP %d' % e.code
                )
            except (OSError, ValueError) as e:
                sponsor_obs.ai_error(span, 599, type(e).__name__)
                return None
            sponsor_obs.ai_usage(
                span,
                got['usage'],
                round((time.perf_counter() - began) * 1000),
                0,
                finish_reason=(
                    'tool_calls' if got['name'] else (got['error'] and 'error')
                ),
                model=request.get('model'),
            )
        ledger(cfg, purpose, began, not got['error'], 200, got['usage'], got['error'])
        chosen = (
            omni_senses.read_expression(got['arguments'])
            if got['name'] == 'set_expression'
            else None
        )
        took = round((time.perf_counter() - began) * 1000)
        sponsor_obs.log(
            'coach.expression',
            emotion=(chosen or {}).get('emotion') or 'none',
            ms=took,
        )
        sponsor_obs.metric(
            'coach.expression.latency',
            took,
            'millisecond',
            emotion=(chosen or {}).get('emotion') or 'none',
        )
        if (
            data.get('remember')
            and got['name'] == 'set_expression'
            and perception is not None
        ):
            notes = sponsor_perception.read(got['arguments'], data)
            if notes is not None:
                perception.update(notes)
        if chosen and data.get('mode') != 'coach' and data.get('expressions', True):
            # The emotion is one of a closed list and the intensity a number: safe to record.
            with sponsor_obs.tool_span(
                'set_expression',
                agent='The Face',
                parent=turn_span,
                emotion=chosen.get('emotion'),
                intensity=chosen.get('intensity'),
                since_turn_start_ms=round((time.perf_counter() - started) * 1000),
            ):
                try:
                    self.event(
                        'expression',
                        {
                            **chosen,
                            'ms': round((time.perf_counter() - started) * 1000),
                            'source': 'OMNI set_expression tool call',
                        },
                    )
                except (OSError, ValueError):
                    pass  # the page left before the face could react

    def preview(self, data):
        """Say one sample line in a chosen voice, so voices can be auditioned from the panel
        without a turn. `engine` says who speaks. The ElevenLabs side always asks, even after a
        standing failure: this is how a repaired key gets noticed."""
        mode = 'coach' if data.get('mode') == 'coach' else 'face'
        line = sponsor_personas.sample(
            omni_voice(secret('omni'), data), mode, elevenlabs_voice.SAMPLES[mode]
        )
        self.open_stream()
        speaker = None
        try:
            if data.get('engine') == 'omni':
                return self.preview_omni(data, mode, line)
            backup = elevenlabs_voice.plan(secret('elevenlabs'), data, mode, force=True)
            if not backup:
                return self.event(
                    'voice',
                    {
                        'engine': 'elevenlabs',
                        'error': {
                            'code': 'unconfigured',
                            'message': 'No ElevenLabs key is saved on this computer.',
                        },
                    },
                )
            self.event(
                'meta',
                {
                    'voiceEngine': 'elevenlabs',
                    'voiceName': backup['voice']['name'],
                    'mode': mode,
                },
            )
            self.event('text', {'delta': line})
            speaker = self.speaker(backup)
            speaker.feed(line)
            self.event('done', {'speech': self.finish_voice(speaker)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            sponsor_obs.capture(e)
            try:
                self.event(
                    'error', {'message': 'Voice preview failed: ' + type(e).__name__}
                )
            except OSError:
                pass
        finally:
            if speaker:
                speaker.abandon()

    def preview_omni(self, data, mode, line):
        cfg = secret('omni')
        if not cfg['apiKey']:
            return self.event(
                'voice',
                {
                    'engine': 'omni',
                    'error': {
                        'code': 'unconfigured',
                        'message': 'No OMNI key is saved on this computer.',
                    },
                },
            )
        voice = omni_voice(cfg, data)
        body = {
            'model': cfg['model'] or 'qwen3.5-omni-flash',
            'messages': [
                {
                    'role': 'system',
                    'content': "You are a voice actor. Say the user's line exactly as written, "
                    'once, in character. Add nothing.'
                    + sponsor_personas.direction(voice, mode)
                    + '\nFor this audition only, read the supplied line exactly; do not write a fresh one.',
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
        self.event(
            'meta',
            {
                'voiceEngine': 'omni',
                'voiceName': voice,
                'mode': mode,
                'model': body['model'],
            },
        )
        started = time.perf_counter()
        purpose = 'punching-face.voice_preview'
        try:
            got = self.omni_stream(cfg, body)
        except urllib.error.HTTPError as e:
            detail = e.read(300).decode('utf-8', 'replace')
            ledger(
                cfg,
                purpose,
                started,
                False,
                e.code,
                error='HTTP %d: %s' % (e.code, detail[:200]),
            )
            return self.event(
                'voice',
                {
                    'engine': 'omni',
                    'error': {
                        'code': 'gateway',
                        'message': 'OMNI gateway refused the request (%d).' % e.code,
                    },
                },
            )
        ledger(cfg, purpose, started, not got['error'], 200, got['usage'], got['error'])
        if got['error'] or not got['audio']:
            self.event(
                'voice',
                {
                    'engine': 'omni',
                    'error': {
                        'code': 'gateway',
                        'message': got['error'] or 'OMNI answered without audio.',
                    },
                },
            )
        self.event(
            'done',
            {
                'ms': round((time.perf_counter() - started) * 1000),
                'usage': got['usage'],
            },
        )

    def coach(self, data):
        # Echoed back in `meta` so the panel can tell which persona actually answered:
        # this file has no reloader, so a server left running across an edit would otherwise
        # keep serving the old prompt while the page looked up to date.
        mode = 'coach' if (data or {}).get('mode') == 'coach' else 'face'
        cfg = secret('omni')
        purpose = str(data.get('purpose') or 'punching-face.coach')
        # OMNI's own voice leads. ElevenLabs is the backup: it speaks for the mock, when the panel
        # puts it in front, and when OMNI answers without a voice. None: no key, or a standing
        # problem with it.
        wants_voice = bool(data.get('voice', True))
        backup = (
            elevenlabs_voice.plan(secret('elevenlabs'), data, mode)
            if wants_voice
            else None
        )
        in_front = not cfg['apiKey'] or data.get('voiceEngine') == 'elevenlabs'
        lead = backup if in_front else None
        engine = (
            'off'
            if not wants_voice
            else ('elevenlabs' if lead else ('omni' if cfg['apiKey'] else 'browser'))
        )
        voiced = {
            'voiceEngine': engine,
            'voiceName': (
                lead['voice']['name']
                if lead
                else (omni_voice(cfg, data) if engine == 'omni' else None)
            ),
            'backupVoice': backup['voice']['name'] if backup else None,
            # Why ElevenLabs is sitting out although a key is saved, if it is.
            'voiceProblem': (
                elevenlabs_voice.standing_problem() if wants_voice else None
            ),
        }
        self.open_stream()
        started = time.perf_counter()
        speaker = None
        try:
            if not cfg['apiKey']:
                # Development stand-in so the capture/playback loop can be built before a key arrives.
                # It is labelled in the stream and in the UI, and it never claims to be the OMNI model.
                self.event(
                    'meta',
                    {
                        'mock': True,
                        'model': 'mock (no OMNI key configured)',
                        'mode': mode,
                        **voiced,
                    },
                )
                speaker = self.speaker(lead) if lead else None
                for word in mock_reply(data).split(' '):
                    self.event('text', {'delta': word + ' '})
                    if speaker:
                        speaker.feed(word + ' ')
                    time.sleep(0.03)
                speech = self.finish_voice(speaker)
                return self.event(
                    'done',
                    {
                        'mock': True,
                        'ms': round((time.perf_counter() - started) * 1000),
                        'speech': speech,
                    },
                )
            # With ElevenLabs in front the model only has to write.
            body, frames = omni_request(cfg, {**data, 'voice': False} if lead else data)
            model = body['model']
            # Non-PII shape data for Sentry AI monitoring. Never prompt content or images.
            shape = dict(
                messages_count=len(body['messages']),
                system_prompt_len=len(body['messages'][0]['content']),
                mode=str(data.get('mode') or 'face')[:12],
                frames_attached=frames,
                has_voice=('audio' in body),
                temperature=body.get('temperature'),
                max_tokens=body.get('max_tokens'),
                audio_ms=0,
            )
            audio = data.get('audioWav')
            shape['audio_ms'] = (
                int(len(audio) * 3 / 4 / 48) if isinstance(audio, str) else 0
            )  # rough wav bytes->ms
            active_span = None
            # One agent turn in Sentry: the spoken reply, the expression tool call beside it and
            # the voice all sit under this span, so the AI Agents view reads a punch as one run.
            agent = 'The Face' if mode == 'face' else 'Cornerman'
            with (
                sponsor_obs.agent_span(
                    agent,
                    model,
                    mode=mode,
                    voice_engine=engine,
                    trigger=str(
                        (data.get('telemetry') or {}).get('trigger') or 'asked'
                    )[:60],
                ) as turn_span,
                sponsor_obs.ai_span(model, 'yibuapi', agent=agent, **shape) as span,
            ):
                active_span = span
                self.event(
                    'meta',
                    {
                        'mock': False,
                        'model': model,
                        'frames': frames,
                        'voice': 'audio' in body,
                        'mode': mode,
                        **voiced,
                    },
                )
                # The face's expression is its own small call, made while the line is being spoken.
                mood, perception = None, {}
                if data.get('remember') or (
                    mode == 'face' and data.get('expressions', True)
                ):
                    mood = threading.Thread(
                        target=self.express,
                        args=(cfg, data, started, turn_span),
                        kwargs={'perception': perception},
                        daemon=True,
                    )
                    mood.start()
                speaker = self.speaker(lead) if lead else None
                # Direct conversation keeps its normal stream, including requests to
                # repeat a line. Only unsolicited face reactions are deduplicated.
                recent = (
                    sponsor_dialogue.recent_history(data.get('history'))
                    if mode == 'face'
                    and not data.get('text')
                    and not data.get('audioWav')
                    else []
                )
                got = self.omni_stream(cfg, body, speaker, recent)
                if got['error'] and not got['text'] and 'audio' in body:
                    # OMNI could not speak (a refused voice, say). Ask again for the words alone:
                    # the backup says them, or failing that the browser does.
                    ledger(cfg, purpose, started, False, 200, error=got['error'])
                    sponsor_obs.warn(
                        'coach.voice_fallback',
                        to='elevenlabs' if backup else 'browser',
                        reason=got['error'][:120],
                        model=model,
                    )
                    sponsor_obs.count(
                        'coach.voice_fallback', to='elevenlabs' if backup else 'browser'
                    )
                    self.event(
                        'voice',
                        {
                            'engine': 'elevenlabs' if backup else 'browser',
                            'voiceName': backup['voice']['name'] if backup else None,
                            'fallback': True,
                            'reason': got['error'],
                        },
                    )
                    body, frames = omni_request(cfg, {**data, 'voice': False})
                    speaker = self.speaker(backup) if backup else None
                    got = self.omni_stream(cfg, body, speaker, recent)
                if got.get('repeated'):
                    ledger(cfg, purpose, started, True, 200, usage=got['usage'])
                    sponsor_obs.count('coach.reply_repeat', outcome='retry')
                    retry = {
                        **body,
                        'messages': [
                            *body['messages'],
                            {
                                'role': 'user',
                                'content': 'That line was already spoken: '
                                + json.dumps(got['repeated'])
                                + '. Give one entirely new reaction with different wording and a different idea. '
                                'Do not paraphrase it. Stay grounded in the supplied evidence. Safety overrides banter.',
                            },
                        ],
                    }
                    got = self.omni_stream(cfg, retry, speaker, recent)
                    if got.get('repeated'):
                        # Silence is better than playing a known duplicate a second time.
                        sponsor_obs.count('coach.reply_repeat', outcome='skipped')
                if got['error'] and not got['text']:
                    raise GatewayRefused(got['error'])
                if (
                    wants_voice
                    and backup
                    and not speaker
                    and got['text']
                    and not got['audio']
                ):
                    # Words but no voice: the backup says the whole reply.
                    self.event(
                        'voice',
                        {
                            'engine': 'elevenlabs',
                            'voiceName': backup['voice']['name'],
                            'fallback': True,
                            'reason': 'OMNI answered without audio.',
                        },
                    )
                    speaker = self.speaker(backup)
                    speaker.feed(got['text'])
                # First, so the last sentence starts streaming before the bookkeeping below.
                speech = self.finish_voice(speaker)
                first, usage, finish = got['first'], got['usage'], got['finish']
                latency = round(((first or time.perf_counter()) - started) * 1000)
                sponsor_obs.ai_usage(
                    span, usage, latency, frames, finish_reason=finish, model=model
                )
                sponsor_obs.log(
                    'coach.turn',
                    model=model,
                    frames=frames,
                    first_token_ms=latency,
                    finish_reason=finish or 'unknown',
                    tokens=(usage or {}).get('total_tokens'),
                )
                # The numbers the demo quotes ("the model is 1.3 s away"), as distributions: p50
                # and p95 over the whole weekend, split by what was attached and who spoke.
                sponsor_obs.metric(
                    'coach.first_token',
                    latency,
                    'millisecond',
                    model=model,
                    mode=mode,
                    voice_engine=engine,
                    frames=frames,
                    heard_audio=bool(shape['audio_ms']),
                )
                sponsor_obs.metric(
                    'coach.turn.duration',
                    round((time.perf_counter() - started) * 1000),
                    'millisecond',
                    model=model,
                    mode=mode,
                    voice_engine=engine,
                )
                sponsor_obs.count('coach.turn', outcome='ok', mode=mode)
                if turn_span:
                    turn_span.set_data('agent.first_token_ms', latency)
                    turn_span.set_data('agent.reply_chars', len(got['text']))
                    turn_span.set_data(
                        'agent.spoke_with', 'omni' if got['audio'] else engine
                    )
                ledger(cfg, purpose, started, True, 200, usage)
                if mood:
                    mood.join(4)
                if perception:
                    # Private conversation evidence goes only to this page, never observability logs.
                    self.event('perception', dict(perception))
                self.event(
                    'done',
                    {
                        'mock': False,
                        'firstTokenMs': latency,
                        'ms': round((time.perf_counter() - started) * 1000),
                        'usage': usage,
                        'finishReason': finish,
                        'speech': speech,
                        'skippedRepeat': bool(got.get('repeated')),
                    },
                )
        except GatewayRefused as e:
            sponsor_obs.count('coach.turn', outcome='refused', mode=mode)
            sponsor_obs.capture(e, {'status': 200, 'detail': str(e)})
            try:
                sponsor_obs.ai_error(
                    active_span if 'active_span' in dir() else None, 200, str(e)[:40]
                )
            except Exception:
                pass
            ledger(cfg, purpose, started, False, 200, error=str(e)[:200])
            self.event(
                'error',
                {
                    'status': 200,
                    'message': 'OMNI gateway refused the request.',
                    'detail': str(e),
                },
            )
        except urllib.error.HTTPError as e:
            detail = e.read(600).decode('utf-8', 'replace')
            sponsor_obs.count('coach.turn', outcome='http_%d' % e.code, mode=mode)
            sponsor_obs.capture(e, {'status': e.code, 'detail': detail})
            # Also mark the AI span so AI-monitoring filters (error rate, top failing models) see it.
            try:
                sponsor_obs.ai_error(
                    active_span if 'active_span' in dir() else None, e.code, detail[:40]
                )
            except Exception:
                pass
            ledger(
                cfg,
                purpose,
                started,
                False,
                e.code,
                error=('HTTP %d: %s' % (e.code, detail[:200])),
            )
            self.event(
                'error',
                {
                    'status': e.code,
                    'message': 'OMNI gateway refused the request (%d).' % e.code,
                    'detail': detail,
                },
            )
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            sponsor_obs.capture(e)
            try:
                self.event(
                    'error', {'message': 'Coach relay failed: ' + type(e).__name__}
                )
            except OSError:
                pass
        finally:
            # However the turn ended, the voice worker must not outlive it.
            if speaker:
                speaker.abandon()


if __name__ == '__main__':
    sponsor_obs.init('sponsor-server')
    sponsor_obs.instrument_http(Handler)
    print(
        'Sponsor services http://127.0.0.1:%d  (OMNI key: %s · Voice: %s · LiveKit: %s · Sentry: %s)'
        % (
            PORT,
            'yes' if secret('omni')['apiKey'] else 'no, mock coach',
            (
                'ElevenLabs'
                if elevenlabs_voice.configured(secret('elevenlabs'))
                else 'OMNI / browser'
            ),
            (livekit() or {}).get('mode', 'not configured'),
            'on' if sponsor_obs.ENABLED else 'off',
        ),
        flush=True,
    )
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
