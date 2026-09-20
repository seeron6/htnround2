// The OMNI Live voice in the room. It sees (webcam keyframes), hears (your voice, hands-free), and
// speaks (streamed audio, with optional interruptions). Two modes, picked in the panel and sent with every turn:
// `face` — the head you are punching, talking back, which is the default; `coach` — a cornerman
// calling corrections. Only the system prompt and the labels change; the transport is identical.
//
// Who speaks: OMNI's own voice first, picked here from the ones the gateway accepts. ElevenLabs is
// the backup (no OMNI key, a refused voice, words without audio) and can be put in front on
// purpose. Both arrive as the same `audio` events, so the mouth and the echo gate do not care. Only
// when neither spoke does the browser's speechSynthesis read the line, so the face is never mute.
//
// What OMNI gets each turn (see omni_senses.py): the keyframes as one short *video*, the person's
// voice, or on a punch-triggered turn the last seconds of room sound, and the punch numbers. What
// comes back is speech plus, from a parallel function call, the expression the head should wear
// (`expression` event -> ./expression.js -> the same mouth channel the voice drives).
//
// Perception stays on this device at 30 Hz; only a spoken question, up to four small keyframes and a
// few numbers leave it, once per turn, and only while the panel is switched on. The key never reaches
// this page: the loopback relay holds it.
import {
  downsample,
  encodeWav,
  bytesToBase64,
  base64ToBytes,
  pcm16ToFloat32,
  rms,
  VoiceGate,
} from './audio.js';
import { EventStream } from './sse.js';
import { obs } from './sentry.js';
import { createMouthSignal, createSyntheticSignal } from '../omni/mouth-signal.js';
import { createExpressionSignal, blendMouth, EXPRESSION_ICONS } from './expression.js';
import { createGrunts, gruntLevel } from './grunts.js';
import { createInstantExpression, verdict } from './instant-expression.js';
import { createDialogueMemory } from './dialogue-memory.js';

const TAP =
  "class Tap extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('punching-face-tap',Tap)";
const FRAME_MS = 20,
  PREROLL_FRAMES = 15,
  KEYFRAME_MS = 500,
  KEYFRAMES = 6,
  ROOM_SECONDS = 2.5,
  GRUNT_GAP_MS = 350,
  QUIET_AFTER_TURN_MS = 7000,
  ECHO_TAIL_MS = 450,
  PUNCHES_PER_CUE = 8;
const MODE_KEY = 'punching-face-sponsors-mode';
const INTERACTION_KEY = 'punching-face-sponsors-voice-interaction';
// Voice picks are kept per mode: choosing a coach must not change what the face sounds like.
const OMNI_VOICE_KEY = 'punching-face-sponsors-omni-voice-',
  BACKUP_VOICE_KEY = 'punching-face-sponsors-backup-voice-',
  PREFER_BACKUP_KEY = 'punching-face-sponsors-prefer-backup';
const MODES = {
  face: {
    label: 'Face',
    tab: 'The Face',
    start: 'Wake the face',
    stop: 'Shut it up',
    speaker: 'Face: ',
    ask: 'Say something',
    see: 'Let it see me',
    talk: 'React to punches',
    idle: 'Listening.',
    off: 'The face is off.',
  },
  coach: {
    label: 'Coach',
    tab: 'Cornerman',
    start: 'Start coach',
    stop: 'Stop coach',
    speaker: 'Coach: ',
    ask: 'Ask a question',
    see: 'Let the coach see me',
    talk: 'React to combos',
    idle: 'Listening.',
    off: 'Coach is off.',
  },
};

