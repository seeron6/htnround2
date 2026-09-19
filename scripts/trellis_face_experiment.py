#!/usr/bin/env python3
"""Prepare/check/run the experimental native PunchingFace TRELLIS extension.

No app hooks, API keys or automatic package/model downloads. Run --help for usage.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.trellis_face_adapter import APPLE_COMMIT, prepare_capture


def check_runtime(source, weights, resolution=512):
    source, weights = Path(source).resolve(), Path(weights).resolve()
    blockers = []
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        blockers.append('This experiment runner targets the Apple Silicon MLX port.')
    if sys.version_info < (3, 12):
        blockers.append(
            'Use an isolated Python 3.12/3.13 environment under .local; keep .venv unchanged.'
        )
    if not (source / 'mlx_backend/pipeline.py').is_file():
        blockers.append('The full pinned trellis2-apple source checkout is missing.')
    else:
        git = subprocess.run(
            ['git', '-C', str(source), 'rev-parse', 'HEAD'],
            capture_output=True,
            text=True,
        )
        if git.returncode or git.stdout.strip() != APPLE_COMMIT:
            blockers.append(
                'Apple source revision differs from the adapter reference; revalidate its interface first.'
            )
    missing = [
        name
        for name in (
            'torch',
            'mlx',
            'transformers',
            'safetensors',
            'torchvision',
            'numpy',
            'cv2',
            'trimesh',
            'xatlas',
            'easydict',
            'einops',
        )
        if importlib.util.find_spec(name) is None
    ]
    if missing:
        blockers.append('Missing native runtime modules: ' + ', '.join(missing))
    if not (weights / 'pipeline.json').is_file():
        blockers.append('Local TRELLIS.2 geometry checkpoints are missing.')
    else:
        try:
            args = json.loads((weights / 'pipeline.json').read_text())['args']
            required = (
                'sparse_structure_flow_model',
                'sparse_structure_decoder',
                'shape_slat_decoder',
                f'shape_slat_flow_model_{resolution}',
            )
            for name in required:
                relative = args['models'][name]
                if not all(
                    (weights / (relative + suffix)).is_file()
                    for suffix in ('.json', '.safetensors')
                ):
                    blockers.append('Missing geometry checkpoint: ' + name)
            from huggingface_hub import try_to_load_from_cache

            encoder = args['image_cond_model']['args']['model_name']
            for filename in ('config.json', 'model.safetensors'):
                if not isinstance(try_to_load_from_cache(encoder, filename), str):
                    blockers.append(
                        'Missing approved DINOv3 cache: '
                        + filename
                        + '. Request access to '
                        + encoder
                        + ' on Hugging Face.'
                    )
        except (ValueError, KeyError, ImportError):
            blockers.append(
                'Could not inspect checkpoint configuration or encoder cache.'
            )
    return {
        'ready': not blockers,
        'blockers': blockers,
        'python': sys.executable,
        'source': str(source),
        'weights': str(weights),
        'appleCommit': APPLE_COMMIT,
        'inferenceValidated': False,
        'compiledMetalRequired': False,
        'runtimePath': 'MLX geometry and CPU dual-grid extraction; no GPU texture export',
    }


def run(bundle, source, weights, output, resolution, seed):
    state = check_runtime(source, weights, resolution)
    if not state['ready']:
        raise ValueError('\n'.join(state['blockers']))
    bundle, output = Path(bundle).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError('Use a new output directory for each experiment.')
    report = json.loads((bundle / 'input.json').read_text())
    if (
        report.get('format') != 'punching-face-trellis-input-v1'
        or (bundle / 'FAILED').exists()
    ):
        raise ValueError('Invalid or incomplete conditioning bundle.')
    from PIL import Image

    images = []
    for view in report['views']:
        path = (bundle / view['image']).resolve()
        if (
            path.parent != bundle
            or hashlib.sha256(path.read_bytes()).hexdigest() != view['sha256']
        ):
            raise ValueError('Conditioning image changed after preparation.')
        with Image.open(path) as image:
            images.append(image.convert('RGBA').copy())
    # Missing gated dependencies fail locally. Do not accept licences/download on import.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['SPARSE_CONV_BACKEND'] = 'pytorch'
    os.environ['ATTN_BACKEND'] = 'sdpa'
    sys.path.insert(0, str(Path(source).resolve()))
    sys.path.insert(0, str(Path(source).resolve() / 'o-voxel'))
    import torch
    import mlx.core as mx
    import numpy as np
    from scripts.trellis_mlx_geometry import create_geometry_pipeline
    from scripts.trellis_face_adapter import generate_geometry

    pipeline = create_geometry_pipeline(weights, resolution)
    images = [pipeline.preprocess_image(image) for image in images]
    torch.manual_seed(seed)
    mx.random.seed(seed)
    with torch.no_grad():
        mesh, evidence = generate_geometry(
            pipeline, images, [v['weight'] for v in report['views']], resolution, seed
        )
    positions = mesh.vertices.detach().cpu().numpy()
    faces = mesh.faces.detach().cpu().numpy()
    if not np.isfinite(positions).all() or not len(faces):
        raise ValueError('The pretrained model returned empty or invalid geometry.')
    output.mkdir(parents=True)
    np.savez_compressed(
        output / 'generated-geometry.npz', positions=positions, indices=faces
    )
    evidence.update(
        input=report,
        vertices=len(positions),
        triangles=len(faces),
        acceptedForPublication=False,
        runtime=state,
        nextStep='Align generated geometry, establish generated-mesh landmark correspondences, fit to measured landmarks, then validate and bake source photographs.',
    )
    (output / 'generation.json').write_text(json.dumps(evidence, indent=2))
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser(
        'prepare', help='Create a private multi-view conditioning bundle using .venv'
    )
    prepare.add_argument('capture', type=Path)
    prepare.add_argument('output', type=Path)
    prepare.add_argument(
        '--training-frames',
        required=True,
        type=Path,
        help='JSON array of explicitly allowed image filenames; exclude withheld views',
    )
    for name in ('check', 'run'):
        p = sub.add_parser(name)
        p.add_argument(
            '--source', type=Path, default=ROOT / '.local/third_party/trellis2-apple'
        )
        p.add_argument(
            '--weights', type=Path, default=ROOT / '.local/trellis-weights/TRELLIS.2-4B'
        )
        if name == 'run':
            p.add_argument('bundle', type=Path)
            p.add_argument('output', type=Path)
            p.add_argument('--resolution', type=int, choices=(512, 1024), default=512)
            p.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            names = json.loads(args.training_frames.read_text())
            if not isinstance(names, list) or not all(
                isinstance(name, str) for name in names
            ):
                raise ValueError('Training split must be a JSON array of filenames.')
            result = prepare_capture(args.capture, names, args.output)
        elif args.command == 'check':
            result = check_runtime(args.source, args.weights)
        else:
            result = run(
                args.bundle,
                args.source,
                args.weights,
                args.output,
                args.resolution,
                args.seed,
            )
        print(json.dumps(result, indent=2))
        return 1 if result.get('ready') is False else 0
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
