# Sentry — track debrief for PUNCHING FACE

Hack the North 2026 · project: [PUNCHING FACE](../README.md) (photo head reconstruction + Newton soft-tissue physics +
an OMNI face that sees, hears and talks back + LiveKit arena)

**Prize target:** Best Use of Sentry — at least two products beyond error monitoring, judged on creativity, depth of
integration, and how meaningfully Sentry data influenced the project.

**Rewritten 2026-09-20 ~00:30.** The earlier version of this file described data that did not exist: no DSN was ever
saved on this machine, so every Sentry call in the repo had been a no-op, and its headline finding (a "3.8 s cold
start, 55 % Warp JIT") does not reproduce. Everything below was observed on the night of Sept 19–20. Each claim says
where it came from: **[Sentry]** = read in our Sentry project · **[sink]** = the real SDKs reporting to
`scripts/sentry_sink.py` · **[test]** = asserted by a test in this repo.

**Sentry org:** `punchingface.sentry.io` · projects **`punching-face-web`** (browser) and **`punching-face-services`**
(the three Python services + pipeline subprocess). One trace crosses both.

---

## The story to tell judges

> "This is a distributed system on one laptop: a WebGL page, three Python services, a reconstruction subprocess, a
> cloud build job and a multimodal model 1.5 seconds away. A punch is one trace through all of it. We turned Sentry on
> at midnight, and within an hour it had told us four things we believed that were wrong. We fixed two before we
> slept, and the other two are why the demo script now says what it says."

Then show the four findings below, in Sentry, with the trace ids given. They are real.

---

## What Sentry data changed

### 1. The physics loop had no headroom, and burned a core doing nothing  **[sink] + [Sentry] + [test]**

`POST /physics/step` is sampled at 2 %, and every sampled one carries a profile. The traces said every step costs the
same, punch or no punch:

| Where | solver p50 | p95 | frame budget |
| --- | --- | --- | --- |
| physics service alone **[sink]** | 28.7 ms | 30.7 ms | 33.3 ms |
| live stack, page rendering beside it **[Sentry]** | **35.0 ms** | 38.6 ms | 33.3 ms |

On the live stack the solver is *over* budget. `src/newton-dynamics.js` serialises steps and caps `dt` at 1/30 s, so
when a round trip exceeds 33 ms simulated time falls behind wall time: under load, the jiggle plays in slow motion.

The profile said why: **512 Warp kernel launches per step** (64 per substep × 8 substeps). The mesh is tiny (1,404
particles, 4,614 tets); the time is Python launch overhead, not arithmetic. So an idle face costs exactly what a
punched one does. We then measured how fast a punched face settles: by 1.0 s the surface moves **under 1 µm per
frame** (peak 7 µm). Nothing visible is being computed.

**Fix (`newton_face.py`):** a face that has moved less than 2 µm/frame for 10 frames answers from its last result
until the next `impact()` wakes it.

| Scenario, 10 s at 30 Hz **[sink]** | before | after |
| --- | --- | --- |
| nobody punching | 83 % of a core, 27.7 ms/step | **6 %**, 0.0 ms/step |
| one punch every 5 s | 92 % | **27 %** |
| a punch every 1.3 s | 81 % | 81 % (it never gets to rest; no gain, no harm) |

`tests/newton_sleep_test.py` runs a sleeping face and a never-sleeping twin through the same two punches: the largest
difference in what is drawn is **0.006 mm**, including the full response to the punch that wakes it. Sleep/wake
transitions are logged (`physics.asleep` / `physics.awake`).

**Status: shipped OFF.** It touches the core mechanic the night before judging, so it is behind
`CONTACT_PHYSICS_SLEEP=1`. Rehearse once with it on (`CONTACT_PHYSICS_SLEEP=1 npm run dev`), then keep it: the core
it frees is the one hand tracking wants.

### 2. "The expression lands before it speaks" was true half the time  **[Sentry] → fixed**

`DEMO.md` said the face wears its expression "about a third of a second *before* it speaks". Each turn is now one
agent run in Sentry (`invoke_agent The Face` → the spoken `gen_ai.chat`, the expression `gen_ai.chat`, and
`execute_tool set_expression`), so the first four real turns could simply be read off:

| trace | reply: time to first token | expression call | expression vs. first speech |
| --- | --- | --- | --- |
| `ee276544` | 1.57 s | 1.04 s | 0.5 s before |
| `10f338ab` | **7.52 s** | 2.69 s | before, only because the reply stalled |
| `bc962190` | 1.47 s | 1.05 s | 0.4 s before |
| `b1bc73d9` | 1.45 s | **2.41 s** | **1.0 s after** |

Two things. The model is ~1.5 s away, not the 1.3 s we quote. And the expression call is bimodal (~1.05 s or ~2.5 s);
when it is slow the face speaks with last turn's expression. n = 4, so the split is not yet a rate: that is what the
`coach.expression.latency` and `coach.first_token` metrics are now collecting.

**What we did with it (built Sept 20, ~00:30):** the pitch now says "about a second and a half", and the face no
longer waits. [`instant-expression.js`](../src/sponsors/instant-expression.js) does for the face what the cached grunt
does for the voice: the instant a punch lands, the device picks the look from what it already measured (hardest →
`stunned`, combo → `winded`, weak → `smug`, hurt a moment ago → `defiant`), and OMNI's `set_expression` call confirms
or corrects it. It uses the relay's own thresholds (a test asks the real `intensity_of()` in Python and checks the
two agree). It never guesses `amused` or `concerned`, which need eyes and ears, and never overrides a `concerned`
OMNI set. The chip says who chose: `· instant`, then `· OMNI agrees` or `· OMNI corrected it`.

