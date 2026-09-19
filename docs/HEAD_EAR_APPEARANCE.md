# Ear occlusion and surface appearance

The remaining dark crescent was not a second physical ear in the mesh. Source-ear masking correctly rejected photographs of an ear falling on the surrounding head, but that left unobserved head texels. Their scalp prior then supplied dark hair. Existing lower-skin completion excluded that prior, while ear continuation only handled ear material. Neither repaired the gap.

## Connected head completion

`ear_surface_completion.py` estimates those missing colors from reliable photographic boundary anchors along the actual mesh. Positive harmonic weights keep the result within the anchors' color bounds. There is no Euclidean shortcut between close, disconnected folds and no connection across the planar neck cap. Unanchored components keep their existing fallback.

Mixed head/ear triangles initially left broken fragments. `head_surface_domain.py` temporarily clips each triangle to its categorical head region: the sum of head barycentric weights must be at least the sum for every other label. Shared original-edge intersections receive shared temporary vertices. The solver can therefore reach head-owned texels right up to the material boundary without using an ear region as a shortcut. The published geometry, UVs, labels, rig and accessories are unchanged.

`ear_surface_material.py` separates three color fields: unmasked photographic donors, the prepared color before generic completion, and the current completed color. It replaces an earlier fallback once. Relaxed oblique hair donors carry their own hair-only RGB, rather than a blend that could contain skin from another camera. Reliable photo support, positive hair semantics, verified cleanup, eyes, ears, mouth and neck cap are protected. The metadata explicitly records this as estimated appearance; photographic coverage is not increased.

This is not a fixed-radius solve. The reported extent describes the active connected graph, including pinned photograph anchors, and does not measure how far any one donor influences an unknown point. Head-only temporary clipping is an appearance operation, not new anatomy.

## Cleanup provenance correction

Two additional defects were found while tracing the remaining fragments:

- Source-ear votes had been removed from both photographic and estimated RGB totals, but hidden-scalp completion still divided by those totals alone. Including hidden mass once in the denominator prevents partially occluded samples from overstating their occlusion fraction.
- Glasses cleanup accumulated RGB and ownership before ear-erased samples lost their quality. The source image had already been inpainted at those locations, so an ear fill was incorrectly treated as a protected glasses edit. `glasses_reference.cleanup_weights` now excludes both ear-owned and ear-erased samples from RGB and every ownership branch, per view. A different unobstructed cleanup reference can still contribute. Aggregate ownership is cleared where no usable reference RGB exists. Valid cleanup also suppresses the later hidden-hair prior.

At one traced native location, the registered reference was RGB `(180,125,100)`, but source-ear inpainting supplied roughly `(74,59,55)` to cleanup. Simply protecting the previous cleanup color would therefore have preserved contamination.

## Development validation and remaining work

The initial clipped candidate changed 35,274 head texels, including 3,056 on mixed-label triangles, while preserving all 3,437,006 protected samples and every measured-face sample checked in that experiment. Its temporary remapping moved no surface point beyond floating-point roundoff. The subsequent cleanup correction changes the eligible region; its private candidate resolves 39,650 targets and leaves 524 unanchored targets untouched. These numbers describe one development capture, not a population benchmark.

Eighty targeted Python tests pass, including categorical boundaries, UV seams, disconnected surfaces, missing anchors, separate hair donor color, per-view cleanup exclusion and preservation of an unobstructed second reference. Actual browser comparisons cover matched profiles, front and rear for the component candidate, with the cleanup revision inspected separately. The large dark crescent is reduced, but estimated ear-owned patches remain at the upper attachment and lobe. Traced examples project outside the photographed ear onto hair or neck skin; broader head filling cannot resolve that registration/material-boundary discrepancy.

The first production integration passes serial/four-worker equivalence within one process, but independent processes have produced different textures from unchanged inputs and code. The final cleanup pair differs at 65,487 PNG pixels, with a maximum channel difference of 65. The source inputs are byte-identical, including all 51 native frames, references, camera files and metadata; full preprojection geometry arrays also match. Two camera visibility audits differ. This is not dismissed as harmless quantization.

