# DEMO.md — the 3-minute OMNI Live demo

Rewritten 2026-09-19 (late) around the path that is actually live: the **Face panel** (`src/sponsors/cornerman.js` →
`sponsor_server.py` → `qwen3.5-omni-flash`). The pitch and the evidence behind every claim are in
[TRACKS/OMNI_JUDGES.md](TRACKS/OMNI_JUDGES.md).

> **Do not open `?arena_omni=1`.** That flag starts a second, realtime session that is not connected to the microphone
> or the speakers: it spends credits and shows nothing.

## Ten minutes before

```bash
npm run dev                                   # everything, including the Face relay on :5176
.venv/bin/python scripts/omni_preflight.py    # must end with ALL PASS
```

- **ALL PASS** means the key, the gateway, video, hearing, tone, the expression tool call and the safety behaviour all
  work right now. If it fails, the line above the failure says why (no key, relay down, gateway refusing).
- The OMNI key is recorded in `TRACKS/OMNI.md` as **expiring 2026-09-20 08:00 EDT**. If judging is after that, confirm
  with the Huawei table that it still works, and record a backup video while it does.
- Use **Chrome**, allow camera and microphone, headset mic if the hall is loud. Phone hotspot standing by.
- A pre-scanned head loaded (a teammate's, with their okay). Open the dock: **The Face**.
- In the panel: **Voice · OMNI** → pick the character (press *Hear it*). *React to punches*, *Let it see me*, *Let it
  hear the room* and *Grunt the instant it is hit* all ticked. Leave *Voice interaction* on **Ambient** unless you have
  tried **Interrupt** at this table with this microphone.

## The script

### 0:00 — the problem (15 s)

> "Most people who train, train alone. A heavy bag gives you nothing back: nobody sees your guard drop, nobody hears
> you gas out, nobody tells you to stop. And with your fists up you can't touch a screen. So we built a sparring
> partner that **sees, hears and talks back** — on the laptop you already have."

### 0:15 — begin punching (the judge throws, if they will)

Press **Begin punching**. The face wakes; the panel badge shows `qwen3.5-omni-flash`.

| Beat | Do this | What happens | What it shows |
| --- | --- | --- | --- |
| 1 | Throw a lazy jab | An instant grunt and a smirk, then a bored, mocking line. The chip shows 😏 **smug · instant**, then **· OMNI agrees**. | Cached OMNI-voice reaction in < 50 ms; the look chosen on the device in ~30 ms, then confirmed by OMNI's function call; tone adaptation |
| 2 | Drop your left hand on purpose for a few punches | It calls it: *"that left drops every single time."* | **Video** understanding: it goes up as a clip, not stills |
| 3 | A teammate heckles from the side: *"my grandmother hits harder!"* then you punch | The face throws the heckle back at you. Watch the chip: if it ends **· OMNI corrected it**, the model just overruled the device. | **Audio** understanding: it hears the room, not just questions. The punch numbers cannot know a joke was made; OMNI can. |
| 4 | Land your hardest | *"Aagh!"*, the jaw drops **as it lands** (😵 **stunned · instant**), and the voice comes back shaken, higher and louder | Tone + expression follow the **measured** punch, on the device first |
| 5 | Fists still up, say: *"Is that all you've got?"* | It answers you. No button was pressed. | Hands-free **speech**, multi-turn |
| 6 | Say: *"Hold on, stop — I feel dizzy."* | The act drops at once: *"Whoa, easy there. Sit down and breathe. Are you okay?"* 😟 **concerned**, and it stays: keep punching and the smirk does not come back. | **Safety beats the persona**, from voice. Only OMNI can give or lift this look; the device's guess never overrides it. |

### 1:45 — the same loop, a different job (20 s)

Switch the selector to **Coach — a cornerman**. Throw a combo.

> "Same eyes, same ears, same numbers, different prompt: now it's a cornerman giving one correction at a time. The
> heel is the hook that keeps you going; the coach is why it's useful."

### 2:05 — how it works (40 s)

Point at the panel's grey badge: *"6-frame clip + your voice + 2.5 s of room sound on a punch + punch numbers →
yibuapi.com"*.

> "That badge is everything that leaves the laptop, and it's live: untick *Let it see me* and it changes. Hand
> tracking, the contact physics and the voice gate all run on the device at 30 Hz. Once per turn the cloud gets a
> three-second clip, the audio and a few numbers. One request carries all three modalities, and the measured numbers
> mean the model never has to guess how hard you hit.
>
> The reply streams back as audio; the mouth is driven by analysing that audio, so the lip-sync can't drift. Beside
> it, a second tiny request asks the model to call `set_expression`. The model is about a second and a half away, so
> the face does not wait for it: the grunt was recorded once in its own voice and plays from memory in under 50
> milliseconds, and the look is chosen on this laptop from the measured punch in about 30. Then OMNI, which saw and
> heard what the numbers can't, confirms that look or corrects it, and the chip says which. The API key never reaches
> the browser."

(If a judge wants proof the model is doing something: untick *React on its face the instant it is hit* and punch.
The face now waits the full second or two for OMNI, as it did before Sentry's traces showed us the gap.)

### 2:45 — close (15 s)

> "When AI can see, hear and speak in real time, the thing you're hitting can know what you did, tell you about it,
> and notice when you should stop. None of that was possible with a bag."

## If something goes wrong

| Symptom | Cause | Say / do |
| --- | --- | --- |
| Panel says *Sponsor services are not running* | The relay is down | `npm run sponsors`, press **Retry** |
| Badge says **MOCK · no key** | No OMNI key on this laptop | Paste it under **OMNI key** in the panel. Until then the stand-in talks: say so. |
| Status ends *Voice: the browser* | OMNI sent no audio and no ElevenLabs backup is working | The line still arrives; the status line says why. Re-run the preflight. |
| A reply takes 4 s | A gateway spike (seen once in ~20 turns) | The grunt already covered the gap. Keep punching. |
| It talks over you, or answers its own voice | Hall noise through the speakers | Headset mic; stay on **Ambient**; lower the speaker volume |
| The face doesn't move its mouth | The head has no mouth anchors | Use the pre-scanned head you rehearsed with |

## What to say if asked

- **"Is it really real-time?"** The reply is streamed; first sound from the model at about 1.5 s (Sentry: 1.45 to
  1.57 s on the first real turns, with one 7.5 s gateway stall), first sound from the face at under 50 ms and its first
  expression at about 30 ms, both on the device. It is turn-based streaming, not the Realtime WebSocket: that is the next step, and the relay for
  it exists (`omni_relay.py`), but it is not in this demo.
- **"Couldn't you do this with three separate models?"** The heckle line needed the clip, the room audio and the punch
  numbers in one context. Stitching ASR + a vision model + TTS loses how something was said, and triples the latency.
- **"Isn't this a deepfake / violence app?"** The target is a virtual head on a screen, the persona refuses anything
  aimed at a real person, never mocks who someone is, and drops the act when someone is in trouble. Scans stay on the
  laptop. A spoken-consent step before scanning someone else is designed and not built yet.