export function createCornerman({ api, panel, config, stats, refreshConfig, onMode }) {
  panel.innerHTML = `
    <div class="sd-row" style="margin-top:0"><select data-k="mode" aria-label="Who is talking"><option value="face">Trash talk — the face</option><option value="coach">Coach — a cornerman</option></select></div>
    <div class="sd-row"><button class="primary" data-k="toggle" style="flex:1">Wake the face</button><span class="sd-badge" data-k="model"></span><span class="sd-badge" data-k="mood" title="Set by the OMNI model through a set_expression tool call" hidden></span></div>
    <div class="sd-meter" data-k="meter"><i></i></div>
    <div class="sd-status" data-k="status">Ready.</div>
    <div class="sd-log" data-k="log" aria-live="polite"></div>
    <div class="sd-row"><input type="text" data-k="ask" maxlength="300"><button data-k="send">Ask</button></div>
    <label class="sd-check"><input type="checkbox" data-k="vision" checked><span data-k="seelabel">Let it see me </span><span class="sd-badge leaving" data-k="leaving"></span></label>
    <label class="sd-check"><input type="checkbox" data-k="hearroom" checked><span>Let it hear the room when I punch</span></label>
    <label class="sd-check"><input type="checkbox" data-k="grunt" checked><span>Grunt the instant it is hit <span class="sd-badge" title="Recorded once in its own OMNI voice, played from memory: no network in the way">cached · &lt;50 ms</span></span></label>
    <label class="sd-check"><input type="checkbox" data-k="instant" checked><span>React on its face the instant it is hit <span class="sd-badge" title="Chosen on this device from the measured punch, the moment it lands. OMNI's set_expression call confirms or corrects it a second or two later. Untick to wait for OMNI, as before.">on device · OMNI corrects</span></span></label>
    <label class="sd-check"><input type="checkbox" data-k="voice" checked><span>Spoken replies</span></label>
    <div data-k="voicebox" hidden>
    <label class="sd-status" for="cornerman-omnivoice">Voice · OMNI</label>
    <div class="sd-row"><select id="cornerman-omnivoice" data-k="omnivoice"></select><button data-k="hearomni">Hear it</button></div>
    <label class="sd-status" for="cornerman-backupvoice">Backup voice · ElevenLabs</label>
    <div class="sd-row"><select id="cornerman-backupvoice" data-k="backupvoice"></select><button data-k="hearbackup">Hear it</button></div>
    <label class="sd-check"><input type="checkbox" data-k="preferbackup"><span>Use the ElevenLabs voice instead of OMNI's</span></label>
    <div class="sd-status" data-k="voicenote"></div>
    </div>
    <label class="sd-status" for="cornerman-interaction">Voice interaction</label>
    <div class="sd-row"><select id="cornerman-interaction" data-k="interaction"><option value="ambient">Ambient · finish replies</option><option value="interrupt">Interrupt · talk over replies</option></select></div>
    <label class="sd-check"><input type="checkbox" data-k="proactive" checked><span data-k="talklabel"></span></label>
    <details><summary>OMNI key</summary>
      <div class="sd-status">Stored only on this computer (<code>.local/secrets/omni.json</code>, mode 0600). Get one from the Huawei form; the gateway is <span data-k="gateway"></span>.</div>
      <div class="sd-row"><input type="password" data-k="key" placeholder="API key" autocomplete="off"><button data-k="save">Save</button></div>
    </details>
    <details><summary>ElevenLabs key (backup voice)</summary>
      <div class="sd-status">Stored only on this computer (<code>.local/secrets/elevenlabs.json</code>, mode 0600). The key needs the <b>Text to Speech</b> permission; <b>Voices: Read</b> lets this panel check which voices the account has.</div>
      <div class="sd-row"><input type="password" data-k="elevenkey" placeholder="ElevenLabs API key" autocomplete="off"><button data-k="elevensave">Save</button></div>
    </details>`;
  const el = Object.fromEntries(
    [...panel.querySelectorAll('[data-k]')].map((n) => [n.dataset.k, n]),
  );
  let ctx = null,
    mic = null,
    node = null,
    out = null,
    streamOut = null,
    gate = null,
    mouth = null,
    synthetic = null,
    enabled = false,
    starting = false,
    session = 0,
    busy = false,
    controller = null,
    nextTime = 0,
    lastTurnAt = -Infinity,
    ambientReadyAt = 0,
    ignoringAudio = false,
    sinceTurn = 0,
    keyTimer = null,
    voices = null,
    hearing = false,
    expression = null,
    moodTimer = null,
    gruntUntil = 0,
    lastGruntAt = -Infinity;
  const dialogue = createDialogueMemory();
  const grunts = createGrunts(),
    instant = createInstantExpression();
  // What the device chose for the punch OMNI is now being asked about, until OMNI answers.
  let guess = null;
  let room = [],
    roomSamples = 0;
  let pending = new Float32Array(0),
    preroll = [],
    recording = null,
    frames = [],
    // Whether #webcam is actually handing over pixels. The badge reports this rather than the
    // checkbox: a ticked box over a camera nobody connected used to advertise a clip that never left.
    seeing = false,
    dialogueTurn = 0;
  const playing = new Set(),
    spokenReplies = new Set(),
    grab = document.createElement('canvas');
  let mode = (() => {
    try {
      return MODES[localStorage.getItem(MODE_KEY)]
        ? localStorage.getItem(MODE_KEY)
        : 'face';
    } catch {
      return 'face';
    }
  })();
  let interaction = (() => {
    try {
      return localStorage.getItem(INTERACTION_KEY) === 'interrupt'
        ? 'interrupt'
        : 'ambient';
    } catch {
      return 'ambient';
    }
  })();
  const voice = () => MODES[mode];
  const speaking = () => playing.size > 0 || spokenReplies.size > 0;
  el.mode.value = mode;
  el.interaction.value = interaction;

  const status = (text, error = false) => {
    el.status.textContent = text;
    el.status.classList.toggle('error', error);
  };
  const say = (who, text) => {
    const p = document.createElement('p');
    p.className = who;
    p.textContent = (who === 'you' ? 'You: ' : voice().speaker) + text;
    el.log.append(p);
    el.log.scrollTop = el.log.scrollHeight;
    return p;
  };
  function paint() {
    const omni = config().omni;
    el.model.textContent = omni.configured ? omni.model : 'MOCK · no key';
    el.model.classList.toggle('mock', !omni.configured);
    el.gateway.textContent = omni.gateway;
    el.leaving.textContent = !enabled
      ? ''
      : (el.vision.checked && !seeing
          ? 'webcam not connected · it cannot see you — '
          : '') +
        [
          el.vision.checked && seeing ? `${KEYFRAMES}-frame clip` : null,
          'your voice',
          el.hearroom.checked ? `${ROOM_SECONDS} s of room sound on a punch` : null,
          'punch numbers',
        ]
          .filter(Boolean)
          .join(' + ') +
        ` → ${omni.gateway}`;
    el.toggle.textContent = enabled ? voice().stop : voice().start;
    el.toggle.classList.toggle('danger', enabled);
    el.toggle.classList.toggle('primary', !enabled);
    el.ask.placeholder = voice().ask;
    el.seelabel.textContent = voice().see + ' ';
    el.talklabel.textContent = voice().talk;
    el.mode.value = mode;
    onMode?.(voice().tab);
  }

  const recall = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const keep = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
  };
  const option = (value, text, title = '') => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    o.title = title;
    return o;
  };
  const group = (label, options) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...options);
    return g;
  };
  const choose = (select, wanted, fallback) => {
    select.value = [...select.options].some((o) => o.value === wanted)
      ? wanted
      : fallback;
  };

  // Says, under the pickers, who will actually be heard and why.
  function describeVoice() {
    if (!voices) return;
    const { omni, backup } = voices;
    const picked = omni.voices.find((v) => v.id === el.omnivoice.value);
    const front = el.preferbackup.checked && backup.configured && !backup.problem;
    let note = front
      ? 'ElevenLabs is speaking; OMNI only writes the lines.'
      : omni.configured
        ? picked?.note || `OMNI voice ${el.omnivoice.value}.`
        : backup.configured && !backup.problem
          ? 'No OMNI key, so the stand-in is talking, in the ElevenLabs voice.'
          : 'No OMNI key, so the stand-in is talking, read aloud by the browser.';
    if (backup.problem) note += ' Backup unavailable: ' + backup.problem.message;
    else if (!backup.configured)
      note +=
        ' No ElevenLabs key saved: if the OMNI voice fails, the browser reads the line.';
    el.voicenote.textContent = note;
    el.voicenote.classList.toggle('error', !!backup.problem);
  }

  // Both casts come from the relay: it knows which voices the gateway accepts and what the
  // ElevenLabs account holds. Picks are per mode, so the lists are refilled when the mode changes.
  function fillVoices() {
    if (!voices) return;
    const { omni, backup } = voices;
    const fits = (v) => v.modes.includes(mode);
    el.omnivoice.replaceChildren(
      group(
        'The cast',
        omni.voices
          .filter(fits)
          .map((v) => option(v.id, `${v.name} · ${v.id}`, v.note)),
      ),
      group(
        'Also accepted',
        [...omni.voices.filter((v) => !fits(v)).map((v) => v.id), ...omni.also].map(
          (id) => option(id, id),
        ),
      ),
    );
    choose(el.omnivoice, recall(OMNI_VOICE_KEY + mode), omni.default);
    const cast = (v) =>
      option(
        v.id,
        `${v.name} · ${v.actor}` +
          (v.available === false ? ' (not on this account)' : ''),
        v.note,
      );
    el.backupvoice.replaceChildren(
      option(backup.auto, 'Match the OMNI voice'),
      group('The cast', backup.voices.filter(fits).map(cast)),
      group('Other roles', backup.voices.filter((v) => !fits(v)).map(cast)),
      ...(backup.account.length
        ? [
            group(
              'On this account',
              backup.account.map((v) => option(v.id, `${v.name} · ${v.category}`)),
            ),
          ]
        : []),
    );
    choose(el.backupvoice, recall(BACKUP_VOICE_KEY + mode), backup.auto);
    el.preferbackup.checked = recall(PREFER_BACKUP_KEY) === '1' && backup.configured;
    el.omnivoice.disabled = el.hearomni.disabled = !omni.configured;
    el.backupvoice.disabled =
      el.hearbackup.disabled =
      el.preferbackup.disabled =
        !backup.configured;
    el.voicebox.hidden = false;
    describeVoice();
  }

  async function loadVoices() {
    try {
      const response = await fetch(api + '/sponsors/voice/options');
      if (!response.ok) throw new Error('voice options ' + response.status);
      voices = await response.json();
      fillVoices();
    } catch {
      // A relay from before the pickers: leave them hidden rather than offer dead controls.
      voices = null;
      el.voicebox.hidden = true;
    }
  }

  // One sample line in the chosen voice. With the face awake it goes through the same bus as a
  // reply, so the mouth moves; asleep, a context borrowed for the length of the line.
  async function hear(engine) {
    if (hearing || busy || speaking()) return;
    hearing = true;
    const own = ctx ? null : new AudioContext();
    let at = 0,
      heard = false,
      who = '',
      trouble = null;
    try {
      await (ctx || own).resume();
      status('Asking for a sample…');
      const response = await fetch(api + '/sponsors/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine,
          mode,
          omniVoice: el.omnivoice.value,
          backupVoice: el.backupvoice.value,
        }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({}))).error ||
            'The relay refused the request. Restart it: npm run sponsors',
        );
      const reader = response.body.getReader(),
        decoder = new TextDecoder(),
        stream = new EventStream();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const { event, data } of stream.feed(
          decoder.decode(value, { stream: true }),
        )) {
          if (event === 'meta') who = data.voiceName || '';
          else if (event === 'voice' && data.error) trouble = data.error.message;
          else if (event === 'error') trouble = data.message;
          else if (event === 'audio') {
            heard = true;
            const samples = pcm16ToFloat32(base64ToBytes(data.pcm16)),
              rate = data.rate || 24000;
            if (ctx) play(samples, rate);
            else {
              const buffer = own.createBuffer(1, samples.length, rate);
              buffer.copyToChannel(samples, 0);
              const source = own.createBufferSource();
              source.buffer = buffer;
              source.connect(own.destination);
              at = Math.max(own.currentTime + 0.04, at);
              source.start(at);
              at += buffer.duration;
            }
          }
        }
      }
      if (trouble) status(trouble, true);
      else status(heard ? `That was ${who}.` : 'No audio came back.', !heard);
      // A sample that worked, or a failure just learned, changes what the pickers should say.
      if (engine === 'elevenlabs') loadVoices();
    } catch (error) {
      status(error.message, true);
    } finally {
      hearing = false;
      if (own)
        setTimeout(() => own.close(), Math.max(0, at - own.currentTime) * 1000 + 300);
    }
  }

  function stopSpeaking() {
    for (const source of playing) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    playing.clear();
    spokenReplies.clear();
    nextTime = 0;
    window.speechSynthesis?.cancel();
    synthetic?.stop();
    if (gate) gate.ratio = 3.2;
  }
  function play(samples, rate) {
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    const at = Math.max(ctx.currentTime + 0.04, nextTime);
    source.start(at);
    nextTime = at + buffer.duration;
    playing.add(source);
    // Interrupt mode keeps a stiffer gate against speaker echo. Ambient mode ignores
    // the microphone throughout playback and its cooldown instead.
    gate.ratio = 8;
    source.onended = () => {
      playing.delete(source);
      if (!speaking()) {
        if (gate) gate.ratio = 3.2;
        ambientReadyAt = performance.now() + ECHO_TAIL_MS;
      }
    };
  }

  function keyframe() {
    if (!enabled) return;
    const video = document.getElementById('webcam'),
      ready = !!video?.videoWidth && video.readyState >= 2;
    if (ready !== seeing) {
      seeing = ready;
      paint();
    }
    if (!ready) frames = [];
    if (!el.vision.checked || !ready) return;
    grab.width = 320;
    grab.height = Math.round((320 * video.videoHeight) / video.videoWidth);
    grab.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height);
    frames.push(grab.toDataURL('image/jpeg', 0.6).split(',')[1]);
    if (frames.length > KEYFRAMES) frames.shift();
  }

  async function turn({ audio = null, text = null, trigger = null }) {
    if (busy) return;
    busy = true;
    controller = new AbortController();
    const signal = controller.signal;
    sinceTurn = 0;
    lastTurnAt = performance.now();
    const sent = el.vision.checked ? frames.slice() : [];
    const body = {
      mode,
      frames: sent,
      telemetry: stats.snapshot(performance.now(), trigger),
      history: dialogue.history(), // six exchanges, including OMNI's understood speech and actions
      remember: true,
      dialogueTurn: dialogueTurn++,
      voice: el.voice.checked,
      ...(voices && {
        omniVoice: el.omnivoice.value,
        backupVoice: el.backupvoice.value,
        voiceEngine: el.preferbackup.checked ? 'elevenlabs' : 'omni',
      }),
    };
    if (audio)
      body.audioWav = bytesToBase64(
        encodeWav(downsample(audio, ctx.sampleRate, 16000), 16000),
      );
    else if (text) body.text = text;
    else {
      // A punch set this off; the room may still contain a question or a reply to the face.
      const heard = roomSound();
      if (heard)
        body.roomWav = bytesToBase64(
          encodeWav(downsample(heard, ctx.sampleRate, 16000), 16000),
        );
    }
    const userLine = text
      ? say('you', text)
      : audio
        ? say('you', '(listening to speech)')
        : null;
    const line = say('coach', '…');
    let perception = null;
    let said = '',
      mock = false,
      started = performance.now(),
      firstAt = null,
      firstAudioAt = null,
      voiceEngine = 'unknown',
      served = null,
      skippedRepeat = false,
      heard = false,
      speaker = null,
      trouble = null;
    try {
      // A trace of its own per turn: this span -> the relay -> the agent run (reply, expression
      // tool call, voice). `within` makes the request its child without leaving the span active
      // while the reply streams, or the 30 Hz physics calls would all be adopted by it.
      await obs.flow(
        'coach.turn',
        {
          'coach.mode': mode,
          'coach.trigger': trigger || (audio ? 'voice' : 'text'),
          'coach.frames': sent.length,
          'coach.audio_ms': audio
            ? Math.round((audio.length / ctx.sampleRate) * 1000)
            : 0,
        },
        async (span, within) => {
          const response = await within(() =>
            fetch(api + '/sponsors/coach/turn', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal,
            }),
          );
          if (!response.ok)
            throw new Error(
              (await response.json().catch(() => ({}))).error ||
                'The relay refused the request.',
            );
          const reader = response.body.getReader(),
            decoder = new TextDecoder(),
            stream = new EventStream();
          for (;;) {
            const { value, done } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            for (const { event, data } of stream.feed(
              decoder.decode(value, { stream: true }),
            )) {
              if (event === 'meta') {
                mock = data.mock;
                span.setAttribute('coach.model', data.model);
                span.setAttribute('coach.mock', !!data.mock);
                // A relay that does not echo the mode back predates the selector, so it is still
                // serving its old system prompt no matter what this page sends.
                served = data.mode ?? null;
                span.setAttribute('coach.mode_served', served || 'unknown');
                if (data.voiceEngine === 'omni' || data.voiceEngine === 'elevenlabs')
                  speaker =
                    (data.voiceEngine === 'omni' ? 'OMNI ' : 'ElevenLabs ') +
                    (data.voiceName || '');
                trouble = data.voiceProblem?.message || null;
                voiceEngine = data.voiceEngine || 'unknown';
                span.setAttribute('coach.voice_engine', voiceEngine);
              } else if (event === 'expression') {
                wear(data.emotion, data.intensity);
                span.setAttribute('coach.expression', data.emotion);
                span.setAttribute('coach.expression_ms', data.ms);
              } else if (event === 'perception') {
                // These are private observations for this session, never Sentry attributes.
                perception = {
                  heard: audio || el.hearroom.checked ? data.heard : '',
                  seen: el.vision.checked ? data.seen : '',
                };
                if (userLine && !text && perception.heard)
                  userLine.textContent = `You (OMNI heard): ${perception.heard}`;
              } else if (event === 'voice') {
                // The backup stepped in for OMNI, or the backup itself failed.
                if (data.error) trouble = data.error.message;
                else if (data.fallback) {
                  speaker =
                    data.engine === 'elevenlabs'
                      ? `ElevenLabs ${data.voiceName || ''} (backup: ${data.reason})`
                      : null;
                  span.setAttribute('coach.voice_fallback', data.engine);
                }
              } else if (event === 'text') {
                firstAt ??= performance.now();
                said += data.delta;
                line.textContent = voice().speaker + said;
                el.log.scrollTop = el.log.scrollHeight;
              } else if (event === 'audio') {
                firstAt ??= performance.now();
                firstAudioAt ??= performance.now();
                if (el.voice.checked && ctx) {
                  heard = true;
                  play(pcm16ToFloat32(base64ToBytes(data.pcm16)), data.rate || 24000);
                }
              } else if (event === 'done') {
                skippedRepeat = !!data.skippedRepeat;
                span.setAttribute('coach.skipped_repeat', skippedRepeat);
              } else if (event === 'error')
                throw new Error(
                  data.message +
                    (data.detail ? ' ' + String(data.detail).slice(0, 160) : ''),
                );
            }
          }
          span.setAttribute(
            'coach.first_response_ms',
            Math.round((firstAt ?? performance.now()) - started),
          );
          // As the person at the table hears it: network, relay and gateway included. The relay
          // records the model's own share of this as coach.first_token.
          const about = { mode, engine: voiceEngine, mock, punch: !audio && !text };
          if (firstAt)
            obs.metric('face.first_response', firstAt - started, 'millisecond', about);
          if (firstAudioAt) {
            span.setAttribute(
              'coach.first_audio_ms',
              Math.round(firstAudioAt - started),
            );
            obs.metric(
              'face.first_audio',
              firstAudioAt - started,
              'millisecond',
              about,
            );
          }
        },
      );
      signal.throwIfAborted();
      if (!said && skippedRepeat) line.remove();
      else if (!said)
        line.textContent =
          voice().speaker + (mode === 'coach' ? '(no reply)' : '(nothing)');
      // Nobody spoke: the stand-in without a backup key, or OMNI and ElevenLabs both failing. The
      // browser reads the line aloud so the face is never mute. The status line says so.
      if (!heard && said && el.voice.checked && 'speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(said);
        spokenReplies.add(utterance);
        if (gate) gate.ratio = 8;
        // speechSynthesis cannot be routed into WebAudio, so the analyser hears nothing.
        // Drive the stand-in envelope off the utterance instead, as long as it speaks.
        utterance.onstart = () => {
          if (spokenReplies.has(utterance))
            synthetic?.speakFor(Math.max(1.2, said.split(/\s+/).length / 2.6));
        };
        utterance.onend = utterance.onerror = () => {
          if (!spokenReplies.delete(utterance)) return;
          synthetic?.stop();
          if (!speaking()) {
            if (gate) gate.ratio = 3.2;
            ambientReadyAt = performance.now() + ECHO_TAIL_MS;
          }
        };
        try {
          speechSynthesis.speak(utterance);
        } catch (error) {
          spokenReplies.delete(utterance);
          throw error;
        }
      }
      dialogue.remember({
        text,
        perception: {
          heard: audio || el.hearroom.checked ? perception?.heard : '',
          seen: el.vision.checked ? perception?.seen : '',
        },
        telemetry: trigger ? body.telemetry : null,
        hasAudio: !!audio,
        hasRoom: !!body.roomWav,
        reply: said,
      });
      if (served !== null && served !== mode)
        status(
          `The relay answered as "${served}", not "${mode}". Restart it: npm run sponsors`,
          true,
        );
      else if (served === null)
        status(
          'The relay is running older code and ignored the mode. Restart it: npm run sponsors',
          true,
        );
      else
        status(
          (mock ? 'Mock reply (add an OMNI key for the real model). ' : '') +
            (skippedRepeat
              ? 'Listening.'
              : firstAt
                ? `First response in ${Math.round(firstAt - started)} ms.`
                : '') +
            (el.voice.checked && said
              ? ` Voice: ${heard && speaker ? speaker.trim() : 'the browser'}.` +
                (trouble && !heard ? ' ' + trouble : '')
              : ''),
          !!trouble && !heard,
        );
    } catch (error) {
      if (error.name === 'AbortError') {
        line.textContent = voice().speaker + (said || '…') + ' (interrupted)';
      } else {
        line.remove();
        status(error.message, true);
        obs.error(error, { feature: 'coach' });
      }
    } finally {
      busy = false;
      controller = null;
      ambientReadyAt = performance.now() + ECHO_TAIL_MS;
    }
  }

  function resetListening() {
    pending = new Float32Array(0);
    preroll = [];
    recording = null;
    if (gate) {
      // Preserve the learned room noise, but never keep a partial utterance across modes.
      gate.speaking = false;
      gate.loudMs = gate.quietMs = gate.spokenMs = 0;
      gate.levels = [];
      gate.ratio = speaking() ? 8 : 3.2;
    }
    el.meter.classList.remove('open');
    el.meter.firstElementChild.style.width = '0';
  }

  // The last ROOM_SECONDS of the mic, kept only while the face is silent so it never hears itself.
  function roomSound() {
    if (!el.hearroom.checked || !ctx || roomSamples < ctx.sampleRate) return null;
    const heard = new Float32Array(roomSamples);
    let offset = 0;
    for (const chunk of room) {
      heard.set(chunk, offset);
      offset += chunk.length;
    }
    return heard;
  }

  // One door for both: `local` is the device's own choice as a punch lands (react() below);
  // without it this is OMNI's set_expression call, which has the last word. The chip says which.
  function wear(emotion, intensity, local = null) {
    if (!expression?.set(emotion, intensity, { restart: !!local?.restart })) return;
    // A guess only counts against the answer to the same punch, not one from a turn ago.
    const about = !local && guess && performance.now() - guess.at < 8000 ? guess : null,
      who = local ? 'instant' : verdict(about, emotion);
    el.mood.textContent = `${EXPRESSION_ICONS[emotion] || ''} ${emotion} · ${who}`;
    el.mood.title = local
      ? `Chosen on this device the moment the punch landed (${local.why}). OMNI's set_expression call confirms or corrects it.`
      : 'Set by the OMNI model through a set_expression tool call' +
        (about
          ? `. The device had chosen ${about.emotion} when the punch landed.`
          : '');
    el.mood.hidden = false;
    clearTimeout(moodTimer);
    moodTimer = setTimeout(() => (el.mood.hidden = true), 7000);
    if (about) {
      // How often the device and the model agree, and how long the face used to wait for this.
      const agreed = about.emotion === emotion;
      obs.count('face.expression.verdict', {
        local: about.emotion,
        omni: emotion,
        agreed,
      });
      obs.metric(
        'face.expression.omni_delay',
        performance.now() - about.at,
        'millisecond',
        { agreed },
      );
    }
    if (!local) guess = null;
  }

  // The face reacts the instant it is hit, from what this device measured, as the grunt does for
  // the voice (instant-expression.js). Returns what it chose, or null if it left the face alone.
  function react(triggers, now) {
    if (!enabled || mode !== 'face' || !el.instant.checked || !expression) return null;
    const choice = instant.react(stats.snapshot(now), triggers, expression.showing);
    if (!choice) return null;
    wear(choice.emotion, choice.intensity, choice);
    const landed = window.__lastContact?.time;
    if (Number.isFinite(landed))
      obs.metric(
        'face.expression.instant_latency',
        performance.now() - landed,
        'millisecond',
        { emotion: choice.emotion, why: choice.why },
      );
    return { ...choice, at: now };
  }

  function onAudio(chunk) {
    if (!enabled || !ctx || !gate) return;
    const now = performance.now();
    if (now < gruntUntil) return;
    if (busy || speaking() || now < ambientReadyAt) {
      room = [];
      roomSamples = 0;
    } else if (el.hearroom.checked) {
      room.push(chunk);
      roomSamples += chunk.length;
      while (roomSamples - room[0].length >= ctx.sampleRate * ROOM_SECONDS)
        roomSamples -= room.shift().length;
    }
    if (interaction === 'ambient' && (busy || speaking() || now < ambientReadyAt)) {
      if (!ignoringAudio) resetListening();
      ignoringAudio = true;
      // Drop speaker echo and room noise, without buffering it or allocating frames.
      if (busy || speaking()) ambientReadyAt = now + ECHO_TAIL_MS;
      return;
    }
    ignoringAudio = false;
    const joined = new Float32Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    const size = Math.round((ctx.sampleRate * FRAME_MS) / 1000);
    while (pending.length >= size) {
      const frame = pending.slice(0, size);
      pending = pending.slice(size);
      const level = rms(frame),
        event = gate.push(level, FRAME_MS);
      el.meter.firstElementChild.style.width = Math.min(100, level * 600) + '%';
      el.meter.classList.toggle('open', gate.speaking);
      if (recording) recording.push(frame);
      else {
        preroll.push(frame);
        if (preroll.length > PREROLL_FRAMES) preroll.shift();
      }
      if (event === 'start') {
        if (interaction === 'interrupt' && (speaking() || busy)) {
          stopSpeaking();
          controller?.abort();
        }
        recording = preroll.slice();
        preroll = [];
        status('Listening…');
      } else if (event === 'end' || event === 'discard') {
        const spoken = recording;
        recording = null;
        if (event === 'discard' || !spoken) continue;
        const audio = new Float32Array(spoken.reduce((n, f) => n + f.length, 0));
        let offset = 0;
        for (const f of spoken) {
          audio.set(f, offset);
          offset += f.length;
        }
        status('Thinking…');
        turn({ audio });
        if (interaction === 'ambient') {
          resetListening();
          return;
        }
      }
    }
  }

  async function start() {
    if (enabled || starting) {
      if (ctx?.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (error) {
          status(error.message, true);
        }
      }
      return;
    }
    const currentSession = ++session;
    starting = true;
    try {
      ctx = new AudioContext();
      const audioContext = ctx;
      status('Starting audio… If it stays paused, tap ' + voice().start + '.');
      await audioContext.resume();
      if (currentSession !== session) return;
      out = ctx.createGain();
      out.connect(ctx.destination);
      streamOut = ctx.createMediaStreamDestination();
      out.connect(streamOut);
      // The head's mouth follows whatever is coming out of this bus. An analyser is a
      // leaf tap, so neither the speakers nor the LiveKit guest stream are affected.
      mouth = createMouthSignal(ctx, out);
      synthetic = createSyntheticSignal();
      expression = createExpressionSignal();
      window.__faceSpeech = {
        read: (dt) => {
          const a = mouth.read(dt),
            b = synthetic.read(dt);
          // Speech owns the jaw; the expression OMNI chose fills whatever the voice is not using.
          return blendMouth(a.open >= b.open ? a : b, expression.read());
        },
      };
      gate = new VoiceGate();
      ambientReadyAt = 0;
      ignoringAudio = false;
      enabled = true;
      keyTimer = setInterval(keyframe, KEYFRAME_MS);
      paint();
      try {
        const microphone = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (currentSession !== session) {
          microphone.getTracks().forEach((track) => track.stop());
          return;
        }
        mic = microphone;
        const workletUrl = URL.createObjectURL(
          new Blob([TAP], { type: 'application/javascript' }),
        );
        try {
          await audioContext.audioWorklet.addModule(workletUrl);
        } finally {
          URL.revokeObjectURL(workletUrl);
        }
        if (currentSession !== session) return;
        node = new AudioWorkletNode(audioContext, 'punching-face-tap');
        node.port.onmessage = (e) => onAudio(e.data);
        ctx.createMediaStreamSource(mic).connect(node);
        status('Learning the room noise… then just talk.');
        setTimeout(
          () => currentSession === session && enabled && !busy && status(voice().idle),
          900,
        );
      } catch (error) {
        if (currentSession !== session) return;
        status('No microphone (' + error.name + '). Typed questions still work.', true);
        obs.warn('coach.mic_unavailable', { reason: error.name });
      }
      grunts.load(audioContext, el.omnivoice.value);
      obs.crumb('coach', 'started', {
        vision: el.vision.checked,
        voice: el.voice.checked,
      });
      window.dispatchEvent(
        new CustomEvent('cornerman:audio', { detail: streamOut.stream }),
      );
    } catch (error) {
      if (currentSession !== session) return;
      stop();
      status(error.message, true);
      obs.error(error, { feature: 'coach' });
    } finally {
      if (currentSession === session) starting = false;
    }
  }
  function stop() {
    session++;
    starting = false;
    enabled = false;
    clearInterval(keyTimer);
    controller?.abort();
    stopSpeaking();
    if (node) node.port.onmessage = null;
    node?.disconnect();
    mic?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    mouth?.dispose();
    synthetic?.dispose();
    mouth = synthetic = expression = null;
    room = [];
    roomSamples = 0;
    clearTimeout(moodTimer);
    el.mood.hidden = true;
    window.__faceSpeech = null;
    ctx = mic = node = out = streamOut = null;
    frames = [];
    dialogue.clear();
    dialogueTurn = 0;
    seeing = false;
    resetListening();
    ignoringAudio = false;
    el.meter.firstElementChild.style.width = '0';
    paint();
    status(voice().off);
  }

  el.toggle.onclick = () => (enabled ? stop() : start());
  el.vision.onchange = () => {
    if (!el.vision.checked) {
      frames = [];
      dialogue.forgetVision();
    }
    paint();
  };
  el.hearroom.onchange = () => {
    room = [];
    roomSamples = 0;
    if (!el.hearroom.checked) dialogue.forgetRoom();
    paint();
  };
  el.interaction.onchange = () => {
    interaction = el.interaction.value === 'interrupt' ? 'interrupt' : 'ambient';
    try {
      localStorage.setItem(INTERACTION_KEY, interaction);
    } catch {
      /* private mode */
    }
    resetListening();
    ignoringAudio = false;
    status(
      interaction === 'interrupt'
        ? 'Interruptions on.'
        : 'Ambient mode. Replies finish before listening.',
    );
  };
  // A new cast member must not inherit the previous speaker's wording or queued reply.
  function resetDialogue() {
    controller?.abort();
    stopSpeaking();
    resetListening();
    dialogue.clear();
    dialogueTurn = 0;
    el.log.replaceChildren();
  }

  function selectMode(nextMode) {
    if (mode === nextMode) return;
    mode = nextMode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode */
    }
    resetDialogue();
    paint();
    fillVoices();
    status(
      enabled
        ? `Switched to ${voice().label.toLowerCase()}. Carry on.`
        : `${voice().label} is off. Nothing is being sent.`,
    );
  }
  el.mode.onchange = () => selectMode(MODES[el.mode.value] ? el.mode.value : 'face');
  const ask = () => {
    const text = el.ask.value.trim();
    if (!text) return;
    el.ask.value = '';
    turn({ text });
  };
  el.send.onclick = ask;
  el.ask.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') ask();
  };
  el.ask.onkeyup = (e) => e.stopPropagation();
  el.key.onkeydown = (e) => e.stopPropagation();
  el.elevenkey.onkeydown = (e) => e.stopPropagation();
  el.elevenkey.onkeyup = (e) => e.stopPropagation();
  el.omnivoice.onchange = () => {
    keep(OMNI_VOICE_KEY + mode, el.omnivoice.value);
    resetDialogue();
    describeVoice();
    if (ctx) grunts.load(ctx, el.omnivoice.value);
  };
  el.backupvoice.onchange = () => {
    keep(BACKUP_VOICE_KEY + mode, el.backupvoice.value);
    describeVoice();
  };
  el.preferbackup.onchange = () => {
    keep(PREFER_BACKUP_KEY, el.preferbackup.checked ? '1' : '0');
    describeVoice();
  };
  el.hearomni.onclick = () => hear('omni');
  el.hearbackup.onclick = () => hear('elevenlabs');
  el.elevensave.onclick = async () => {
    const apiKey = el.elevenkey.value.trim();
    if (!apiKey) return;
    el.elevenkey.value = '';
    try {
      const r = await fetch(api + '/sponsors/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'elevenlabs', apiKey }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      await loadVoices();
      status('ElevenLabs key saved on this computer. Press Hear it to check it.');
    } catch (error) {
      status(error.message, true);
    }
  };
  el.save.onclick = async () => {
    const apiKey = el.key.value.trim();
    if (!apiKey) return;
    el.key.value = '';
    try {
      const r = await fetch(api + '/sponsors/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'omni', apiKey }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      await refreshConfig();
      paint();
      status('Key saved on this computer.');
    } catch (error) {
      status(error.message, true);
    }
  };
  paint();
  loadVoices();

  return {
    startFace() {
      selectMode('face');
      el.voice.checked = true;
      el.proactive.checked = true;
      paint();
      return start();
    },
    // Called for every landed punch, local or remote. The face answers back at natural beats,
    // never over a person who is speaking, and never back-to-back.
    onPunch(triggers) {
      sinceTurn++;
      const now = performance.now(),
        // First, so nothing is in its way: the look, on this device, as the punch lands.
        local = react(triggers, now),
        wasBusy = busy;
      if (
        enabled &&
        el.proactive.checked &&
        !busy &&
        !gate?.speaking &&
        !gate?.loudMs &&
        !recording &&
        !speaking() &&
        now >= ambientReadyAt &&
        now - lastTurnAt >= QUIET_AFTER_TURN_MS &&
        (triggers.length || sinceTurn >= PUNCHES_PER_CUE)
      )
        // First, because it samples the room sound as it starts, before the grunt is in the air.
        turn({
          trigger:
            triggers[0] || `${PUNCHES_PER_CUE} punches since it last said anything`,
        });
      // turn() takes `busy` before its first await: this punch is the one OMNI is being asked
      // about, so its guess is the one OMNI's answer will be held against.
      if (local && !wasBusy && busy) guess = local;
      // The instant answer, from memory, in its own OMNI voice. Never over its own sentence or a
      // person who is talking; while a reply is still on its way is exactly when it helps most.
      if (
        enabled &&
        mode === 'face' &&
        el.voice.checked &&
        el.grunt.checked &&
        !speaking() &&
        !gate?.speaking &&
        !gate?.loudMs &&
        !recording &&
        now - lastGruntAt >= GRUNT_GAP_MS
      ) {
        const level = gruntLevel(stats.snapshot(now), triggers),
          seconds = grunts.play(ctx, out, el.omnivoice.value, level);
        if (seconds) {
          // The badge says "cached, <50 ms". This is that number: the punch landing (main.js
          // stamps it) to the grunt being handed to the audio clock, plus the output latency.
          const landed = window.__lastContact?.time;
          if (Number.isFinite(landed))
            obs.metric(
              'face.grunt_latency',
              performance.now() -
                landed +
                (ctx.outputLatency || ctx.baseLatency || 0) * 1000,
              'millisecond',
              { level, voice: el.omnivoice.value },
            );
          lastGruntAt = now;
          gruntUntil = now + seconds * 1000 + 250;
          // The spoken line waits its turn: "Oof! ... that one actually rattled me."
          nextTime = Math.max(nextTime, ctx.currentTime + seconds + 0.05);
        }
      }
    },
    get outputStream() {
      return streamOut?.stream || null;
    },
    repaint: paint,
  };
}
