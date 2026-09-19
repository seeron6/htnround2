"""Conservative, image-derived ear-contour observations; no geometry fitting.

Semantic polygons/anchors and opaque polygons use normalized annotation-crop
coordinates. Crop is native-image XYXY; image sizes are (width, height). All
thresholds ending in ``_px`` are CAMERA pixels, after native-to-camera scaling.
No alpha mask is interpreted as background. These approximate annotations are
not ground truth, and unknown blur/hidden anchors provide no observation.
"""

import numpy as np


def _normalized(value, minimum=1):
    a = np.asarray(value, dtype=np.float64)
    if a.ndim != 2 or a.shape[1] != 2 or len(a) < minimum:
        raise ValueError('Expected normalized Nx2 coordinates')
    if not np.isfinite(a).all() or np.any((a < 0) | (a > 1)):
        raise ValueError('Coordinates must be finite and inside normalized crop')
    return a


def _simplify(poly):
    # Remove duplicate/collinear subdivisions before endpoint selection: adding
    # points along an existing segment must not change the chosen contour.
    p = poly.copy()
    changed = True
    while changed and len(p) >= 3:
        changed = False
        for i in range(len(p)):
            u, v = p[i] - p[i - 1], p[(i + 1) % len(p)] - p[i]
            if np.linalg.norm(u) < 1e-9 or (
                abs(np.cross(u, v))
                <= 1e-10 * max(1, np.linalg.norm(u) * np.linalg.norm(v))
                and np.dot(u, v) >= 0
            ):
                p = np.delete(p, i, axis=0)
                changed = True
                break
    return p


def _simple(poly):
    def orient(a, b, c):
        return float(np.cross(b - a, c - a))

    def on(a, b, p):
        return (
            abs(orient(a, b, p)) < 1e-9
            and np.all(p >= np.minimum(a, b) - 1e-9)
            and np.all(p <= np.maximum(a, b) + 1e-9)
        )

    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        for j in range(i + 1, len(poly)):
            if j == i + 1 or (i == 0 and j == len(poly) - 1):
                continue
            c, d = poly[j], poly[(j + 1) % len(poly)]
            if (
                orient(a, b, c) * orient(a, b, d) < 0
                and orient(c, d, a) * orient(c, d, b) < 0
            ) or any((on(a, b, c), on(a, b, d), on(c, d, a), on(c, d, b))):
                return False
    return True


def _blocked(points, polygons, margin):
    blocked = np.zeros(len(points), dtype=bool)
    for polygon in polygons:
        inside = np.zeros(len(points), dtype=bool)
        distance = np.full(len(points), np.inf)
        for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
            edge = b - a
            t = np.clip((points - a) @ edge / max(float(edge @ edge), 1e-30), 0, 1)
            distance = np.minimum(
                distance, np.linalg.norm(points - (a + t[:, None] * edge), axis=1)
            )
            if b[1] != a[1]:
                crosses = (a[1] > points[:, 1]) != (b[1] > points[:, 1])
                inside ^= crosses & (
                    points[:, 0] < a[0] + (points[:, 1] - a[1]) * edge[0] / edge[1]
                )
        blocked |= inside | (distance <= margin)
    return blocked


