"""Choose clear overlapping views using measured image quality and camera angle."""

import json, hashlib, tempfile
from pathlib import Path
import numpy as np, cv2
from PIL import Image
from face_pipeline import atomic


def _save_source_cache(path, result):
    # Independent reconstruction readers can finish the same cache together.
    # A unique temporary file keeps their atomic replacements from colliding.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode='w',
            prefix='.frame-evidence-',
            suffix='.tmp',
            dir=path.parent,
            delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, allow_nan=False)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def assess_frames(folder, output_folder=None):
    frames = json.loads((folder / 'capture.json').read_text())['frames']
    digest = hashlib.sha256(b'frame-evidence-v1')
    images = {}
    for frame in frames:
        path = folder / 'images' / frame['filename']
        raw = path.read_bytes()
        digest.update(raw)
    signature = digest.hexdigest()
    # These scores are a reusable source-image cache. The similarly named
    # frame-evidence.json is a published model audit: creating or changing it
    # at the capture root would invalidate an active legacy-model transaction.
    cache = folder / 'frame-evidence-cache.json'
    audit = output_folder / 'frame-evidence.json' if output_folder is not None else None

    def save(result, cached=False):
        if not cached:
            _save_source_cache(cache, result)
        if audit is not None:
            atomic(audit, result)
        return result['frames']

    for previous in (cache, folder / 'frame-evidence.json'):
        if previous.exists():
            result = json.loads(previous.read_text())
            if result.get('inputHash') == signature:
                return save(result, cached=previous == cache)
    for frame in frames:
        with Image.open(folder / 'images' / frame['filename']) as image:
            rgba = np.array(image.convert('RGBA'))
            box = (
                image.getchannel('A').getbbox()
                if image.mode == 'RGBA'
                else (0, 0, image.width, image.height)
            )
        if box is None:
            images[frame['filename']] = {
                'quality': 0,
                'sharpness': 0,
                'foregroundPixels': 0,
            }
            continue
        x0, y0, x1, y1 = box
        cut = cv2.resize(rgba[y0:y1, x0:x1], (224, 224), interpolation=cv2.INTER_AREA)
        mask = cv2.erode(np.uint8(cut[:, :, 3] > 220), np.ones((5, 5), np.uint8)) > 0
        gray = cv2.cvtColor(cut[:, :, :3], cv2.COLOR_RGB2GRAY)
        edge = cv2.Laplacian(gray, cv2.CV_32F)
        sharpness = float(np.mean(edge[mask] ** 2)) if mask.any() else 0
        clipped = (
            float(np.mean((gray[mask] < 8) | (gray[mask] > 248))) if mask.any() else 1
        )
        quality = float(
            np.clip(np.log1p(sharpness) / np.log(501), 0, 1) * (1 - clipped * 0.7)
        )
        images[frame['filename']] = {
            'quality': quality,
            'sharpness': sharpness,
            'clippedFraction': clipped,
            'foregroundPixels': int(np.sum(rgba[:, :, 3] > 220)),
        }
    return save(
        {
            'version': 1,
            'inputHash': signature,
            'frames': images,
            'method': (
                'Scale-normalized foreground sharpness, clipped exposure and '
                'registered camera angular coverage. Does not certify identity '
                'or anatomy.'
            ),
        },
    )


def choose_views(views, frames, targets, quality):
    if not views:
        raise ValueError('No registered views are available.')
    selected = set()
    for angle in targets:
        distances = {
            im.name: abs(
                (
                    frames[im.name].get('cameraYaw', frames[im.name].get('yaw') or 0)
                    - angle
                    + 180
                )
                % 360
                - 180
            )
            for im in views
        }
        nearest = min(distances.values())
        candidates = [im for im in views if distances[im.name] <= nearest + 8]
        best = max(
            candidates,
            key=lambda im: quality.get(im.name, {}).get('quality', 0)
            - 0.012 * (distances[im.name] - nearest),
        )
        selected.add(best.name)
    return selected
