#!/usr/bin/env python3
"""Fetch public MIT TRELLIS geometry weights; never request gated encoder access.

Run in .local/trellis-env. Each download uses an exact repository revision and
is stored under .local/trellis-weights. No texture-generation weights are needed.
"""

import argparse
import json
from pathlib import Path
import shutil
from huggingface_hub import HfApi, hf_hub_download

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'microsoft/TRELLIS.2-4B'
LEGACY = 'microsoft/TRELLIS-image-large'


def fetch(output, resolution):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    api = HfApi(token=False)
    revisions = {}
    for repo in (MODEL, LEGACY):
        info = api.model_info(repo)
        if info.gated or (info.card_data or {}).get('license') != 'mit':
            raise ValueError(
                'Public MIT model metadata changed; review before downloading.'
            )
        revisions[repo] = info.sha

    def download(repo, filename, target):
        print(f'Fetching {repo}/{filename}', flush=True)
        # Private task cache stays under .local instead of the global HF cache.
        cached = hf_hub_download(
            repo,
            filename,
            revision=revisions[repo],
            token=False,
            cache_dir=output / '.cache',
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cached, target)

    download(MODEL, 'pipeline.json', output / 'pipeline.json')
    args = json.loads((output / 'pipeline.json').read_text())['args']
    names = (
        'sparse_structure_flow_model',
        'sparse_structure_decoder',
        'shape_slat_decoder',
        f'shape_slat_flow_model_{resolution}',
    )
    files = []
    for name in names:
        relative = args['models'][name]
        repo, remote = (
            (LEGACY, relative[len(LEGACY) + 1 :])
            if relative.startswith(LEGACY + '/')
            else (MODEL, relative)
        )
        if (
            not remote.startswith('ckpts/')
            or '..' in Path(relative).parts
            or Path(relative).is_absolute()
        ):
            raise ValueError('Unexpected checkpoint path.')
        for suffix in ('.json', '.safetensors'):
            target = output / (relative + suffix)
            download(repo, remote + suffix, target)
            files.append(
                {
                    'model': name,
                    'path': str(target.relative_to(output)),
                    'bytes': target.stat().st_size,
                }
            )
    record = {
        'repositories': revisions,
        'resolution': resolution,
        'files': files,
        'gatedEncoderDownloaded': False,
        'textureWeightsDownloaded': False,
    }
    (output / 'geometry-download.json').write_text(json.dumps(record, indent=2))
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--output', type=Path, default=ROOT / '.local/trellis-weights/TRELLIS.2-4B'
    )
    parser.add_argument('--resolution', type=int, choices=(512, 1024), default=512)
    args = parser.parse_args()
    print(json.dumps(fetch(args.output, args.resolution), indent=2))
