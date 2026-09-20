"""ElevenLabs: the backup voice for the face and the coach.

OMNI's own voice comes first (it is the point of the OMNI Live track). ElevenLabs speaks when OMNI
cannot: no OMNI key (mock mode, which otherwise falls to the browser's robotic `speechSynthesis`),
a voice the gateway refuses, or a reply that arrives as words without audio. The panel can also
put it in front on purpose. Either way the relay cuts the text into sentences while it streams and
sends each to ElevenLabs' streaming endpoint as raw 24 kHz PCM16: exactly the shape the panel
already plays for OMNI audio, so the mouth analyser (real lip-sync), the echo gate and the LiveKit
guest stream need no changes.

The key never leaves this process and is never written into an event, a log or an error.
Standard library only, so it runs in the existing Python 3.9 venv.
"""

import json, queue, re, socket, threading, time, urllib.error, urllib.request
from urllib.parse import quote

API = 'https://api.elevenlabs.io'
RATE = 24000
# ~75 ms model latency and built for real-time use. `eleven_multilingual_v2` is richer but slower;
# set ELEVENLABS_MODEL (or "model" in .local/secrets/elevenlabs.json) to try another.
DEFAULT_MODEL = 'eleven_flash_v2_5'
CHUNK_BYTES = 4800  # 100 ms of PCM16 mono at 24 kHz per `audio` event
MIN_SENTENCE = 28  # shorter fragments ride along with the next sentence: fewer requests, better prosody
AUTO = 'auto'  # the picker's default: the backup that sounds most like the chosen OMNI voice

# A cast, not a list of stock names: each is a way of being punched. ElevenLabs "Default" voices,
# present on accounts created before March 2026 and retired on 2026-12-31; after that, replace the
# ids with voices from the account's My Voices (three-dot menu > Copy voice ID) and keep the roles.
VOICES = (
    {
        'id': 'N2lVS1w4EtoT3dr4eOWO',
        'name': 'The Brawler',
        'actor': 'Callum',
        'note': 'Gravelly and intense. Sounds like it has been hit before and liked it.',
        'modes': ('face',),
    },
    {
        'id': 'onwK4e9ZLuTAKqWW03F9',
        'name': 'The Deadpan Brit',
        'actor': 'Daniel',
        'note': 'A newsreader calmly reporting how bad your jab is.',
        'modes': ('face',),
    },
    {
        'id': 'IKne3meq5aSn9XLyUdCD',
        'name': 'The Cocky Aussie',
        'actor': 'Charlie',
        'note': 'Loose, quick and laughing at you.',
        'modes': ('face',),
    },
    {
        'id': 'nPczCjzI2devNBz1zQrb',
        'name': 'The Heavyweight',
        'actor': 'Brian',
        'note': 'Deep, slow and completely unbothered.',
        'modes': ('face', 'coach'),
    },
    {
        'id': 'cgSgspJ2msm6clMCkdW9',
        'name': 'The Firecracker',
        'actor': 'Jessica',
        'note': 'Fast, expressive and sharp-tongued. For a scanned head that is a woman.',
        'modes': ('face',),
    },
    {
        'id': 'Xb7hH8MSUJpSbSDYk0k2',
        'name': 'The Ice Queen',
        'actor': 'Alice',
        'note': 'Crisp British contempt, never raises her voice.',
        'modes': ('face', 'coach'),
    },
    {
        'id': 'pqHfZKP75CvOlQylNhV4',
        'name': 'The Old Cornerman',
        'actor': 'Bill',
        'note': 'Weathered and trustworthy. Forty years of taping hands.',
        'modes': ('coach',),
    },
)
DEFAULTS = {'face': 'N2lVS1w4EtoT3dr4eOWO', 'coach': 'pqHfZKP75CvOlQylNhV4'}
# When the backup steps in for an OMNI voice it should not change the character (or the gender) of
# the head mid-round. OMNI voice (sponsor_server.OMNI_VOICES) -> the closest of the cast above.
BACKUP_FOR = {
    'Ryan': 'N2lVS1w4EtoT3dr4eOWO',  # theatrical heel -> The Brawler
    'Ethan': 'IKne3meq5aSn9XLyUdCD',  # quick and bright -> The Cocky Aussie
    'Dylan': 'IKne3meq5aSn9XLyUdCD',
    'Marcus': 'nPczCjzI2devNBz1zQrb',  # deep and level -> The Heavyweight
    'Eric': 'nPczCjzI2devNBz1zQrb',
    'Peter': 'onwK4e9ZLuTAKqWW03F9',  # the comedian -> The Deadpan Brit
    'Rocky': 'onwK4e9ZLuTAKqWW03F9',
    'Jennifer': 'Xb7hH8MSUJpSbSDYk0k2',  # cold and controlled -> The Ice Queen
    'Katerina': 'Xb7hH8MSUJpSbSDYk0k2',
    'Serena': 'cgSgspJ2msm6clMCkdW9',  # young and light -> The Firecracker
}

