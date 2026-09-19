"""Project only annotated ear ownership into photographic donor evidence."""

import cv2
import numpy as np

from scripts.ear_donor_evidence import ear_donor_observation, resolve_ear_side


def _simple_polygon(points):
    """Reject crossings/touches and adjacent backtracking; allow densification."""

    def cross(a, b):
        return float(a[0] * b[1] - a[1] * b[0])

    def orientation(a, b, c):
        return cross(b - a, c - a)

    def on(a, b, p):
        return (
            abs(orientation(a, b, p)) <= 1e-10
            and np.all(p >= np.minimum(a, b) - 1e-10)
            and np.all(p <= np.maximum(a, b) + 1e-10)
        )

    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        previous = a - points[i - 1]
        if abs(cross(previous, b - a)) <= 1e-10 and np.dot(previous, b - a) < 0:
            return False
        for j in range(i + 1, len(points)):
            if j == i + 1 or (i == 0 and j == len(points) - 1):
                continue
            c, d = points[j], points[(j + 1) % len(points)]
            if (
                orientation(a, b, c) * orientation(a, b, d) < 0
                and orientation(c, d, a) * orientation(c, d, b) < 0
            ) or any((on(a, b, c), on(a, b, d), on(c, d, a), on(c, d, b))):
                return False
    return True


def _camera_polygon(outline, crop, native_size, camera_size):
    """Malformed annotation is unknown, not an exterior ownership observation."""
    try:
        polygon = np.asarray(outline, float)
        box = np.asarray(crop, float)
    except (TypeError, ValueError):
        return None
    if (
        polygon.ndim != 2
        or polygon.shape[1] != 2
        or len(polygon) < 3
        or box.shape != (4,)
        or not np.isfinite(polygon).all()
        or not np.isfinite(box).all()
        or np.any((polygon < 0) | (polygon > 1))
        or np.any(box[:2] < 0)
        or np.any(box[2:] > native_size)
        or np.any(box[2:] <= box[:2])
    ):
        return None
    polygon = polygon[np.r_[True, np.any(np.diff(polygon, axis=0) != 0, axis=1)]]
    if len(polygon) > 1 and np.array_equal(polygon[0], polygon[-1]):
        polygon = polygon[:-1]
    if len(polygon) < 3 or not _simple_polygon(polygon):
        return None
    polygon = (polygon * (box[2:] - box[:2]) + box[:2]) * (camera_size / native_size)
    polygon = np.ascontiguousarray(polygon, dtype=np.float32)
    if abs(cv2.contourArea(polygon)) <= 1e-6:
        return None
    return polygon


def projected_ear_observations(
    semantics,
    filename,
    camera_id,
    camera_origin,
    camera_size,
    raw_rgba,
    sample_projection,
    parts,
    *,
    inside,
    visible,
    facing,
    edge,
    masked,
):
    """Return ear_donor_observation dictionaries in the supplied sample order.

    camera_origin is camera-minus-head-center in the canonical head basis
    (+Z front); the same basis must be used for every view. camera_id identifies
    an exposure/pose (COLMAP IMAGE id), not a shared lens. camera_size is (W,H).
    Semantics outline coordinates are normalized within native-image XYXY crops.
    sample_projection is the actual registered CAMERA XY: no half-pixel shift,
    affine recalculation, ellipse substitution, or integer contour rasterization.

    Alpha comes only from original uint8 native RGBA at floor(XY * [W/w,H/h]);
    nonfinite/out-of-image projections supply no evidence. masked must include
    opaque accessories and generated-reference regions. Missing or invalid
    annotations return no observation; ambiguous side/low confidence/unknown
    blur return zero evidence through the qualification helper. Duplicate view
    records are ambiguous and return none. Colors, input arrays and caches are
    never modified. Each observation audit includes filename and image-side key.
    """
    raw = np.asarray(raw_rgba)
    size = np.asarray(camera_size, float)
    xy = np.asarray(sample_projection, float)
    labels = np.asarray(parts)
    bound = np.asarray(inside)
    origin = np.asarray(camera_origin, float)
    if (
        raw.ndim != 3
        or raw.shape[2] != 4
        or raw.dtype != np.uint8
        or min(raw.shape[:2]) <= 0
    ):
        raise ValueError('Expected original uint8 HxWx4 RGBA')
    if size.shape != (2,) or not np.isfinite(size).all() or np.any(size <= 0):
        raise ValueError('Expected positive camera (width,height)')
    if xy.ndim != 2 or xy.shape[1] != 2 or labels.shape != (len(xy),):
        raise ValueError('Projection and parts must have matching sample counts')
    if bound.shape != (len(xy),) or not np.isin(bound, [0, 1]).all():
        raise ValueError('inside must be a boolean sample-length vector')
    if (
        origin.shape != (3,)
        or not np.isfinite(origin).all()
        or np.linalg.norm(origin) <= 0
    ):
        raise ValueError('Expected nonzero finite canonical camera origin')
    if not isinstance(semantics, dict):
        return []
    views = semantics.get('views', [])
    if not isinstance(views, (list, tuple)):
        return []
    matches = [
        v for v in views if isinstance(v, dict) and v.get('filename') == filename
    ]
    if len(matches) != 1:
        return []
    view = matches[0]
    crops = semantics.get('crops', {})
    crop = crops.get(filename) if isinstance(crops, dict) else None
    native_size = np.array([raw.shape[1], raw.shape[0]], float)
    valid = (
        np.isfinite(xy).all(axis=1) & (xy >= 0).all(axis=1) & (xy < size).all(axis=1)
    )
    # Never clip an outside coordinate into an opaque edge pixel.
    ids = np.flatnonzero(valid)
    native_xy = np.floor(xy[ids] * (native_size / size)).astype(np.int64)
    native_valid = (native_xy >= 0).all(axis=1) & (native_xy < native_size).all(axis=1)
    valid[ids[~native_valid]] = False
    ids, native_xy = ids[native_valid], native_xy[native_valid]
    alpha = np.zeros(len(xy))
    alpha[ids] = raw[native_xy[:, 1], native_xy[:, 0], 3] / 255.0
    ears = [(key, view.get(key)) for key in ('imageLeftEar', 'imageRightEar')]
    visible_count = sum(
        isinstance(ear, dict) and ear.get('visible') is True for _, ear in ears
    )
    result = []
    for key, ear in ears:
        if not isinstance(ear, dict) or ear.get('visible') is not True:
            continue
        polygon = _camera_polygon(ear.get('outline'), crop, native_size, size)
        if polygon is None:
            continue
        confidence = ear.get('confidence', 0)
        if (
            not isinstance(confidence, (int, float))
            or not np.isfinite(confidence)
            or not 0 <= confidence <= 1
        ):
            confidence = 0
        side = resolve_ear_side(key, origin, visible_count)
        distance = np.full(len(xy), np.nan)
        distance[ids] = [
            cv2.pointPolygonTest(polygon, tuple(map(float, xy[i])), True) for i in ids
        ]
        observation = ear_donor_observation(
            camera_id,
            origin,
            labels,
            distance,
            side=side,
            annotation_confidence=confidence,
            annotation_visible=True,
            blur=view.get('blur'),
            inside=bound.astype(bool) & valid,
            visible=visible,
            alpha=alpha,
            facing=facing,
            edge=edge,
            masked=masked,
        )
        observation['audit'].update(
            filename=filename,
            imageSide=key,
            projectionOutsideSamples=int(np.count_nonzero(~valid)),
            polygonCoordinateUnits='camera pixels',
        )
        result.append(observation)
    return result
