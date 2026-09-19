# Automatic crown texture completion

Crown detail is now baked during model generation. There is no manual GLB edit or viewer enhancement step required for a new compatible capture.

## Pipeline integration

- The normal video builder (`build_photo_face_fast.py` and the serial `build_photo_face.py`) invokes `crown_material.complete_crown` inside `photo_geometry.bake_photographs`, before appearance files and the sealed generation are published.
- The independent Object Capture builder invokes `crown_capture.complete_capture_crown` in `prepare_object_capture_head.prepare`, before exporting its GLB. It starts with the raw reconstructed OBJ and texture, not a previously repaired GLB.
- Both use the same bundled detail donor, `public/textures/crown-hair-generated.png`. It is a reusable appearance prior generated once with the built-in imagegen tool, without uploading subject photographs. Generation requires no additional API request, credentials or package installation.
- `fit_template_hair` also stages its frame-quality evidence in the transaction output. Previously a first build could create `frame-evidence.json` in the capture root and trigger its own publication conflict check. The conflict checks remain intact.

The stage fits the projection to each head's measured forehead/chin landmarks and upper surface bounds, follows recognized hair direction and part offset, and matches pigment to supported upper-hair photographs. A height fade, upward-normal gate and semantic hair ownership limit the blend to the crown. Original mesh positions, UVs, indices and normals are not modified by this stage.

The donor currently supports confidently recognized wavy hair, density at least 0.65 and length 20–160 mm. Bald, unknown, sparse, incompatible or low-confidence hairstyles retain their existing material. This does not impose this subject's hairstyle on every capture. Missing bundled assets also leave the previous material intact.

## Evidence protection and provenance

Usable photographed texels (physical support >= 0.12) remain exactly unchanged. The standard builder additionally protects measured facial triangles, non-scalp parts, underside closure, eyewear cleanup and already estimated-reference texels. Its existing supported-color preservation check still runs after completion.

Object Capture does not export per-texel observation confidence. Its adapter conservatively protects any crown point with adequate camera-facing support inside an actual source-image alpha footprint. It does not remove support for possible occlusion, so it can leave uncertain regions under-filled rather than overwrite potentially valid photographic detail.

`mesh.json` and `texture-atlas.json` record `stats.appearance.crownCompletion` and `stats.crownCompletion`, respectively. Object Capture records `crownTexture` in `shape-audit.json` and appearance metadata in its GLB. Audits identify the donor hash, estimated status, fitted bounds, captured color, support, changed texels and skip reason when applicable. Unseen strands remain estimated appearance; this does not recover true unseen hair or add volume.

## Validation on 2026-09-19

Validation used an isolated source-code snapshot and a copy of saved `IMG_7496.MOV` inputs in `.local/crown-pipeline-validation`. No production capture or accepted generation was replaced. The actual standard builder recomputed geometry, atlas, appearance and sealed artifacts from saved frames with no previous output model. Extracted frames, recovered cameras and analysis caches were reused; video extraction, camera recovery and cloud analysis were not rerun. Network access was explicitly blocked in the test process.

- Standard build: completed in 52.96 seconds; 1,027,615 crown texels received detail. The existing preservation audit checked 1,860,679 protected texels with zero changed colors and zero maximum channel difference.
- Independent builder: rebuilt from `.local/objectcapture-head-v1` and copied capture evidence; 281,634 crown texels received detail. Its audit records 3,652,234 unchanged occupied texels and 51 source camera footprints considered. The output is `public/generated/native-crown-pipeline-review/model.glb`, SHA-256 `31e81853ec1c9faa8d7e4d86e2ba666eb690f5f725bea7e6d5170ff2308d41ac`.
- Browser review of both newly generated outputs confirms readable crown detail and preserved front hairline/face. The standard inspection uses the app's `SurfaceAppearance` renderer with the untouched new atlas and geometry. Screenshots and build logs are under `.local/crown-pipeline-validation`.
- 83 targeted Python tests and 10 JavaScript tests passed, including crown evidence protection, projection scaling, color matching, incompatible styles, missing assets, source alpha, UV seams, generation publication and sponsor/Meshy hooks. The hair-fitting test now exercises real frame-evidence staging. Accelerator status reports all three pinned functions active.

Local review URLs with the dev server running:

- Standard baked crown: `http://localhost:5173/generated/crown-pipeline-review/inspect.html`
- Camera-matched standard output: `http://localhost:5173/hair-review.html?review=crown-pipeline-review`
- Independent GLB in the app: `http://localhost:5173/?nativePreview=native-crown-pipeline-review`

Reproduce the isolated standard build from the retained inputs and code snapshot:

```sh
.venv/bin/python .local/crown-pipeline-validation/run.py
```

Reproduce the isolated independent build into a new output folder:

```sh
.venv/bin/python .local/crown-pipeline-validation/code/scripts/prepare_object_capture_head.py \
  .local/crown-pipeline-validation/native-capture .local/objectcapture-head-v1 \
  public/generated/native-crown-pipeline-rerun
```

## Earlier manual experiment

`scripts/bake_crown_texture.py` remains available as the original aligned-candidate repair experiment, with its original buffer-preservation tests. Its hardcoded vertical mask is not used by the automatic stage. The automatic Object Capture adapter reuses only its UV rasterization helper. The first one-off baseline and audit remain under `.local/crown-texture-review`.

## Generation prompt

Use case: photorealistic-natural.
Asset type: albedo texture for the missing crown of a 3D reconstructed head, square 1536x1536.
Primary request: a densely detailed photograph-like texture of short-to-medium nearly black dark brown hair viewed straight down on the crown, filling the ENTIRE square edge to edge with hair. No head outline or visible skin.
Hair structure: irregular fine individual strands grouped in soft natural locks, slightly wavy, compact, with subtle variation in direction and length. A soft, off-center growth whorl toward the upper third flows into swept-back hair; front hair is at the bottom of the image. Keep the whorl fully covered with hair, no bald spot or visible scalp. Natural intersecting fibers and modest messy flyaways within the hair. No perfectly parallel grooves or exaggerated corkscrew swirl.
Lighting: broad very soft diffuse illumination; predominantly deep charcoal brown, no strong directional shadows or specular white shine. Good readable fine detail and restrained contrast, no gray hair.
Composition: orthographic top-down macro surface suitable for projection onto a scalp mesh. Hair continues beyond all four edges, no background, no face, no ears, no shoulders, no outline, no text, no watermark. This is a surface texture, not a portrait or a photograph of an entire head.
