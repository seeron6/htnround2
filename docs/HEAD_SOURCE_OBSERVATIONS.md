# Source review and eyewear rebuild consistency

19 September 2026. The accepted local capture remains generation
`3fd53b91e39344e8bf81aaacfb7b9162`. This pass changes the review and future
rebuild behavior. None of the private geometry or material proposals below has
been published to the capture.

## Original frames versus foreground masks

The previous comparison labeled the segmented image as the original frame.
The source video clearly contains the far lens in frame 10, but the foreground
cutout removes it. Treating that omission as an invisible lens would incorrectly
drive reconstruction and validation. Some hair boundaries are removed too.

`source_observations.matched_video_observation` reads the exact decoded frame
already chosen by the detail matcher, applies the saved orientation convention,
checks dimensions and rechecks alignment against opaque registered pixels. It
retains all original RGB, including pixels removed by the matte. It never writes
capture images, alpha, semantic caches or generated cleanup. The audit records
decoder index, rotation, sizes, pixel match error and image hashes. Missing video
or a missing matched record is explicitly unavailable; inconsistent source data
fails rather than silently substituting another frame.

The source review defaults to this unmasked frame. “Show cutout mask” toggles the
segmented capture with the same crop, camera and overlay. A larger shared crop
margin retains accessories outside the face mask. All seven current review angles
decoded and passed the existing 12/255 match-error threshold (4.83–6.97/255).
Native decoder RGB has no registered-color correction, so this is not a skin
albedo/color-calibration claim. Browser inspection verified the real far lens and
the source/cutout/overlay toggle.

This does **not** yet change the inputs to Astra's saved semantic analysis. A new
unmasked observation pass must be stored separately and verified before changing
approved masks, fitted geometry or cleanup inputs.

## Preserve measured frames through detail rebuilds

The full build measured rim widths with `eyewear_detail`, while the detail rebuild
called only the basic frame fitter. Rebuilding therefore silently dropped the
measured widths, lens-edge detail and source-described pale temple accents.
Both now call `fitted_eyewear.fit_photo_glasses`, which performs the same geometry,
source-pixel refinement and frame-color sampling.

A cached, offline private rebuild took 115.53 s and produced private generation
`4b0ac1cd9ef64e79aeec1ad9f95cf52f`. Relevant code stayed unchanged. Head positions,
the complete groom, appearance/roughness PNGs, physics cage/binding and ear
measurements were exact matches to the accepted release. The glasses retained
21 and 30 accepted width samples out of 48 per rim; other widths and hidden
hardware remain estimates. Report: `.local/eyewear-detail-rebuild.json`.

Actual renderer geometry revealed pre-existing intersections: the second arm
has sampled penetration up to 20.55 mm; measured rim refinement alone does not
repair that. The candidate reduces one rim's penetration but leaves about
0.50 mm on the other. Measurements include every rendered vertex and triangle
centroid, not a proof that all intersections were found. Source-independent
outward arm correction alters some profile projections. A separate private
source-camera ray correction preserves those projections but moves hidden
points substantially. Its exact rendered samples clear the right arm by at
least 2.16 mm, while the left still penetrates by 1.79 mm, so it is not accepted.
The multiview
lens-plane fit is also experimental. None is accepted merely because its
optimizer converged or one contour statistic improved.

## Remaining ear donor inconsistency

Astra reproduced the accepted PNG byte-for-byte before tracing 17,724 exact atlas
samples. A right attachment strip gets all accepted color from predicted ear
ellipses in unannotated views; native frame 12 shows that donor on the cheek.
Two trustworthy annotated views reject it. Real upper hair and concha shadows
are separate evidence and must remain.

The new pure `ear_donor_evidence` helper can attenuate predicted-only donor
eligibility when two independently positioned annotated views agree exterior
and no trustworthy interior view supports it. It uses original alpha,
visibility, accessory masks and an uncertainty band; duplicate or near-identical
poses cannot form the required pair. The private trace flags 263 samples,
fully rejecting 44, while all named genuine hair/concha controls stay unchanged.
It is now connected through an **off-by-default experimental bake argument**.
The full projector freezes the evidence once for use by every camera/subset.
Fresh serial/threaded bakes agree exactly and preserve covered non-ear color.
Rendered inspection shows a darker fallback at the false donor, but the visible
attachment seam remains. The proposal is not published; this is a provenance
correction, not a demonstrated likeness improvement. One-view left-lobe
ambiguity and mixed-ear continuation darkening remain separate open issues.
See [full-bake results](HEAD_EAR_DONORS.md).

## Checks

52 targeted Python tests and 14 JavaScript renderer/export/hook tests passed.
The Vite production build passed. The tests cover actual source-pixel fitting,
rebuild entrypoints, orientation/frame mismatch, input preservation, annotated
contradiction handling and existing head/rig contracts. These checks do not
establish hyperrealism or generalization across people and arbitrary videos.
