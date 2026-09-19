# Experimental ear donor evidence

The accepted capture remains generation `3fd53b91e39344e8bf81aaacfb7b9162`.
This experiment is **off by default and unpublished**. Removing an invalid
photographic donor prevents false confidence; it does not recover missing ear
shape or color. Matched browser and independent CPU comparisons still show the
attachment seam and lower fragments.

## Why the original sample was wrong

Astra's exact replay reproduced the accepted texture before inspecting 17,724
covered atlas samples. At PNG coordinate `(1391,644)`, the right attachment strip
received all accepted support from predicted ear ellipses in unannotated views.
The strongest donor in native frame 12 is visibly cheek. Annotated frames 6 and
10 put the same registered surface sample outside the photographed ear; their
camera directions differ by 32.43 degrees. These are distinct observations,
not duplicate crops of one exposure. Real upper hair and both concha shadows
remain separate, supported controls.

## Bounded rule

`ear_donor_projection.py` measures signed distance to the original undilated
annotation at the actual camera sampling coordinates after ear registration.
It converts native crop coordinates to camera pixels independently on each
axis. Original alpha, first-hit visibility, image bounds, facing, cutout-edge
distance, opaque accessories and generated-reference masks qualify evidence.
Malformed polygons, ambiguous side assignments and absent annotations supply
no negative evidence. Two camera views at least 10 degrees apart must agree
exterior, and any trustworthy interior observation prevents suppression.

`ear_donor_evidence.py` tapers the strength over the two-pixel uncertainty band
and the facing/alpha/edge thresholds. These thresholds are experimental bounds,
not calibrated probabilities. `bake_photographs` freezes the resulting field
once on the full surface index set. Only inferred-ellipse donor contributions
receive it; annotated observations, anatomical labels and geometry do not.
The argument is `experimental_ear_donor_evidence=True`. Normal builds and detail
rebuilds omit it and retain the accepted behavior.

## Full-bake findings

The control with the argument off reproduced the accepted appearance PNG exactly.
With it on, seven annotated cameras attenuate 3,423 of 202,586 ear samples;
550 lose inferred support completely and 95,275 have positive protection.
The finished PNG changes 2,347 covered ear texels and **zero covered non-ear
texels**. Including atlas padding, 8,760 pixels change. UVs, mapping, indices and
head positions are exact. The original upper-hair, both concha, left-lobe and
rear-lobe controls retain their exact RGB.

The false attachment donor changes from `(197,151,122)` to `(184,134,108)`.
That new color is an estimate from the existing continuation stage, not a
newly observed ear pixel. At matched yaw 62 degrees, the strip becomes slightly
darker but remains jagged. The independent CPU comparison at -68 degrees changes
only 59 screen pixels, by at most 3 channel values; 149 degrees is unchanged.
The evidence supports lowering donor confidence, **not publishing this as a
visual reconstruction repair**.

Fresh one-worker and four-worker processes took 133.80 and 110.81 seconds.
Their appearance/roughness PNGs and normalized atlas metadata match exactly;
code fingerprints stayed fixed. These are cached texture-bake timings, not
video-to-model pipeline timings. The experimental appearance SHA256 is
`90f4bc8c59a83e07ff524174216f2228f9b1674b8e430c4df6c90c16f1a8e9d2`.
Thirty-six targeted evidence, projection, ownership and registration tests pass.

A separate probe reaches the real projector before the final color fill. Four
actual camera views (three annotated and one inferred) agree exactly between
full projection and a deliberately permuted subset containing every ear sample
plus 8,192 other surface samples. All contribution/confidence fields agree with
zero numeric difference. Comparing enabled/disabled projection preserves every
annotated and non-ear contribution exactly; only the inferred view loses
support, at 2,012 tested samples. The common evidence field stays immutable.
The first probe stopped because NumPy's lazy testing import tried to launch a
platform probe under the offline guard; preloading that testing utility before
entering the guard allowed the verification to run without weakening the guard.

Local evidence: `.local/ear-donor-{baseline,proposal,proposal-serial}/verification.json`,
`.local/ear-donor-equivalence.json`, `.local/ear-donor-targeted-tests.log`,
and `.local/ear-donor-render-review/comparison-{62,-68,149}.png`.
The actual projector report is
`.local/ear-donor-projector-verification-v2/verification.json`.
The private browser bundle is `/hair-review.html?review=ear-donor-review`.

## Exact continuation branch audit

Astra subsequently reproduced the accepted PNG again and saved all 202,586 ear
samples at entry/exit of `continue_ear_skin`. Replaying its two algorithms from
those arrays agrees within 6.7e-16. This identifies the actual branch rather
than inferring it from the final image.

The rear-lobe control `(2721,125)` shares a triangle with outside-core vertex
6915, which is unresolved. The all-three-corners gate therefore skips harmonic
completion, leaving the nearest-donor estimate. Its two strongest donors are
5.55/5.61 mm away on connected lower-ear triangles, with categorical surface
path upper bounds of 8.73/8.51 mm. These are not evidence of a remote concha
shortcut, but their exact source-photo identity remains unverified. At the
left upper control `(944,2348)`, two outside-core corners similarly prevent
harmonic completion. Its nearest donors are about 12 mm away in space, with
surface path upper bounds around 21–24 mm.

A private clipped-ear solve reaches every original ear-owned texel, including
15,257 mixed-triangle samples. It changes 47,285 unsupported ear PNG texels and
zero samples with confidence at least 0.08. Reliable donors, both conchas and
all non-ear texels remain exact. Final PNG values change as follows:

| Control | Accepted | Clipped counterfactual |
| --- | --- | --- |
| Left upper patch | 138 / 86 / 73 | 176 / 128 / 109 |
| Rear lobe | 78 / 50 / 38 | 85 / 56 / 44 |

Matched render crops still show angular attachment boundaries and the dark
lower fragment. This establishes a solver-domain inconsistency, **not a
visually adequate repair**. The private experiment uses binary head/ear labels
because those border these particular ears. General adoption would need to
preserve each original categorical label sum and its exact tie rule; changing
an ear temporarily to label zero must not grant it head-owned boundary samples.

The complete branch, donor and render evidence is under
`.local/ear-completion-branch-audit/`, especially `REPORT.md`, `provenance.json`,
`branch-report.json`, `donor-paths.json` and `comparison-{62,-68,149}.png`.
No variant was published.

## Subsequent attachment correction

The next measurement established an unsupported-to-unsupported color jump at
the shared boundary on triangles `[963,9514,14186]` and `[4592,6915,5301]`.
That separate investigation produced an accepted continuous attachment field
with genuine photographs and cleanup pinned. See
[attachment evidence and release checks](HEAD_ATTACHMENT_CONTINUATION.md).
The donor gate and independently clipped ear solve described above remain
unadopted; the accepted change does not enable either experiment.
