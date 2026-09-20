# Lip topology: a mouth that can open

Written 2026-09-19 by Claude. Code: `src/lip-topology.js` (geometry, no DOM), `src/lip-fit.js` (glue),
hooks in `src/main.js` (`fitMouth`, `fitLips`, `adoptLipGeometry`), `src/speech-rig.js` (`_buildFromLips`),
`src/physics.js` (`setLipTopology`, `seamJaw`), `src/surface-appearance.js` (`shadeMouth`).
Tests: `tests/lip-topology.test.mjs`, `tests/lip-rig.test.mjs`, `tests/lip-adopt.test.mjs`,
`tests/mouth-interior.test.mjs` (teeth and tongue, `src/mouth-interior.js`).

## The fault

`src/mouth-aperture.js` opens a mouth by deleting the triangles that seal it. That is exact on the MediaPipe
canonical face, which has real lip rings, and wrong on everything else. Measured on the three Meshy heads in
`.local/face-captures/*/meshy/model.glb`: ~30k triangles, mean edge 2 % of head height, so **~6 mm triangles at
the lips**, and the UV atlas is torn into 2-3.3 copies of every vertex. Deleting whole triangles there leaves
black shards across a *closed* mouth, and the triangles that survive still bridge the lips, so they stretch
across the opening when the jaw moves. No choice of triangles fixes it: the mesh has no edge where the lips meet.

## What runs now, for every head, after it is built

Every head reaches `fitMouth()` whichever engine made it (Meshy GLB, local pipeline, uploaded GLB, restored
session). It ends in one of three states, reported on `window.__faceDetection.lips`:

| mode | when | what happens |
| --- | --- | --- |
| `cut` | lips are one sealed surface (Meshy, most uploads) | refine, cut a seam, add the inside of the mouth |
| `adopted` | lips are already parted (local pipeline: the head template has real lips) | nothing moves; lips are labelled, the inside is darkened |
| a refusal string | no trustworthy face, or no clean seam | mesh untouched, lips stay sealed |

**Cut.** (1) Bisect long edges around the lips (Rivara longest-edge, 4T-LE templates) until they are about 1/24
of the mouth's width; a dense mesh is left alone. (2) The lip line is the zero set of a per-vertex
height-above-seam in the detector's image; every edge it crosses is split, which chains the splits into one edge
path from corner to corner. (3) The lower lip gets its own copy of that path; the two corner vertices stay
shared. (4) A closed pouch (inner lip, roof/floor, back wall) hangs behind the lips from its own copy of the
lip edge, drawn in one lip-coloured texel and darkened with depth through vertex colour.

The invariant: **it only refines.** Every new surface vertex lies on an original edge and every new triangle
inside one original triangle, so the shape is unchanged and the texture is exactly preserved however fragmented
the atlas is. Nothing is re-projected or re-baked; a closed mouth renders exactly as before. Vertices are only
appended and untouched faces keep their place, so hair roots, the Newton binding and sculpts survive
(`extendVertexField`, `growBinding`).

**Adopted.** The local pipeline's heads are hollow shells whose template already has separate lips: through the
gap you look ~13 cm back at the untextured inner wall (it showed as a teal line between closed lips and a teal
hole when open). Nothing is cut. Which lip each vertex belongs to is found by walking the surface from skin
that is certainly upper or lower lip (the lips only meet at the corners and deep inside, so the nearer source
is right even where the upper lip hangs below the top of the lower, which is where judging by height made the
opening ragged). What to darken is decided by occlusion, not connectivity or normals: a surface is inside the
head if something lies behind it AND (something lies at least 8 % of a mouth width in front of it OR it is deep
behind the lip gap). On scan `a0caa0c3…` a connectivity walk from the inner lips reaches the scalp, and the
whole head would have been drawn black; `tests/lip-adopt.test.mjs` pins that.

## Teeth and a tongue

`src/mouth-interior.js` (tests: `tests/mouth-interior.test.mjs`). Built in `fitMouth()` for every head that ends
`cut` or `adopted`, so a Meshy head and a PunchingFace-pipeline head get the same mouth with nothing authored per
head and nothing saved: it is sized and placed from that head's lip line (everything is in mouth widths) and
rebuilt on every load. `window.__faceDetection.lips.teeth` reports the count (24: six a side, top and bottom).

They are separate meshes, not more of the head's surface: no texel of a photograph of a closed mouth is the
colour of a tooth, and an adopted head must not change its vertex count. What keeps separate meshes honest:

- **The jaw.** `FaceSpeechRig.jaw` exposes the open shape's hinge and its radians per unit of `open`;
  `FaceDynamics.jawSwing` adds speech and the Jaw slider. The lower teeth and tongue swing on that hinge by that
  angle, in the same small-angle form the rig uses, so they keep their place behind the lower lip at any
  opening. The upper teeth belong to the skull and never move with speech.
