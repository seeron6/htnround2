"""Automatic, evidence-gated crown detail shared by the head builders.

The bundled wavy-hair donor is an appearance prior. It is selected only for a
compatible recognized hairstyle, fitted to this head and recolored from this
capture. Usable photographed texels always win over generated detail.
"""

from functools import lru_cache
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

DONOR = Path(__file__).resolve().parents[1] / 'public/textures/crown-hair-generated.png'
VERSION = 1


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def compatible_hair(completion):
    hair = (completion or {}).get('hair', {})
    return (
        hair.get('present') is True
        and hair.get('type') == 'wavy'
        and hair.get('confidence', 0) >= 0.65
        and hair.get('density', 0) >= 0.65
        and 20 <= hair.get('lengthMm', 0) <= 160
    )


@lru_cache(maxsize=2)
def _donor(path, modified, size):
    data = Path(path).read_bytes()
    with Image.open(path) as image:
        pixels = np.asarray(image.convert('RGB'), dtype=float) / 255
    return pixels, hashlib.sha256(data).hexdigest()


def complete_crown(
    color,
    points,
    normals,
    vertices,
    landmarks,
    completion,
    scalp,
    support,
    preserve=None,
    donor_path=DONOR,
):
    """Return new RGB in [0,1] and provenance; all input arrays stay untouched.

    ``support`` is physical visible-photo support, not view-selection preference.
    >= .12 is an exact no-op. ``scalp`` carries semantic hair ownership; callers
    separately protect face triangles, ears, eyes, closure and cleanup regions.
    Missing/unsupported hair classification retains the existing completion.
    """
    color = np.asarray(color)
    audit = {
        'version': VERSION,
        'applied': False,
        'estimatedAppearance': True,
        'changedTexels': 0,
        'geometryChanged': False,
        'method': 'Capture-fitted crown projection with photo support and semantic hair ownership.',
    }
    if not compatible_hair(completion):
        return color, {
            **audit,
            'reason': 'No compatible confident wavy-hair classification.',
        }
    landmarks, vertices = np.asarray(landmarks), np.asarray(vertices)
    height = float(landmarks[10, 1] - landmarks[152, 1])
    hairline = float(landmarks[10, 1])
    if not np.isfinite(height) or height <= 0:
        raise ValueError('Crown completion requires aligned forehead/chin landmarks.')
    upper = vertices[vertices[:, 1] > hairline + height * 0.06]
    if len(upper) < 3:
        return color, {**audit, 'reason': 'No upper hair surface.'}
    lo, hi = upper.min(0), upper.max(0)
    span = hi - lo
    if min(span[0], span[2]) < height * 0.1:
        return color, {**audit, 'reason': 'Upper hair projection is degenerate.'}
    weight = (
        smooth((points[:, 1] - hairline - height * 0.14) / (height * 0.15))
        * smooth((normals[:, 1] - 0.10) / 0.55)
        * smooth((np.asarray(scalp) - 0.75) / 0.20)
        * (1 - smooth(np.asarray(support) / 0.12))
    )
    if preserve is not None:
        weight[np.asarray(preserve, bool)] = 0
    ids = np.flatnonzero(weight > 0)
    if not len(ids):
        return color, {**audit, 'reason': 'Crown is photographed or protected.'}
    path = Path(donor_path)
    if not path.is_file():
        return color, {**audit, 'reason': 'Bundled crown detail asset is unavailable.'}
    stat = path.stat()
    donor, digest = _donor(str(path), stat.st_mtime_ns, stat.st_size)
    hair = completion['hair']
    # Extend slightly beyond the head so cropping has no clamped border stripe.
    x = (points[ids, 0] - (hi[0] + lo[0]) * 0.5) / (span[0] * 1.04)
    z = (points[ids, 2] - (hi[2] + lo[2]) * 0.5) / (span[2] * 1.04)
    angle = np.radians(float(hair.get('flowDegrees', 15)) - 15)
    c, s = np.cos(angle), np.sin(angle)
    u = np.clip(0.5 + c * x - s * z - float(hair.get('partOffset', 0)) * 0.10, 0, 1)
    v = np.clip(0.5 + s * x + c * z, 0, 1)
    coords = [v * (donor.shape[0] - 1), u * (donor.shape[1] - 1)]
    sampled = np.column_stack(
        [map_coordinates(donor[..., channel], coords, order=1) for channel in range(3)]
    )
    trusted = (
        (np.asarray(scalp) >= 0.95)
        & (np.asarray(support) >= 0.12)
        & (points[:, 1] > hairline)
    )
    if preserve is not None:
        trusted &= ~np.asarray(preserve, bool)
    # Keep actual capture color, including light or dyed hair. Do not copy the
    # donor's black/brown pigment or the style classifier's guessed RGB.
    samples = color[trusted] if trusted.sum() >= 32 else color[ids]
    target = np.median(samples, axis=0)
    if not np.isfinite(target).all():
        raise ValueError('Crown color samples must be finite.')
    matched = sampled * (target / np.maximum(np.median(sampled, axis=0), 1 / 255))
    result = color.copy()
    amount = 0.96 * weight[ids, None]
    result[ids] = np.clip(color[ids] * (1 - amount) + matched * amount, 0, 1)
    changed = int(np.count_nonzero(np.any(result != color, axis=1)))
    return result, {
        **audit,
        'applied': bool(changed),
        'changedTexels': changed,
        'donor': 'crown-hair-generated.png',
        'donorSha256': digest,
        'recognizedHairType': hair['type'],
        'captureMedianSrgb': target.tolist(),
        'colorSource': (
            'Supported captured upper hair'
            if trusted.sum() >= 32
            else 'Existing upper-hair material'
        ),
        'projectionBounds': [lo.tolist(), hi.tolist()],
        'flowDegrees': hair.get('flowDegrees', 15),
        'protectedPhotographedTexels': int(
            np.count_nonzero(np.asarray(support) >= 0.12)
        ),
        'limitation': 'Generated detail only in unsupported upper hair; individual strands and unseen crown remain estimated.',
    }
