# Notes for coding agents working in this repo

Written 2026-09-19 by Claude at the owner's request, to hand over research results. Edit or delete freely.
Everything below was measured or read directly on this machine unless it says otherwise. The full reasoning,
evidence tags and recipes are in [OPEN_SOURCE_STACK.md](OPEN_SOURCE_STACK.md). Read that before choosing a library.

## Where things are

- `SPONSOR_TRACKS.md`: the Hack the North plan (OpenAI, Huawei OMNI Live, Sentry), with tasks mapped to files here.
  New sponsor work goes in **new files** with one-line hooks; do not restructure `src/main.js` or `server.py` for it.
- `SPONSOR_SETUP.md`: how to run the OMNI coach, the LiveKit arena and Sentry (`npm run sponsors`, `npm run livekit:dev`).
  Their code lives in `src/sponsors/`, `sponsor_server.py`, `sponsor_obs.py`, `guest.html`.
  **Keep these hooks when editing:** the second `<script>` in `index.html`; the `window.__punchingFace.remotePunch` block at
  the end of `src/main.js`; the `sponsor_obs` lines in `server.py`, `physics_server.py`, `face_pipeline.py` and
  `scripts/build_photo_face.py`. `tests/sponsors-hook.test.mjs` fails if one is lost: restore the hook, keep the test.
- **Sentry is ON** since 2026-09-20 (org `punchingface.sentry.io`; what it found and how it is wired:
  [TRACKS/SENTRY.md](TRACKS/SENTRY.md)). `npm run sentry:doctor` must end `ALL PASS`; services read the DSN only at
  start-up, so restart `npm run dev` after changing it. **Keep these hooks too** (`tests/sentry-browser.test.mjs`
  fails if one is lost): `startFlightRecorder()` / `afterSentryStarts(dock)` in `src/sponsors/boot.js`; `obs.flow(` and
  `within(() => fetch(` around the turn in `src/sponsors/cornerman.js`; the `punching-face-contact` event with
  `time: performance.now()` in `src/main.js` (it is what puts punches into replays); `sponsor_obs.traced(` and
  `sponsor_obs.job_state(state)` in `meshy_backend.py`; `sponsor_obs.capture(crash` in `physics_server.py`; the
  `agent_span` / `tool_span` / `turn_span` lines in `sponsor_server.py`. Never add `replayCanvasIntegration`, feedback
  screenshots or `networkDetailAllowUrls`: the canvas is a face and request bodies hold webcam frames.
  `CONTACT_PHYSICS_SLEEP=1` (off by default) lets a face at rest stop simulating: `newton_face.py`, finding 1.
- **The face's expression is chosen twice** (finding 2 there): on the device the instant a punch lands
  (`src/sponsors/instant-expression.js`, pure, ~25 ms), then by OMNI's `set_expression` call 1 to 2.7 s later, which
  confirms or corrects it. Both go through `wear()` in `src/sponsors/cornerman.js`; the `react(triggers, now)` call at
  the top of `onPunch`, the `guess` line after `turn(...)`, and the `data-k="instant"` checkbox are the hooks
  (`tests/instant-expression.test.mjs` fails if one is lost). Rules that must survive edits: the device never picks
  `amused` or `concerned` and never replaces a showing `concerned`; `expression.set()` on the look already showing
  must sustain it, not restart it (or OMNI agreeing makes the face twitch); the thresholds are `gruntLevel`'s, which
  mirror `intensity_of()` in `omni_senses.py`, and that test asks the real Python function, so change both or neither.
- **The face's voice** ([docs/FACE_VOICE.md](docs/FACE_VOICE.md)): OMNI's own voice first, ElevenLabs as the backup, the
  browser's `speechSynthesis` last. The backup lives in `elevenlabs_voice.py`; the OMNI cast (`OMNI_VOICES`, only voices
  yibuapi accepts) and the fallback order live in `sponsor_server.py::coach`; the pickers and **Hear it** buttons are in
  `src/sponsors/cornerman.js`. yibuapi reports some failures (an unsupported voice) *inside a 200 stream*:
  `omni_stream` reads them, keep that. `tests/face_voice_test.py` covers every path with a fake upstream
  (`npm run test:sponsors`); `scripts/voice_audition.py` re-checks which voices the live keys accept.
- **What OMNI gets and gives each turn** ([TRACKS/OMNI_JUDGES.md](TRACKS/OMNI_JUDGES.md), the rubric map with measured
  numbers; [DEMO.md](DEMO.md), the script): `omni_senses.py` builds the request (keyframes as one `video`, room sound on
  punch-triggered turns, a tone direction from the measured punch) and the parallel `set_expression` function call;
  `src/sponsors/expression.js` draws that expression through `window.__faceSpeech` (no `main.js` change);
  `src/sponsors/grunts.js` plays cached OMNI-voice grunts from `public/omni-reactions/` the instant a punch lands
  (rebuild: `scripts/build_omni_reactions.py`). **Before a demo run `.venv/bin/python scripts/omni_preflight.py`**: it
  exercises all of it against the live model. The Realtime engine (`omni_relay.py`, `src/omni/`, `?arena_omni=1`) is NOT
  wired to the mic or speakers and is not the demo path. `qwen3.8-omni-flash` refuses audio output on yibuapi: keep
  `qwen3.5-omni-flash`. `npm run dev` now also starts `sponsor_server.py` (skipped if :5176 is taken).
