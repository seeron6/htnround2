# Native-frame hair mask experiment

SAM2.1 improves the visible dense-hair outline in this capture, but its binary masks cannot yet safely replace the pipeline's hair annotations. Sparse temple hair is sometimes rejected by all three proposals. This experiment therefore remains separate from published geometry and materials.

## Model and local execution

The [official SAM2 implementation](https://github.com/facebookresearch/sam2) and checkpoints use Apache-2.0. Source is pinned to `2b90b9f5ceec907a1c18123530e92e794ad901a4` in `scripts/third_party_manifest.json`. The optional Hiera-large SAM2.1 checkpoint came from Meta's [public checkpoint](https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt), with SHA-256 `2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318`.

Inference used the existing isolated Python 3.13 environment `.local/head-depth-env`, PyTorch 2.8.0 and float32 MPS. Installing the official source with `SAM2_BUILD_CUDA=0` avoided the optional CUDA extension. No application dependency or Python 3.9 environment was changed, and no user photographs were uploaded. CUDA-dependent hole/sprinkle cleanup is not assumed to operate on this machine.

Seven registered native frames from the 51-frame capture were evaluated. Astra's coarse hair polygons supplied five spread interior positive prompts. Native ear annotations and a band outside the coarse hair mask supplied negative prompts. Original source alpha remained available separately. The initial experiment chose the highest-scored of three mask proposals; that score is a model ranking signal, not calibrated segmentation accuracy.

The seven-view run took 6.25 seconds after checkpoint download, including model creation. Individual warm frame calls took about 0.47–0.56 seconds. These timings exclude camera recovery, frame extraction and the roughly 856 MB checkpoint download.

## Observed results and failure cases

Front and rear proposals followed visible locks and the curved hairline more closely than the polygon edges. All selected masks had zero overlap with the annotated ear polygons. These observations do not constitute independently labeled segmentation accuracy.

The side views expose an important failure:

| Native frame | Opaque coarse-hair pixels removed | Connected mask components | Internal holes |
| --- | ---: | ---: | ---: |
| `frame_0037.png` | 9,634 | 19 | 66 |
| `frame_0010.png` | 15,623 | 113 | 28 |

In frame 0010, 12,632 removed coarse-hair pixels were rejected by **all three** proposals. Agreement among proposals from one prompted model therefore cannot establish that a sparse fade is bare skin. Selecting only the largest component could erase photographed stubble. Blanket hole filling could add hair over genuine skin or source-alpha holes.

The native-detail assets preserve the RGB inside an upsampled registered alpha mask. Hair already removed by that earlier mask is unavailable to this experiment. Improving the outer capture matte would require returning to the original video frames.

## Integration boundary

Keep independently qualified hair, skin and unknown evidence. A mask exterior alone is not a skin observation. Coarse/refined disagreements, sparse islands, small holes and source/crop boundaries remain uncertain. Refined unknown evidence must not add a zero hair vote with a positive visibility denominator: that would assert skin.

Preserve the original photographic RGB. For skin negatives, require a margin outside the hair uncertainty envelope and inside the original foreground, excluding ears and opaque eyewear. For an upgrade to an existing classifier, qualify only the additional angular support near uncertain boundaries; deleting its previously useful observations can bring the hair prior back onto actual skin.

Do not substitute SAM's hair mask for the full-head foreground used by `hair_silhouette.py`. Internal forehead, fade and ear boundaries are material boundaries, not 3D outer silhouettes. The first geometry use should qualify existing external-alpha constraints while retaining their target distance field, protected vertices and displacement bounds. Internal mask holes must never attract the outer head surface inward.

A future cache must hash native image bytes, crop transform, coarse annotations, ear/opaque annotations, prompts, preprocessing version, source revision and checkpoint. Missing or stale caches must reproduce the existing path without implicit network requests. Test sparse-fade preservation, native/camera coordinate scaling, source-alpha holes, unknown semantics and unchanged geometry under internal mask holes before enabling the consumer.

## Evidence

The local script is `.local/evaluate_sam2_hair.py`. Run it using `.local/head-depth-env/bin/python`; it reads this capture and writes diagnostic outputs only. Inputs, three proposals, logits, prompts and selected masks are under `.local/sam2-hair-native`. `report.json` records timing/model provenance, `topology-audit.json` records the component/hole comparison, and `integration-audit.md` records Astra's independent review. `review-sides.png` and `review-front-rear.png` show source, coarse annotation and refined mask at native crops.

This is one identity and one capture. It does not establish performance on arbitrary videos, photorealistic strand reconstruction or superiority to a commercial reconstruction service.

## Native outer-matte experiment

Returning to the original video exposes wisps that are absent from the saved RGBA images. In native frame 0032, visible wisps at `(170,335)`, `(174,350)` and `(193,380)` have zero saved alpha. That is an extraction loss, not a strand-rendering problem.

A separate local experiment uses the MIT-licensed [PyMatting implementation](https://github.com/pymatting/pymatting), version 1.1.16, for [closed-form alpha estimation](https://pymatting.github.io/alpha.html) and [multilevel foreground estimation](https://pymatting.github.io/foreground.html). It is installed only in the isolated `.local/head-depth-env`; the application does not import or require it. It downloads no model weights and sends no photographs to a service.

Seven native views were evaluated with 8- and 16-pixel uncertainty bands around the external head boundary, limited to the annotated hair area. Original internal alpha holes were preserved. Alpha is fixed outside the uncertain band; the uncertain values remain estimates rather than trusted hair or skin labels. The 8-pixel front proposal assigns approximately 0.406, 0.415 and 0.173 alpha to the three diagnosed wisp pixels, while the nearby background control `(145,350)` stays zero. Visual review found plausible wisps and softer outer edges, but there is no independent alpha ground truth, temporal check or multi-identity validation.

Astra found another important failure in the unbounded foreground-color output: even where trimap alpha is fixed at one, the foreground solver can change photographed RGB. Across these fourteen proposals, the largest channel change at a known-foreground pixel is 47 levels. The corrected private proposals restore native RGB exactly everywhere outside the uncertain band. Alpha preservation alone is not a sufficient color-preservation test.

This matte is **not enabled** in production reconstruction, geometry or materials. Before adoption it needs color matching, temporal/novel-view evaluation, and a consumer that treats fractional/uncertain evidence correctly. A binary threshold would discard some recovered wisps and could turn an uncertain hair boundary into false skin or an incorrect silhouette constraint.

Evidence: `.local/evaluate_native_matte.py`, `.local/native-matte-cf/report.json`, `.local/native-matte-cf/unknown-only-rgb-audit.json` and the fourteen per-view folders. `foreground-unknown-only.png` retains native RGB outside the uncertainty band. The earlier `comparison.png` includes the unbounded solver's RGB and must not be mistaken for a fully preservation-checked result. See also [the independent native color-fusion correction](HEAD_NATIVE_DETAIL.md).
