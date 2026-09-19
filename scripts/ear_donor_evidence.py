"""Conservative annotated contradictions of inferred ear donor regions.

Pure evidence only: no colors, geometry, labels, files, or measured coverage are
modified. A predicted ellipse is not an independent observation of an ear.
Defaults are experimental uncertainty bounds, not calibrated probabilities.
"""

import numpy as np


def resolve_ear_side(image_side, local_camera_origin, visible_ear_count):
    """Return anatomical sign using the contour adapter's conservative mapping.

    Origin is camera-minus-head-center in the canonical head basis (+Z front).
    Count every visible ear, even a low-confidence second ear. Rear frontal and
    dual-ear oblique views are unknown; image-side names alone cannot route them.
    """
    origin = np.asarray(local_camera_origin, float)
    if image_side not in ('imageLeftEar', 'imageRightEar'):
        raise ValueError('Unknown image-side ear name')
    if origin.shape != (3,) or not np.isfinite(origin).all():
        raise ValueError('Expected finite local camera origin')
    if visible_ear_count not in (0, 1, 2):
        raise ValueError('Expected zero, one, or two visible ears')
    if not visible_ear_count or np.linalg.norm(origin) == 0:
        return None
    if abs(origin[0]) > abs(origin[2]) * 0.2:
        return int(np.sign(origin[0])) if visible_ear_count == 1 else None
    if origin[2] <= 0:
        return None
    return -1 if image_side == 'imageLeftEar' else 1


def _smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def _vector(value, n, name, *, boolean=False):
    a = np.asarray(value)
    if a.shape != (n,) or not np.isfinite(a).all():
        raise ValueError(name + ' must be a finite sample-length vector')
    if boolean:
        if not np.isin(a, [0, 1]).all():
            raise ValueError(name + ' must be boolean')
        return a.astype(bool)
    return a.astype(float)


def ear_donor_observation(
    camera_id,
    camera_direction,
    parts,
    signed_distance_px,
    *,
    side,
    annotation_confidence,
    annotation_visible,
    blur,
    inside,
    visible,
    alpha,
    facing,
    edge,
    masked,
    uncertainty_px=2.0,
):
    """Qualify one annotated ear view at a consistent ordered set of texels.

    ``camera_id`` identifies an exposure/pose (COLMAP IMAGE id, not shared lens
    camera_id). Direction is camera-minus-head-center in a common frame.
    ``side`` is -1/+1 or None from resolve_ear_side. Parts3/4 denote left/right.
    Signed distance is positive INSIDE the original, undilated semantic polygon,
    measured in CAMERA pixels at actual registered sampling coordinates. Convert
    annotation crop/native coordinates before measuring; do not use the inferred
    ellipse. No annotation means side=None or annotation_visible=False.

    inside combines original and registered image bounds; visible is first-hit
    visibility at that surface point. alpha is ORIGINAL photographic alpha0..1;
    facing is cosine[-1,1], edge0..1, masked includes opaque glasses/cleanup.
    blur must explicitly be 'sharp' or 'usable'; unknown blur is not evidence.
    All fields must use the same global/subset texel ordering. Nonfinite distance
    is unknown; malformed physical fields raise rather than invent evidence.
    """
    if not isinstance(camera_id, (str, int)) or isinstance(camera_id, bool):
        raise ValueError('camera_id must identify one exposure/pose')
    direction = np.asarray(camera_direction, float)
    if (
        direction.shape != (3,)
        or not np.isfinite(direction).all()
        or np.linalg.norm(direction) <= 0
    ):
        raise ValueError('Expected nonzero finite camera direction')
    if side not in (-1, 1, None):
        raise ValueError('Anatomical side must be resolved or None')
    if not np.isfinite(annotation_confidence) or not 0 <= annotation_confidence <= 1:
        raise ValueError('Annotation confidence must be in [0,1]')
    if not np.isfinite(uncertainty_px) or uncertainty_px <= 0:
        raise ValueError('Pixel uncertainty must be positive')
    parts = np.asarray(parts)
    if (
        parts.ndim != 1
        or not np.isfinite(parts).all()
        or np.any(parts != parts.astype(int))
    ):
        raise ValueError('Parts must be integer sample labels')
    n = len(parts)
    distance = np.asarray(signed_distance_px, float)
    if distance.shape != (n,):
        raise ValueError('Signed distance must match sample count')
    inside = _vector(inside, n, 'inside', boolean=True)
    visible = _vector(visible, n, 'visible', boolean=True)
    masked = _vector(masked, n, 'masked', boolean=True)
    alpha, facing, edge = [
        _vector(v, n, k)
        for v, k in ((alpha, 'alpha'), (facing, 'facing'), (edge, 'edge'))
    ]
    if np.any(
        (alpha < 0)
        | (alpha > 1)
        | (edge < 0)
        | (edge > 1)
        | (facing < -1)
        | (facing > 1)
    ):
        raise ValueError('Alpha/edge require [0,1], facing requires [-1,1]')
    accepted = (
        side is not None
        and annotation_visible
        and annotation_confidence >= 0.8
        and blur in ('sharp', 'usable')
    )
    eligible = (
        accepted
        & (parts == (3 if side == -1 else 4))
        & inside
        & visible
        & ~masked
        & np.isfinite(distance)
        & (alpha >= 230 / 255)
        & (facing > 0.3)
        & (edge >= 0.9)
    )
    finite_distance = np.where(np.isfinite(distance), distance, 0)
    support = (
        _smooth((facing - 0.3) / 0.2)
        * _smooth((alpha - 230 / 255) / (25 / 255))
        * _smooth((edge - 0.9) / 0.1)
    )
    negative = (
        eligible
        * support
        * _smooth((-finite_distance - uncertainty_px) / uncertainty_px)
    )
    # Even a modest trustworthy interior observation prevents an exterior veto.
    positive = eligible & (finite_distance > uncertainty_px)
    return {
        'cameraId': camera_id,
        'direction': direction / np.linalg.norm(direction),
        'negative': negative.astype(np.float32),
        'positive': positive,
        'audit': {
            'acceptedAnnotation': bool(accepted),
            'side': side,
            'negativeSamples': int(np.count_nonzero(negative)),
            'positiveSamples': int(np.count_nonzero(positive)),
        },
    }


