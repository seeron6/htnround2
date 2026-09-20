# Punching Face × OMNI Live: five-minute judging video

Prepared 2026-09-20. This is a shooting and editing plan, not a claim that the footage has been recorded or the current live service has been tested. Runtime: exactly 5:00. Read the narration naturally at roughly 130–145 words per minute; live interaction fills the remaining time.

## The story

**A webcam sparring game whose opponent can see your movement, hear the room, and talk back.**

Make the game and its personality the hook. Show solo, hands-free physical play as the use case. Coach mode is the practical extension. Describe exercise engagement as potential, not a demonstrated training or health benefit.

The judges should remember one real exchange in which the character responds to what the camera saw, something someone said, and what happened in the game. That earns more credibility than a list of supported modalities.

## Exact edit and ready-to-read narration

### 0:00–0:15 · Let the product introduce itself

**Picture:** Start on a real punch, the head reacting, and a genuinely funny OMNI reply. Keep the player visible in a picture-in-picture. Use the strongest authentic moment from the recorded session. Let the exchange breathe, including the original response delay.

**Sound:** Gameplay and the model's own voice. No narrator over the reply.

**Title, appearing after the first hit:**

> PUNCHING FACE  
> A sparring partner that sees, hears and talks back.

Do not script an AI line for dubbing. Caption exactly what the model actually said.

### 0:15–0:45 · Explain the idea and the person it is for

**Picture:** A brief wide shot of you in front of the laptop establishes the real setup. Cut to gameplay with your camera inset. Keep playing while the voiceover explains the idea.

**Voiceover:**

> This is Punching Face: a webcam-controlled sparring game with an opponent that sees, hears, and talks back. When you're shadowboxing alone, there's nobody reacting to your movement or sharing the moment. We wanted to make physical play feel social and responsive, using a laptop you already own. You throw real punches at a virtual target, and the conversation becomes part of the game.

**Small on-screen labels:** `Laptop + webcam + microphone` → `Hands-free physical play`.

### 0:45–1:05 · Show how it becomes personal

**Picture:** Three short, real shots: your captured head footage → your finished rotating 3D head → the same head responding in the game. Show a wireframe briefly only if it is clear and visually strong. If reconstruction is sped up or skipped, label the transition `Reconstruction condensed`.

**Voiceover:**

> You can start with a captured head, including your own. We turn photos or video into a textured 3D model, then give it deformable facial motion and a speaking mouth. Your webcam maps your hand movements into the game.

**Overlay:** `Capture → 3D head → Play`.

This segment introduces personalization. It should not imply that OMNI reconstructs the head or simulates its physics.

### 1:05–2:15 · The main proof: one continuous round

**Picture:** A continuous 70-second recording of screen and player. Begin with the loaded head, click **Begin punching** if needed, and stay with the interaction. No cuts inside the proof segment. Use small labels to draw attention to evidence, without covering the target or the response chip.

**Sound:** No voiceover. Keep the player, bystander and OMNI clearly audible. Drop the music.

**Action order; these are recording targets, not guaranteed timings or model outputs:**

1. **First ~20 seconds:** Throw a few light punches, visibly lowering the left hand after a punch. Let the face react. Ask, “What did you notice about that?” Keep a take where the reply contains a specific, visible observation. A generic insult alone does not demonstrate vision.
2. **Next ~25 seconds:** Have an off-camera teammate call out a distinctive line, such as “That punch had dial-up internet!” while the face is silent, immediately before a punch-triggered turn. Let OMNI respond. Choose a take where it actually refers to the remark; do not pre-write the model's answer. If filming alone, say a spontaneous line yourself and present it as hands-free speech, not proof of a separate bystander-audio turn.
3. **Last ~25 seconds:** Throw a short, more energetic combo. Follow up on the remark: “Still think that was slow?” Let the character respond before the section ends. A follow-up that uses the prior conversation demonstrates continuity more clearly than an unrelated second question.

**Optional evidence labels, only when supported by this take:** `Notices the movement` / `Hears the room` / `Keeps the conversation`.

Rehearse and record several continuous rounds. Choose an actual round that fits; if a response runs long, simplify the action sequence rather than hiding the wait. Keep the model name and voice-source status readable at least once. The proof must use the live OMNI path, not a development stand-in or a dubbed reply.

### 2:15–2:45 · Explain why the inputs belong together

**Picture:** Replay brief excerpts of the just-seen round, explicitly labelled `Replay`, then show `01-multimodal-context.png`. Build the three inputs one at a time. If the editor supports SVG, animate the named groups in the SVG source. Use actual recorded words if adding a response quote.

**Voiceover:**

> The video tells OMNI how I'm moving. The microphone gives it my words and what's happening around me. The game supplies which punches landed and their relative intensity. Together, those inputs let the character respond to this particular moment. That's why the conversation belongs inside the game: my hands are busy, my attention is on the target, and the feedback reaches me through its voice and expression.

