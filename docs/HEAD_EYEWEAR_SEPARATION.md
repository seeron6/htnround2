# Eyewear ownership in the reconstruction pipeline

Glasses are a rigid accessory, with independent rims, transparent lenses, arms and hardware. They are never vertices of the deformable head. Meshy supplies no geometry, texture or eyewear specification to this stage.

## Detection and publication

`scripts/eyewear_separation.py` interprets the existing multiview accessory analysis as **present**, **absent**, or **unknown**. It retains confidence, model and source views. Missing or low-confidence analysis is unknown. Visible contours contradicting a negative classification are also unknown. Cached analysis must match the capture hash for local photogrammetry preparation.

The default photo pipeline in `scripts/build_photo_face.py` records this decision, rejects uncertain analyzed captures, and requires a valid independent frame specification for a positive detection. It also requires registered clean front and side references, rather than silently falling back to painting photographed glasses into the skin when reference preparation fails. Explicitly disabling vision analysis still produces an unknown audit, not an assertion that glasses are absent.

The local photogrammetry adapter calls `scripts/scan_eyewear.py`. Confidently absent eyewear bypasses repair and leaves the head unchanged. For present eyewear it:

1. Fits frame contours through the recovered cameras.
2. Removes the scan-fused orbital/temple surface, including the opaque lens sheets.
3. Builds a constrained triangulation with the exact retained boundary and estimates socket depth from triangulated facial controls. This is not an anatomical eyeball model.
4. Bakes only that repair band from three cached, source-hash-verified and registration-checked glasses-free references. Both eyes use the frontal reference to avoid blending different expressions. Hidden skin is explicitly estimated.
5. Keeps the rest of the scan geometry and original atlas unchanged. Removes orphaned scan vertices and checks winding, welded watertightness and float32 triangle crossings.
6. Samples the original frontal photograph to refine rim centerlines and widths (`scripts/eyewear_detail.py`). Arm paths are fitted outside the repaired temple surface. Hidden hardware cross sections remain estimates.
7. Packages actual separate GLB nodes using `scripts/package_head_eyewear.mjs`, rather than relying on metadata alone. The importer rebuilds the same accessory specification for the live viewer and excludes accessory meshes from the skin solver.

Uncertain detection, stale inputs, unsupported repair boundaries, missing clean references or failed surface checks stop preparation before publication. This stage currently expects a camera-registered, upright head in the application's normalized 20 cm hairline-to-chin coordinate system. It is not a general repair tool for arbitrary full-body GLBs or sunglasses hiding all eye evidence.

## Reproduce and inspect

```sh
.venv/bin/python scripts/prepare_object_capture_head.py CAPTURE OBJECT_CAPTURE_DIRECTORY public/generated/NEW_CANDIDATE
```

The command uses new output directories and does not modify the accepted capture generation. It performs no new cloud calls; references must already have been prepared by the configured capture pipeline. See `HEAD_LOCAL_PHOTOGRAMMETRY.md` for the preceding local reconstruction step.

- Interaction: `http://localhost:5173/?nativePreview=native-photo-head-review`
- Comparison: `http://localhost:5173/engine-comparison.html?nativeGlb=native-photo-head-review`
- In the lab, expand **Accessories & alignment** and toggle **3D glasses** to inspect the clean underlying face.

The current review is `native-photo-head-review`, rebuilt from the separated-eyewear preparation of capture `7a2bc070892642999d3357c2c5838390`: 137,078 head triangles, 71,842 welded render vertices, and 21 separate eyewear meshes. The crown refinement keeps the rear expansion bounded by registered alpha and adds a 20 mm posterior roundover above the hairline; the face and independent glasses remain unchanged. Detection confidence was 0.99 from the saved seven-view analysis; that score is not a calibrated probability. The eyewear stage replaced 16,307 fused triangles with 19,323 socket/temple triangles. The original frame provided 21 and 30 accepted dark-edge width samples out of 48 per rim; unsupported samples retain bounded priors. Per-frame cleanup registrations take precedence over the legacy root-level front cache.

The exported head has zero detected crossing pairs and is watertight after UV welding. Sampled lens clearances are at least 2.20 mm and sampled arm clearances at least 1.25 mm in normalized, assumed-scale units. Rim contacts near the bridge reach approximately 0.20 mm penetration; the glasses share no geometry with skin. This sampling is an engineering check, not a complete collision proof.

The live material pass keeps the source-fitted rim contours and measured edge widths while applying a bounded 1.38× source-edge correction (2.0–6.8 mm) so the photographed thick rims remain substantial at review size. The acetate uses a broad bevelled section, warm grazing-angle specular lobe and clearcoat. Clear lenses retain the photographed eye appearance while adding a restrained optical response, 1.6 mm edge thickness and polished perimeter edge, independent silicone nose pads and metal carriers. The broad profile temple section uses the source-fitted path with a bounded 1.4× display correction and 3.1 mm side depth; the arm remains its own rigid mesh and does not deform with the head. These are display/material refinements; they do not change the independent head positions or fitted rim contours.

Browser checks on the published review: both hooks at magnitude 0.85 remained finite with zero reversed triangles (minimum area ratios 0.139 left, 0.090 right); Reset gave zero positional error. Glasses-off inspection showed the repaired face with no opaque lens sheet or frame texture. The live rig is still the experimental spring/impact rig, not a Newton cage. Crown/profile shape, some photographic shading, and overall superiority to Meshy remain unresolved.

Regression coverage: detection uncertainty and contradictions; no-glasses bypass; stale analysis and failed cleanup rejection; preservation of constrained boundary edges; temple clearance; independent GLB node/accessor ownership and transparent lenses; interleaved GLB import; finite detailed hardware; appearance, impact, sponsor and Meshy hooks. The GLB importer now handles interleaved attributes before passing packed arrays to the solver.
