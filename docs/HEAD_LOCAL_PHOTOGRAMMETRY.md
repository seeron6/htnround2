# Independent local head geometry experiment

The original candidate improved the old template's ear attachments and photographic continuity, but does **not** establish better geometry or realism than Meshy. It remains an explicit preview; the accepted native capture is unchanged.

## Eyewear update

The review link now contains the separated-eyewear candidate with bounded crown refinement: 130,312 head triangles and 17 independent accessory meshes. The old fused-lens crossing and right-hook flip reported below are historical failures of the preceding candidate. Both are resolved in the current reviewed output. Detection, repair, publication gates, limitations and verification are documented in [HEAD_EYEWEAR_SEPARATION.md](HEAD_EYEWEAR_SEPARATION.md) and [HEAD_CROWN_GEOMETRY.md](HEAD_CROWN_GEOMETRY.md). The overall model is still not qualified as better than Meshy.

## Reproduce

On this Mac, RealityKit's `PhotogrammetrySession.isSupported` returns true. The system Swift compiler builds the small CLI with Command Line Tools alone; no CUDA, Metal build tool, downloaded weights or cloud upload is required. This adapter uses camera intrinsics exposed by macOS 26.

```sh
xcrun swiftc -parse-as-library scripts/reconstruct_object_capture.swift -o .local/object-capture
.local/object-capture CAPTURE/detail-images NEW_RECONSTRUCTION_DIRECTORY
.venv/bin/python scripts/prepare_object_capture_head.py CAPTURE NEW_RECONSTRUCTION_DIRECTORY public/generated/NEW_CANDIDATE_NAME
```

The output paths must be new. The original capture is read-only. The first step supplies the saved native-resolution RGBA photographs and their alpha masks to Apple's local engine. The second aligns the result using triangulated facial landmarks, rounds crown corners, shortens the posterior and neck using explicit priors, transfers existing photographic hair-flow directions into modeled relief, and creates a sloped artificial neck closure. It writes a textured GLB, provenance audit and review metadata. It does not use the Meshy model, its texture, or a shape extracted from it.

- Compare: `/engine-comparison.html?nativeGlb=NEW_CANDIDATE_NAME`
- Interact: `/?nativePreview=NEW_CANDIDATE_NAME`

The interaction link uses the existing textured GLB importer, which welds UV seams and installs preview springs plus the facial impact rig. It does **not** use the saved scan's Newton cage. A normal app URL continues to restore the accepted scan. The crown and closure are estimates, and the integrated glasses and eye surfaces do not constitute a separately fitted anatomical rig.

## Current capture evidence

Input: `7a2bc070892642999d3357c2c5838390`, original `IMG_7496.MOV`. Apple's local engine registered all 51 saved native frames. Twenty-five contained facial landmarks. Five reserved facial views gave 2.666 px median and 8.058 px 95th-percentile landmark projection residual. This check covers control landmarks, not the complete rendered surface. Absolute scale remains assumed.

Review output: `public/generated/native-photo-head-review/`, 65,178 triangles after subdivision and closure. The final mesh is watertight after UV seam welding. The pre-closure shape changes add no non-adjacent crossings and reverse no triangles; some small elements shrink to 5.8% of their original area. This is an appearance candidate, not a validated finite-element mesh. The audit records the capture and original OBJ hashes.

Texture and clay review covered front, both profiles, rear, above and underside. The new ears are continuous with the scalp instead of the old template's thin flaps and detached-looking painted regions. The main limitations remain the smooth/flat crown, missing volumetric hair detail, soft eye/glasses geometry, and estimated underside appearance. Raw-detail Object Capture produced 16,900 triangles versus 16,664 in the custom-detail run, without a meaningful visual hair-detail improvement.

Earlier global dome, ear-warp and eye-texture experiments were rejected visually. Their source is retained under `.local/rejected-head-quality-sources/`; none was enabled in the production reconstruction pipeline. A strong dome also distorted the photographic quiff into a pointed cap and was rejected.

Tests: `tests/object_capture_head_test.py` checks the Apple/OpenCV camera basis, exact central-face and duplicate-seam invariants, and watertight closure with separate texture space. Existing appearance/import, hair, impact-rig, sponsor and Meshy-hook tests also pass. Browser interaction validation is recorded separately in `.local/native-head-browser-verification.json`.

API references: [PhotogrammetrySession](https://developer.apple.com/documentation/realitykit/photogrammetrysession), [custom object masks](https://developer.apple.com/documentation/realitykit/photogrammetrysample/objectmask), [model requests and OBJ output](https://developer.apple.com/documentation/realitykit/photogrammetrysession/request).

## Final review failures and interaction checks

The browser left hook at magnitude 0.85 remained finite with zero reversed triangles. The right hook at the same magnitude remained finite but reversed one triangle (minimum area ratio 0.058); this is a failed stress case, not a passing deformation qualification. Release recovered the left-hook surface, Reset restored the exact rest positions, and reload returned the named candidate with zero displacement and the camera off.

A further check of the exported float32 GLB found 83 crossing pairs localized near the integrated left eyeglass surface. The earlier zero-crossing report applies only to the float64 volume/relief stage. These export and stress defects, along with the visibly weak crown and underside, prevent accepting the candidate or claiming it exceeds Meshy. The existing accepted native generation remains untouched.

A separate TRELLIS geometry adapter is also now present in this shared workspace. Its readiness check currently reports missing approved DINOv3 `config.json` and `model.safetensors`; no inference ran as part of this experiment. See `docs/TRELLIS_FACE.md` for that work.