**Editing condition:** This explanation follows demonstrated behavior. If the selected round does not show a visible observation or an audio reference, record another take or narrow the claim.

### 2:45–3:25 · High-level architecture

**Picture:** `02-edge-cloud.png`, with laptop first, then inputs crossing to the cloud, then the returned response. Briefly replace the diagram with the real head speaking at the end. Avoid code, terminal walls and a logo collage.

**Voiceover:**

> On the laptop, camera tracking turns movement into game events, and local physics animates the head. At a conversational moment, we send OMNI a short sequence of camera frames, speech or recent room audio, and structured game context. OMNI uses that context to generate a spoken response. The audio streams back and drives the mouth animation. Alongside it, a separate OMNI call chooses a facial expression. Our local server connects the game to the cloud and keeps the API key out of the browser.

**Small optional label:** `Qwen3.5-Omni · qwen3.5-omni-flash`.

For a brief privacy insert, show the real camera/room-audio toggles and the live data-disclosure badge. User controls determine which inputs are supplied. Do not claim that all data stays on the laptop.

### 3:25–3:55 · The engineering choice that makes it feel responsive

**Picture:** Begin with a real-time punch and reaction, then show `03-reaction-flow.png`. Highlight the local row first, followed by the OMNI row. Return to the real `instant` → `OMNI agrees` or `OMNI corrected it` chip if that transition is captured.

**Voiceover:**

> A physical game cannot wait for a cloud response to acknowledge a hit. So we split reaction into two layers. The laptop handles deformation, a cached grunt recorded in the character's OMNI voice, and an initial expression immediately. OMNI then adds the contextual reply and can confirm or change that expression. The fast reaction keeps the game responsive; the model gives it understanding.

**Overlay:** `Immediate local reaction` → `Contextual OMNI response`.

No latency numbers are necessary. If adding one, use a fresh measured sample from the recorded build, show what interval was measured, and label it as a sample. First token, first audible model speech and first local reaction are different metrics. Do not label the cached grunt as a fresh model response.

### 3:55–4:20 · The same interaction becomes useful feedback

**Picture:** Switch to **Coach — a cornerman**, visibly. Show a short combination and a specific coach response. Keep the full action-to-response interval.

**Voiceover, first ~6 seconds only:**

> Switch to Coach, and the same inputs become specific feedback between punches.

**Live audio, remaining time:** Ask “What should I change?” after an observable movement. Use the actual answer. Show yourself acting on the correction if it fits naturally; do not suggest this demonstrates improved boxing skill.

**Overlay:** `Same senses · different role`.

### 4:20–4:40 · Show that context can override the character

**Picture:** Return to The Face, ideally in an uninterrupted recording that includes the mode switch. Give the deliberate test prompt below, then stop throwing and let the real response and expression play.

**Your live line:**

> Hold on, stop. I need a break.

**Sound:** Actual OMNI reply. No narration over it.

**Overlay:** `Safety test: “Stop. I need a break.”`

Show the observed change from banter to concern. Do not imply medical monitoring, guaranteed safety, automatic game pausing, or emergency detection. If the demonstration does not behave as intended, fix/retest it before using it as evidence.

### 4:40–5:00 · Finish on the experience and its potential

**Picture:** Return to you and the playable game, then a clean end card for the final four seconds. Use the same head and visual identity as the opening.

**Voiceover:**

> Punching Face makes a solo game feel shared. You move and speak; the character sees, hears, and responds. We're exploring how that interaction can make camera-based exercise more engaging. This is our playable prototype, built with OMNI.

**End card:**

> PUNCHING FACE  
> Move. Speak. It responds.  
> Built with Qwen3.5-Omni · Hack the North  
> github.com/akashngb/punching-face

Verify the final submitted repository URL before export. Hold it long enough to read; add a QR code only once that destination is final.

## Visual assets

Three ready-to-use 1920 × 1080 PNGs and editable SVG sources are next to this file:

- `01-multimodal-context`: video, audio and game context converge on OMNI. Use at 2:15.
- `02-edge-cloud`: the device, local server, cloud, and return path. Use at 2:45.
- `03-reaction-flow`: local feedback followed by model-driven context. Use at 3:25.

These are explanatory graphics, not product screenshots or measured charts. The arrows show information flow, not a scaled latency axis. The game footage and real voice remain the primary visual evidence. A contact sheet is in `visuals-preview.png`.

The visual style is dark charcoal, warm white type, lime for the device/input side and cyan for OMNI. Keep captions to two lines, with a consistent safe margin. Build each diagram progressively in the edit instead of holding a dense static slide for forty seconds.

## Recording and editing checklist

