"""Independent contour-stage rest geometry, stored with the earlier ear baseline.

Adding a later shape edit to a pre-ear surface does not commute with nonlinear
ear regularization. Retain both stage inputs instead of silently refitting away
an accepted shape, or repeatedly refining an already-refined contour.
"""

import hashlib
import json

import numpy as np


def measurement_digest(measurements):
    return hashlib.sha256(
        json.dumps(
            measurements, sort_keys=True, separators=(',', ':'), allow_nan=False
        ).encode()
    ).hexdigest()


def _digest(array, dtype):
    return hashlib.sha256(np.asarray(array, dtype=dtype).tobytes()).hexdigest()


def _faces(faces, count):
    value = np.asarray(faces)
    if (
        value.ndim != 2
        or value.shape[1] != 3
        or not np.issubdtype(value.dtype, np.integer)
        or np.any(value < 0)
        or np.any(value >= count)
        or np.any(np.diff(np.sort(value, axis=1), axis=1) == 0)
    ):
        raise ValueError('Invalid contour rest topology.')
    return value


def contour_rest_fields(points, faces, measurements):
    rest = np.array(points, dtype=np.float32, copy=True)
    if rest.ndim != 2 or rest.shape[1] != 3 or not np.isfinite(rest).all():
        raise ValueError('Invalid contour rest surface.')
    faces = _faces(faces, len(rest))
    return dict(
        contourRestPositions=rest,
        contourRestPositionsSha256=_digest(rest, '<f4'),
        contourRestTopologySha256=_digest(faces, '<i8'),
        contourRestMeasurementsSha256=measurement_digest(measurements),
    )


def load_contour_rest(saved, reference_points, faces, face_count, measurements):
    if 'contourRestPositions' not in saved:
        if any(str(key).startswith('contourRest') for key in saved):
            raise ValueError('Incomplete contour rest snapshot.')
        return None
    required = (
        'contourRestPositionsSha256',
        'contourRestTopologySha256',
        'contourRestMeasurementsSha256',
    )
    if any(key not in saved for key in required):
        raise ValueError('Incomplete contour rest snapshot.')
    reference = np.asarray(reference_points, np.float32)
    if (
        reference.ndim != 2
        or reference.shape[1] != 3
        or not np.isfinite(reference).all()
    ):
        raise ValueError('Invalid contour rest reference surface.')
    if str(saved['contourRestMeasurementsSha256']) != measurement_digest(measurements):
        raise ValueError(
            'Ear observations changed after the contour rest snapshot; run the complete pipeline.'
        )
    faces = _faces(faces, len(reference))
    if not isinstance(face_count, (int, np.integer)) or not 0 <= face_count <= len(
        faces
    ):
        raise ValueError('Invalid observed-face triangle count.')
    if str(saved['contourRestTopologySha256']) != _digest(faces, '<i8'):
        raise ValueError('Contour rest topology changed; run the complete pipeline.')
    rest = np.asarray(saved['contourRestPositions'])
    if (
        rest.shape != reference.shape
        or not np.isfinite(rest).all()
        or not np.array_equal(rest, rest.astype(np.float32))
        or str(saved['contourRestPositionsSha256']) != _digest(rest, '<f4')
    ):
        raise ValueError('Invalid or corrupt contour rest surface.')
    protected = np.unique(
        np.r_[np.arange(min(468, len(rest))), np.asarray(faces)[:face_count].ravel()]
    )
    if not np.array_equal(rest[protected], reference[protected]):
        raise ValueError('Contour rest differs from the protected face and cage.')
    return rest.astype(float).copy()