def extract_ear_contour_observation(
    ear,
    crop,
    *,
    native_size,
    camera_size,
    blur,
    opaque_glasses=(),
    source=None,
    min_confidence=0.8,
    trim_fraction=0.05,
    sample_spacing_px=1.5,
    glasses_margin_px=2.0,
):
    """Return reliable open-arc samples and an explicit acceptance/rejection audit.

    The two top-to-bottom polygon paths are compared by arc-length-weighted
    distance from tragus. Ambiguous choices are rejected. Five-percent endpoint
    trimming avoids uncertain attachments; *untrimmed* extrema remain available
    for independent overshoot validation. ``segmentIds`` separates retained runs
    across glasses exclusions; do not close or bridge these sample sequences.

    Defaults are conservative experimental annotation gates, not calibrated
    confidence probabilities. A 2-camera-pixel uncertainty band should accompany
    contour scoring. Raw native-image review is still needed for new captures.
    """
    size = np.asarray(native_size, float)
    camera = np.asarray(camera_size, float)
    box = np.asarray(crop, float)
    if (
        size.shape != (2,)
        or camera.shape != (2,)
        or box.shape != (4,)
        or not np.isfinite(np.r_[size, camera, box]).all()
        or np.any(size <= 0)
        or np.any(camera <= 0)
        or np.any(box[:2] < 0)
        or np.any(box[2:] > size)
        or np.any(box[2:] <= box[:2])
    ):
        raise ValueError('Invalid native/camera sizes or native XYXY crop')
    params = np.array(
        [min_confidence, trim_fraction, sample_spacing_px, glasses_margin_px]
    )
    if (
        not np.isfinite(params).all()
        or not 0 <= min_confidence <= 1
        or not 0 <= trim_fraction < 0.5
        or sample_spacing_px <= 0
        or glasses_margin_px < 0
    ):
        raise ValueError('Invalid contour thresholds')
    scale = camera / size
    audit = dict(
        accepted=False,
        source=source,
        provenance='estimated semantic contour; no model-derived samples',
        coordinateUnits='camera pixels',
        nativeSize=size.tolist(),
        cameraSize=camera.tolist(),
        cropNativeXYXY=box.tolist(),
        nativeToCameraScale=scale.tolist(),
        minConfidence=float(min_confidence),
        trimFraction=float(trim_fraction),
        sampleSpacingCameraPx=float(sample_spacing_px),
        glassesMarginCameraPx=float(glasses_margin_px),
        uncertaintyCameraPx=2.0,
    )
    result = dict(
        pointsCameraPx=np.empty((0, 2)),
        pointsNativePx=np.empty((0, 2)),
        arcDistanceCameraPx=np.empty(0),
        segmentIds=np.empty(0, dtype=int),
        polygonCameraPx=np.empty((0, 2)),
        untrimmedArcCameraPx=np.empty((0, 2)),
        extremaCameraPx={},
        extremaEligible={},
        audit=audit,
    )

    def reject(reason):
        audit['reason'] = reason
        return result

    if not ear.get('visible', False):
        return reject('not-visible')
    try:
        confidence = float(ear.get('confidence', 0))
    except (TypeError, ValueError):
        return reject('low-or-invalid-confidence')
    if not np.isfinite(confidence) or confidence < min_confidence or confidence > 1:
        return reject('low-or-invalid-confidence')
    if blur not in ('usable', 'sharp'):
        return reject('blur-not-reliably-usable')
    try:
        normalized = _normalized(ear.get('outline', []), 3)
        anchors = _normalized(
            [ear.get(k, [0, 0]) for k in ('top', 'bottom', 'tragus')], 3
        )
        polygons = [_normalized(x, 3) for x in opaque_glasses]
    except (ValueError, TypeError):
        return reject('invalid-normalized-annotation')
    if np.any(np.all(anchors == 0, axis=1)):
        return reject('missing-anchor')
    transform = lambda x: (box[:2] + x * (box[2:] - box[:2])) * scale
    p = _simplify(transform(normalized))
    result['polygonCameraPx'] = p
    anchors = transform(anchors)
    polygons = [transform(x) for x in polygons]
    if len(p) < 3 or not _simple(p):
        return reject('degenerate-or-self-intersecting-polygon')
    area = abs(np.sum(np.cross(p, np.roll(p, -1, axis=0)))) / 2
    axis = anchors[1] - anchors[0]
    height = np.linalg.norm(axis)
    if (
        area < 4
        or height < 8
        or abs(np.cross(axis, anchors[2] - anchors[0])) / height < 1
    ):
        return reject('degenerate-anchor-geometry')

    # Geometric tie break is independent of polygon winding/cyclic origin.
    def nearest(q):
        dist = np.linalg.norm(p - q, axis=1)
        candidates = np.flatnonzero(dist <= dist.min() + 1e-9)
        return min(candidates, key=lambda i: tuple(p[i]))

    first, last = nearest(anchors[0]), nearest(anchors[1])
    if first == last or max(
        np.linalg.norm(p[first] - anchors[0]), np.linalg.norm(p[last] - anchors[1])
    ) > max(3, 0.15 * height):
        return reject('anchors-do-not-identify-separated-outline-ends')
    paths = []
    for direction in (1, -1):
        indices = [first]
        while indices[-1] != last:
            indices.append((indices[-1] + direction) % len(p))
        paths.append(p[indices])
    nodes, weights = np.polynomial.legendre.leggauss(16)

    def arc_stats(path):
        edges = np.diff(path, axis=0)
        lengths = np.linalg.norm(edges, axis=1)
        q = path[:-1, None] + ((nodes + 1) / 2)[None, :, None] * edges[:, None]
        mean = (
            np.sum(lengths * (np.linalg.norm(q - anchors[2], axis=2) @ (weights / 2)))
            / lengths.sum()
        )
        return float(mean), np.r_[0, np.cumsum(lengths)]

    stats = [arc_stats(path) for path in paths]
    choice = int(stats[1][0] > stats[0][0])
    if abs(stats[0][0] - stats[1][0]) < max(1, 0.05 * height):
        return reject('ambiguous-external-path')
    path = paths[choice]
    distance = stats[choice][1]
    length = distance[-1]
    positions = np.linspace(
        length * trim_fraction,
        length * (1 - trim_fraction),
        max(2, int(np.ceil(length * (1 - 2 * trim_fraction) / sample_spacing_px)) + 1),
    )
    samples = np.column_stack(
        [np.interp(positions, distance, path[:, k]) for k in range(2)]
    )
    valid = ~_blocked(samples, polygons, glasses_margin_px)
    extrema = dict(
        top=path[np.argmin(path[:, 1])],
        bottom=path[np.argmax(path[:, 1])],
        left=path[np.argmin(path[:, 0])],
        right=path[np.argmax(path[:, 0])],
        anchorTop=anchors[0],
        anchorBottom=anchors[1],
    )
    result['untrimmedArcCameraPx'] = path
    result['extremaCameraPx'] = {k: v.tolist() for k, v in extrema.items()}
    result['extremaEligible'] = {
        k: not bool(_blocked(v[None], polygons, glasses_margin_px)[0])
        for k, v in extrema.items()
    }
    audit.update(
        confidence=confidence,
        pathMeanDistanceFromTragusCameraPx=stats[choice][0],
        otherPathMeanDistanceFromTragusCameraPx=stats[1 - choice][0],
        untrimmedArcLengthCameraPx=float(length),
        samplesBeforeExclusion=len(samples),
        samplesExcludedOpaque=int((~valid).sum()),
    )
    if valid.sum() < 6 or valid.mean() < 0.5:
        return reject('insufficient-unoccluded-arc')
    runs = np.cumsum(valid & ~np.r_[False, valid[:-1]]) - 1
    result.update(
        pointsCameraPx=samples[valid],
        pointsNativePx=samples[valid] / scale,
        arcDistanceCameraPx=positions[valid],
        segmentIds=runs[valid],
    )
    audit.update(accepted=True, reason='accepted', samplesRetained=int(valid.sum()))
    return result