| Punch lands → the face reacts | before | after |
| --- | --- | --- |
| look appears, measured in the app | 1.04 to 2.69 s **[Sentry]** | **24 to 27 ms** (the dock hears of a contact on a 33 ms poll) |
| OMNI agrees a second later | the look eased to neutral and back: a twitch | carried on, no dip **[test]** |
| switched off (the checkbox in the panel) | | 1,457 ms, the old behaviour exactly: a live A/B for judges |

Verified in the running app with the relay's turn stubbed in the page (no model call, no credits): agree, correct,
`concerned` holding through three more punches, and off. **From here Sentry keeps score:**
`face.expression.instant_latency`, `face.expression.omni_delay`, and `face.expression.verdict {local, omni, agreed}`,
which is the number worth quoting once it has an evening of real punches behind it: how often does a laptop's guess
match a multimodal model's judgement? *(The three `verdict` and `omni_delay` samples between 00:20 and 00:30 on Sept
20 are from that stubbed check, not from OMNI. Exclude that window.)*

### 3. One turn in four stalled 7.5 s, and it was not our relay  **[Sentry]**

Trace `10f338ab`: 7.52 s to first token. In the same trace the expression call, a separate request on a separate
thread, was also slow (2.69 s against 1.05 s). Both requests slow at once, relay spans negligible: the gateway. The
cached grunt is what covers this in the room. `DEMO.md` already says "a gateway spike, seen once in ~20 turns"; the
first hour of real data says plan for more often than that.

### 4. Our own folklore was wrong  **[Sentry]**

The previous version of this file said `/physics/open` takes 3.8 s and that 55 % of every cold start is Warp's JIT.
The spans that claim was supposedly built on (`newton.open.cage` / `.build` / `.warmup`) say otherwise:

```text
POST /physics/open   cold, fresh process   372 ms   build 312 ms · first step 57 ms     [sink]
POST /physics/open   warm                  137 ms   build 100 ms · first step 36 ms     [sink]
POST /physics/open   live stack            177 ms   trace 2fc6a8b6a78740058818baf65d313965   [Sentry]
```

Warp caches compiled kernels on disk (`~/Library/Caches/warp`), so a JIT cost is paid once per Warp version, not per
reload. There was never a cold-start problem to fix; the traces pointed at the step loop instead (finding 1).

### 5. Failures that could not reach Sentry at all  **[test] + [sink]**

Found while wiring, fixed the same night:

- **A Newton crash left no trace.** `physics_server.py` turned every unexpected exception into a sentence and a 500.
  It now reports the exception; and `sponsor_obs.instrument_http` opens an issue for *any* 5xx from any service,
  tied to its trace, because `server.py` swallows exceptions the same way.