# Trash talk wants range and pace; a coach wants to be steady. `style` stays 0: on the Flash models
# it only adds latency.
SETTINGS = {
    'face': {
        'stability': 0.35,
        'similarity_boost': 0.8,
        'style': 0.0,
        'use_speaker_boost': True,
        'speed': 1.06,
    },
    'coach': {
        'stability': 0.55,
        'similarity_boost': 0.8,
        'style': 0.0,
        'use_speaker_boost': True,
        'speed': 1.0,
    },
}

# What "Hear it" says. Same rule as the persona: mock the punching, nothing else.
SAMPLES = {
    'face': 'Was that the whole thing? I have been hit harder by a software update.',
    'coach': 'Hands up, chin down. Turn your hip into that cross and bring it straight back.',
}

_VOICE_ID = re.compile(r'[A-Za-z0-9]{10,40}')
_BOUNDARY = re.compile(r'[.!?…]+["\')\]]*\s+')
_UNSPOKEN = re.compile(r'[*_#`~<>|\\]+')

# Problems that will not fix themselves between two turns. While one stands, turns stop asking
# ElevenLabs (so an OMNI turn keeps its own voice) until the key is saved again or a preview works.
_STICKY = ('permission', 'key', 'quota', 'plan')
_STICKY_SECONDS = 120
_down = {'until': 0.0, 'error': None}
_listing = {'at': 0.0, 'key': None, 'voices': None}


class VoiceError(Exception):
    """A failure the panel can show as is. Never contains the key."""

    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status

    def public(self):
        return {'code': self.code, 'message': self.message, 'status': self.status}


def _explain(error, key):
    """Map an ElevenLabs HTTP error onto something a person at a demo table can act on."""
    raw = error.read(800).decode('utf-8', 'replace')
    status, said = '', ''
    try:
        detail = json.loads(raw).get('detail')
        if isinstance(detail, dict):
            status, said = str(detail.get('status') or ''), str(
                detail.get('message') or ''
            )
        elif isinstance(detail, str):
            said = detail
    except ValueError:
        pass
    said = said.replace(key or '\0', '[key]')[:200]
    code = error.code
    if status == 'missing_permissions' or 'missing the permission' in said:
        return VoiceError(
            'permission',
            'This ElevenLabs key is not allowed to do text-to-speech. In ElevenLabs > Developers > '
            'API Keys, edit the key and give "Text to Speech" access (or create an unrestricted '
            'key), then press Hear it again.',
            code,
        )
    if status == 'quota_exceeded' or 'quota' in said.lower():
        return VoiceError(
            'quota', 'The ElevenLabs account is out of credits for this month.', code
        )
    if code == 401:
        return VoiceError('key', 'ElevenLabs rejected the API key.', code)
    if status == 'voice_not_found' or code == 404:
        return VoiceError(
            'voice',
            'That voice is not on this ElevenLabs account. Pick another, or copy a voice ID from '
            'My Voices into ELEVENLABS_VOICE_ID.',
            code,
        )
    if code in (402, 403):
        return VoiceError(
            'plan',
            'The ElevenLabs plan does not allow this voice or model over the API. '
            + said,
            code,
        )
    if code == 429:
        return VoiceError(
            'busy', 'ElevenLabs is rate limiting. Try again in a moment.', code
        )
    return VoiceError(
        'error', ('ElevenLabs refused the request (%d). ' % code) + said, code
    )


def configured(cfg):
    return bool((cfg or {}).get('apiKey'))


def catalogue(cfg=None):
    """The voices the panel offers. Public: names and ids only."""
    voices = [{**v, 'modes': list(v['modes'])} for v in VOICES]
    custom = str((cfg or {}).get('voiceId') or '')
    if _VOICE_ID.fullmatch(custom) and custom not in {v['id'] for v in voices}:
        voices.insert(
            0,
            {
                'id': custom,
                'name': 'Your voice',
                'actor': 'ELEVENLABS_VOICE_ID',
                'note': 'The voice ID configured on this computer.',
                'modes': ['face', 'coach'],
            },
        )
    return voices