- **Meshy engine** (README "Reconstruction engines"): the scan dialog can build a saved scan with Meshy's cloud
  image-to-3D instead of the local pipeline. All of it is in `meshy_backend.py`, `src/meshy-engine.js` and
  `src/meshy-engine.css`. **Keep these hooks when editing:** `import meshy_backend`, the `MESHY = ...` line, the two
  `meshy_backend.ROUTES` lines and `meshy_backend.api_key()` in `server.py`; the `EngineChoice` import and the
  `this.engines` lines in `src/face-capture.js`. It loads its GLB through `#face-file`'s change handler in
  `src/main.js` and reads `#busy`, `#model-name`, `#scene-name`, `#model-kind`, `#physics-engine`, `#photo-count`
  and `window.__labReady`, so it needs no code in `main.js`: keep those ids. `tests/meshy-engine-hook.test.mjs`
  fails if any of this is lost. Never start a second `server.py` on the real `.local/face-captures`: `FaceStore`
  marks every running job there as failed at start-up. Point `CONTACT_FACE_CAPTURES` at a copy instead.
- **Lip topology** ([docs/LIP_TOPOLOGY.md](docs/LIP_TOPOLOGY.md)): every head, from either engine, gets lips that can
  part when it is loaded. `src/lip-topology.js` (pure geometry) either **cuts** a seam into sealed lips (Meshy:
  refine, cut, add a mouth pouch) or **adopts** lips that are already parted (local pipeline: label them, darken
  the inside). `src/lip-fit.js` is the glue; the rigs read `geometry.userData.lipTopology`. **Keep when editing:**
  in `src/main.js` the `lip-fit.js` import, `fitLips`, `adoptLipGeometry`, the token and `settle` wait at the top
  of `fitMouth`, and in `loadPhotoFace` the `await fitMouth(…, cage)` that comes BEFORE `new NewtonFaceDynamics`
  together with `growBinding(binding, mesh.geometry)` (a cut changes the vertex count, and Newton must bind to
  the final buffer); `setLipTopology`/`seamJaw` in `src/physics.js`; `_buildFromLips` in `src/speech-rig.js`;
  `shadeMouth` in `src/surface-appearance.js`; `prepare` and landmarks 78/308 in `src/lip-detect.js`.
- **Pain rig and bone breaks** ([docs/PAIN_RIG.md](docs/PAIN_RIG.md)): in Live head · elastic a blow gets a three-pose
  reaction (flinch, grimace, ache), a head flinch and a gasp from `src/pain-rig.js`, and a magnitude of 0.70 or more
  on bone leaves a slight, capped break plus swelling from `src/bone-fracture.js` (this replaced the `> 0.90` damage
  rule; `src/pain-expression.js` is now a re-export). **Keep when editing:** in `src/impact-rig.js` the `BLEND` list,
  `headPose`/`gasp`, the `offThread` marker and the `wouldFracture` gate (a breaking blow must stay on the ordered
  main-thread path; everything else must still reach the worker after a break); `bones` in `TissueField.anatomy`
  and the `fractureField` call in `build`; in `src/physics.js` AND `src/newton-dynamics.js` the
  `.addScaledVector(this.impactRig.headPose, 40 * …)` spring term and the third argument of
  `speechRig.step(dt, this.speechDuck, this.impactRig.gasp)`; the `gasp` floor in `FaceSpeechRig.step`; the
  `wouldFracture` skip in `src/impact-worker.js`. `tests/pain-rig.test.mjs` and `tests/bone-fracture.test.mjs`
  fail if one is lost. Every event array must stay a top-level typed array (the worker transfers only those).
  Every such head also gets **teeth and a tongue** (`src/mouth-interior.js`), built in `fitMouth` and moved each
  frame by `mouthInterior.update({ swing: dynamics.jawSwing, offsets: [...] })` in the render loop: keep that call,
  `jawSwing` in `src/physics.js` and `jaw`/`openNow` in `src/speech-rig.js`.
  `window.__faceDetection.lips` says what happened to the current head (`cut`, `adopted`, or why it was refused).
  Do not go back to deleting triangles to open a mouth: on Meshy's ~6 mm lip triangles that is the black-shard bug.
