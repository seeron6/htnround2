"""Join unsupported head/ear appearance across their actual shared surface.

This is an estimated material field. Boundary anchors can themselves be earlier
estimates; they are never reported as newly photographed skin or hair.
"""

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

from scripts.surface_completion import complete_surface_colors


def _smooth(value):
    value = np.clip(value, 0, 1)
    return value * value * (3 - 2 * value)


def continue_attachment_color(
    vertices,
    faces,
    binding,
    vertex_parts,
    parts,
    color,
    *,
    support,
    preserve,
    collar_width=0.004,
):
    """Return (color, audit), preserving trusted samples and original geometry.

    Categorical head/ear triangles seed one continuous surface-distance field.
    A collar extends ``collar_width`` beyond their vertices, at the model's
    estimated meter scale. It is not an exact distance from the category curve.
    Graph paths use real mesh edges and omit eyes and the artificial neck cap.

    A single positive harmonic RGB field spans both sides of the attachment.
    Its fixed anchors are current colors outside the uncertain collar, which
    can be photographed, cleaned, or estimated. The field is blended only into
    unprotected samples: full strength at support<=0.03, smoothly zero at0.08,
    with a continuous spatial taper at the collar edge. No source confidence,
    categorical label, vertex, UV or rig binding is modified.

    ``preserve`` must include measured-face samples, positive observed hair,
    generated cleanup, mouth and cap. Surface parts1/2 are also protected here.
    Components without any fixed anchors keep their previous appearance.
    """
    p, f = np.asarray(vertices), np.asarray(faces)
    labels, part = np.asarray(vertex_parts), np.asarray(parts)
    triangles = np.asarray(binding['triangles'])
    tids = np.asarray(binding['triangleIds'])
    weights = np.asarray(binding['weights'])
    rgb, strength, protected = (
        np.asarray(color),
        np.asarray(support),
        np.asarray(preserve),
    )
    n, count = len(p), len(rgb)
    if (
        p.shape != (n, 3)
        or f.ndim != 2
        or f.shape[1] != 3
        or triangles.ndim != 2
        or triangles.shape[1] != 3
        or labels.shape != (n,)
        or rgb.shape != (count, 3)
        or weights.shape != (count, 3)
        or any(a.shape != (count,) for a in (tids, part, strength, protected))
        or not all(
            np.isfinite(a).all() for a in (p, labels, part, rgb, weights, strength)
        )
        or np.any(strength < 0)
        or not np.isin(protected, [False, True]).all()
        or np.any(weights < -1.1e-5)
        or np.any(np.maximum(weights, 0).sum(axis=1) <= 0)
        or not np.isfinite(collar_width)
        or collar_width <= 0
        or np.any(labels != np.floor(labels))
        or np.any(part != np.floor(part))
        or np.any(labels < 0)
        or np.any(part < 0)
    ):
        raise ValueError('Invalid attachment continuation inputs.')
    for array, bound in ((f, n), (triangles, n), (tids, len(triangles))):
        if not np.issubdtype(array.dtype, np.integer) or (
            array.size and (array.min() < 0 or array.max() >= bound)
        ):
            raise ValueError('Invalid attachment surface binding.')
    result = rgb.astype(float, copy=True)
    protected = protected.astype(bool) | ~np.isin(part, [0, 3, 4]) | (strength >= 0.08)
    audit = dict(
        estimated=True,
        method='One continuous head/ear attachment field with fixed current-color boundary anchors.',
        collarWidthBeyondBoundaryFaceVerticesMm=float(collar_width * 1000),
        fullyEstimatedSupportAtMost=0.03,
        protectedSupportAtLeast=0.08,
        boundaryTriangles=0,
        targetTexels=0,
        resolvedTexels=0,
        unresolvedTargetTexels=0,
        changedTexels=0,
        protectedTexels=int(protected.sum()),
        protectedChanged=0,
        physicalCoverageChanged=False,
        limitation='Interpolates existing measured and estimated appearance at the model scale; no new photographic evidence or anatomy.',
    )
    if not count or not len(f):
        return result, audit
    used = np.unique(f)
    cap = np.all(p[f, 1] <= p[used, 1].min() + 0.0001, axis=1)
    safe = f[~cap & np.isin(labels[f], [0, 3, 4]).all(axis=1)]
    mixed = safe[(labels[safe] == 0).any(axis=1) & (labels[safe] >= 3).any(axis=1)]
    audit['boundaryTriangles'] = len(mixed)
    audit['excludedCapTriangles'] = int(cap.sum())
    if not len(mixed):
        return result, audit
    # Excluding a face from the edge graph alone is insufficient: an eye or
    # cap texel can still splat its color onto a shared skin vertex. Gate both
    # anchors and targets using original face identity, independent of atlas
    # row numbers or vertex ordering.
    safe_keys = {tuple(sorted(face)) for face in safe}
    allowed_triangles = np.fromiter(
        (tuple(sorted(face)) in safe_keys for face in triangles),
        dtype=bool,
        count=len(triangles),
    )
    allowed = allowed_triangles[tids] & np.isin(part, [0, 3, 4])
    audit['excludedTopologyOrPartTexels'] = int(np.count_nonzero(~allowed))
    edges = np.unique(
        np.sort(np.vstack((safe[:, [0, 1]], safe[:, [1, 2]], safe[:, [2, 0]])), axis=1),
        axis=0,
    )
    edge_length = np.linalg.norm(p[edges[:, 0]] - p[edges[:, 1]], axis=1)
    graph = coo_matrix(
        (
            np.r_[edge_length, edge_length],
            (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]]),
        ),
        shape=(n, n),
    ).tocsr()
    distance = dijkstra(graph, directed=False, indices=np.unique(mixed), min_only=True)
    domain = distance < collar_width
    # Clamping outside vertices would compress distance on long triangles and
    # widen the collar incorrectly. Only disconnected vertices need a finite
    # placeholder; their triangles are explicitly excluded below.
    blend = np.zeros(count)
    for start in range(0, count, 65536):
        end = min(start + 65536, count)
        corners = triangles[tids[start:end]]
        valid = np.isfinite(distance[corners]).all(axis=1)
        bary = np.maximum(weights[start:end].astype(float), 0)
        bary /= bary.sum(axis=1, keepdims=True)
        local_distance = np.sum(
            np.where(np.isfinite(distance[corners]), distance[corners], 0) * bary,
            axis=1,
        )
        blend[start:end] = (
            (1 - _smooth(local_distance / collar_width))
            * (1 - _smooth((strength[start:end] - 0.03) / 0.05))
            * valid
            * allowed[start:end]
            * ~protected[start:end]
        )
    target = blend > 0
    audit['targetTexels'] = int(target.sum())
    if not target.any():
        return result, audit
    field, resolved, field_audit = complete_surface_colors(
        p, safe, binding, rgb, ~target & allowed, domain
    )
    # These anchors include prior estimates. Do not inherit the generic
    # solver's photographed-anchor wording as evidence provenance.
    field_audit['method'] = (
        'Positive surface-edge harmonic solve with fixed current-color anchors.'
    )
    field_audit['anchorsIncludePriorEstimates'] = True
    field_audit['limitation'] = (
        'Anchor color is held fixed without claiming it was photographed.'
    )
    audit['surfaceSolve'] = field_audit
    for start in range(0, count, 65536):
        ids = np.flatnonzero(target[start : start + 65536]) + start
        corners = triangles[tids[ids]]
        valid = resolved[corners].all(axis=1)
        ids, corners = ids[valid], corners[valid]
        if not len(ids):
            continue
        bary = np.maximum(weights[ids].astype(float), 0)
        bary /= bary.sum(axis=1, keepdims=True)
        estimate = np.sum(field[corners] * bary[:, :, None], axis=1)
        result[ids] += blend[ids, None] * (estimate - result[ids])
        audit['resolvedTexels'] += len(ids)
    audit['unresolvedTargetTexels'] = audit['targetTexels'] - audit['resolvedTexels']
    audit['changedTexels'] = int(np.any(result != rgb, axis=1).sum())
    if not np.array_equal(result[protected], rgb[protected]):
        raise ValueError('Attachment continuation changed protected appearance.')
    return result, audit