def pick(cfg, requested, mode, omni_voice=None):
    """The catalogue entry a turn will speak with. An explicit pick wins; unknown but well-formed
    ids are allowed, so a voice from the account's own library works without a code change. Left
    on auto: the voice ID configured on this computer, else the match for the OMNI voice, else the
    mode's default."""
    mode = mode if mode in SETTINGS else 'face'
    voices = catalogue(cfg)
    by_id = {v['id']: v for v in voices}
    requested = str(requested or '')
    if requested in by_id:
        return by_id[requested]
    if _VOICE_ID.fullmatch(requested):
        return {'id': requested, 'name': 'Account voice', 'actor': requested[:8]}
    custom = str((cfg or {}).get('voiceId') or '')
    return (
        by_id.get(custom)
        or by_id.get(BACKUP_FOR.get(str(omni_voice or '')))
        or by_id[DEFAULTS[mode]]
    )


def plan(cfg, data, mode, force=False):
    """How ElevenLabs would speak this turn, or None when it cannot: no key, or a standing problem
    (see _STICKY). `force` asks anyway: that is how a repaired key gets noticed."""
    data = data or {}
    if not configured(cfg):
        return None
    if not force and time.time() < _down['until']:
        return None
    mode = mode if mode in SETTINGS else 'face'
    voice = pick(cfg, data.get('backupVoice'), mode, data.get('omniVoice'))
    return {'cfg': cfg, 'mode': mode, 'voice': voice}


def standing_problem():
    """The sticky failure still in force, for the panel to show; else None."""
    return (
        _down['error'].public()
        if _down['error'] and time.time() < _down['until']
        else None
    )


def reset():
    """Forget a standing problem: a key was just saved, or a preview just worked."""
    _down.update(until=0.0, error=None)
    _listing.update(at=0.0, key=None, voices=None)


def note_failure(error):
    if error.code in _STICKY:
        _down.update(until=time.time() + _STICKY_SECONDS, error=error)


def clean(text):
    """Markdown and markup are not speech; the model sometimes emphasises with them anyway."""
    return re.sub(r'\s+', ' ', _UNSPOKEN.sub('', str(text or ''))).strip()


class Chunker:
    """Cuts streamed text into speakable pieces at sentence ends. A boundary only counts once the
    whitespace after it has arrived, so "2.6 metres" and a trailing "..." are never split.
    """

    def __init__(self, minimum=MIN_SENTENCE):
        self.buffer, self.minimum = '', minimum

    def feed(self, delta):
        self.buffer += str(delta or '')
        ready = []
        while True:
            cut = next(
                (
                    m.end()
                    for m in _BOUNDARY.finditer(self.buffer)
                    if len(clean(self.buffer[: m.end()])) >= self.minimum
                ),
                None,
            )
            if cut is None:
                return ready
            piece, self.buffer = clean(self.buffer[:cut]), self.buffer[cut:]
            if piece:
                ready.append(piece)

    def flush(self):
        piece, self.buffer = clean(self.buffer), ''
        return piece


