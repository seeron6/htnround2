# PunchingFace reconstruction built on TRELLIS

This is an experimental adaptation of pretrained TRELLIS.2 code and geometry weights. It is part of developing PunchingFace's own reconstruction pipeline. It adds no cloud provider or engine selector.

## Implemented

- `scripts/trellis_face_adapter.py`: front-and-side conditioning selected from an explicit training split. Each view predicts a denoising velocity on the same latent; weighted predictions are combined before TRELLIS's existing classifier-free guidance, guidance interval and rescaling. Features are not averaged. A long run of frontal frames cannot dominate the selected inputs. Unknown camera angles are not labeled as rear views.
- `scripts/trellis_mlx_geometry.py`: an Apple MLX loader that constructs only structure/shape networks. It uses the captured alpha mattes, omits the background-removal network, and skips generated texture networks. The intended final materials come from PunchingFace's photo pipeline.
- `fit_measured_landmarks`: regularized displacement fitting for an aligned generated mesh with explicit barycentric landmark correspondences. It retains topology, checks triangle quality/intersections through the existing bounded deformation routine, and measures landmark residuals. Template indices cannot be reused on a different generated mesh.
- `scripts/trellis_face_experiment.py`: separate input preparation, runtime checks, and geometry generation commands. Results remain private experiment files in TRELLIS object coordinates. The generator does not write a published PunchingFace model.
- `scripts/fetch_trellis_geometry_weights.py`: downloads only public MIT geometry checkpoints at exact Hugging Face revisions. It does not fetch the gated image encoder or accept terms.

The front weight of 0.4 and equal division of the remaining 0.6 among distinct views are experimental choices. Neither improved identity nor better quality than Meshy has been measured. This is inference-time adaptation of existing pretrained weights, not a newly trained face model.

## What still prevents an end-to-end result

The DINOv3 encoder required by the pretrained network is not cached here. Its [official access page](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m) requires the account owner to review conditions and share contact information; the model API reports manual gating. Once approved, authenticate locally and cache `config.json` and `model.safetensors` using that authorized account. Do not paste tokens in chat or commit them.

The four required public geometry checkpoint components for 512-resolution generation have been downloaded and successfully loaded through the adapted MLX loader. The encoder was deliberately omitted from that load check; it performed no inference. Download provenance is saved in `.local/trellis-weights/TRELLIS.2-4B/geometry-download.json`, and the load result is `.local/trellis-face-experiment/checkpoint-loading.json`.

Full head inference has not run. Generated geometry still needs reliable alignment and landmark correspondences, then validation against withheld photographs, transfer into the native surface/rig contract, and photographic baking. The measurement-fitting function is tested separately; automatic correspondence construction and publication are not implemented. No inference output has been substituted into the running app. Keeping this separate is an implementation staging decision while those steps remain unvalidated.

The official CUDA implementation cannot run on this Mac. The complete Apple fork's GPU export dependencies compile Metal shaders and would require full Xcode. **The narrower geometry path tested here does not use those dependencies:** it uses MLX network operations and the port's CPU dual-grid extraction. Do not install the fork's full `requirements_macos.txt` on this machine.

## Reproducible source and environment

- Microsoft interface reference: [TRELLIS.2 at 75fbf0183001ed9876c8dbb35de6b68552ee08bd](https://github.com/microsoft/TRELLIS.2/tree/75fbf0183001ed9876c8dbb35de6b68552ee08bd).
- Apple runtime: [trellis2-apple at 17347247c91c36c8cdc1896234983e878a457bba](https://github.com/pedronaugusto/trellis2-apple/tree/17347247c91c36c8cdc1896234983e878a457bba).
- Sparse source checkout: `.local/third_party/trellis2-apple` with `trellis2`, `mlx_backend` and `o-voxel`. Root source files and MIT licence are included. No upstream source was modified.
- The adapted loader retains the upstream interface and configuration structure; MIT attribution is in `third_party/trellis-LICENSE`. DINOv3 weights have separate terms.
- Isolated Python 3.13 runtime: `.local/trellis-env`; exact direct dependencies in `requirements-trellis.txt`. `.venv` and the service interpreters were not changed.

To recreate the environment and source checkout:

```sh
python3.13 -m venv .local/trellis-env
.local/trellis-env/bin/python -m pip install --only-binary=:all: -r requirements-trellis.txt
git clone --filter=blob:none --no-checkout https://github.com/pedronaugusto/trellis2-apple.git .local/third_party/trellis2-apple
git -C .local/third_party/trellis2-apple sparse-checkout init --cone
git -C .local/third_party/trellis2-apple sparse-checkout set trellis2 mlx_backend o-voxel
git -C .local/third_party/trellis2-apple checkout --detach 17347247c91c36c8cdc1896234983e878a457bba
.local/trellis-env/bin/python scripts/fetch_trellis_geometry_weights.py --resolution 512
```

Check readiness without downloading or accepting anything:

```sh
.local/trellis-env/bin/python scripts/trellis_face_experiment.py check
```

Prepare inputs using a JSON array of training filenames that excludes evaluation views, then generate private geometry after the weight dependencies are available:

```sh
.venv/bin/python scripts/trellis_face_experiment.py prepare CAPTURE_PATH .local/trellis-face-experiment/new-inputs --training-frames TRAINING_SPLIT.json
.local/trellis-env/bin/python scripts/trellis_face_experiment.py run .local/trellis-face-experiment/new-inputs .local/trellis-face-experiment/new-geometry --resolution 512 --seed 42
```

The real input bundle already prepared is `.local/trellis-face-experiment/conditioning-v1/input.json`. It uses the current published head's inner training split from capture `7a2bc070892642999d3357c2c5838390`: four frames at approximately -3°, -52°, +61° and +31°. The capture and published release were read only. Image hashes are checked before inference. Future generated outputs remain in TRELLIS coordinates and are explicitly marked as unmeasured and unapproved for publication.

## Validation performed

```sh
.venv/bin/python -m unittest tests.trellis_face_adapter_test
.local/trellis-env/bin/python -m unittest tests.trellis_native_smoke
node --test tests/meshy-engine-hook.test.mjs tests/sponsors-hook.test.mjs
python3 scripts/check_python_envs.py
```

Thirteen adapter tests pass: selection, held-out exclusion, duplicate-front robustness, unknown angles, immutable input bundles, prediction fusion, unconditional handling, pipeline restoration, geometry orchestration and landmark fitting. Three native smoke tests pass using the actual upstream dense/sparse guided sampler, MLX sparse convolution and CPU dual-grid extraction. Those native tests use analytic/synthetic inputs, not pretrained heads. The six existing Meshy/sponsor hook checks also pass.

The environment successfully imports the real Apple pipeline, MLX loaders and CPU mesh extractor without `flex_gemm`, `cumesh`, `mtldiffrast` or `mtlbvh`. This verifies the tested runtime components; it does not validate full-model memory use, speed, multi-view consistency, face likeness or punch behavior. The remaining end-to-end comparison must inspect the same capture under matched lighting, profiles, wireframe and the actual punching rig before replacing the native builder or claiming an improvement over Meshy.
