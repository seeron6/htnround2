# Ear contour refinement and repeatable rebuilds

19 September 2026. Published generation
`3fd53b91e39344e8bf81aaacfb7b9162` replaces
`8488bd76981e4320bcde74d59249456d`, which remains available. It contains the
source-constrained ear outline, transported existing groom, matching photographic
atlas and separate glasses. This is a bounded improvement, not a hyperrealism
or arbitrary-video validation claim.

## What the observations support

The remaining upper ear flap is partly a geometry error. Native RGB confirms
that its projection lands on background in frame 34 and hair in frame 37.
Three fitted anchors do not constrain the full helix. Moving an ear texture or
painting the flap as hair would hide a shape error and stretch real ear detail.

`ear_contour_observations.py` extracts the visible external arc from source
annotations in their exact crop coordinates. It chooses between the two
top-to-bottom polygon paths using arc-length-weighted distance from the tragus,
samples by arc length, trims uncertain ends and removes opaque glasses gaps.
Missing anchors, unreliable annotations, ambiguous paths, two accepted ears in
an oblique frame and unresolved near-rear image-side correspondence are rejected.
No outline is inferred through glasses or a hidden attachment.

`ear_contour_fit.py` requires at least two reliable views separated by 15 degrees.
It solves smooth local surface displacement using camera-projected, mesh-bound
correspondences and a 2-camera-pixel uncertainty deadband. The observed face,
first 468 cage vertices and all ear anchors are fixed. Both directions of contour
error and untrimmed eligible extrema are checked. Large reverse errors remain in
validation; excluded gaps cannot become correspondence targets by averaging.
Clipped boundary points retain original vertex identity, including coincident
disconnected surfaces. Original and current surface quality, intersections and
the actual persisted float32 result are checked separately.

## Withheld source arcs

The generic candidate was fixed before evaluating these manual native-image
arcs. Frames 35 and 36 cover the exposed left outline; frame 18 supplies only a
short right upper-helix arc. These are adjacent views from one recording, not
independent captures or measured anatomical ground truth. Approximate annotation
uncertainty is 1.5–2 camera pixels.

| Frame | Outline P95 before → after (camera px) | Mean squared error before → after |
| --- | --- | --- |
| 35, left | 7.48 → 4.05 | 12.23 → 2.55 |
| 36, left | 9.03 → 6.15 | 27.29 → 12.02 |
| 18, right upper rim only | 4.33 → 3.75 | 5.05 → 3.80 |

The right median changes from 1.53 to 1.61 px; do not describe every statistic
as improved. That short arc cannot validate posterior thickness or the lobe.
Frame 19 was consulted during earlier method development and is not an untouched
holdout. The latest measured proposal retains a closed mesh, introduces no
detected crossings or reversed triangles, and moves a vertex by at most 7.075 mm.
Its float32 position hash is
`84c33295b66935e230af9135e732a4592cbd6c854f353163f071167837676d12`.

## Hair and stage ordering

`hair_surface_transport.py` retains all 8,000 root identities, station bindings,
photographic colors, confidence and parameters. Each curve offset receives its
bound station displacement minus its bound root displacement. This preserves
the original submicron rounding residual; it does not create new hair evidence.
The candidate moves 172 roots and 3,347 station centers, with a maximum retained
rest residual of 0.00086 mm. Browser inspection with fibers enabled shows the
smaller upper flap and attached hair, but rough upper/lower attachment patches
remain. This is not a hyperrealism pass.

A rebuild regression exposed a separate stage-order problem. Generation
`e4d4c9b3b65744acbbb3b6680027042c` applied the same later hair displacement to 940
vertices in both the accepted surface and its earlier pre-ear baseline. Ear
measurements stayed identical. Re-running nonlinear ear regularization on that
modified baseline changes the accepted result by up to 2.419 mm.

`ear_contour_rest.py` therefore stores a distinct post-ear, pre-contour input
alongside the original independent quality baseline in `pre-ear-surface.npz`.
Hashes bind topology, canonical rest positions and ear measurements. The loader
checks the protected face/cage. A legacy accepted surface may seed this stage
once only when its saved measurements match and it has no previous contour fit.
Subsequent detail rebuilds start from that same stage input. Changed measurements
require a complete build. Hair refits transfer their persisted displacement into
both stage inputs separately and refresh the contour-rest hash.

The private geometry-only detail rebuild reproduces every saved float32 vertex
exactly. A complete private detail rebuild also preserves positions and the
transported groom exactly, taking 46.98 seconds. It exposed the old
visibility-based material-ownership routine pruning 154 left and 37 right
anatomical ear vertices. That routine ignored the source-alpha/negative-evidence
rules. It now retains anatomical identity, matching the previously approved
material labels. The pruned private generation
`cfdf2be00c9b4b8cb5df8456b80f832a` was rejected and never published to the capture.

## Final verification

A concurrent, user-requested UI/OMNI merge temporarily removed tracked pipeline
hooks. Its preserved snapshot restored them, and all final checks below were
rerun against the restored code. The final complete private rebuild took 82.98 s
and preserved the candidate's positions and groom exactly. A subsequent
geometry-only rebuild again produced identical float32 positions, leaving its
release pointer unchanged. Runtime checks constructed 21,600 strands from the
saved groom, translated the real mesh and returned it to rest with errors below
0.00004 mm. Reloading the saved groom reconstructs identical strand vertices.

The serial/four-worker texture bakes ran in separate fresh interpreters with
network, subprocesses and source writes prohibited, including writes through
borrowed capture-input symlinks. PNG bytes and atlas metadata match exactly,
and match the published candidate. Times were 107.33/85.97 s with concurrent
work on this machine; these are not isolated performance benchmarks. The final
atlas has 25,653 vertices and 38,630 triangles. All six served model/texture/rig
assets match their immutable release hashes.

The measured face, first 468 cage points and ear anchors remain exact. All 3,007
moved mesh vertices have zero physics deformation activation; the cage and
physics-binding files remain byte-identical. The independent pre-ear positions
are unchanged, and the separate contour rest is recorded. Browser inspection
covered both profiles with hair and glasses enabled. Upper/lower attachment
appearance seams, template inner folds and inferred eyes still remain.

There are **124 passing targeted Python tests**, plus **10 passing hair-renderer
tests**. A fresh live Newton session was not established in this pass; the
earlier viewer attempt encountered the shared session limit. No unrelated
session was evicted and no new live-physics success is claimed.

## Evidence

- `.local/ear-contour-generic/heldout-report.json`: persisted geometry and held-out arcs.
- `.local/ear-contour-generic-candidate/verification.json`: first private 31.56 s bake and hair transport.
- `.local/ear-contour-rebuild-replay.json`: exact geometry-only rebuild.
- `.local/ear-contour-complete-rebuild.json`: complete private rebuild and code fingerprints.
- `public/generated/ear-contour-generic-review`: browser candidate before the rejected ownership pruning.
- `.local/ear-contour-final-rebuild.json`: corrected full rebuild after anatomical ownership retention.
- `.local/ear-contour-final-geometry-replay.json`: exact repeated geometry and unchanged release pointer.
- `.local/ear-contour-groom-runtime.json`: actual saved-groom translation/return/reload checks.
- `.local/ear-contour-final-verification.json`: fresh-process exact bake comparison and code fingerprints.
- `.local/ear-contour-publication.json`, `.local/ear-contour-api-verification.json`: publication and served assets.