- **Worker crashes were invisible.** Hand tracking, face capture, impact preparation and the target camera run in
  workers; an exception there never reaches `window.onerror`. The flight recorder wraps `Worker`: both a missing
  worker script and a crash *inside* a worker arrived as issues in the harness.
- **The breadcrumb trail would have been useless.** Inspecting a raw replay in the sink showed every 30 Hz
  `/physics/step` recorded as a breadcrumb and a replay network event: any error's 100-crumb trail would hold 3
  seconds of physics and nothing the person did. Hot-loop and poll requests are now dropped unless they fail.
- **The expression call and the backup voice run in other threads.** They are parented explicitly so they sit
  beside the reply in the waterfall instead of vanishing.

---

## What is wired

| Product | What it does here | Where |
| --- | --- | --- |
| **Tracing** | A person's action is a trace of its own: `coach.turn`, `scan.save`, `scan.meshy_build`, `physics.open`. Browser → service → pipeline subprocess (env vars) or Meshy cloud job (background thread continuing the request's trace, one span per stage). Every response carries `X-Sentry-Trace-Id`. | [`sentry.js`](../src/sponsors/sentry.js) `obs.flow` · [`flight-recorder.js`](../src/sponsors/flight-recorder.js) · [`sponsor_obs.py`](../sponsor_obs.py) `instrument_http`, `traced`, `job_state` |
| **AI Agent Monitoring** | Each turn is `gen_ai.invoke_agent` (The Face / Cornerman) containing the spoken `gen_ai.chat`, the expression `gen_ai.chat`, and `gen_ai.execute_tool set_expression`. Convention attributes: time to first token, tokens, finish reasons, and cost computed by us (this gateway's model is not in Sentry's price list). Never prompts, replies, frames or audio. | [`sponsor_obs.py`](../sponsor_obs.py) `agent_span` / `ai_span` / `tool_span` · [`sponsor_server.py`](../sponsor_server.py) `coach()`, `express()` |
| **Session Replay** | On for every session. The webcam, every image and the 3D canvas are blocked (the canvas *is* a face); the conversation and guests' names are masked; inputs masked; no request bodies. Every punch is a breadcrumb (`webcam left 2.4 m/s`), so the timeline of a blank-canvas replay still reads like a fight log. | [`sentry.js`](../src/sponsors/sentry.js) · [`flight-recorder.js`](../src/sponsors/flight-recorder.js) `watchPunches` |
| **Logs** | Pipeline stages, job stages, coach turns, voice fallbacks (warn, with the gateway's reason), slow physics steps, sleep/wake, frame pacing every 5 s, worker boots, refused cameras, hidden tabs. Logs carry the trace id. | `sponsor_obs.log` / `warn` · `obs.log` |
| **Profiling** | Continuous, all three Python services; browser profiling via a `Document-Policy` header from Vite. It is what turned "the step is slow" into "512 kernel launches". | [`sponsor_obs.py`](../sponsor_obs.py) `init` · [`vite.config.js`](../vite.config.js) |
| **Metrics** | The numbers the pitch quotes, as distributions: `coach.first_token`, `coach.expression.latency`, `coach.voice.first_audio`, `face.grunt_latency` (the "cached · <50 ms" badge, measured), `face.expression.instant_latency`, `face.expression.verdict` (how often the device's look and OMNI's agree), `face.first_response`, `punch.dispatch_delay`, `punch.camera_to_contact`, `render.frame_p95`, `worker.boot`, `flow.request`. | `sponsor_obs.metric` · `obs.metric` |
| **User Feedback** | "Report a problem" in the dock. No screenshot (it could hold a face), no name, no email; arrives attached to that session's replay. For judges and booth visitors. | [`flight-recorder.js`](../src/sponsors/flight-recorder.js) `mountFeedback` |
| **Errors** | Browser, workers, three services, pipeline, Meshy job; 5xx safety net; duplicates capped at 5 per 5 min so a polled endpoint that breaks cannot spend the quota. | both |

**Not used, on purpose:** Uptime Monitoring needs a public URL and this app is loopback-only by design (scans never
leave the laptop). Canvas replay: the canvas is a reconstructed face.

**Sampling:** `/physics/step` 2 % · status polls 5 % · everything a person did 100 %. The browser makes no spans at
all for the hot loop.

---

## How this was verified

- `npm run sentry:doctor` — **ALL PASS** just before midnight: both DSNs accepted (HTTP 200), both interpreters sent a trace, a
  log and a metric, and all three running services answer with `X-Sentry-Trace-Id`.
- **[Sentry]** read in the UI: 1.3K spans in the first hour, four real agent runs, 5+ replays, 164 logs.
- **[sink]** `scripts/sentry_sink.py` is a loopback stand-in for Sentry's ingest. The real browser SDK config and
  flight recorder ran against it in a real browser (`.local/sentry-preview/`): each flow was its own trace with
  exactly one child request *while a 30 Hz loop and a poll ran through it*; logs made before the DSN arrived were
  delivered; feedback carried its `replay_id`. With `SENTRY_SINK_KEEP=1` the replay recording was inflated and
  grepped: the conversation appears as `** *********** ****`, the guest name as `*****`, typed input and capture ids
  not at all.
- **[test]** `npm run test:sponsors` (63 tests) + `tests/sentry-browser.test.mjs` (6) + `tests/newton_sleep_test.py`
  (2). `tests/sentry_turn_test.py` re-runs the entire voice suite with Sentry live, then asserts that no reply text,
  no words a person said, no frame and no key is in any envelope.

Without a DSN every call is a no-op and the app is untouched: `test_6`, and the first test in `sentry-browser`.

---

## Demo script — 3 minutes

1. **(30 s) One punch, one trace.** Throw a punch. Sentry → Explore → Traces → newest `coach.turn`. Browser span →
   relay → `invoke_agent The Face` → reply, expression call, `set_expression`. Read out time to first token and cost.
2. **(45 s) What it told us.** Finding 1: the step-duration numbers, the profile, the before/after table. "We
   thought we had a cold-start problem. The trace said we had an idle problem."
3. **(45 s) What it told us about our own pitch.** Finding 2, with the four traces. "Our script said the face reacts
   before it speaks. Sentry said: half the time. So that night we built the fix." Untick *React on its face the
   instant it is hit*, punch (the face waits a second or two for OMNI), tick it, punch again (~25 ms), and point at
   the chip: `instant`, then `OMNI agrees`. Then show `face.expression.verdict` in Explore → Metrics.
4. **(30 s) Privacy.** Open a replay: canvas and webcam blank, conversation starred out, punches in the timeline.
   "This app reconstructs faces. We can debug a session without ever seeing one."
5. **(30 s) The judge files a bug.** "Report a problem" in the dock → it appears in Sentry attached to their replay.

## Judge Q&A

- **Why 2 % on `/physics/step`?** 30 Hz is 108,000 transactions an hour per tab. 2 % keeps the outliers visible;
  every kept one has a profile, which is how finding 1 got from "slow" to "512 launches".
- **How does a trace reach the subprocess and the cloud job?** `SENTRY_TRACE`/`SENTRY_BAGGAGE` in the child's
  environment; for the Meshy job, `sponsor_obs.traced()` captures the request's trace and continues it in the worker
  thread as its own transaction, because the request ends minutes before the build does.
- **Why not leave a span active for the whole turn?** A browser has no async context: an active span adopts every
  request made meanwhile, and the physics loop makes thirty a second. `obs.flow` activates the span only while its
  own request is dispatched. Checked in the harness: one child, not ninety.
- **What happens without Sentry?** Nothing. Every helper is a no-op; two tests hold that.

## Setup

```sh
npm install
.venv/bin/python -m pip install -r requirements-sponsors.txt
.local/newton-env/bin/python -m pip install -r requirements-sponsors.txt
npm run sentry:doctor -- --dsn <python DSN> --browser-dsn <browser DSN>   # saves 0600, then checks everything
npm run dev                                                                 # services read the DSN at start-up
npm run sentry:doctor                                                       # must end ALL PASS
```

## Next, in order

1. Rehearse with `CONTACT_PHYSICS_SLEEP=1`, then make it the default.
2. Rehearse the instant expression with real fists and the real model (built and verified with a stubbed relay; not
   yet seen against live OMNI). If anything looks wrong at the table, the checkbox turns it off.
3. After an hour of real use, read `coach.first_token` and `coach.expression.latency` p50/p95 in Explore → Metrics
   and put the real numbers in the pitch.
4. Screenshot the four views in the demo script, in case the hall Wi-Fi is not there when the judges are.