1. Record a clean 16:9 screen feed at 1920 × 1080 or higher. Use 60 fps if the app and recorder remain smooth; otherwise prioritize stable 30 fps. Hide notifications. Use your own head or an agreed participant's head.
2. Use a second camera/phone for you playing, framed wide enough to see fists, upper body and laptop. The player inset should occupy roughly a quarter of the frame's width. Place it away from controls and the face; reserve the bottom for captions.
3. Capture application audio and your microphone separately if possible. Make one visible/audible clap for synchronization. Check that OMNI is intelligible, not doubled by the room microphone. Record the narration afterward in a quiet room.
4. Before recording, run the project's `scripts/omni_preflight.py` with the intended environment and verify the actual camera/microphone path manually. The repo notes mention a sponsor key expiry on September 20; verify current access before spending time setting up a take. The checks can make live API calls.
5. Use the Face/Cornerman demo path. Do not use `?arena_omni=1`: the repo notes identify that Realtime relay as disconnected from demo microphone/speakers. Choose native OMNI voice for the OMNI voice demonstration, and verify the visible source status.
6. Record the 70-second uninterrupted core round first, while the live service is working. Capture the coach exchange and stop-test next. Then collect the setup shot, head capture/turntable, mode switch, input toggles and expression-chip close-up.
7. Record multiple real takes. Planned player actions are fine; OMNI answers must remain actual outputs. Do not remove response waiting time within the continuous proof or use sound effects to disguise it. Label replays and reconstruction time compression.
8. Keep music low under narration and silent or nearly silent during proof moments. Caption both your speech and OMNI's actual words, with consistent speaker labels. Do not read every UI label aloud.
9. Time the rough cut to the chapter boundaries. Keep architecture to forty seconds. If a good reply needs more room, shorten adjacent montage/voiceover, not the reply's genuine timing. The final export must end at 5:00.
10. Watch the full export with headphones, then laptop speakers. Confirm captions, no clipped replies, clear hand-to-game correspondence, correct cloud/local attribution, readable repo destination, and exactly five minutes.

## Rubric coverage

| Criterion | Evidence in this cut |
| --- | --- |
| Scenario value and creativity · 30% | 0:15–0:45 frames solo hands-free play; a scanned head and responsive personality make it distinctive; coach mode shows potential utility. |
| OMNI capabilities · 25% | 1:05–2:15 shows video, speech/audio and language in a coherent interaction; 2:15 explains why those inputs matter together. |
| Demo completeness · 20% | A real loaded game, start action, physical input, model response and conversational follow-up form the continuous core round. |
| Interaction experience · 15% | Natural player/model audio, retained response intervals, local impact feedback and conversational continuity. |
| Technical implementation · 10% | Forty-second device/cloud explanation, separate immediate/model reactions, expression tool calling, and optional privacy-control insert. |

## Claim boundaries and sources

The official rubric was checked against the [challenge repository](https://github.com/cari-waterloo-rc/OMNI-Live-Build-the-Next-Generation-of-Real-Time-Multimodal-AI). Project grounding: `TRACKS/OMNI_JUDGES.md`, `DEMO.md`, `TRACKS/SENTRY.md`, `docs/FACE_VOICE.md`, and the current `sponsor_server.py`, `omni_senses.py`, `sponsor_perception.py`, `src/sponsors/cornerman.js`, and `src/sponsors/instant-expression.js`.

- Current code uses six small keyframes sampled every 500 ms and up to 2.5 seconds of recent room sound for punch-triggered turns. A spoken turn supplies the person's speech instead. Say “short clip and relevant audio”; do not imply continuous full-resolution video upload.
- Spoken output and expression selection are separate parallel OMNI requests. The expression call also records short heard/seen notes for conversational memory in the current implementation. The high-level diagram abstracts this inside OMNI.
- This is streamed turn-based interaction. It is not the project's unused Realtime WebSocket path. Barge-in is implemented but not relied upon in this cut because the supplied notes do not establish successful live microphone validation.
- The initial expression is chosen locally. OMNI chooses the later expression. Audio analysis drives mouth movement; do not claim phoneme-accurate lip synchronization or model-controlled eyes/brows based on these sources.
- Telemetry represents game events and estimated/relative motion intensity. It is not a calibrated measurement of physical punch force.
- The Sentry table contains first-token measurements, including a 7.52-second outlier. It does not establish a universal first-audio latency. Earlier local-expression checks included a stubbed relay; do not present those as fresh cloud measurements.
- Do not claim that OMNI builds the 3D head, that a language/vision/audio combination is impossible with separate models, or that separate models necessarily triple latency. The advantage demonstrated here is the coherent shared context and interaction.
- Native OMNI speech is the intended demonstration. Backup speech exists but should not be labelled native OMNI output. Local physics and reconstruction quality are supporting features; keep them subordinate to the demonstrated multimodal experience.