- `PIPELINE_SPEEDUP.md`: measured video-to-model timings (fresh build 309 s serial, 122 s accelerated, identical outputs)
  and the recipe for the rest. The server now launches `scripts/build_photo_face_fast.py`, which installs
  `scripts/pipeline_accel.py` and then calls `build_photo_face.run()` unchanged. If you edit `photo_geometry.zbuffer`,
  `photo_geometry.raster_atlas` or `photo_detail.prepare_detail_frames`, its accelerator switches itself off and the
  build log says `STALE`: port the edit, then `.venv/bin/python scripts/pipeline_accel.py --pin`. Layers 2 and 3 in
  that file are edits inside `bake_photographs()` and `run()`, left for whoever owns those functions.
- `OPEN_SOURCE_STACK.md`: which open-source projects fit each failing stage, what was verified, what is still a guess.
- `.local/third_party/`: 17 pinned, permissively licensed sources (reference code and ungated model data).
  Recreate with `.venv/bin/python scripts/setup_third_party.py`; pins are in `scripts/third_party_manifest.json`.
- Convention already used here: third-party **sources go in `.local/`**, prepared **browser assets go in `public/`**
  via a `scripts/prepare_*.py` step. `.local/` is excluded from the Vite watcher, the dependency scan, `fs` serving
  and git, so writing there never reloads a camera session.

## Hard constraints of this machine

- Apple M5 Pro, 64 GB, macOS 26.5. **No CUDA.** Reject anything needing `nvdiffrast`, `pytorch3d` CUDA ops,
  `tiny-cuda-nn`, `diff-gaussian-rasterization` or `gsplat`.
- **No full Xcode** (Command Line Tools only): `xcrun -f metal` fails and `xcodebuild` will not run. Anything that
  compiles Metal at *build* time cannot be installed. Run-time Metal (torch-MPS, MLX wheels) is fine.
- `.venv` is Python 3.9.6, and that is a ceiling: `open3d==0.18.0` and `pycolmap==3.13.0` are the last releases with
  3.9 wheels. Put new ML/geometry tools in a separate Python 3.12/3.13 env under `.local/` and call them by
  subprocess, as `.local/newton-env` already does. Do not upgrade `.venv` in place.
- The several `requirements*.txt` files are deliberate, one per interpreter: do not merge them. Each starts with
  `# env:` and `# python:` header lines (plus `# optional: yes` where the app runs without it), and
  `python3 scripts/check_python_envs.py` fails if an environment or a pin drifts from them. Give any new
  requirements file the same header. `openai` in `requirements.txt` looks unused but is imported by the image CLI
  that `scripts/predict_rear.py` runs with `.venv`'s interpreter: keep it. The README table under
  "Installation and checks" is the one place that explains the environments.
- Never import `pycolmap` and `open3d` in one process on macOS (conflicting OpenMP runtimes; native crash).

## Verified traps

1. **Self-calibrated intrinsics are wrong and the gates do not notice.** On the synthetic fixture the true focal is
   1250 px (`public/generated/face-fixture/source.json`); the pipeline recovered 1701 px (+36 %) with radial
   `k = -2.48` on a distortion-free render, while reporting 0.41 px reprojection error and 40/40 views. Supply a known
   camera instead of estimating one. No test checks recovered focal against the stored ground truth yet.
2. **A supplied FOV is silently ignored on existing captures.** In `scripts/photo_cameras.py::recover()` the
   `dataset/sparse/0` legacy-reuse branch returns before the `calibrated` path is reached.
3. **Spark 2.2.0: `covObjectModifiers` is not a constructor option.** The installed build only reads the property and
   never assigns it from options. Set `mesh.covObjectModifiers = [...]` after construction, then
   `mesh.updateGenerator()`. Requires `SparkRenderer({covSplats:true, accumExtSplats:true})` and
   `SplatMesh({extSplats:true, covSplats:true})`.
4. **Do not mesh from Gaussian centres.** Median splat thinness here is 0.2–0.4 (blobs, not surfels). Fuse depth
   rendered at the registered cameras into a TSDF; Open3D 0.18 already has `ScalableTSDFVolume`.

## Licence rule for `.local/third_party`

Everything fetched there is MIT, Apache-2.0 or CC0, so its code may be adapted with attribution kept. Projects under
non-commercial, GPL/AGPL or custom licences (2DGS, RaDe-GS, GaussianAvatars, PhysGaussian, Spirula, OpenMVS, Sapiens2,
FLAME, MANO, SMPL-X) are cited by URL in `OPEN_SOURCE_STACK.md` on purpose: read them for the algorithm, do not paste
from them. Two caveats travel with fetched code: `anny` must stay on `topology="anny"` (its `smplx` option pulls
non-commercial assets), and `face-parsing`'s released weights inherit CelebAMask-HQ's non-commercial terms.

## Not done, on purpose

No model weights, prebuilt binaries or gated assets were downloaded; nothing was installed; no licence was accepted and
no account was used on the owner's behalf. Those choices are listed in section 6 of `OPEN_SOURCE_STACK.md` for the owner.
