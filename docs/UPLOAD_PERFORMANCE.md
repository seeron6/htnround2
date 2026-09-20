# Continuous video-to-head reconstruction

Video selection now starts extraction and reconstruction automatically. The saved
head uses the video filename and can be renamed later. Stopping extraction still
cancels automatic reconstruction. Completed heads remain available through the
existing background completion/swap prompt.

The timing panel records actual elapsed time from video selection to the first
completed-model status response. It includes initialization, upload, extraction,
reconstruction and polling. Scene loading is reported separately. Older scans
without a start timestamp show processing time rather than invented elapsed time.

## Work that overlaps

- Tracking initialization runs during video upload and native decoding.
- Sequential native video decoding feeds four bounded PNG-encoding workers.
- The fitted template and photographic hair silhouette run during AI analysis.
- Hair and ear/accessory annotations use simultaneous output batches.
  Every batch still sees **all** the original reference images, at the original
  resolution and JPEG quality. The model, reasoning setting, requested detail
  and global multiview assessment are retained. The current split responses use
  an 8192-token allowance for a single view or global assessment, scaled for
  larger batches, and a 90-second annotation socket timeout. Completed requests
  are validated and cached independently. See [Astra latency](ASTRA_LATENCY.md).
  The tradeoff is additional API request and input usage because the visual
  context is repeated.
- Texture ownership blends retain the already-validated first-pass colors,
  avoiding a second projection/mask/warp pass and inconsistent boundary rejection.

Frame quality measurements use a separate source cache. They no longer modify
published model artifacts during a first build, which previously caused the final
publication guard to reject an otherwise completed model. The guard remains active.

## Quality checks

For `IMG_7497.mov` (15.401667 seconds), native decoding preserves all 52 sampled
PNG files **byte-for-byte**, with identical timestamps and 720×1280 dimensions.
Decoder-only time changed from 1.564–1.636 seconds to 0.462–0.496 seconds.

With fixed source photographs and cached AI answers, serial and parallel local
scheduling produce identical mesh positions, indices, normals, colors, anchors,
accessories, physics cage/binding, pre-ear surface and both texture PNG files.
The 3072×3072 photo texture is also pixel-identical to the previously accepted
model for capture `9fc62fd49f72469dbad74c597c9279f9`. Its head has 19,759 vertices
and 38,570 triangles and passes the watertight/finite geometry checks.

AI outputs can vary across fresh requests. The batching tests verify preservation
of every input image and annotation field, concurrent execution, deterministic
filename merge order, and rejection of incomplete/duplicate/invalid results before
cache publication. These checks do not claim identical answers from a generative
service.

Local validation evidence is in `.local/upload-speed-validation/`, including
`quality-equivalence.json`. Reproducible isolated full-quality run:

```sh
CONTACT_TEXTURE_SIZE=3072 VITE_CONTACT_FAST_CAPTURE=0 npm run dev:video -- .local/video-optimization/IMG_7497.mov
```

The video lab shares local models and API keys with the demo, but disables both
Sentry SDKs by default so failed benchmarks do not send demo crash emails.
Use `CONTACT_VIDEO_SENTRY=1 npm run dev:video -- <video>` to trace a benchmark
deliberately; it uses the `video-lab` environment unless explicitly overridden.
Restart an existing lab after changing this setting. The main `npm run dev`
session continues to report to Sentry.

OpenAI 429 responses are classified separately as temporary throttling or quota
exhaustion. Temporary throttling gets bounded retries; a failed prefetch does not
repeat the full annotation batch. If recovery fails, reconstruction still writes
its failed status and rolls back unpublished artifacts. The CLI then exits with
code 1 and a warning log, preserving the failed trace without an unhandled crash
alert. Unexpected exceptions still reach Sentry.

The timing target applies to the measured source video on this Mac. Longer videos,
missing rear observations requiring generated references, cloud latency and machine
load can change the total. Reconstruction is never cut short at the target time.

## Fresh full-quality measurements, September 20