def predicted_ear_donor_multiplier(
    observations, sample_count, *, min_angle_degrees=10.0
):
    """Return (multiplier, audit) ONLY for predicted-mask donor contributions.

    Each independent pair contributes its weaker negative confidence; maximum
    over pairs gives a view-order-independent veto. Any trustworthy positive
    blocks it. Duplicate IDs cannot form a pair, and directions for the same ID
    must agree. Angular independence is a hard eligibility criterion between
    fixed cameras, not a texel boundary. No qualifying evidence returns ones.

    Aggregate once over a common surface index set, freeze it, then index this
    multiplier for both full and subset projectors. Do not apply to annotated
    source contributions, part0/hair, geometry, or post-completion RGB.
    """
    if not isinstance(sample_count, (int, np.integer)) or sample_count < 0:
        raise ValueError('Invalid sample count')
    if not np.isfinite(min_angle_degrees) or not 0 < min_angle_degrees <= 180:
        raise ValueError('Angular separation must be in (0,180] degrees')
    rows, directions = [], {}
    positive = np.zeros(sample_count, bool)
    for observation in observations:
        identity = observation['cameraId']
        direction = np.asarray(observation['direction'], float)
        if (
            direction.shape != (3,)
            or not np.isfinite(direction).all()
            or not np.isclose(np.linalg.norm(direction), 1, atol=1e-7)
        ):
            raise ValueError('Observation direction must be unit length')
        if identity in directions and not np.allclose(
            direction, directions[identity], atol=1e-10, rtol=0
        ):
            raise ValueError('One camera ID has conflicting poses')
        directions[identity] = direction
        negative = _vector(observation['negative'], sample_count, 'negative')
        if np.any((negative < 0) | (negative > 1)):
            raise ValueError('Negative evidence must be bounded')
        positive |= _vector(
            observation['positive'], sample_count, 'positive', boolean=True
        )
        rows.append((identity, direction, negative))
    veto = np.zeros(sample_count)
    pairs = 0
    threshold = np.cos(np.deg2rad(min_angle_degrees))
    for i, (identity, direction, negative) in enumerate(rows):
        for other, other_direction, other_negative in rows[i + 1 :]:
            if identity == other or np.dot(direction, other_direction) > threshold:
                continue
            pairs += 1
            np.maximum(veto, np.minimum(negative, other_negative), out=veto)
    veto[positive] = 0
    return (1 - veto).astype(np.float32), {
        'method': 'Independent annotated exterior contradiction of predicted ear donors',
        'cameraCount': len(directions),
        'independentObservationPairs': pairs,
        'minimumAngleDegrees': float(min_angle_degrees),
        'attenuatedSamples': int(np.count_nonzero(veto)),
        'rejectedSamples': int(np.count_nonzero(veto == 1)),
        'positiveProtectedSamples': int(np.count_nonzero(positive)),
        'changesAnatomicalLabels': False,
        'limitation': 'Contradicted inferred ownership becomes unsupported; no replacement color or recovered anatomy is supplied.',
    }
