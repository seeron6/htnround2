# Punching Face × OMNI Live — for the judges

Everything marked **measured** was run on 2026-09-19 against the live `qwen3.5-omni-flash` model through yibuapi, on
the demo laptop. Re-run it yourself: `.venv/bin/python scripts/omni_preflight.py` (about 20 s, prints pass/fail).

## The scenario

**Most people who train, train alone.** A heavy bag or a shadow-boxing app gives you nothing back: nobody sees your
left hand drop, nobody hears you run out of breath, and nobody tells you to stop when you should. A coach does all
three at once, and costs more than the gym.

Punching Face turns the device you already own into a sparring partner. You scan a head (yours, or a friend who
agreed), it becomes a physically simulated 3D target, and you hit it with your bare hands in front of the webcam. The
head **sees** you, **hears** you, and **talks back**, in one of two characters that share the same loop:

- **The Face**: the target itself, a smug heel that trash-talks you into one more round. This is the hook.
- **The Coach**: a cornerman calling one correction at a time. This is the utility.

## Why this needs a model that sees, hears and speaks together

Your hands are fists, your eyes are on the target, and you are out of breath. **You cannot touch a screen, read text,
or type.** Voice and vision are not features here, they are the only interface left.

| What the moment needs | Why one modality cannot do it |
| --- | --- |
| "That left drops every single time" | The flaw is in your body, not in anything you could say: it takes **video**. |
| Knowing the punch was your hardest | A camera guesses; the device **measures** it (hand tracking + contact physics), and hands the number to the model. |
| Answering your "is that all you've got?" | **Speech in**, hands-free: a voice gate opens the turn, there is no button to press with gloves on. |
| Throwing a bystander's heckle back at you | **Audio understanding** of the room, not of a question. |
| Noticing you are gassed, or that you said stop | Tone of voice and breathing, plus what it sees: **audio + vision**, and it must win over the act. |
| Feedback where you are looking | **Speech out** and a **facial expression** on the thing you are punching. |

A chatbot cannot see the guard drop. A vision model cannot be talked to mid-round. A voice assistant does not know a
punch landed. The line *"you're out of breath already, and your grandma hits harder than that"* needed the punch
telemetry, the video, and a friend's voice in the room, in one turn.

## How OMNI is used (rubric: Use of OMNI Capabilities)

One turn, end to end: `src/sponsors/cornerman.js` → loopback relay `sponsor_server.py` (+ `omni_senses.py`) →
yibuapi → `qwen3.5-omni-flash` → streamed back as SSE.

| Capability | What we do with it | Evidence (**measured**) |
| --- | --- | --- |
| **Video understanding** | The last 3 s of webcam go up as one `video` (6-frame list), not loose images, so the model reasons over motion: the dropped hand, the telegraphed cross. | The gateway bills it as `video_tokens`: 6 frames = 242 tokens, against 328 for 4 separate images. On a synthetic clip it answered *"moving right and about to touch the gray oval"*. |
| **Speech understanding** | Hands-free: a noise-adaptive voice gate (`VoiceGate`, unit-tested for a loud hall) opens and closes the turn; the WAV goes to the model as `input_audio`, so it hears *how* something was said. | Spoken *"Hold on, stop. I feel really dizzy"* → it dropped the act (below). |
| **Audio understanding** | A punch-triggered turn carries the last 2.5 s of **room sound** instead of a question: breathing, grunts, the crowd. Recorded only while the face is silent, so it never hears itself. | A bystander shouted *"my grandmother hits harder than that"*; the face replied *"…and your grandma hits harder than that."* |
| **Multimodal reasoning** | Video + audio + on-device telemetry (who, which hand, which zone, how fast, their average and best) in a single request. The model never invents numbers, it is given them. | *"You telegraphed that left hook from three blocks away, and you missed the jaw by a mile."* |
| **Streaming** | Text and 24 kHz PCM stream back as they are generated and are scheduled gaplessly into Web Audio; the mouth is driven by analysing that audio (real lip-sync, no visemes to drift). | First sound of the reply, median of 3: **0.98 s** voice only, **1.14 s** with video, **1.31 s** with video and the expression call running beside it. |
| **Natural voice** | OMNI's own voice is the voice of the head. Ten stock voices are accepted by the gateway; six are cast as characters in the panel (The Showman, The Heavyweight, The Ice Queen…). | Each was auditioned saying the same line and measured for pitch and pace: `docs/FACE_VOICE.md`. |
| **Voice / tone adaptation** | The measured punch becomes a line of direction for the delivery: a weak shot is mocked slowly, a personal best leaves it shaken. Relative to *that person's* punches, so it works for anyone. | Same voice, same scene. Weak punch: **133 Hz**, 8.6 st pitch swing, RMS 1113. Hardest punch: **158 Hz**, 11.1 st, RMS 1542: higher, livelier, 39 % louder. Words change too: *"That was a slow-motion slap"* vs *"That one actually rattled me. I'm breathing hard…"* |
| **Expression (function calling)** | Beside every spoken turn a second, tiny request asks the model to call `set_expression(emotion, intensity)`; the 3D head wears it (smug, amused, stunned, winded, defiant, concerned). Tool calls and audio cannot share a response on this gateway, so they run in parallel. **The device does not wait for it:** the instant a punch lands it picks a look from the measured punch (`src/sponsors/instant-expression.js`), and OMNI's call confirms or corrects it. | Measured in the app: the look appears **~25 ms** after the punch; OMNI's call lands **1.0 to 2.7 s** later (Sentry traces of the first real turns; an earlier single measurement was 0.99 s) and the chip says `OMNI agrees` or `OMNI corrected it`. On the device: weak → `smug`; hardest → `stunned`; combo → `winded`. Only OMNI can give `amused` or `concerned` ("I feel dizzy"): they need eyes and ears, and no device guess may override `concerned`. |
| **Continuous / interruptible** | Multi-turn with history; the face speaks up unprompted at natural beats (a combo, a personal best, eight punches of silence) and never over a person. In *Interrupt* mode, talking over it cuts the audio and aborts the request. | Multi-turn with history verified in the app. Barge-in is implemented in `cornerman.js` but was **not** measured here (no microphone in the test browser): try it at the table before relying on it. |

