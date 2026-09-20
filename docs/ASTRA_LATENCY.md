# Astra annotation latency — September 20

The target is **120 seconds from video selection to model ready**, including
upload, extraction, reconstruction and readiness polling. A halving of latency
or a two-minute full-Astra build has **not yet been verified** for these changes.

## Confirmed stall

Capture `498b7c4328c046049283653cf1441b5f` spent 450.219 seconds in the
single head/glasses response, then failed when its 32,000-token output limit was
reached. Reconstruction took 465.564 seconds, after 21.398 seconds of extraction.
The head/glasses call had not used the parallel annotation helper.

## Changes

- Head/glasses, hair and ear/accessory annotations now each use up to nine
  concurrent per-view requests and a separate global assessment. Every request
  retains all original reference images, resolutions, prompts and field schemas.
  Astra and the low reasoning setting are unchanged.
- Each small response reserves 8,192 output tokens, scaled up when a batch has
  multiple views, instead of reserving 24,000–32,000 for each small response.
  This is an output allowance, not a reduction in requested contour detail.
- Validated responses persist in each capture's `annotation-cache/`, keyed by
  the complete request, schema and options. Retrying requests only missing parts;
  changed evidence invalidates affected caches. Complete annotation artifacts
  still publish only after every part validates.
- Annotation socket timeouts are 90 seconds rather than 600. Failed prefetches
  propagate instead of repeating the wait inline. This is not a hard end-to-end
  deadline: cloud throttling, optional image generation and local work can still
  exceed two minutes.
- Logs record per-batch elapsed seconds without image data, credentials or
  provider account identifiers.

Up to 30 annotation requests can overlap for nine chosen views, before optional
eye/image requests. This repeats input usage and requires sufficient API quota.

## Validation and current blocker

A fresh full-quality run with the split requests was attempted in
`.local/astra-parallel-validation/fresh/`. It failed with HTTP 429, so it is not
a speed result. A minimal diagnostic also received HTTP 429, with request limit
50, used 50, remaining 0 and `Retry-After: 1728` at that check. No further live
requests were made after confirming the limit.

The focused regression suite covers concurrency, all-image context, unchanged
field schemas, global/per-view merge, rejection of missing/duplicate/invalid
results, resumable caches, evidence invalidation and existing artifact retention.
It also exercises the real head-completion entry point with a fake provider.
Local evidence is in `.local/astra-parallel-validation/`.

After API capacity is available, run a fresh upload with AI detail enabled and
3072px texture. Existing main-server workers launch the updated scripts; isolated
video labs snapshot code and need restarting. Use separate capture storage for a
benchmark, never start another server on the main `.local/face-captures` folder.
Inspect the resulting front, profiles, rear, hair and separate glasses before
accepting a timing result. Mock-provider tests cannot establish live latency or
visual equivalence of generative answers.

## Resumed integration checks

The combined local suite on September 20 passed **69 Python tests** with one
optional real-recording check skipped, plus **26 browser hook/timing/telemetry
tests**. Formatting and `git diff --check` passed. Logs:

- `.local/astra-parallel-validation/resume-integration.log`
- `.local/astra-parallel-validation/resume-web-integration.log`

This includes capture storage/publication checks and the combined provider-limit
handling added by the parallel work. A failed batch is not cached; other validated
batches persist. The annotation helper raises instead of returning an incomplete
result, so the caller does not replace its previous complete annotation artifact.
The executor joins already-started batches, allowing their valid results to be
saved. An explicit retry requests missing/invalid parts and merges the complete
result in original filename order. It does not discard the source scan.

One shared benchmark is owned by the **Speed up video model creation** task
(`01a0bd39-5eec-7562-bde5-f6baf88d167b`), using its stricter 105-second target.
The final request settings and visual acceptance checks above were handed over.
No additional live quota probes, requests or benchmark runs were made here during
the resumed integration checks. A provider retry delay alone does not establish
capacity for all 30 possible annotation requests and their repeated image inputs.

Still blocked: a successful fresh full-Astra upload-to-ready timing and visual
inspection of its generated head. The local checks do not close either item or
prove that the two-minute target has been met. Full Astra, the existing model and
photographic detail remain enabled; no local-only fallback was substituted.
