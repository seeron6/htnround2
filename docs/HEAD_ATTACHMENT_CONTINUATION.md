# Continuous estimated head/ear attachment

The remaining jagged ear seam had a separate material cause after the outline
fit. The head and ear completion stages solved independently. They assigned
different estimated colors to immediately adjacent points on the same triangle.
Changing the ear solve alone could make that discontinuity worse.

## Evidence from the source recording

Astra measured the original accepted capture, generation
`3fd53b91e39344e8bf81aaacfb7b9162`, after reproducing its texture exactly.
An upper attachment boundary has a median adjacent RGB-vector difference of
71.90/255; the lower boundary has 141.86/255. The sampled pairs are about
0.25 mm apart at the model's estimated scale. All 11 upper and 13 lower pairs
lack reliable photographic, cleanup or positive hair support.

At the upper boundary, the two registered projections land on the same native
upper-ear attachment skin, about 0.4 native pixels apart. Their native RGB is
approximately `(181,133,114)` and `(180,131,112)`. The head side's dark color is
an unobserved scalp prior, not photographed hair. This source check diagnoses
the false split; it does not bypass source-ear occlusion or claim that the
hidden head itself was photographed.

The lower pair projects beside the same below-lobe shadow. A dark estimate may
be legitimate there, but the abrupt categorical color jump is not supported by
those observations. Exact masks, projections, annotated native panels and
boundary endpoints are in `.local/ear-boundary-jump-audit/`.

## Pipeline change

`attachment_continuation.continue_attachment_color` solves one positive harmonic
color field across the connected head/ear junction. Mixed categorical triangles
seed a continuous mesh-distance field; the correction tapers over a 4 mm collar
beyond their vertices. That number is not an exact distance from the anatomical
attachment and uses the reconstruction's estimated physical scale.

The fixed boundary colors can be measured, cleaned or earlier estimates. The
audit labels them accordingly. The result supplies no additional photographic
coverage, recovered anatomy or calibrated skin color. Geometry, UVs, labels,
glasses, hair curves, the facial cage and physical binding are untouched.

Only unsupported attachment samples change. The correction is full at physical
support at most 0.03 and fades to zero at 0.08. Measured-face samples, reliable
hair/skin, positive semantic hair, verified glasses cleanup, eyes, mouth and the
neck cap remain exact. Some unprotected earlier inpaint estimates can change;
the pipeline records their count separately. Disconnected surfaces cannot
exchange colors, and components without fixed anchors retain their old fill.

This runs after the separate lower-skin and source-ear occlusion fills, before
eye material and the final photographic-preservation check. The experimental
ear-donor contradiction rule remains off; it is a separate unfinished proposal.

## Development validation

The private joint field reduces the two measured median boundary differences
to 1.41 and 4.12/255. It changes 43,974 covered PNG texels: 21,258 head and 22,716
ear. Independent inspection confirms no changes to protected source detail,
hair, cleanup or the concha controls. Of the changed PNG texels, 1,604 had an
unprotected earlier inpaint estimate; these are not newly recovered colors.

Matched browser views and independent CPU crops show cleaner upper attachments
and lower lobes. The inferred tones remain approximate, and genuine dark hair
above the right ear stays in place. Template inner-ear geometry, remaining
hair/skin transitions and broader capture generalization still need work.

The reusable helper uses float64 barycentrics; its largest difference from the
private prototype is below 8.5e-8 and the resulting PNG texels are identical.
Forty-four focused tests pass, covering same-facet continuity, UV duplication,
binding permutations, fixed source features, disconnected components, absent
anchors, cap exclusion, malformed inputs and existing appearance protections.

Independent review caught an additional general-topology defect before
publication. Omitting an eye or cap face from the edge graph did not stop its
texels from accumulating color onto a shared skin vertex. An excluded cap
could also remain a target if its vertices connected through permitted side
faces. Two new tests reproduce three failures in the initial implementation.
The corrected helper gates **both donors and targets** by permitted original
face identity and surface part, including independently reordered atlas faces.
Changing an excluded eye/cap color can no longer alter the attachment field.

## Accepted local bundle

Generation `41fa09628c104090af7ffb8253fbce56` replaces
`3fd53b91e39344e8bf81aaacfb7b9162` through the immutable artifact transaction.
The appearance PNG SHA256 is
`bef72f604353a6e43fdc4e2c46f75e1aadb0be34ba7b7d68113da466785c9976`.
Prior generations remain available.

Fresh one-worker and four-worker bakes of the corrected implementation took
143.41 and 105.88 seconds. Exact PNGs and normalized atlas metadata agree, and
all covered texels match the visually reviewed prototype. These are cached
texture-bake timings, not video-to-model timings. The finished texture changes
43,974 covered texels; all 3,721,737 protected texels remain exact. Code stayed
unchanged during verification and matched the fingerprint checked at publication.

Only the appearance PNG and its metadata changed. All mesh fields other than
appearance statistics, all accessories, roughness, the facial/physics cage,
bindings, saved rest geometry, ear measurements and source-validation artifacts
remain exact. Six served assets were fetched through the running frontend API
and matched the sealed release hashes. No new live Newton session is claimed
in this material-only pass.

The matched review was refreshed with the accepted bundle. Private source data
and comparisons remain in `.local/ear-junction-audit/`. Publication and current
verification reports are `.local/attachment-publication.json`,
`.local/attachment-final-equivalence.json`,
`.local/attachment-http-verification.json` and
`.local/attachment-full-targeted-tests.log`.
