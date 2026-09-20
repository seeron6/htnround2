# Pain rig and bone breaks (Live head · elastic)

Asked for on 2026-09-20: in elastic mode the head should look hit and in pain, move the way a
struck head moves, and come back; and a blow of magnitude 0.70 or more on a bony part of the
face should leave that part slightly deformed, as if the bone broke. This replaces the single
wince of [PAIN_REACTION.md](PAIN_REACTION.md) and the `> 0.90` damage rule of
[IMPACT_RIG.md](IMPACT_RIG.md). Clay mode is unchanged.

Code: `src/pain-rig.js` (the rig), `src/bone-fracture.js` (the breaks), hooked into
`src/impact-rig.js`, `src/tissue-field.js`, `src/physics.js`, `src/newton-dynamics.js`,
`src/speech-rig.js`, `src/impact-worker.js` and `src/impact-controls.js`.
`src/pain-expression.js` now only re-exports the old names.

## What was taken from FaceFusion

[FaceFusion](https://github.com/facefusion/facefusion) was read for method only. It is
OpenRAIL-AS, so nothing is copied, and it is a 2D tool: its face editor and expression restorer
drive LivePortrait's 21 implicit keypoints through ONNX models, which cannot pose a 3D mesh.
What transfers is how it rigs a face (`processors/modules/face_editor/core.py`,
`expression_restorer/core.py`, `processors/live_portrait.py`):

| FaceFusion | Here |
| --- | --- |
| A face is `scale * (points @ rotation.T + expression) + translation`: the head's turn and the expression are separate channels, and the expression lives in the head's own frame. | The poses are head-space fields; the flinch is a separate head rotation (`headFlinch`) that the recoil spring chases. |
| Each control (`edit_mouth_grim`, `edit_eyebrow_direction`, ...) is one scalar in -1..1 that moves a few named points by a fixed small amount. | `PAIN_CONTROLS`: `eyeClose`, `browLower`, `cheekRaise`, `noseWrinkle`, `upperLipRaise`, `cornerPull`, `jawOpen`, each side separately, each a sparse field built once per head from its landmarks. |
| Controls are summed into one expression, then clamped once to a calibrated box: `limit_expression`. Head angles likewise: `limit_angle` (it allows an edit pitch 20°, yaw 60°, roll 15°). | `limitControls` clamps every summed control to 0..1; `limitHeadPose` clamps the summed flinch of any number of blows to a much tighter box (about 9°, 12°, 7° as shown). |
| Eyes and lips are driven as an opening **ratio** of this face's own lid gap / mouth width, so every face closes alike. | `eyeClose` removes a share (78 %) of *this head's* measured lid gap, the upper lid doing most of it. The gasp is a fraction of the speech rig's open shape, itself sized as a lip-open ratio ([LIP_TOPOLOGY.md](LIP_TOPOLOGY.md)). |
| The expression restorer keeps upper-face and lower-face keypoints as separate groups. | Each control names its `area`; the reflex (eyes) leads and the guarded eye outlasts the mouth. |
| Every edit is pasted back through a feathered mask so it joins what it did not touch. | Every field feathers to nothing on the skull and neck, and only the largest connected skin component moves (eyeballs and cage points stay put). |

## The reaction

Three poses per blow, blended by `painTimeline` (weights never sum past 1):

- **Flinch** (from ~30 ms, shut by ~130 ms): the blink reflex and a jaw knocked slack. Eye
  closure here barely depends on strength: a light hit still makes you blink.
- **Grimace** (from ~0.15 s, held 0.45 to 0.8 s by strength): brow lowering, orbital
  tightening, nose wrinkle and upper-lip raise, lips stretched down and back. The struck side
  does more. These are the core pain actions of Prkachin's
  [comparison across pain modalities](https://pubmed.ncbi.nlm.nih.gov/1491857/).
- **Ache** (until 1.5 + 1.3 × magnitude s; 0.7 s longer after a break): the far eye opens
  first, the struck eye stays half shut, the brow stays drawn, then everything eases to rest.

At magnitude 0.85 the whole thing runs about 2.6 s and ends at exactly zero offset. Alongside it:

- **Head flinch** (`FaceImpactRig.headPose`): the face turns the way the blow was travelling
  (away from the fist), the chin tucks (or lifts, for a blow from below), a little roll. The
  existing recoil spring in `FaceDynamics.step` / `NewtonFaceDynamics.step` now rests at this
  pose instead of at zero, so the motion has the spring's weight and the "Head recoil" checkbox
  still governs all of it.
- **Gasp** (`FaceImpactRig.gasp`): the mouth is knocked open and stays a little parted while it
  aches. It goes through `FaceSpeechRig.step(dt, duck, gasp)` as a floor under the jaw, because
  that rig knows which lip is which on a mouth with a seam. A voice that opens the jaw further
  wins; `src/sponsors/expression.js` is untouched and still layers on top.

Each pose is checked (`SurfaceValidity.constrain`) alone and together with the contact dent,
over the base it will be drawn on, exactly as the old single pose was. Endpoints are now stored
relative to that base, so `step` is `kept + Σ weight × endpoint`.

## Bone breaks

Rule (`wouldFracture`): magnitude **≥ 0.70** and the contact's bone support
(`TissueField.anatomy().bone`) **≥ 0.5**. `anatomy()` now also says *which* bone
(`bones.nasal / zygoma / mandible / temple / frontal / occipital`). Lips and cheeks never break.
Severity is 0.55 at the threshold and 1.0 at full magnitude: bone breaks or it does not.

| Bone | What is asked for at full severity (the surface smoothing below keeps a little less) |
| --- | --- |
| Nasal | The nose is carried sideways with the blow (7.5 mm) and its bridge sinks (4 mm). A blow that came straight in still leaves it a little crooked. Both lower lids swell. |
| Zygoma | The cheekbone plate is driven in (9 mm). The lower lid on that side swells. |
| Mandible | The whole chin block sits off to one side (7.5 mm), a little back, and hangs 2.5 mm. |
| Temple, frontal, occipital | A shallow depressed plate (7.5 mm) with a raised ring. |

Each field is spread along the surface and gradient-limited before it is kept, so its edges
do not read as creases on sound topology (see Limits); on the measured scan that leaves 2.2 to 4.4 mm at magnitude 0.70 and
4.0 to 7.1 mm at 1.0. The break sets with the blow (the same 120 ms onset as a clay dent).
**Swelling** (0.5 to 2 mm) comes up afterwards over `SWELL_SECONDS` = 3 s. Both are fitted with the existing `fitIncrement`, so the
kept shape has no reversed triangles, and a live head's total is capped at `FRACTURE_LIMIT` =
12 mm however often it is hit ("slightly deformed" is the brief; clay keeps its 65 mm). Breaks
persist until **Reset head**, are saved with sessions and baked into GLB export, like the old
damage. A break also makes the reaction stronger and longer. The eyelids are left out of every
kept field: they are the finest skin on the head and they close hard in the grimace.

The status line names it ("Live impact · broken nose"), and `lastImpact.fracture` is
`{ bone, side, severity }` or `null`.

### Threading

A blow that breaks bone is prepared in order on the main thread, because it changes what the
head keeps. Measured on the 17,842-vertex scan: 40 to 105 ms (the first one also builds the
gradient matrix, ~130 to 190 ms). It lands on the frame of the blow and reads as hit-stop. Every other
live contact still goes to the worker **even after a break** (it used to fall back to the main
thread forever once any damage existed): worker endpoints are relative to rest and are laid over
the break. The worker no longer warms contacts that would break bone.

## Verified 2026-09-20

- `FACE_IMPACT_CAPTURE=.local/face-captures/<id> npm test`: **357 passed, 0 skipped**, on the
  17,842-position / 35,680-triangle photo head; `vite build` passes. New:
  `tests/pain-rig.test.mjs`, `tests/bone-fracture.test.mjs`. Updated for the new timings and
  rule: `pain-expression`, `directional-impact`, `impact-preparation`, `physics` tests.
- Every bone at 0.70 and 1.0, sampled every 20 ms for 4 s on that head: finite, **zero reversed
  triangles**, kept peaks 2.2 to 7.1 mm, six full-power breaks at one spot stop at 12 mm.
- Rendered on the real scan (timeline contact sheets) and run end to end in the app against the
  real worker: nose 0.85 → "broken nose", kept 4.6 mm; a cheek hook afterwards went through the
  worker and recovered to exactly the broken shape; forehead 0.69 → nothing kept.
- Review harness (safe to delete): `.claude/launch.json` `pain-preview` →
  `http://localhost:6231/pain-review/`, then `__review.sheet({...})` / `__review.aftermath({...})`
  write PNGs to `.local/claude-pain/shots/`. It renders a static copy of one scan and cannot
  reach the live API or Newton.

## Limits

- Authored animation and a product rule, not a pain measurement or a fracture predictor. There
  is no skull: "bone" is the landmark-based support field already used for compliance.
- Breaks change shape only. There is no bruising or blood; a vertex-colour bruise would share
  the `color` attribute with `shadeMouth` and was left alone on purpose.
- On a scan with sliver triangles where lid meets cheek (older local heads), a cheekbone break
  can show a fine crease under the eye in Geometry view. It is barely visible textured.
- The gasp opens a real gap only on a mouth with a lip seam; on a sealed mouth the lips stretch,
  as they do for speech.
- Hits from behind still get a (weaker) wince. The flinch is a head rotation only: no neck,
  shoulders or stagger.