## Interaction experience

- **Under 50 ms to the first sound.** The model is ~1.5 s away (Sentry, first real turns), so the face's grunts were recorded *once, in its own
  OMNI voice* (`scripts/build_omni_reactions.py`, 46 clips, three intensities per voice) and are played from memory
  through the same audio bus. **Measured in the app: the mouth opens 50 ms after the punch lands.** The spoken line is
  queued behind it: *"Oof! … that one actually rattled me."*
- The physical reaction (soft-tissue deformation, the pain pose) is local and immediate. OMNI is never in that path.
- The status line says who spoke and how fast; the panel shows the expression the model chose as it arrives.

## Safety and privacy (rubric: additional consideration)

- **Safety beats the act.** *"Hold on, stop. I feel really dizzy"* (spoken) → *"Whoa, easy there. Stop right now. Sit
  down and breathe. Are you okay? Just get some water…"*, expression `concerned`, no taunt (**measured**, twice). The
  persona also refuses anything that turns toward hitting a real person, and only ever mocks the punching: never
  someone's body, face, age, accent or gender.
- **What leaves the device is on screen.** The panel states it live: *"6-frame clip + your voice + 2.5 s of room
  sound on a punch + punch numbers → yibuapi.com"*. Untick *Let it see me* or *Let it hear the room* and it changes.
  The camera and microphone are only sampled while the face is awake.
- **Perception stays on the edge.** Hand tracking, contact physics, the voice gate and the punch statistics run on
  the laptop at 30 Hz. The cloud gets a 320-px clip and a few numbers, once per turn.
- **Keys never reach the browser.** A loopback-only relay holds them (`.local/secrets`, mode 0600), checks `Origin`
  and `Host`, and is covered by tests for cross-origin and DNS-rebinding requests.
- **It degrades, it does not die.** OMNI voice → ElevenLabs backup → the browser's voice; a refused voice or a
  gateway error inside a 200 stream is detected and the turn is retried for its words alone.

## Architecture

```
 EDGE (the laptop)                                   LOOPBACK RELAY               CLOUD
 webcam ─► hand tracking ─► contact physics ─┐
            (on-device, 30 Hz)               ├─ punch telemetry ─┐
 webcam ─► 6 keyframes / 3 s ────────────────┼─ video ───────────┤
 mic ────► voice gate (VAD) ─► your voice ───┼─ input_audio ─────┼─► sponsor_server.py ─► yibuapi
 mic ────► 2.5 s room ring ─► room sound ────┘                   │    omni_senses.py      qwen3.5-omni-flash
                                                                 │         │
 punch ──► cached OMNI-voice grunt (<50 ms) ─┐                   │   ┌─────┴───────────────┐
 mouth ◄── audio analyser ◄── Web Audio bus ◄┴── audio (PCM) ◄───┼───┤ spoken turn (SSE)   │
 face  ◄── expression renderer ◄──────────────── expression ◄────┴───┤ set_expression call │ (in parallel)
                                                                     └─────────────────────┘
```

Multi-device: the Arena tab streams the head to guests over LiveKit; a guest's phone sends punches over the data
channel and the face addresses them by name (`npm run livekit:dev`, see `SPONSOR_SETUP.md`).

## What is not done (so nobody has to find out)

- The turn is streamed chat-completions, not the Realtime WebSocket. A realtime engine exists under `src/omni/` and
  `omni_relay.py` but is not connected to the microphone or the speakers, so it is **not** part of this demo. Do not
  open `?arena_omni=1`.
- The expression is drawn with the three mouth shapes the head exposes (jaw, lip corners, lip rounding). Brows and
  eyes move with the local pain pose on impact, not with the model's choice.
- The ElevenLabs backup voice is wired and tested against a fake service, but has not produced audio with a real key.
- A consent step before scanning someone else's head is designed, not built. Scans stay on the laptop by default.

## Verify it

```bash
npm run dev                                   # everything, including the relay on :5176
.venv/bin/python scripts/omni_preflight.py    # see / tone / hear / safe against the live model
npm run test:sponsors                         # 35 tests: every fallback path, with a fake gateway
node --test tests/face-expression.test.mjs tests/face-grunts.test.mjs
```