The **105-second target is not yet verified**. All of these runs started with a
new capture and used AI refinement, full sampling and a 3072-pixel texture.
The measured parallel runs used three batches per analyzer. Concurrent work in
the shared checkout subsequently changed the default to up to nine view batches
plus a separate global assessment (up to ten requests per analyzer), and applied
the split to all three analyzers: head, hair, and ears/accessories. That newer
configuration has not completed a fresh live benchmark; it increases pressure on
the account's request and input-token limits.

| Run | Upload elapsed | Result |
| --- | ---: | --- |
| Before annotation batching and source-cache fix | 131.509 s | Publication rejected; subsequently fixed |
| Parallel annotations, Low Power and competing local build | 178.697 s | Complete |
| Low Power, subsequent run | 104.942 s | AI request throttled; not a completed model |
| Temporarily Automatic, concurrent primary capture | 50.337 s | AI request throttled; not a completed model |

The completed run had 41 recovered cameras and 16 rear views. Its front, profile
and rear were inspected in the browser, with the app reporting the photo model
and Newton ready. This validates loading and retained photographic coverage;
it does not establish perfect reconstruction of unobserved regions.

In Automatic mode, extraction took 21.791 seconds and camera recovery 11.652
seconds, compared with 31.060 and 22.866 seconds in the completed Low Power run.
These runs also had different competing workloads, so this is not a controlled
measurement of the power setting alone. Battery Energy Mode was restored to
Low Power after the approved diagnostic run; adapter mode remained Automatic.

The final API diagnostic returned `rate_limit_exceeded`, zero remaining requests,
a request limit of 50 and `Retry-After: 1728`. No additional live builds were
attempted after confirming that limit. Transient request failures now have at
most two bounded retries, retaining already completed parallel batches. Valid
provider delays above the retry budget are reported rather than retried early;
quota/billing failures are distinct and are not retried. Exhausted retry errors
also bypass the accelerator's ordinary speculative-work fallback so it cannot
repeat the entire annotation fanout.

Machine-readable run results and sanitized rate-limit metadata are in
`.local/upload-speed-validation/results.json` and `api-status.json`. A fresh
complete upload benchmark remains necessary after API capacity is available.

## Resumed benchmark readiness

The replacement key configuration is shared by the main app and both video labs.
On the resumed turn, no live API request or cloud build was made. The coordinator's
latest diagnostic still reported a 50-request daily allowance, zero remaining
requests and a 1728-second retry delay. September 20 at 06:29 UTC is the earliest
time to reconsider capacity, not authorization to launch the entire build.

The previous successful upload selected eight analysis views. The current code
would request eight per-view outputs and one global assessment from each of three
analyzers: **27 fresh annotation requests**, or up to 30 if a new camera recovery
selects nine views. Optional eye analysis and image generation add conditional
requests. One replenished request slot would not be sufficient for this plan.

Capture `252e8d318c054642bdaef9761fe4c085` has saved head and hair artifacts but
no ear/accessory artifact or individual request caches. If the existing aggregate
hashes validate, its explicit retry needs nine annotation requests. The completed
capture `6db859bccc214add807fb72cb10b211e` has all three saved aggregates. Either
would be a warm run and cannot establish fresh upload-to-ready latency.

The isolated lab on ports 5193/5194/5195 was refreshed with current code and full
quality settings. Local validation passed: 33 decoder/geometry/publication tests,
26 browser hook/timing/telemetry tests, and the production build. The latency task
also verified its combined provider-mock integration suite (69 passed, one
optional recording check skipped). All accelerator source pins remain active.
Battery Low Power remains enabled; no second setting change was needed to prepare
the benchmark.

`.local/upload-speed-validation/benchmark-readiness.json` records source hashes,
request demand, cached-versus-fresh inventory, acceptance checks and test logs.
The coordinating task owns the capacity follow-up, and this upload task owns the
single eventual timing benchmark. Other tasks are avoiding duplicate cloud runs.