def stream_pcm(cfg, voice_id, text, mode='face', previous_text='', timeout=30):
    """Yield even-length PCM16 mono chunks at RATE for one piece of text."""
    model = cfg.get('model') or DEFAULT_MODEL
    body = {
        'text': text,
        'model_id': model,
        'voice_settings': SETTINGS.get(mode, SETTINGS['face']),
    }
    # Earlier sentences keep the delivery continuous across requests. v3 does not take them.
    if previous_text and not model.startswith('eleven_v3'):
        body['previous_text'] = previous_text[-300:]
    request = urllib.request.Request(
        '%s/v1/text-to-speech/%s/stream?output_format=pcm_%d'
        % (API.rstrip('/'), quote(voice_id, safe=''), RATE),
        data=json.dumps(body).encode(),
        headers={
            'xi-api-key': cfg['apiKey'],
            'Content-Type': 'application/json',
            'Accept': 'audio/pcm',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as upstream:
            carry = b''
            while True:
                piece = upstream.read(CHUNK_BYTES)
                if not piece:
                    break
                piece = carry + piece
                # A sample is two bytes; a read may end between them.
                carry = piece[-1:] if len(piece) % 2 else b''
                piece = piece[: len(piece) - len(carry)]
                if piece:
                    yield piece
    except urllib.error.HTTPError as e:
        raise _explain(e, cfg.get('apiKey'))
    except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
        raise VoiceError(
            'network', 'ElevenLabs could not be reached (%s).' % type(e).__name__
        )


class Speaker:
    """Speaks a reply while it is still being written. feed() takes text deltas; finished
    sentences go to a worker that streams each through ElevenLabs and hands the PCM to `emit`,
    in order. `emit` is called from that worker, so it must be safe to call off-thread.
    """

    def __init__(self, plan, emit):
        self.plan, self.emit = plan, emit
        self.chunker = Chunker()
        self.queue = queue.Queue()
        self.error = None
        self.spoken = ''
        self.bytes = 0
        self.characters = 0
        self.first_ms = None
        self.started = time.perf_counter()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def feed(self, delta):
        for sentence in self.chunker.feed(delta):
            self.queue.put(sentence)

    def close(self, timeout=45):
        """Speak what is left, wait for the audio to finish streaming, return the error if any."""
        rest = self.chunker.flush()
        if rest:
            self.queue.put(rest)
        self.queue.put(None)
        self.thread.join(timeout)
        if self.thread.is_alive():
            # Setting the error also stops the worker at its next chunk.
            self.error = VoiceError('timeout', 'ElevenLabs took too long to answer.')
        if self.error:
            note_failure(self.error)
        elif self.bytes:
            _down.update(until=0.0, error=None)
        return self.error

    def abandon(self):
        """The turn died (page gone, model failed): say nothing more and let the worker end."""
        if self.thread.is_alive():
            self.error = self.error or VoiceError('abandoned', 'The turn ended early.')
            self.queue.put(None)

    def stats(self):
        return {
            'voice': self.plan['voice']['name'],
            'model': self.plan['cfg'].get('model') or DEFAULT_MODEL,
            'firstAudioMs': self.first_ms,
            'audioMs': round(self.bytes / 2 / RATE * 1000),
            'characters': self.characters,
        }

    def _run(self):
        while True:
            sentence = self.queue.get()
            if sentence is None:
                return
            if self.error:
                continue  # drain: one failure silences the rest of this reply
            try:
                self.characters += len(sentence)
                for pcm in stream_pcm(
                    self.plan['cfg'],
                    self.plan['voice']['id'],
                    sentence,
                    self.plan['mode'],
                    self.spoken,
                ):
                    if self.error:
                        break
                    if self.first_ms is None:
                        self.first_ms = round(
                            (time.perf_counter() - self.started) * 1000
                        )
                    self.bytes += len(pcm)
                    self.emit(pcm)
                self.spoken += sentence + ' '
            except VoiceError as e:
                self.error = e
            except OSError:
                # `emit` writes to the page's socket; it went away mid-sentence.
                self.error = VoiceError('client', 'The page stopped listening.')


def account_voices(cfg, max_age=600, timeout=6):
    """Voice ids on this account, or None when the key may not list them (no `voices_read`) or
    the call fails. Cached, because the panel asks every time it opens."""
    if not configured(cfg):
        return None
    fresh = time.time() - _listing['at'] < max_age and _listing['key'] == cfg['apiKey']
    if fresh:
        return _listing['voices']
    voices = None
    try:
        request = urllib.request.Request(
            API.rstrip('/') + '/v1/voices',
            headers={'xi-api-key': cfg['apiKey'], 'Accept': 'application/json'},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            listed = json.loads(response.read(4_000_000)).get('voices') or []
        voices = [
            {
                'id': str(v.get('voice_id')),
                'name': str(v.get('name') or 'Voice')[:60],
                'category': str(v.get('category') or '')[:20],
            }
            for v in listed
            if isinstance(v, dict) and _VOICE_ID.fullmatch(str(v.get('voice_id') or ''))
        ]
    except (OSError, ValueError, AttributeError):
        voices = None
    _listing.update(at=time.time(), key=cfg['apiKey'], voices=voices)
    return voices


def options(cfg):
    """Everything the panel's voice picker needs. No secrets."""
    voices = catalogue(cfg)
    listed = account_voices(cfg)
    known = {v['id'] for v in listed} if listed is not None else None
    for v in voices:
        v['available'] = None if known is None else v['id'] in known
    cast = {v['id'] for v in voices}
    return {
        'configured': configured(cfg),
        'model': (cfg or {}).get('model') or DEFAULT_MODEL,
        'voices': voices,
        # Cloned or library voices already on the account are offered too, after the cast.
        'account': [
            v
            for v in (listed or [])
            if v['id'] not in cast and v['category'] != 'premade'
        ][:20],
        'defaults': DEFAULTS,
        'auto': AUTO,
        'matches': BACKUP_FOR,
        'problem': standing_problem(),
    }