The verifier now starts each bake in a fresh Python interpreter. Every child retains the source-write, network and subprocess prohibition. Its negative control rejects the inconsistent implementation with differing appearance statistics after 56.73/38.18-second runs, whereas the earlier same-process check passed.

A low-overhead trace isolated two corrupted eight-row blocks in frame 0037's ear registration, with up to 138.907 camera pixels of error while its original projections and visibility inputs remained exact. `ear_fit.affine_sample_coordinates` now evaluates the two affine components with explicit row-independent products, keeping identical operation order for full views and subsets. This avoids the failing tall Nx2 matrix-product path. Retaining intermediate arrays sometimes made the fault disappear, and synthetic matrix stress tests did not reproduce it, so the underlying library cause is not established.

Three private fresh runs of the explicit calculation (one serial, two four-worker) emit the same PNG as the stable serial reference. The production fresh-process verifier then passes at 48.288/32.158 seconds, with exact texture bytes and atlas metadata. Its current result also includes a concurrent task's crown-completion hook; it is not an isolated ear-only appearance comparison. An independent saved candidate matches that verified output exactly. The ear continuation changes 39,650 targets while preserving 3,427,798 protected samples; the final supported-color gate preserves all 1,835,830 prepared-color samples it checks. The combined targeted suite runs 97 tests: 96 pass and one optional integration test is skipped. The full real-capture check was run separately.

Evidence is in `.local/ear-affine-current-verification.json`, `.local/ear-component-stable/verification.json`, `.local/ear-final-unit-tests.log`, the earlier negative-control log `.local/ear-fresh-process-negative.log`, and `.local/ear-fragment-audit/`. These are verification results, not a claim that every ear attachment is visually correct.

## Accepted appearance bundle

Generation `8488bd76981e4320bcde74d59249456d` replaces `7f1a70cdf531445184ac404d4b4e817a`. Its appearance PNG is SHA256 `604ed0e60d7b4cf729e71c1503e5c1ad320d83a597ce85433667b9ec1e422644`. Publication checked the current code against the fresh-process verification, matched the independently saved candidate, and used the immutable-bundle transaction. Geometry, UV correspondence, groom, glasses, facial cage, physics binding and pre-ear baseline are unchanged. All six served browser assets match the release manifest.

This bundle includes the concurrently developed, explicitly estimated crown-completion material. Native frame caches were not migrated. The initial ear-only comparisons and current combined appearance check are distinct experiments. Publication and HTTP checks are recorded in `.local/ear-component-publication.json` and `.local/ear-component-api-verification.json`.

The main viewer loads this bundle. A new Newton session was refused because the local service had reached its concurrent-session limit. No existing sessions were evicted; this pass does not claim a new live physics/rig smoke test. The unchanged cage and binding files were verified by hash.

## Remaining attachment evidence

Astra's registered, alpha-aware ownership probe rejected a tempting label-only repair. Upper ear controls have several geometrically facing cameras, but frame 0034's candidate source pixels have alpha zero: they are unknown, not negative ear evidence. Only one annotated view supplies valid exterior evidence for the traced upper and lobe controls. A two-view agreement rule therefore cannot safely relabel them as head. The upper controls also lie roughly 28–33 mm along the template surface from its ear/head interface, outside a narrow attachment collar. Clipping the existing ear color solve alone makes negligible changes to these examples.

Do not expand the ear mask into photographed hair/neck or clamp missing samples to the nearest ear pixel. The next investigation needs native foreground coverage and silhouette/geometry evidence before changing the auricle or its ownership. Private measurements are in `.local/ear-attachment-material-audit/registered-ownership-report.json`; zero-alpha observations must remain unknown as appearance evidence.

Direct inspection of native frame 0034 subsequently confirms that the traced upper-flap projection is actual background, both before and after ear registration. This can constrain a silhouette/geometry investigation, but it cannot donate head color or count as a photographed adjacent-skin observation. Native control images and the final recommendation are in `.local/ear-attachment-material-audit/REPORT.md`.

These changes do not establish hyperrealism. Hidden appearance is estimated, inner-ear geometry is still template-derived, and actual source registration and lighting need further validation. Browser inspection still shows small ear-owned flaps, estimated eyes and residual attachment seams.
