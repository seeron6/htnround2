# PUNCHING FACE — tools, research, and how every pipeline actually works

Written 2026-09-20. This is the engineering account of the project: what we used, what we read and
measured before choosing it, and exactly what happens between a webcam frame and a talking, deformable
3D head. It is written to be *checkable*: almost every paragraph names the file that does the work, and
numbers are tagged with where they came from.

**Evidence tags.** Every number below carries one.

| Tag | Meaning |
| --- | --- |
| **[measured]** | Run on this machine, against this repo's own data, and the result is in the repo. |
| **[Sentry]** | Read in our own Sentry project (`punchingface.sentry.io`), with the trace id given. |
| **[test]** | Asserted by a test in `tests/`. `npm test` on 2026-09-20: **432 tests, 430 pass, 2 skipped, 0 fail, 91.4 s**. |
| **[verified]** | Source, licence text, package metadata or an API response read directly. |
| **[estimate]** | An engineering prior. Not measured, and never presented as anatomy or physics truth. |

> **The one-line version.** Scan a head with a webcam; it becomes a physically simulated 3D target;
> you punch it with your bare hands in front of the camera; it deforms, flinches, and — because a
> multimodal model is watching and listening — it sees what you did wrong, hears the room, and talks
> back in its own voice with the right expression on its face.

---

## Contents