- **A punch.** Rigid teeth behind lips that a fist has pushed in a centimetre would burst through them. Each tooth
  rides the *contact* displacement (the solver's `offset` and the impact rig's, never pose or speech) of the three
  lip vertices in front of it.
- **Standing room.** Each tooth looks forward from just behind itself and backs off until it clears the first
  surface it meets (a Meshy head's pouch starts ~3 mm under the skin, a local head's lips are a centimetre of
  shell), then the row is evened out. In `cut` mode the pouch (`POUCH` in `src/lip-topology.js`) climbs the back
  of each lip before heading for the throat, which is the front room the teeth stand in; `tuck` keeps every pouch
  row behind the skin whatever the lips are shaped like.
- **The light.** Colours are linear albedos chosen against this app's lighting (2.7 hemisphere + three
  directional lights through ACES): "tooth white" clips to a flat white there, and a fifth of it still displays
  as light grey. So the mouth is dimmed by how far the lips are parted (on a squared curve from 0.004), which
  also keeps an adopted head's millimetre of resting lip gap from showing a white line, and teeth fall to almost
  nothing towards the corners, or the molars show as wedges of white.

Not exported with the GLB, and hidden in clay mode like the old mouth cavity.

## What was taken from FaceFusion

Read for method only (it is OpenRAIL-AS; nothing is copied). It is a 2D tool, so what transfers is how it
addresses a mouth, not code:

- The mouth is two lip **contours** (68-point outer ring 48-59, inner ring 60-67), and its face parser keeps
  `upper-lip`, `lower-lip` and `mouth` as three regions. Here: one seam on the inner-lip line, each lip on its
  own vertices, shared corners, and a separate inside.
- Lip opening is a **ratio**: inner-lip gap over mouth width (`calculate_distance_ratio(lm, 62, 66, 54, 48)`),
  which is what LivePortrait's lip retargeting takes. `FaceSpeechRig.lipOpenRatio` is the same quantity, and
  the open shape is sized to `OPEN_RATIO = 0.30` of *this head's* mouth width, so every mouth opens alike.
- Every edit is pasted back through a **feathered mask**, hard inside and soft at the edge. Here that is the
  jaw weight in `_buildFromLips`: a step across the seam mid-mouth, closing to 0.5 on both sides at the
  corners (they travel half as far and stay joined), feathered beyond them. Discontinuous exactly where the
  mesh is, and nowhere else.
- wav2lip only ever redraws the **lower half** of the face; the speech rig already never moves anything above
  the base of the nose.

The Jaw slider drives the same seam-aware swing (`FaceDynamics.seamJaw`, x2 a spoken "ah"), because `rigDelta`
is a function of position alone and the two copies of a seam vertex share a position: it can only drag both
lips the same way. The exported `jaw` morph target uses it too.

## Guards worth knowing

- **A detection is only believed if it is a face.** MediaPipe returns a complete, well-proportioned face
  whenever it returns anything. `trustedDetection` requires the close-up second pass (`framing === 'face'`) and
  a nose tip at least 0.12 interocular distances in front of the eyes. Measured: 0.50 and 0.32 on two real
  Meshy heads; -0.24 on the neck stump of a head Meshy delivered lying on its back
  (`4c5a9076…/meshy/model.glb`), which was otherwise given a mouth in its neck.
- **A local scan's own landmarks win.** Its first 468 vertices are the MediaPipe landmarks
  (`detectionFromCage`), so its lip line is exact and no render is needed.
- **Raycast anchors can fall through.** A ray through a lip landmark passes between parted lips and lands on
  the back of the skull (`mouthCentre`, `soundAnchors`); one aimed at a mouth corner can miss it
  (`mouthCorners`; the reference head's does, which doubled the measured mouth width).
- **A crease is not a parted mouth.** Lips that look parted from the front but meet a few mm down a crease are
  not adopted (their floor would stretch like a tongue); they go to the cut.
- **Order of assembly.** `installMesh` starts a fit before its caller has attached a textured surface or a
  solver. That fit waits for the busy overlay to clear (`settle`) and gives way to any later fit (token), and
  `loadPhotoFace` awaits a fit *before* it builds `NewtonFaceDynamics`, so Newton starts once, on the final
  vertex buffer, with a grown binding.

## Known limits

- The **reference head** (`public/reference/face-poisson.json`) is refused by both modes (a raw scan with a
  ragged, half-open slit and messy inner layers), so it keeps the mouth it always had.
- A head Meshy delivers in the wrong orientation gets no mouth at all, by design; fixing its orientation is a
  separate problem.
- Re-importing a GLB this app exported welds the two lips back together by position, and the cut is made again
  from a fresh detection. Saved sessions keep their topology (`geometry.userData.lipTopology`).
- Teeth and tongue are stylised and rigid (no gums, no per-phoneme tongue shapes), and are not written into an
  exported GLB.
- Browser checks: the render loop returns early while `document.hidden`, so a hidden preview pane shows a
  blank canvas and cannot be used to judge any of this.
