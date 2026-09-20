# Independent crown geometry refinement

The reviewed local head now uses `scripts/crown_geometry.py` after eyewear separation and before crown texture completion. Meshy remains a visual comparison only. This is progress toward the realism goal, not evidence that the full head surpasses Meshy.

The old cap contained edges up to 54 mm long in the upper region. `subdivide_crown` splits long edges on every incident face, including separate UV copies, until eligible crown edges are approximately 2.2 mm. It preserves the original surface before displacement. All 59,164 triangles wholly below Y=130 mm retain their exact exported positions and UVs. The glasses' 17 mesh buffers are also unchanged.

For a confidently recognized dense wavy hairstyle, the stage fits a bounded rounded cap to sloping crown observations and samples shallow relief from the existing generated hair donor. Both are estimated geometry. It projects the proposed vertices into all 51 original alpha masks, reduces motion that expands existing silhouette disagreement, smooths within the allowed displacement intervals, and checks the projections again. The half-pixel tolerance applies to projected vertices, not a complete rendered-silhouette validation. Surface gates then limit area changes, normal reversal and non-adjacent intersections. Final GLB validation rejects open, inconsistently wound or intersecting float32 head geometry.

The published `native-photo-head-review` candidate has 137,078 head triangles and 71,842 welded render vertices. Its bounded crown pass expands the registered posterior and applies a 20 mm posterior roundover above the hairline; the face and rigid glasses are unchanged. The exported head is watertight with zero detected crossing pairs. The original lower head and independent eyewear are preserved.

## Eye reference

The same candidate uses a new front glasses-removal edit made with the built-in imagegen tool from the original `frame_0032.png` crop. Registration found 108 inliers, a 0.542 px median error and 0.646 px maximum corner shift. The earlier edit had approximately 14.7 px corner movement. The new edit retains the original downward gaze and eyelid openness. Hidden skin and lens-affected eye appearance remain estimates.

- Generated image: `.local/eye-reference-v2/generated-front.png`
- Exact prompt: `.local/eye-reference-v2/prompt.txt`
- Registered reference: `.local/face-captures/7a2bc070892642999d3357c2c5838390/glasses-reference/frame_0032/`

The old root-level reference remains available as a fallback. The photogrammetry adapter now prefers a per-frame registration over that legacy cache, matching the default photo pipeline's precedence. Source photographs and the accepted capture generation remain unchanged.

## Verification and remaining work

Rendered review covered front, three-quarter, profile, above, clay geometry and glasses hidden. Live hooks at magnitude 0.85 remained finite with zero reversed triangles: minimum area ratios 0.139 left and 0.090 right. Reset restored exact rest coordinates. The live rig remains experimental springs plus the facial impact rig.

Regression tests cover conforming UV-seam subdivision, unchanged lower triangles, bounded smoothing, protected zero-displacement points, source-alpha limits, incompatible-hair bypass and cleanup-cache precedence. Existing crown, eyewear, interleaved-import, sponsor and Meshy-hook tests pass. Evidence is saved in `.local/crown-geometry-browser-verification.json` and the published `shape-audit.json`.

The profile is still too squared, hair clumps are still less convincing than Meshy's, eye depth remains estimated and photographic lighting remains baked into the skin. This candidate does not close the overall quality gap. The goal remains active.

Previous review: `.local/native-review-before-crown-geometry/`.