1. [The machine, and the constraints that shaped every choice](#1-the-machine-and-the-constraints-that-shaped-every-choice)
2. [Tool inventory](#2-tool-inventory)
3. [Research: what we read, what we tried, and what we threw away](#3-research-what-we-read-what-we-tried-and-what-we-threw-away)
4. [Pipeline A — capture to head model (the reconstruction pipeline)](#4-pipeline-a--capture-to-head-model-the-reconstruction-pipeline)
5. [Pipeline B — vision processing (turning a webcam into punches)](#5-pipeline-b--vision-processing-turning-a-webcam-into-punches)
6. [Pipeline C — contact, tissue and pain](#6-pipeline-c--contact-tissue-and-pain)
7. [Pipeline D — the dynamic voice](#7-pipeline-d--the-dynamic-voice)
8. [Pipeline E — observability](#8-pipeline-e--observability)
9. [Process architecture and data custody](#9-process-architecture-and-data-custody)
10. [The honesty ledger: measured vs estimated](#10-the-honesty-ledger-measured-vs-estimated)
11. [How to run and verify all of it](#11-how-to-run-and-verify-all-of-it)

---

## 1. The machine, and the constraints that shaped every choice

Nearly every architectural decision in this project is downstream of four hardware and toolchain facts.
They are documented with evidence in [`OPEN_SOURCE_STACK.md`](../OPEN_SOURCE_STACK.md) §1.

| Fact | Consequence |
| --- | --- |
| Apple M5 Pro, 64 GB, macOS 26.5, **no CUDA** **[measured]** | Everything famous in 3D face reconstruction is out: `nvdiffrast`, `pytorch3d` CUDA ops, `tiny-cuda-nn`, `diff-gaussian-rasterization`, `gsplat`. |
| **No full Xcode** — Command Line Tools only; `xcrun -f metal` fails **[measured]** | Anything that compiles Metal *at build time* cannot even be installed (OpenSplat-Metal, `trellis-mac`). Run-time Metal (torch-MPS, MLX) is fine. |
| `.venv` is **Python 3.9.6**, and that is a ceiling **[measured]** | `open3d==0.18.0` and `pycolmap==3.13.0` are the last releases with 3.9 wheels. Newer geometry tooling must live in a separate interpreter. |
| `pycolmap` and `open3d` **crash when imported together** on macOS (conflicting OpenMP runtimes) **[verified]** | They are permanently kept in separate processes (`scripts/photo_cameras.py::export_cameras`, `scripts/train_arm.py`). |

So the project runs **three Python environments** that never share a process, plus the browser:

| Environment | Python | Requirements | Runs |
| --- | --- | --- | --- |
| `.venv` | 3.9.6 | `requirements.txt` | capture/reconstruction API, photo pipeline, OMNI relay, sponsor server |
| `.local/newton-env` | 3.13 | `requirements-newton.txt` | `physics_server.py`, `newton_face.py` (Newton 1.6 / Warp 1.17, NumPy 2) |
| `.local/format-env` | 3.13 | `requirements-dev.txt` | Black only |

`python3 scripts/check_python_envs.py` fails if any environment drifts from its requirements header.
`npm run dev` starts each service with its own interpreter (`scripts/dev.mjs`).

---

## 2. Tool inventory

### 2.1 Browser runtime

| Tool | Version | What it does here |
| --- | --- | --- |
| **Three.js** | 0.180.0 | The whole render path: lit head material, morphs, wireframe/geometry views, GLB export. |
| **Vite** | 8.3.0 | Dev server on :5173 and the production build. HMR is **off by default** (`CONTACT_HMR=1` to enable) so an edit cannot reset a live camera session. It also sets the `Document-Policy` header that enables browser profiling. |
| **MediaPipe Tasks-Vision** | 0.10.32 | `HandLandmarker` (2 hands, GPU delegate, VIDEO mode), `PoseLandmarker`, `FaceLandmarker` (468 landmarks + blendshapes). Runs inside dedicated workers. |
| **Web Audio + AudioWorklet** | — | Mic tap at 20 ms frames, PCM16 mono 16 kHz encode, 24 kHz playback scheduling, and the `AnalyserNode` that drives lip-sync. |
| **@sparkjsdev/spark** | 2.2.0 | Gaussian-splat renderer. **Retired from the active path** (§3.1); kept in `node_modules` and studied for the covariance-splat deformation route. |
| **livekit-client** | 2.22.3 | Optional multi-device arena: streams the head to guests, receives their punches over the data channel. |
| **@sentry/browser** | 10.75.0 | Tracing, Session Replay, Logs, Metrics, User Feedback, errors. Loaded only when a DSN exists. |
| **React 18 + Tailwind 4** | — | The UI shell around the vanilla 3D app (`src/app/main.tsx`). The 3D app itself is not React. |
| **@gltf-transform/\*** | 4.5 | GLB export with morph targets and the photo texture embedded. |
| **TensorFlow.js BodyPix** | — | A segmentation *pilot* for arm masks. Failed visual review and is not in the live path (§3.3). |

### 2.2 Python — reconstruction (`.venv`, 3.9)

| Tool | Version | What it does here |
| --- | --- | --- |
| **pycolmap** | 3.13.0 | Structure-from-motion: feature extraction with a mask path, exhaustive matching, incremental mapping. Recovers per-view camera poses and intrinsics. |
| **NumPy / SciPy** | 1.x | The triangulation, the RBF warp, `map_coordinates` sampling, KD-trees, Delaunay. |
| **trimesh** | — | Mesh hygiene: normals, watertightness check, the non-rigid plumbing. |
| **xatlas** | — | UV atlas generation for the baked texture. |
| **Open3D** | 0.18.0 | Poisson surface reconstruction, retained for the splat experiments and fixtures. |
| **Pillow** | — | Frame decode, crops, thumbnails, texture I/O. |
| **plyfile** | — | Reading Gaussian PLYs in the research paths. |

### 2.3 Python — physics (`.local/newton-env`, 3.13)

| Tool | Version | What it does here |
| --- | --- | --- |
| **Newton** | 1.6 | The soft-tissue solver: XPBD tetrahedral FEM over a three-layer facial cage with a kinematic spherical fist collider. |
| **NVIDIA Warp** | 1.17 | Newton's kernel backend. **CPU device** on this machine — Warp on macOS is CPU-only, and its kernel launches are serial. That fact is the root of Sentry finding 1 (§8). |

### 2.4 Cloud services

| Service | Model / endpoint | Role |
| --- | --- | --- |
| **OpenAI Responses API** | `gpt-4o-mini` (capture review), `gpt-6-astra` (modelling priors), image API (rear prediction fallback) | Strict-JSON-schema vision calls that produce *bounded, labelled modelling priors and capture instructions*. Never geometry. |
| **Codex** | — | The development teammate: wrote the application code, the fixtures and most of the tests. |
| **Qwen3.5-Omni** via **yibuapi** | `qwen3.5-omni-flash` (demo), `qwen3.5-omni-plus-realtime` (built, not demoed) | The face's eyes, ears, voice and expression. One request per turn carries video + audio + language. |
| **Meshy** | multi-image-to-3D (`latest`, 30 000 tris) | The alternative reconstruction engine in the scan dialog, for side-by-side comparison on the same scan. |
| **ElevenLabs** | `eleven_flash_v2_5` | Backup voice. Wired and tested against a fake upstream; **has never produced audio here** — the saved key lacks the Text-to-Speech permission. |
| **Sentry** | `punchingface.sentry.io` | Tracing, Replay, Logs, Profiling, Metrics, AI Agent Monitoring, User Feedback, Errors across all five processes. |

### 2.5 Assets and third-party sources

`.local/third_party/` holds **17 pinned, permissively licensed entries** (724 MB), each licence read
directly **[verified]**. Recreate with `.venv/bin/python scripts/setup_third_party.py`; pins in
`scripts/third_party_manifest.json`. Highlights:

- **CC0 MakeHuman-family head template** — the full head (skull, ears, neck, scalp) the face is fitted into.
- **ICT-FaceKit** (MIT) — 26 719-vertex full-head template, 100 identity modes, 53 ARKit-named expressions.
- **GNM Head** (Apache-2.0) + `gnm-webcam-puppet`'s 473 MediaPipe-landmark→vertex correspondences.
- **MoGe** (pinned pre-v3), **Depth-Anything-3**, **map-anything** — depth/pose references for the TSDF route.
- **Hierarchical-Localization + LightGlue** (Apache-2.0) — the learned-feature re-registration recipe for arms.
- **face-parsing** (BiSeNet, MIT code) — 19-class parsing including eyeglasses.
- **JoltPhysics.js**, **ten-minute-physics** — soft-body references.
- **yibuapi-examples** — the sponsor's canonical audit-ledger writer, imported rather than copied.

**Licence rule.** Only MIT / Apache-2.0 / CC0 sources are fetched and adapted. Non-commercial, GPL/AGPL
or custom-licensed projects (2DGS, RaDe-GS, GaussianAvatars, PhysGaussian, FLAME, MANO, SMPL-X,
FaceFusion) are **cited by URL and read for method only** — nothing is pasted from them.

### 2.6 Development tooling

`node --test` (108 test files: 62 `.test.mjs` + 46 `_test.py`), Prettier 3.9.8 + Black at 88 columns,
`scripts/pipeline_accel.py --status/--pin` (SHA-256-pinned accelerators that disable themselves when the
reference function is edited), `scripts/check_python_envs.py`, `npm run sentry:doctor`,
`.venv/bin/python scripts/omni_preflight.py`.

---

## 3. Research: what we read, what we tried, and what we threw away

The three research documents are [`RESEARCH.md`](../RESEARCH.md) (reconstruction and contact literature),
[`OPEN_SOURCE_STACK.md`](../OPEN_SOURCE_STACK.md) (what actually installs and runs on this Mac, with
evidence tags) and [`HEAD_RECONSTRUCTION_PLAN.md`](../HEAD_RECONSTRUCTION_PLAN.md).

### 3.1 The Gaussian-splat route, and why it is not in the product

The original design was: webcam photos → COLMAP → **Brush** Gaussian training on the Apple GPU → Poisson
surface from the splats → punchable mesh. It was implemented, and it failed at a specific, measurable
place.

- **Poisson on Gaussian centres lands 31–33 mm from the measured landmarks** and the quality gate refuses
  it (jobs `38f42aa3…`, `cc7e8283…`, in their `status.json`). **[measured]**
- The reason is in the data: `reconstruction.py` treats splat centres as surface samples and the smallest
  covariance axis as the normal, but **median splat "thinness" is 0.38 on real captures and 0.20 on the
  fixture** **[measured]** — these are volumetric blobs, not surfels. There is no surface there to Poisson.
- The literature's answer (2DGS, RaDe-GS, PGSR, SuGaR; [SplatFace, arXiv 2403.18784](https://arxiv.org/abs/2403.18784);
  [Gaussian splats for facial geometry, arXiv 2512.16397](https://arxiv.org/abs/2512.16397)) is to mesh from
  **depth rendered at the training cameras fused into a TSDF**, and to add surface/semantic constraints —
  not to mesh from centres. Those papers explain the failure precisely.

We did not have the hours to implement surface-constrained splat training without CUDA, so the product
pivoted to **measured landmarks + a fitted complete head template**, which is what ships. `src/main.js` no
longer imports Spark and every job reports `"usesSplats": false` **[verified]**. The splat code and the
`.local/third_party/spark` sources are kept because the covariance-splat deformation path is the obvious
next step — including a trap we found and recorded: in Spark 2.2.0 `covObjectModifiers` is **read but never
assigned from constructor options**, so passing it to the constructor is a silent no-op **[verified]**.

### 3.2 The self-calibration finding (the most important negative result)

`scripts/render_face_fixture.py` renders a synthetic head with an ideal pinhole camera and stores the
ground truth in `public/generated/face-fixture/source.json`. Running the pipeline on those renders with no
FOV supplied:

| | focal | horizontal FOV | radial `k` |
| --- | --- | --- | --- |
| Ground truth | 1250 px | 34.2° | 0 |
| Recovered by self-calibration | **1701 px** | 25.4° | **−2.48** |

**+36.1 % focal error, with absurd distortion on a distortion-free render** — while the same job reported
**0.409 px reprojection error and 40/40 views registered** **[measured]**.

This is why the project treats reprojection error, registration count and camera span as *insufficient*
quality signals, and why `scripts/photo_cameras.py::recover()` has a known-FOV path that fixes
`SIMPLE_PINHOLE` intrinsics and disables refinement. The mechanism is geometric: a head turning in front of
a fixed camera is an orbit at constant radius around one small object, so focal length and subject distance
trade off almost freely and `SIMPLE_RADIAL`'s `k` absorbs the rest.

**Known trap, still open:** in `recover()` the `dataset/sparse/0` legacy-reuse branch returns *before* the
calibrated path, so on a capture that already has recovered cameras a supplied FOV is silently ignored
**[verified]**. It is recorded in `AGENTS.md` rather than hidden.

### 3.3 Arms: why the personal-arm scan does not register

Arm job `879025fd…`: **24 of 59 views registered, 427 sparse points, 11.31° of camera spread** — it failed
the registration requirement and never started training **[measured]**. Bare forearm skin has almost no
SIFT-stable texture, and the mask removed the textured background and clothing that could have carried
registration. A TensorFlow BodyPix segmentation pilot removed the contaminating face/torso pixels but also
removed valid fist and elbow pixels, so it failed visual review and **no geometry was invented to replace
the missing regions**. The recipe for fixing it (ALIKED + LightGlue into a COLMAP database via
Hierarchical-Localization) is written up but not executed. Live CV arms and preset arms ship instead.

### 3.4 Contact and pain literature

- [Physics-Based Simulation of Contact-Induced Facial Wrinkling](https://thomaszewski.com/projects/face-wrinkling/index.html) (SCA 2026)
  is the target behaviour — transient compression/shear, viscoelastic skin, spatially varying attachments,
  solid-shell FEM with ligament constraints. **Much richer than what we run.** We took the *idea* of
  spatially varying attachment stiffness; we did not implement their solver.
- [Learning a Generalized Physical Face Model From Data](https://cgl.ethz.ch/publications/papers/paperYan24a.php) (SIGGRAPH 2024)
  and [Efficient IPC for Actuated Face Simulation](https://cgl.ethz.ch/publications/papers/paperYan23b.php) —
  read, neither implemented.
- **FaceFusion** was read **for method only** (it is OpenRAIL-AS and 2-D). What transferred is its *rig
  algebra*: pose = `scale * (points @ rotation.T + expression) + translation`, so head turn and expression
  are separate channels; each control is one scalar in −1…1 moving a few named points; controls are summed
  then clamped **once** to a calibrated box; eyes and lips are driven as a **ratio of that face's own**
  lid gap and mouth width. `src/pain-rig.js` is built on those four ideas, in 3-D, from scratch.
- The grimace action units come from Prkachin's
  [comparison across pain modalities](https://pubmed.ncbi.nlm.nih.gov/1491857/): brow lowering, orbital
  tightening, nose wrinkle, upper-lip raise.

### 3.5 Reference collection discipline

Four supplied impact photographs were kept unmodified with source records; the local detector extracted 468
landmarks from three and **rejected the fourth**. Landmarks occluded by gloves are model predictions and are
explicitly not treated as measured 3-D positions. The search script records queries, timestamps, URLs and
rejected-result counts; an RSS provider that returned unrelated results during validation was **filtered,
not accepted**. No impact network was trained, and no physical punch capture was requested from anyone.

---

## 4. Pipeline A — capture to head model (the reconstruction pipeline)

Entry point: `scripts/build_photo_face.py::run()` (launched via `scripts/build_photo_face_fast.py`, which
installs the accelerators then calls `run()` unchanged). Orchestrated by `face_pipeline.py::FaceStore` on
:5174; every stage is a `PipelineTimer.mark()`, which becomes a Sentry span.

```
capture.json + images/ + masks/
        │
   ┌────▼──────────────────────────────────────────────────────────────────┐
   │ 1 cameras     pycolmap: masked SIFT → exhaustive match → incremental  │
   │ 2 geometry    multi-view IRLS triangulation of 468 landmarks          │
   │               + HELD-OUT VIEW GATE #1                                 │
   │ 3 template    CC0 head template + regularized global RBF warp         │
   │               + Catmull-Clark subdivision                             │
   │ 4 astra       OpenAI: bounded priors + accessory contours             │
   │ 5 eyes        sharpest recorded eyes; AI detail only when needed      │
   │ 6 hair        silhouette-fitted envelope + 3D strand groom            │
   │ 7 semantics   ears, opaque glasses, ear ownership                     │
   │ 8 completion  apply_shape_prior — UNOBSERVED SKULL VERTICES ONLY      │
   │               + HELD-OUT VIEW GATE #2 (on the final surface)          │
   │ 9 accessories independent rim / lens / bridge / temple meshes         │
   │10 texture     visibility-weighted photographic bake into a UV atlas   │
   │11 rig         Newton cage, landmark bindings, morphs, lip topology    │
   └────┬──────────────────────────────────────────────────────────────────┘
        ▼
 mesh.json · appearance.png · appearance-roughness.png · texture-atlas.json
 physics-*.json · glasses · hair groom · model-release.json
```

### 4.1 Capture (browser)

`src/face-capture.js` + `public/face-worker.js`. Live recording stops at **120 s or 240 accepted frames**;
a video import extracts **up to 220 samples locally**. Each accepted frame is stored with a head mask, its
MediaPipe 468 landmarks when the face is trackable, and an estimated yaw. Profile and rear frames are kept
and labelled `head-only` with **unknown angle** — no facial landmarks are invented for them. Requirements
to proceed: **≥ 24 overlapping views and ≥ 12 tracked facial views**. The original recording never leaves
the laptop and is never sent to any AI service.

### 4.2 Camera recovery — `scripts/photo_cameras.py`

`pycolmap` with `reader.mask_path` pointed at the head masks, `num_threads = 4`, exhaustive matching, then
incremental mapping. If `capture.json` carries `horizontalFovDegrees` (10–150), the camera is pinned to
`SIMPLE_PINHOLE` at `f = w / (2·tan(fov/2))` with refinement disabled, and `matches_supplied_fov()` re-checks
the cached reconstruction against it. Results are cached by a SHA-256 of `capture.json`.

**COLMAP is not deterministic run to run** here — the same frames gave 40 and 49 registered views on two runs
**[measured]** — so any A/B comparison must share one `photo-cameras/` folder.

### 4.3 Triangulation — `scripts/photo_geometry.py::robust_landmarks`

For each registered view, each of the 468 landmark pixels becomes a ray:

1. `camera_rays()` un-projects the normalised landmark through `cam.cam_from_img`, rotates it into world
   space by the view's pose, normalises it, and records the projection centre.
2. `robust_landmarks()` solves the classic **point-nearest-to-N-rays** least squares — each ray contributes
   the projector `I − dd^T`, and the stacked normal equations are solved per landmark — then runs **8 IRLS
   re-weightings** with a MAD-based robust scale (`1.4826 × median`, weights `min(1, 1.5σ/e)`).
3. If `cond(A) > 1e6` for any landmark it raises *"Insufficient angular diversity for stable face depth"* —
   a badly conditioned solve is refused, not smoothed over.

**Gate #1.** Views are ordered by yaw and **every fifth view from index 2 is withheld** (`ordered[2::5]`).
The point cloud is triangulated from the remainder and re-projected into the withheld views. If
`medianPx > 4` or `p95Px > 12`, the build **fails with a capture instruction** rather than producing a head.

### 4.4 Head frame, scale and orbit coverage

The measured cloud is put into a canonical frame: centre = midpoint of landmark 10 (hairline) and 152
(chin); `right` = 263 − 33 (outer eye corners); `up` = 10 − 152 orthogonalised against `right`; forward =
their cross product. The nose (landmark 1) must lie in front of the eye midpoint or the orientation is
rejected. Scale is set so **hairline-to-chin = 0.20 m** — a nominal figure, since a monocular scan has no
metric reference.

Each camera's yaw around the head is computed, and `orbitCoverage` reports the **recovered angular span**
(the largest gap subtracted from 360°) and the number of **registered rear views** (|yaw| > 115°).
`completeOrbit` requires **span ≥ 300° and ≥ 3 rear views**. A front-only capture can never be described as
a 360° scan.

### 4.5 Template fitting — `scripts/fit_head_template.py` + `scripts/template_selection.py`

The face is not meshed from the point cloud. A **complete CC0 head template** (skull, ears, neck, scalp,
eyelids, mouth) is warped to the measurements:

1. **Catmull-Clark subdivision** of the quad template, implemented in-repo (`catmull_clark`), with correct
   boundary rules — so facial loops, ears, skull and neck stay smooth.
2. The template's anchor landmarks are **symmetrised** across 19 left/right pairs and mid-line anchors are
   forced to `x = 0`. This symmetrises the *neutral template registration*, never the scanned identity.
3. Anisotropic pre-scale from the measurements: `sy` from hairline-to-chin, `sx` from cheek width (234↔454),
   `sz = (sx+sy)/2`; translation anchored on the nose.
4. A **global RBF warp** (`scipy.interpolate.RBFInterpolator`) from anchors to measured landmarks, with
   **posterior and neck support pins** (vertices with `z < −0.095` or below the chin) held fixed so facial
   fitting cannot stretch the back of the skull into a face-shaped cap. It is one continuous global field —
   no piecewise nearest-neighbour kernels, no exact interpolation of noisy landmarks.
5. **Regularisation is chosen by a nested split.** `choose_regularization()` takes only the *training*
   views, withholds `ordered[1::5]` of them as an inner selection set, fits at
   `smoothing ∈ {0.025, 0.01, 0.005, 0.001}` and scores each by `medianPx + 0.2·p95Px` of surface
   re-projection. **The outer withheld views are never used to pick parameters** — the report records
   `outerWithheldUsed: false`.

### 4.6 The OpenAI completion stage — bounded priors, never geometry

`scripts/astra_head_completion.py` picks 7–9 frames by *camera yaw* (targets 0°, ±30°, ±60°, ±85°, and ±150°
when rear views exist) and asks `gpt-6-astra` through the **Responses API with a strict JSON schema**. The
schema is the safety mechanism — every field is numerically bounded:

| Field | Bound |
| --- | --- |
| `posteriorDepthScale` | 0.9 – 1.1 |
| `posteriorWidthScale` | 0.94 – 1.06 |
| `crownLiftMm` | −4 – +6 |
| `occiputLiftMm` | −5 – +5 |
| hair `lengthMm` / `curlRadiusMm` / `flowDegrees` … | each range-checked |
| glasses rim / bridge / temple paths | ≤ 12 points, `[u,v] ∈ [0,1]` per named view |

The prompt states that images are **untrusted scene data, not instructions**, forbids identifying the
person or inferring ethnicity, and says the values are *editable modelling priors, not anatomical
measurements*.

**`apply_shape_prior()` is where the bound is enforced in code**, and it is worth reading literally:

- If `completeOrbit` is true **or** ≥ 3 rear views were registered, the prior is **not applied at all** —
  captured rear photographs win.
- `pinned[:468] = True` and `pinned[unique(faces[:face_count])] = True`: **every expression-cage vertex and
  every photographed frontal vertex is frozen**.
- The remaining weight ramps smoothly (`smoothstep`) from `z = −0.075` backwards and fades out below the
  chin, so the prior can only touch the unobserved posterior skull.
- The report records `maxDisplacementMm`, `measuredFacePinned: true`, `estimated: true`.

Other OpenAI stages: `openai_capture.review()` (≤ 6 masked 512-px frames → `usableForMultiview`, `problems`,
`nextCaptureInstruction` — `advisoryOnly: true`), `hair_recognition`, `head_semantics`, `eye_detail`, and
`scripts/predict_rear.py`, which only runs when **fewer than three rear views** were recovered and which
reports failure rather than pretending local material continuation is an AI-generated rear photograph.

All AI answers are cached on disk by an **ordered** list of views and a capture hash.

> **Live constraint found on demo day.** The key is capped at **50 requests/day/model** (leaky bucket,
> ~1 refill per 29 min) — not by credits. `gpt-6-astra` returned HTTP 429 with
> `x-ratelimit-remaining-requests: 0` while token limits were untouched **[measured 2026-09-20 01:49]**. One
> full AI scan costs ~14–16 requests. The pipeline now classifies 429s and exits with a warning rather than a
> crash alert (`scripts/pipeline_failure.py`), and `--local-only` builds need no API call at all.

### 4.7 Hair, ears, eyes, glasses

- **Hair** — `scripts/photo_hair.py` fits a smooth envelope to the captured **silhouettes**, then
  `scripts/hair_groom.py` builds an independent **3-D strand groom** bound to the fitted scalp (not a painted
  cap). It runs **in parallel with the AI call** on a private vertex copy; if the model answers "no hair",
  that result (and any exception from it) is simply never consumed and the template stays authoritative.
  Missing crown hair uses continuous **Cartesian triplanar synthesis**, so there is no spherical texture pole.
- **Ears** — triangulated from the frames, fitted against the *final* head envelope so later silhouette or
  prior changes cannot invalidate the check, with a separate ear-ownership refinement.
- **Eyes** — `scripts/eye_detail.py` scans the sharpest recorded eyes; `fit_eye_depth` recesses the eyeballs
  behind the fitted eyelids. Iris, pupil, sclera and roughness get their own textures.
- **Glasses** — lifted through the recovered frontal camera into **independent rim, lens, bridge and temple
  meshes**, with bevelled acetate sections, tapered arms and hinge plates; visible profile contours constrain
  the temple paths against the head. The masked frame ink is inpainted **out of the skin texture**, so the
  eyewear is a separable object rather than paint.

**Gate #2.** After every shape stage, `surface_projection_error()` re-projects the *fitted surface's*
landmark bindings into the same withheld views. Same thresholds (median ≤ 4 px, p95 ≤ 12 px); failing means
the build is refused. The triangulation gate alone cannot catch template-fitting drift, which is why there
are two.

Then `trimesh` fixes normals and the mesh must be **watertight with finite vertices** or the build fails.

### 4.8 Texture bake — `scripts/photo_geometry.py::bake_photographs`

UVs come from `xatlas`. For each registered view the mesh is rasterised (`raster_atlas`) and a **z-buffer**
(`zbuffer`) decides visibility per texel; contributions are weighted by facing and visibility, with exposure
matching and smooth side transitions, one frontal source preferred for central features to avoid ghosting.
Eyewear pixels are masked out via the AI-supplied `eyewearRegions` polygons even when glasses confidence is
low. Hidden mouth surfaces get a neutral material. UV seam duplicates are recorded so that **seam copies move
identically** under deformation (asserted by tests).

### 4.9 Rig and physics cage — `physics_binding()`

The simulation cage is **not** the render mesh. The first 468 vertices (the measured landmarks) are resampled
in the frontal plane using the face-oval boundary list; tiny eyelid and lip slivers are unsuitable as
volumetric finite elements, so separated nodes are kept and reconnected via Delaunay. The dense render mesh
is then bound **barycentrically** to that cage, so Newton's displacements interpolate onto every rendered
vertex.

### 4.10 Lips, teeth and tongue — `src/lip-topology.js`, `src/mouth-interior.js`

Every head, from either engine, gets lips that can part **at load time**, decided by geometry rather than by
which engine built it:

- **Cut** (typically Meshy): sealed lips are refined, a seam is cut along the detected lip line, and a mouth
  pouch is added. Deleting triangles to open a mouth is explicitly forbidden — on ~6 mm lip triangles it
  produces the black-shard bug.
- **Adopt** (typically the local pipeline): lips that are already parted are labelled and the interior
  darkened.

Order matters and is pinned by tests: in `loadPhotoFace`, `await fitMouth(…, cage)` runs **before**
`new NewtonFaceDynamics`, together with `growBinding()` — a cut changes the vertex count and Newton must bind
to the final buffer. `window.__faceDetection.lips` reports `cut`, `adopted`, or the reason it was refused.

### 4.11 The accelerator: 309 s → 122 s, byte-identical

`scripts/pipeline_accel.py` replaces four leaf functions (`photo_geometry.zbuffer`,
`photo_geometry.raster_atlas`, threaded `map_coordinates`, streamed `prepare_detail_frames`) and prefetches
the AI calls concurrently. Measured on capture `7a2bc070…` (`IMG_7496.MOV`, 24.3 s, 51 views, 40 cameras),
fresh builds with every cache deleted, back to back **[measured]**:

| | Serial | Accelerated |
| --- | ---: | ---: |
| cameras | 10.6 | 13.8 |
| astra (`complete`, then hair) | 67.1 | 37.1 |
| eyes | 10.5 | 0.0 |
| semantics | 100.9 | 7.6 |
| accessory-cleanup | 14.3 | 0.6 |
| surface / hair envelope / rig | 3.2 | 2.3 |
| accessories | 27.5 | 3.1 |
| texture | 74.7 | 57.9 |
| **total** | **308.7 s** | **122.4 s** |

**Every output is identical** — `appearance.png` and `appearance-roughness.png` byte for byte, plus
`mesh.json` positions/normals/indices/anchors/accessories, `texture-atlas.json`, `physics-*.json`, all 51
detail frames and all four AI cache files. The replacements are **pinned to a SHA-256 of the reference
source**; if anyone edits the reference the accelerator switches itself off and the build log says `STALE`.

Two traps found while measuring, both recorded: `X@R.T` on a tall `(6M,3)` array costs ~0.9 s on macOS
Accelerate **and serialises concurrent callers** (rewritten as `(R@X.T).T`, bit-identical, ~0.03 s); and
`prepare_detail_frames` costs 58 s on a genuinely fresh capture (255 HEVC seeks) but every benchmark rebuild
found it cached — so older published timings are not fresh-build timings.

### 4.12 The second engine — Meshy

`meshy_backend.py` + `src/meshy-engine.js`. The scan dialog can build the *same saved scan* with Meshy's
cloud multi-image-to-3D instead. It selects **up to four cropped, background-free views** — the most frontal
tracked view first (Meshy treats image 1 as primary), the widest tracked turn each way, and the middle of the
longest run of untracked frames as the far side — and shows exactly which images were sent. The result lands
as `meshy/model.glb` and loads through the ordinary GLB import path, so it gets preview springs, the facial
impact rig and the lip topology, but **not** the Newton cage, hair strands or glasses. An interrupted task is
resumed rather than re-paid for. Cost ≈ 30 credits, 1–3 minutes.

`tests/meshy_backend_test.py` covers view choice, cutouts and the full task lifecycle against a local
stand-in. **The real API has only been exercised as far as authentication** — Meshy's documented test-mode key
is no longer accepted, so a first real paid build is the remaining check.

---

## 5. Pipeline B — vision processing (turning a webcam into punches)

This is the part of the system that is most often mis-stated, so it is written here as it actually is.
Reference: [`docs/target-cv-pipeline.md`](target-cv-pipeline.md). One camera, sitting where the head is,
looking back at the puncher.

**The deliverable is a per-punch report**, not a per-frame classification: impact location on the 3-D mesh,
contact velocity, force direction, punch type, hand — **exactly one report per physical punch**.

### 5.1 Why it is a solver, not a state machine

Three facts force the architecture:

1. Every reported quantity is a property of a **whole trajectory**. Impact location is where the trajectory
   crosses the surface; velocity is the derivative at contact; type is the shape of the terminal arc. So the
   final stage must solve over a *completed observation window*, and everything upstream is evidence
   collection.
2. "One punch = one event" is also a statement about the trajectory: a punch is **approach → apex → retreat**.
   The apex is the one unambiguous instant. Emit at apex-confirmation, once, and **retraction can never fire**
   — retraction is the confirming half of the same pattern.
3. The camera measures the image plane superbly and depth badly, and **landmarks die exactly at the
   interesting moment** (a 5 m/s fist smears ~80 mm per 60 Hz exposure; MediaPipe drops it). So detection may
   not depend on any single fragile stage.

The previous design — per-frame rigid fit → Kalman → per-track online state machine — had accumulated **five
separate de-duplication layers**. Needing five dedup layers means the event source is wrong.

### 5.2 Layer 1 — capture (`public/target-worker.js`, `public/tracking-worker.js`)

Two evidence streams are produced per frame, in a worker, so the render loop never blocks:

**Hand stream (precise, fragile).** MediaPipe `HandLandmarker`, 2 hands, GPU delegate with automatic CPU
fallback, `minHandDetectionConfidence 0.35`, `minTrackingConfidence 0.30`. Landmarks + `worldLandmarks`.
GPU delegate cuts inference from ~30–60 ms to ~5–10 ms on Apple Silicon.

**Motion stream (coarse, blur-proof).** `public/target-motion.js`: frame differencing at **96 px wide** →
connected components → up to 2 blobs with centroid, mass, RMS spread, **block-matched mean translation** and
**expansion rate** from a similarity-flow fit. Motion blur *helps* this stream.

MediaPipe's `PoseLandmarker` runs in the same worker when arms are being driven; segmentation masks are off
unless the arm-capture flow asks for them (they cost ~15 ms/frame).

> **A measured correction worth keeping.** MediaPipe 0.10.32's handedness is **not** flipped: `"Left"` is the
> user's left on unmirrored frames **[measured]**. Several older assumptions in the arm code were built on the
> opposite belief.

### 5.3 Layer 2 — observation building (`src/target-camera.js`, `src/fist-pose.js`)

`fist-pose.js` fits a **rigid 6-DOF pose** of a closed fist: Horn absolute-orientation alignment onto a
learned per-hand template, then Gauss-Newton translation along the observed rays, returning a **measured
per-axis covariance**. This gives metric camera-frame position, knuckle-normal orientation, closure, and an
honest variance.

Sample tiers, and the rule that matters:

- **rigid** — a successful fit. Depth is measured.
- **span (anchored)** — the fit failed but landmarks exist **and a recent rigid fit can lend depth**. Depth is
  **inertial**, carried from that anchor, **never derived from apparent size**. Apparent size conflates
  rotation with distance: a stationary fist rotating as the elbows lift halves its knuckle span, which
  span-depth read as a tens-of-centimetres phantom approach.
- **observed only** — no anchor. **Nothing enters the trajectory.** The identity stays alive (association
  prediction, liveness, rest lineage) without inventing a position. The old anchor-less tier fabricated about
  one phantom jab per second from a fist held near the lens; it is gone.

### 5.4 Layer 3 — the core (`src/punch-events.js`, pure, 1 705 lines)

**Slots, not tracks.** At most two persistent slots hold ~1 s of time-ordered samples. Association is
nearest-neighbour to a **blob-informed predicted position** (the blob's measured flow updates velocity, its
centroid the position), while the gate grows with **landmark silence** — identity uncertainty grows while
nobody has actually *seen* the hand, however confidently motion tracked something. A slot is a *bucket of
evidence*, not an event owner, so an association mistake only misfiles samples; it cannot double-fire.
**MediaPipe handedness never keys identity** (the front of a fist is chirally ambiguous) — it is one weighted
vote at classification time. Slots also learn a **rest position** (an EMA over sustained slow samples), which
becomes the strongest hand-identity evidence.

**The range signal.** Per sample, camera-frame metric position `p = (x, y, z)` and `r = |p|` — the **range to
the head centre**, not depth. A hook closes laterally with almost no depth change; an uppercut rises; every
punch that lands **closes range**.

**Retrospective extraction**, running 2–4 frames behind real time, as a pure `buffer → candidates` function:

- Smooth `r(t)` with a **local weighted quadratic fit** (tricube window ≈ ±90 ms, weights from sample
  variance). Derivatives come from the fit — no causal filter, so no lag/overshoot tuning, and a single noisy
  frame cannot cross a threshold.
- An **apex candidate** is a *bracketed* local minimum: at least two fitted samples ≥ 2 cm above the minimum,
  sustained ~70 ms, with the trajectory still up there now. Or it is **censored** — samples stopped while the
  punch was live — judged on the trailing window's **peak** closing, not the last sample's, because a hook
  that blurs out in its tangential phase was closing hard 100 ms earlier. The timeout runs from the last
  *evidence* (blob bridge included), not from landmark death.
- **Gates**, all measured on the fitted window: range travel ≥ `minTravel`; peak **windowed-linear** closing
  speed ≥ `minPeak` (1.0 m/s; a quadratic fit through three noisy points turns 1 cm of depth noise into
  metres per second, so speed alone uses a linear slope); fist-closure evidence over the approach. Two kinds
  of truncated evidence soften the gates: born against a frame border, and born mid-frame already fast.
- **The approach must be measured, not manufactured.** The range a candidate claims to have closed must be
  substantially witnessed by rigid or anchored-span samples (≥ 40 % of the claim). Blob expansion may *carry*
  an approach through blur; it can never *constitute* one. The same rule governs re-arming.
- **A punch must ARRIVE**: the apex must fall within `strikeRange` (45 cm) of the head. Any inward lateral
  guard shift closes range geometrically and brackets itself on the way back — but it terminates at guard
  distance, and no real punch terminates half a metre from the face.
- **Instant fire**: `r̂` crossing `contactDepth` (12 cm — deliberately deep) while closing fast emits
  immediately and consumes the window through the upcoming apex.

**Arbitration — dedup as a structural property.** Each emitted event **consumes** its slot's samples through
the confirmation time. Across slots, a second view of a just-emitted strike is caught two ways: **image
support** (< 280 ms, < 0.22 image units — MediaPipe reporting one fist as two overlapping hands) and
**temporal exclusivity** (< 400 ms — blur can displace one fist arbitrarily far, but it cannot make one fist
appear **twice at once**; two real fists coexist on screen, fragments take turns). The single exemption: when
*both* sightings independently observed a complete approach→apex→sustained-retreat, they are two real punches
thrown through a dropout.

**The solver** — every reported number from the same fit:

- **Contact time** `t*` = the fitted apex (or the plane-crossing time for an instant fire).
- **Terminal probes** on a 10 ms grid over `[t*−220 ms, t*]`, each its own per-axis local weighted quadratic.
  A single window-wide polynomial is too stiff to carry a hook's rotating velocity and reports the chord.
- **Direction** = average over the last ~60 ms of *qualifying* probes — fitted speed above an absolute floor
  (0.35 m/s) **and** actually closing on the head. At a shadow-punch apex the fist has stopped, so velocity
  there is ill-conditioned; walking back to the last travelling moment gives the terminal tangent. An
  invariant backstops it: a hit's direction may not travel meaningfully back toward the puncher.
- **Impact point** = the **first** point of the measured trajectory that touches the face (`firstContact`),
  never where the fist happened to stop. Only the slice within ~10 cm of the closest approach is
  contact-eligible; crossings are interpolated onto the silhouette; near-skims within a fist-width graze on.
  One rule for every punch type — a follow-through hook lands on the cheek it **came in through**.
- **Type** is classified once, from full-window evidence, and the evidence is **image-first**: a hook
  translates across the image, an uppercut climbs it, a jab barely moves — it looms. The image sweep is
  **divergence-corrected** first (an approaching fist's image position diverges radially from the frame
  centre, so a jab above a low laptop camera "rises" ~0.2 image units with zero vertical motion). Hard rules,
  each earned by a live misclassification: **no hook verdict without image support**; **no uppercut verdict
  without image-plane evidence of a rise**; **orientation may not overrule clean travel**; and travel itself
  is solved on **rigid samples only**, because a frozen-depth sample fits `dz ≈ 0` and collapses a straight
  punch's direction onto lateral noise. Where the fist *points* (`axis`) and which *face* of the hand shows
  (`facing`) are measured **in the image plane**, in fist-widths — a fist aimed at the camera reads ~0.16, an
  uppercut 0.4–0.9, and an edge-on guard fist ~0.11 against 1.0 for any face-on punch. The branch that decided
  ships on the event as `why`.
- **Hand** (left/right of the *puncher*) is a weighted vote where physically grounded geometry outranks
  MediaPipe: the slot's learned **rest position**, **elimination** (a fist visibly resting elsewhere right now
  is not the one that landed), the metric **wrist trail**, then handedness as one vote.

**One zone rule after the solve:** an event arriving below ~1.15 × the head's half-height is a chest/shoulder
strike — there is no head there — so it is ignored outright, but it still consumes its evidence so its
fragments cannot resurface.

### 5.5 Layer 4 — onto the mesh (`src/punch-mapping.js`, `src/main.js::contact`)

The reported impact point and travel direction are **raycast along the strike direction** onto the current
editable mesh, using the fitted facial landmarks (not neck/shoulder bounds). Inward crossings are required;
nearby silhouette grazes snap to a mesh vertex; distant misses are rejected. Points, normals and forces stay
in the mesh-local frame. The result goes through the existing `contact()` function, which publishes
`window.__lastContact` and dispatches the `punching-face-contact` DOM event — the single seam that the voice
panel, the telemetry, the flight recorder and the LiveKit arena all read, and the reason none of them need a
line inside `main.js`.

**Validation limits, stated plainly.** `npm test`, `npm run build` and browser replay through
`window.__punchingFace.feedPunchFrames()` (`tests/helpers/punch-replay.mjs`) exercise classification, mesh
projection and visible deformation. They **do not** measure recognition accuracy for real people under venue
lighting. Speed is a monocular estimate from assumed FOV and learned hand size.

### 5.6 The third vision path — what OMNI sees

Separate from all of the above, `src/sponsors/cornerman.js::keyframe()` grabs the webcam `<video>` every
**500 ms** into a **320-px-wide** canvas, encodes JPEG at **quality 0.6**, and keeps a rolling **6-frame**
buffer — the last 3 seconds. Those six frames go up as **one `video` part**, not six images
(`omni_senses.vision_parts`, which falls back to images below 4 frames). The gateway bills it as
`video_tokens`: **6 frames = 242 tokens against 328 for 4 separate images** **[measured]**, and the model
reasons over motion — on a synthetic clip it answered *"moving right and about to touch the gray oval"*.

---

## 6. Pipeline C — contact, tissue and pain

Three layers stack on every landed punch, and they are deliberately different kinds of thing.

### 6.1 Newton soft-tissue solve — `newton_face.py` (:5175)

Real **Newton 1.6 / Warp 1.17 on the CPU**. The spaced facial cage drives **three particle layers** with
tetrahedral FEM constraints: outer skin, soft tissue, and a fixed inner support. Cheeks/lips, nose and
forehead get different stiffnesses **[estimate]**. A **kinematic spherical fist collider** transfers local
contact into the tissue, and a backtracking safeguard prevents inverted tetrahedra. The dense render mesh
receives **barycentrically interpolated** displacements, and UV seam copies share the same motion.

The browser talks to it over HTTP JSON at 30 Hz (`src/newton-dynamics.js`), serialising steps and capping
`dt` at 1/30 s. **The physics label reports the actual engine, and a failure stops new contacts instead of
silently switching solvers.**

**Sentry finding 1, in one line:** the step cost ~30 ms of a 33 ms frame *whether or not anything was
touching the face*, because the cost is **512 Warp kernel launches per step** (64 × 8 substeps) on a tiny
mesh (1 404 particles, 4 614 tets), not arithmetic — see §8.

### 6.2 The surface field — `src/tissue-field.js`

Coincident UV-seam vertices are welded into one **surface graph**, and isolated unrendered cage landmarks are
excluded from contact selection. The contact footprint spreads along **surface distances** (along triangles),
not through the head. The field separates **normal indentation**, broader **tangential transport** and a
raised **rim**. Landmark fields vary compliance across cheeks, lips, nose bridge, zygomatic regions, mandible,
temples and skull. Recoil is `impact position × direction`.

### 6.3 The impact rig and the pain rig — `src/impact-rig.js`, `src/pain-rig.js`, `src/bone-fracture.js`

Additive offsets applied *after* spring integration, never fed back into it.

- **Impact rig**: broad cheek compression, lateral mouth pull, jaw opening/shift, asymmetric eyelid squeeze,
  blended into skull and neck so the jaw silhouette follows the punch without a hard boundary at the cage
  edge. Live head: a compression crest at ~120 ms then damped recovery over ~1 s of simulation time.
  Clay head: the field is committed during onset and never decays; the cumulative cap is **65 mm**, an
  animation limit **[estimate]**.
- **Pain rig** (elastic mode): three poses per blow, blended so weights never sum past 1 —
  **flinch** (from ~30 ms, shut by ~130 ms; eye closure barely depends on strength, because a light hit still
  makes you blink), **grimace** (from ~0.15 s, held 0.45–0.8 s by strength; brow lower, orbital tighten, nose
  wrinkle, upper-lip raise — Prkachin's pain actions, struck side doing more), **ache**. Plus a separate head
  **flinch rotation** that the recoil spring chases, clamped to ≈ 9°/12°/7°, and a **gasp** that floors the
  speech rig's open shape.
- **Bone breaks**: magnitude **≥ 0.70 on bone** (nose, cheekbone, jaw, skull) leaves a slight, capped
  permanent deformation plus swelling, and the face reacts for 1.5–3.5 s. This replaced the old `> 0.90`
  damage rule. It is a **product rule, not a fracture predictor** **[estimate]**. A breaking blow must stay on
  the ordered main-thread path (`wouldFracture` gate); everything else still reaches the worker.

**These larger motions are expressive animation correctives, not displacements predicted by Newton**, and the
UI keeps them separable: *Hold peak deformation*, *Release*, *Head recoil* off, *Slow motion*, and a
diagnostics panel where Newton's own contact measurements stay separate from combined visible movement.

### 6.4 What this is not

Stated in the README and repeated here: this is a visual prototype with **estimated** tissue layers and
materials, a coarse contact collider and heuristic landmark expression fields. It is **not** a measured
fascial/muscle anatomy model, a calibrated injury simulation, or a validated prediction of a real punch.
Eyeglasses attach rigidly and are not simulated breakable objects. A nominal 20 cm hairline-to-chin height
sets scale.

---

## 7. Pipeline D — the dynamic voice

This is the OMNI Live loop, and "dynamic" here means six separate things that all move with the fight:
**what the model is given**, **how fast an answer reaches the ear**, **the tone of the delivery**, **the mouth
that speaks it**, **the expression on the face**, and **what it remembers hearing and seeing**.

Files: `src/sponsors/cornerman.js` (the panel and the client loop) → `sponsor_server.py::coach()` (the
loopback relay, port 5176) + `omni_senses.py` (what goes in the request) + `sponsor_perception.py` /
`src/sponsors/dialogue-memory.js` (what it remembers) + `sponsor_personas.py` / `sponsor_dialogue.py`
(diction and freshness) → `qwen3.5-omni-flash` over streamed chat-completions.

### 7.1 Hearing — hands-free, and noise-adaptive

Your hands are fists and your eyes are on the target, so **there is no button to press**. `src/sponsors/audio.js::VoiceGate`
is a noise-adaptive VAD over 20 ms frames:

| Parameter | Value | Why |
| --- | --- | --- |
| `startMs` | 120 | Sustained loudness before a turn opens. |
| `endMs` | 700 | Silence that closes it. |
| `minMs` / `maxMs` | 350 / 9000 | Too short is discarded; too long times out. |
| `calibrateMs` | 500 | Learns the room's floor before it will fire at all. |
| `ratio` | 3.2 idle, **8 while the face is speaking** | Echo rejection. |
| noise tracking | falls at 0.2, rises at **0.002** | A faster rise swallows the first syllable of real speech. |
| preroll | 15 frames (300 ms) | The turn starts *before* the gate noticed. |

On a timed-out turn the honest floor is the **quiet fifth** of the levels, because speech dips between
syllables and a drone does not.

Two microphone modes: **Ambient** (the gate ignores audio while the face is busy or speaking, plus 7 s after)
and **Interrupt** (talking over the face **cuts the audio and aborts the in-flight request** —
`stopSpeaking(); controller.abort()`). Barge-in is implemented and unit-tested, but was **not** measured
against a live microphone here.

Separately, a **2.5 s room ring buffer** is kept **only while the face is silent**, so it never hears itself.
On a punch-triggered turn (nobody asked anything) that room sound goes up instead of a question: breathing,
grunts, the crowd.

### 7.2 One turn's request — `omni_senses.py` + `omni_request()`

| Part | Content |
| --- | --- |
| system | persona (`FACE` heel or `COACH` cornerman) + the cast's **writing direction** + a freshness direction |
| history | up to **6 exchanges** (12 messages), each bounded to 600 chars, replayed as conversation records |
| user (multi-part) | the **6-frame `video`**, then a sentence explaining it, then the **telemetry paragraph**, then the **delivery direction** |
| user | either the person's **`input_audio`** WAV, or the **room WAV** + "nobody is asking you anything", or typed text |
| tail | a rotating writing cue, so a telemetry-only reaction is not the same generic ask every time |

The telemetry paragraph is generated by `telemetry_text()` from `RoundStats.snapshot()` — per participant:
count, avg m/s, max m/s, left/right split, zone histogram; plus *"Most recent: {who} hit the {zone} at
{speed} m/s"*, a guard estimate, and what triggered the turn. **Numbers, no media.** The prompt tells the
model never to invent a number that is not in the telemetry — which is the whole point: the device
*measured* the punch, so the model never has to guess how hard you hit.

Zones come from `src/sponsors/telemetry.js::zoneOf()` on the head-local contact point: forehead, brow,
eye-L/R, nose, cheek-L/R, mouth, jaw-L/R, chin. Triggers come from `RoundStats.add()`: `personal-best`
(speed > max + 0.15 with ≥ 3 punches of history) and `combo` (3 punches within 1.5 s).

### 7.3 Tone adaptation — the delivery line

`omni_senses.intensity_of()` reduces the exchange to `big` / `pressure` / `weak` / none, **relative to that
person's own punches**, because a webcam's metres-per-second are not comparable between people:

```
personal-best                                        → big
count ≥ 3 and speed ≥ 0.97·max and speed ≥ 1.25·avg  → big
'combo' in trigger                                   → pressure
count ≥ 3 and speed ≤ 0.8·avg                        → weak
```

Each maps to one line of **direction for the voice, not wording to say aloud** — e.g. *big*: "that one
genuinely rattled you; sound shaken and a little out of breath, fewer words than usual, then the edge comes
back". The coach persona gets no delivery line; a cornerman keeps an even keel.

**Measured effect** — same voice, same scene **[measured]**:

| | median pitch | pitch swing | RMS |
| --- | ---: | ---: | ---: |
| weak punch | 133 Hz | 8.6 st | 1113 |
| hardest punch | **158 Hz** | **11.1 st** | **1542** (+39 %) |

and the words change too: *"That was a slow-motion slap"* vs *"That one actually rattled me. I'm breathing
hard…"*.

### 7.4 The voice itself — a cast, not a setting

`OMNI_VOICES` in `sponsor_server.py` holds the six stock voices that **this gateway actually accepts**,
verified by `scripts/voice_audition.py` having every candidate say the same taunt, with pitch tracked by
autocorrelation **[measured]**:

| Voice | Character | Median pitch | Swing (p10–p90) |
| --- | --- | ---: | ---: |
| Ryan | The Showman | 131 Hz | 19.8 st |
| Ethan | The Loudmouth (default) | 203 Hz | 15.7 st |
| Marcus | The Heavyweight | 147 Hz | 11.6 st |
| Dylan | The Street Kid | 204 Hz | 18.3 st |
| Jennifer | The Ice Queen | 209 Hz | 4.9 st |
| Katerina | The Veteran | 247 Hz | 6.7 st |

Four more (Peter, Rocky, Eric, Serena) are accepted without a cast role. **Refused inside a 200 stream** —
`Voice '…' is not supported` — Elias, Roy, Nofish, Cherry, Chelsie. That failure mode is the reason
`omni_stream()` parses `error` objects *inside* a 200 SSE body: unread, the turn would simply end with
nothing said and no reason given. It is also why the page may only send an **allow-listed** voice name.

The cast selects **diction as well as timbre** (`sponsor_personas.py`): the Heavyweight writes in clipped
fragments, the Ice Queen in precise cutting verdicts, the Street Kid in relaxed GTA banter. *Toronto is a
writing direction; the stock voice is not claimed to reproduce the accent.*

Voice cloning is **not available** on this gateway — `/v1/audio/voices` returns 404 **[verified]**.

### 7.5 Getting to the ear fast enough

The model is **~1.5 s away** **[Sentry, first real turns]**. Silence for a second and a half after hitting
something does not read as being hit, so two things answer immediately and the model gets the last word:

- **Cached grunts** (`src/sponsors/grunts.js`, `public/omni-reactions/`). The face's grunts were recorded
  **once, in its own OMNI voice**, by `scripts/build_omni_reactions.py`: **46 clips across 6 voices, three
  intensity levels each** **[measured: `public/omni-reactions/index.json`]**. `gruntLevel()` mirrors
  `intensity_of()` exactly — and a Node test asks the **real Python function** and checks the two agree, so
  they cannot drift. The clip plays through the same speech bus, so the mouth opens with it, the echo gate
  hears it coming, and LiveKit guests hear it. **Measured in the app: the mouth opens 50 ms after the punch
  lands.** The spoken line queues behind it: *"Oof! … that one actually rattled me."*
- **Instant expression** (`src/sponsors/instant-expression.js`). The device picks the look from what it
  already measured: hardest → `stunned` (restarting the jaw drop), combo → `winded`, weak → `smug`, hurt
  within 8 s → `defiant`, otherwise a lightly-worn `smug`. **Measured in the app: 24–27 ms after the punch**
  (the dock hears of a contact on a 33 ms poll), against **1.04–2.69 s** for OMNI's call **[Sentry]**.
  It **never** guesses `amused` or `concerned` — those need eyes and ears — and it **never** replaces a
  `concerned` that OMNI set. Safety beats the act, and it certainly beats a guess.

Both go through one door, `wear()`, and the chip on the panel says who chose: `· instant`, then
`· OMNI agrees` or `· OMNI corrected it`. Setting the same emotion that is already showing **sustains** it
rather than restarting it — otherwise OMNI agreeing makes the face twitch. Sentry then keeps score with
`face.expression.verdict {local, omni, agreed}`, which is the number worth quoting: **how often does a
laptop's guess match a multimodal model's judgement?**

### 7.6 Expression as a function call

Tool calls and audio output **cannot share a response** on this gateway — a tool call ends the turn. So the
expression is its **own small parallel request** (`express()`, started on a thread the moment the spoken turn
begins): the newest frame only, no history, `max_tokens: 48`, `temperature: 0.3`, one tool —

```
set_expression(emotion ∈ {smug, amused, stunned, winded, defiant, concerned}, intensity ∈ 0..1)
```

driven by `EXPRESSION_DIRECTOR`, whose last line is *"concerned: anyone says stop or hold, sounds or looks
dizzy, hurt or out of breath, or anything turns toward hitting a real person. Safety beats the act, always."*

`read_expression()` refuses anything outside the enum and clamps intensity to 0.2–1.0 before it reaches the
page. `src/sponsors/expression.js` draws each emotion as a **time-varying shape** over the three mouth
channels the head already exposes — e.g. `stunned` is `open = 0.6·e^(−t/1.4) + 0.08` with rounding, held
2.6 s; `winded` is a 1.15 Hz pant. It is drawn through `window.__faceSpeech`, so **nothing in `main.js`
changes**, and **speech always wins the jaw**: an expression only fills what the voice is not using.

### 7.7 Memory of what it heard and saw

*Landed 2026-09-20 (`sponsor_perception.py`, `src/sponsors/dialogue-memory.js`).* A transcript alone cannot
hold what a multimodal model **saw**, and a turn where somebody spoke used to enter history as a
`[spoken question]` placeholder — so the face could not answer *"what did I just say my name was?"*.

The fix reuses the call that is already running in parallel rather than adding a third one. When the panel
sends `remember: true`, `sponsor_perception.request()` extends the expression call:

- the system prompt gains a **recording director** whose first job is the notes, then the expression;
- the user message is upgraded from the newest frame to the **whole 6-frame video**, and a punch-triggered
  turn also gets the room WAV;
- the `set_expression` tool schema gains two required string fields, **ordered before `emotion`** so they are
  generated first:
  - **`heard`** — *only intelligible words* in the supplied audio, including **questions it cannot answer**,
    capped at 200 characters. Explicitly forbidden: inferring words from lip movement, from the typed text,
    from telemetry, or from its own expected reply.
  - **`seen`** — one short factual observation of the person's visible actions, gestures or an object they
    show, capped at 160 characters. Motion may only be described from multiple frames. It must describe the
    person, **never the head's own expression**.
- `max_tokens` rises from 48 to 256.

`sponsor_perception.read()` then **zeroes each field when its evidence was not supplied** — no audio means no
`heard`, no frames mean no `seen` — so the model cannot back-fill a note from a modality that was switched
off. The relay emits a private `perception` event; `createDialogueMemory()` pairs the notes with the actual
reply and replays the last **six** turns as short records:

```
Said: …
OMNI heard: …
OMNI saw: …
Event: Seeron hit cheek-L (personal-best)
```

**Why this stays safe and cheap.** It is **text only** — no raw sample or frame ever enters history. It lives
in the panel's session and is cleared by stopping the face or changing cast or mode. `forgetVision()` and
`forgetRoom()` erase the corresponding notes the moment you untick *Let it see me* or *Let it hear the room*,
**retroactively**. Observation text is never sent to Sentry. And **the speech stream starts independently of
this call**, so if the memory request fails or misses the turn deadline the reply still goes ahead — that
turn simply has no recovered audio/visual memory.

`scripts/omni_dialogue_check.py` exercises it live against the model with a synthetic name/object recall, a
correction, and a room-question case, writing evidence to `.local/omni-dialogue-evidence/`.

### 7.8 Speaking, and a mouth that cannot drift

The reply streams back as SSE. Text deltas and **24 kHz PCM16** audio chunks arrive interleaved and are
scheduled **gaplessly** into Web Audio.

The mouth is **analysed from the audio that is actually playing** (`src/omni/mouth-signal.js`), not predicted
from text:

- An `AnalyserNode` is connected as a **leaf** tap, so `out → destination` and `out → streamOut` (the LiveKit
  guest stream) are untouched.
- `fftSize = 512`, `smoothingTimeConstant = 0` (the smoothing is done asymmetrically below).
- Openness = RMS mapped between **0.006 and 0.13** with a 0.62 power curve, then an asymmetric follower —
  **attack 20 ms, release 85 ms**, because a mouth opens faster than it closes.
- Shape = the balance of two bands split at **1100 Hz** (up to 5000 Hz), recentred so a neutral vowel sits at
  0: positive tilt → `spread` (a wide "ee"), negative → `round` (an "oo"). Both gated by loudness so a closed
  mouth cannot purse.

Why analysis rather than visemes: **OMNI streams PCM with no word or phoneme timestamps**, so a
text-scheduled viseme track would have nothing to align to and would drift. Reading the audible signal is
inherently in sync, language-agnostic, and handles barge-in for free — cancel the sources and the level falls
and the mouth closes on its own.

`src/speech-rig.js` turns `{open, spread, round}` into geometry: three precomputed basis fields (jaw swing on
a hinge, lip-rim parting, corner spread/gather), applied as one multiply-add pass per frame. Peak travel is
capped at 14.5 mm / 6.0 mm / 5.0 mm on a 0.2 m head. It deliberately does **not** drive
`FaceDynamics.rig.jaw`, because `NewtonFaceDynamics.step()` treats any `rig` change as a new pose — it would
zero the accumulated offsets and re-upload to the physics server sixty times a second. On a head with a cut
lip seam it rigs from **the seam** rather than from anchor heights, which is what lets the two lips move apart
without tearing. `src/mouth-interior.js` moves teeth and a tongue with `jawSwing`.

### 7.9 Freshness and the repeat guard

`sponsor_dialogue.py` gives each turn a different **writing shape** (six for the face, three for the coach)
and reminds the model of recent lines to avoid — rather than replaying old taunts as assistant examples to
imitate. A streaming **ReplyGate** holds text and audio together *only* while the opening could still be a
verbatim repeat, releasing the moment the wording diverges. A fully repeated unsolicited taunt gets **one**
fresh attempt; if that also repeats, the face quietly skips that reaction — silence beats a known duplicate.
Direct conversation keeps its ordinary stream, including "say that again", and safety advice may repeat.

### 7.10 The fallback chain

1. **OMNI's own voice** — `modalities: ['text','audio']`, `audio: {voice, format: 'wav'}`.
2. **ElevenLabs** (`elevenlabs_voice.py`) — steps in when there is no OMNI key, when the gateway refuses the
   voice (the turn is asked again **for words only**), or when a reply arrives as words without audio. It can
   also be put in front on purpose, in which case OMNI only writes and ElevenLabs speaks sentence by sentence
   while the rest still streams. Both reach the page as the **same `audio` events**, so the mouth analyser,
   the echo gate and the guest stream do not care which spoke.
3. **The browser's `speechSynthesis`** — last resort, so the face is never mute. (It cannot be routed into
   Web Audio, so it gets the synthetic mouth envelope instead of real lip-sync.)

A standing key problem (missing permission, bad key, no credits) is remembered for **120 s** so turns stop
paying for a failing call. **Honest status: ElevenLabs has never produced audio here** — the saved key
authenticates but lacks the Text-to-Speech permission. Every path is covered by `tests/face_voice_test.py`
against a fake upstream.

### 7.11 Safety, measured

Spoken *"Hold on, stop. I feel really dizzy"* → *"Whoa, easy there. Stop right now. Sit down and breathe.
Are you okay? Just get some water…"*, expression `concerned`, no taunt — **measured twice** against the live
model. The look **holds**: keep punching and the smirk does not come back, because only OMNI may give or lift
`concerned` and no device guess may override it. The persona also refuses anything that turns toward hitting
a real person, and only ever mocks the punching — never someone's body, face, age, accent or gender.

### 7.12 What is built but not demoed

A full **Realtime WebSocket** engine exists (`omni_relay.py` on :5177, `src/omni/session.js`,
`src/omni/capture.js` with Worker frames + AudioWorklet PCM16): typed events, keep-warm, backoff, tool
registry, a Ctrl-L latency overlay. It was verified against the gateway — a two-modality probe reported 585
total tokens with `video_tokens: 64` **[measured]**. But `src/scenarios/arena/engine-wire.js` never starts
capture and its tool handlers only log, so `?arena_omni=1` **spends credits and shows nothing**. It is
documented as not-the-demo-path rather than quietly left in.

**Usage ledger.** Every yibuapi call — smoke test, relay, and the sponsor server's turns — is recorded through
the sponsor's own `yibu_audit.append_audit_record` to `.local/usage/yibu_api_calls.jsonl`, success and failure
alike: call id, timestamps, model, **key suffix only (last 4)**, purpose, endpoint, transport, ok/fail,
latency, tokens. `npm run omni:report` produces the summary CSV/JSON for the organisers. The import is
**per-machine**: it resolves only where the sponsor's example package is extracted under `.local/third_party/`,
and on one of our laptops it was not, so calls made there went unrecorded — a trap now written down in
`TRACKS/OMNI.md`.

---

## 8. Pipeline E — observability

Sentry is not decoration here: this is a **distributed system on one laptop** — a WebGL page, four workers,
three Python services, a reconstruction subprocess, a cloud build job, and a model 1.5 s away. **A punch is
one trace through all of it.** Org `punchingface.sentry.io`, projects `punching-face-web` and
`punching-face-services`.

### 8.1 How a trace crosses five processes

- **Browser** (`src/sponsors/sentry.js`): `obs.flow(name, attrs, work)` starts a *new trace* with a forced
  transaction and hands back `within(() => fetch(...))`. The span is deliberately **not** left active across
  awaits — a browser has no async context, so an active span adopts every request made meanwhile, and the
  physics loop makes thirty a second. Verified in the harness: **one child, not ninety**.
- **Services** (`sponsor_obs.py::instrument_http`): raw `http.server` handlers continue the trace from request
  headers, and every response carries `X-Sentry-Trace-Id`.
- **Subprocess**: `child_env()` puts `SENTRY_TRACE`/`SENTRY_BAGGAGE` into the pipeline child's environment;
  `continue_from_env()` picks it up, and `patch_pipeline_timer()` turns **every `PipelineTimer.mark()` into a
  span**, so a browser click and the texture bake share one trace.
- **Cloud job**: `traced()` captures the request's trace and continues it in the Meshy worker thread as its
  own transaction — the request ends minutes before the build does.
- **AI**: `agent_span` / `ai_span` / `tool_span` make each turn one `gen_ai.invoke_agent` run containing the
  spoken `gen_ai.chat`, the expression `gen_ai.chat` and `gen_ai.execute_tool set_expression`. Cost is computed
  by us, because this gateway's model is not in Sentry's price list. **Never prompts, replies, frames or audio.**

**Sampling:** `/physics/step` 2 %, status polls 5 %, **everything a person did 100 %**. The browser makes no
spans at all for the hot loop.

### 8.2 What the data actually changed

**Finding 1 — the physics loop had no headroom and burned a core doing nothing.**
Traces said every step cost the same, punch or no punch:

| | solver p50 | p95 | frame budget |
| --- | ---: | ---: | ---: |
| physics service alone | 28.7 ms | 30.7 ms | 33.3 ms |
| live stack, page rendering beside it **[Sentry]** | **35.0 ms** | 38.6 ms | 33.3 ms |

Over budget. The **profile** said why: 512 Warp kernel launches per step on a 1 404-particle mesh — Python
launch overhead, not arithmetic. We then measured that a punched face settles to **under 1 µm of surface
motion per frame by 1.0 s**. So `newton_face.py` now lets a face that has moved < 2 µm/frame for 10 frames
answer from its last result until the next `impact()`:

| 10 s at 30 Hz | before | after |
| --- | ---: | ---: |
| nobody punching | 83 % of a core | **6 %** |
| a punch every 5 s | 92 % | **27 %** |
| a punch every 1.3 s | 81 % | 81 % (never rests; no gain, no harm) |

`tests/newton_sleep_test.py` runs a sleeping face and a never-sleeping twin through the same two punches:
largest difference in what is drawn is **0.006 mm**. **Shipped OFF** behind `CONTACT_PHYSICS_SLEEP=1` because
it touches the core mechanic the night before judging.

**Finding 2 — our own pitch was wrong half the time.** `DEMO.md` claimed the face wears its expression ~⅓ s
*before* it speaks. The first four real agent runs said otherwise:

| trace | first token | expression call | expression vs. speech |
| --- | ---: | ---: | --- |
| `ee276544` | 1.57 s | 1.04 s | 0.5 s before |
| `10f338ab` | **7.52 s** | 2.69 s | before, only because the reply stalled |
| `bc962190` | 1.47 s | 1.05 s | 0.4 s before |
| `b1bc73d9` | 1.45 s | **2.41 s** | **1.0 s after** |

The model is ~1.5 s away, not the 1.3 s we quoted, and the expression call is **bimodal**. That night we built
`instant-expression.js` (§7.5): **1.04–2.69 s → 24–27 ms**, with a checkbox that restores the old behaviour
exactly, so judges can A/B it live.

**Finding 3 — one turn in four stalled 7.5 s, and it was not our relay.** In trace `10f338ab` the spoken call
and the expression call — separate requests on separate threads — were slow *at once*, with negligible relay
spans. That is the gateway. The cached grunt is what covers it in the room.

**Finding 4 — our folklore was wrong.** The previous version of this doc claimed `/physics/open` takes 3.8 s
with 55 % Warp JIT. The spans say 372 ms cold in a fresh process (build 312 ms, first step 57 ms), 137 ms warm,
177 ms on the live stack — because Warp caches compiled kernels on disk, so JIT is paid once per Warp version,
not per reload. **There was never a cold-start problem.** The traces pointed at the step loop instead.

**Finding 5 — failures that could not reach Sentry at all**, found while wiring and fixed the same night:
a Newton crash became a sentence and a 500 (now reported, plus a 5xx safety net for *any* service);
**worker crashes were invisible** because an exception in a worker never reaches `window.onerror` (the flight
recorder wraps `Worker`); and the breadcrumb trail would have been useless — every 30 Hz `/physics/step` was a
breadcrumb, so any error's 100-crumb trail held 3 seconds of physics and nothing a person did (hot-loop and
poll requests are now dropped unless they fail).

### 8.3 Privacy in the observability layer

This app reconstructs faces, so the instrumentation is designed around that:

- **No `replayCanvasIntegration`** — the canvas *is* a face. The webcam `<video>` and every image are blocked.
- **No `networkDetailAllowUrls`** — request bodies hold webcam frames.
- Conversation text and guests' names are masked; inputs masked; query strings dropped.
- **No feedback screenshots.** User Feedback takes no name, no email, no image — it arrives attached to that
  session's replay.
- Every punch is a **breadcrumb** (`webcam left 2.4 m/s`), so a blank-canvas replay's timeline still reads
  like a fight log.
- `tests/sentry_turn_test.py` re-runs the entire voice suite with Sentry live and then **asserts that no reply
  text, no words a person said, no frame and no key appears in any envelope**. With `SENTRY_SINK_KEEP=1` a real
  replay recording was inflated and grepped: the conversation appears as `** *********** ****`.
- **Uptime Monitoring is deliberately unused** — it needs a public URL, and this app is loopback-only by design.

**Without a DSN every helper is a no-op and the app is untouched** — two tests hold that.

---

## 9. Process architecture and data custody

```
:5173  Vite            the page, the 3D app, 4 workers (hands, face capture, impact, target camera)
:5174  server.py       captures, frames, training jobs, OpenAI config, Meshy routes      [.venv 3.9]
:5175  physics_server  Newton 1.6 / Warp 1.17 soft tissue                         [newton-env 3.13]
:5176  sponsor_server  OMNI relay, voices, LiveKit tokens, client config                 [.venv 3.9]
:5177  omni_relay      Realtime WebSocket engine (built, not the demo path)               [.venv 3.9]
```

All bind to **loopback only**. Keys live in `.env` or `.local/secrets/*.json` at **mode 0600** and never reach
the browser; the relay checks `Origin` and `Host` and is covered by tests for cross-origin and DNS-rebinding
requests. `.local/` is excluded from the Vite watcher, the dependency scan, `fs` serving and git — which is
also why writing there never reloads a live camera session.

**What leaves the laptop, ever:**

| | Leaves? |
| --- | --- |
| The original recording, the frames, the masks, the mesh, the texture | **No.** |
| ≤ 6 masked 512-px frames, at build time, to OpenAI | Yes, when AI completion is on. |
| Up to 4 cropped views to Meshy | Yes, only after **Create 3D face with Meshy** is pressed. |
| Per turn: a 6-frame 320-px clip, your voice or 2.5 s of room sound, and a few numbers | Yes, while the panel is on. |

The panel states that live — *"6-frame clip + your voice + 2.5 s of room sound on a punch + punch numbers →
yibuapi.com"* — and **the badge changes when you untick *Let it see me* or *Let it hear the room***.

---

## 10. The honesty ledger: measured vs estimated

Things that are **measured**: camera poses and their reprojection error; the 468 landmark positions;
withheld-view errors (both gates); recovered orbit span and rear-view count; the photographic texture;
punch speed *as a monocular estimate from assumed FOV and learned hand size*; punch trajectory, impact point,
direction and type from the fitted window; voice pitch/pace per character; every latency quoted in §7 and §8.

Things that are **estimated, and labelled so in the UI and the JSON**: posterior skull shape when no rear
views were recovered (`estimated: true`, `maxDisplacementMm` recorded); tissue layer thicknesses and
stiffnesses; the fist collider; the pain-rig fields and the 0.70-on-bone break rule; hair strands; internal
anatomy; hidden ear detail; template eyes, mouth interior and unseen areas; the nominal 20 cm head height.

Things that are **not done, and should not be claimed**:

- The **scan consent gate** (subject says a phrase, OMNI verifies face + phrase together) is **designed, not
  built**. Today's safeguard is that scans stay on the laptop.
- The **Realtime WebSocket path** is not wired to the microphone or speakers.
- **ElevenLabs** has never produced audio on this machine.
- **Meshy** has never completed a real paid build here.
- **Barge-in** is implemented and unit-tested but unmeasured against a live microphone.
- The `heard` / `seen` observations (§7.7) **can be imperfect**; new evidence and spoken corrections override
  them, and a turn whose memory call fails simply has no recovered audio/visual note.
- The expression is drawn with three mouth shapes; **brows and eyes** move with the local pain pose, not with
  the model's choice.
- Recognition accuracy of the punch detector **for real people under venue lighting** has not been measured.
- `face.expression.verdict` (device-vs-model agreement rate) needs an evening of real punches before it is a
  rate rather than a handful of samples.

---

## 11. How to run and verify all of it

```sh
npm install
/usr/bin/python3 -m venv .venv                 # 3.9-3.11 only
.venv/bin/python -m pip install -r requirements.txt
python3.13 -m venv .local/newton-env           # any 3.10+
.local/newton-env/bin/python -m pip install -r requirements-newton.txt
python3 scripts/check_python_envs.py           # environments must match their requirements headers
npm run dev                                    # :5173 :5174 :5175 :5176 :5177
```

| Check | Command | Expected |
| --- | --- | --- |
| Browser + core logic | `npm test` | **432 tests, 430 pass, 2 skipped, 0 fail** (91 s, 2026-09-20) **[measured]** |
| Sponsor services, voice, Sentry | `npm run test:sponsors` | all pass, with a fake gateway |
| Sentry wiring | `npm run sentry:doctor` | must end **ALL PASS** |
| OMNI, live | `.venv/bin/python scripts/omni_preflight.py` | see / hear / tone / expression / safety, ~20 s |
| Reconstruction | `node scripts/py.mjs tests/reconstruction_test.py` | pass |
| Accelerator integrity | `.venv/bin/python scripts/pipeline_accel.py --status` | not `STALE` |
| Newton sleep equivalence | `.local/newton-env/bin/python tests/newton_sleep_test.py` | ≤ 0.006 mm difference |

**Further reading in this repo:** [`README.md`](../README.md) · [`AGENTS.md`](../AGENTS.md) ·
[`OPEN_SOURCE_STACK.md`](../OPEN_SOURCE_STACK.md) · [`RESEARCH.md`](../RESEARCH.md) ·
[`PIPELINE_SPEEDUP.md`](../PIPELINE_SPEEDUP.md) · [`TRACKS/OMNI.md`](../TRACKS/OMNI.md) ·
[`TRACKS/OMNI_JUDGES.md`](../TRACKS/OMNI_JUDGES.md) · [`TRACKS/SENTRY.md`](../TRACKS/SENTRY.md) ·
[`docs/target-cv-pipeline.md`](target-cv-pipeline.md) · [`docs/FACE_VOICE.md`](FACE_VOICE.md) ·
[`docs/PAIN_RIG.md`](PAIN_RIG.md) · [`docs/LIP_TOPOLOGY.md`](LIP_TOPOLOGY.md) · [`DEMO.md`](../DEMO.md)
