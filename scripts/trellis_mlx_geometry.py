"""Load only TRELLIS.2 shape weights through the pinned Apple MLX implementation.

PunchingFace uses its own captured mattes and photo materials, so neither texture
networks nor a background-removal network are constructed. All weights are local.
Upstream interfaces and attribution: docs/TRELLIS_FACE.md, third_party/trellis-LICENSE.
"""

import json
from pathlib import Path


def create_geometry_pipeline(weights, resolution=512):
    import torch
    from trellis2.pipelines.trellis2_image_to_3d import Trellis2ImageTo3DPipeline
    from trellis2.pipelines import samplers
    from mlx_backend.pipeline import _get_loader, _resolve_model_path
    from mlx_backend.adapters import MlxImageCondAdapter
    from mlx_backend.dinov3 import load_dinov3_from_hf

    root = Path(weights).resolve()
    args = json.loads((root / 'pipeline.json').read_text())['args']
    names = (
        'sparse_structure_flow_model',
        'sparse_structure_decoder',
        f'shape_slat_flow_model_{resolution}',
        'shape_slat_decoder',
    )
    models = {}
    for name in names:
        path = _resolve_model_path(str(root), args['models'][name])
        config = json.loads(Path(path + '.json').read_text())
        models[name] = _get_loader(name, config)(path, config)
    pipe = Trellis2ImageTo3DPipeline(models)
    for stage in ('sparse_structure', 'shape_slat'):
        spec = args[stage + '_sampler']
        setattr(
            pipe, stage + '_sampler', getattr(samplers, spec['name'])(**spec['args'])
        )
        setattr(pipe, stage + '_sampler_params', spec['params'])
    pipe.shape_slat_normalization = args['shape_slat_normalization']
    pipe.image_cond_model = MlxImageCondAdapter(
        load_dinov3_from_hf(args['image_cond_model']['args']['model_name'])
    )
    pipe.rembg_model = None
    pipe.low_vram = True
    pipe._device = torch.device('cpu')  # MLX adapters do network computation on Metal.
    return pipe
