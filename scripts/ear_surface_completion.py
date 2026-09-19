"""Estimated appearance on connected head surfaces hidden by source ears."""

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from scripts.surface_completion import complete_surface_colors


def continue_ear_surface(
    vertices,
    faces,
    binding,
    photo_color,
    parts,
    vertex_parts,
    confidence,
    ear_occluded,
    *,
    photographed,
    preserve=None,
    observed_hair=None,
):
    """Return ``estimate, alpha, ownership, audit`` without changing inputs.

    Domain: target-bearing categorical head subtriangles and their immediate
    photographic boundary faces. Mixed triangles are clipped temporarily in
    barycentric coordinates, sharing original-edge intersections. There is no
    metric-radius truncation. Ear/eye regions and the planar neck cap are
    excluded; the model mesh and anatomical labels remain unchanged.

    ``photo_color`` contains unmasked photographic RGB before estimated blends.
    Callers must use the matching hair-only RGB where relaxed ``hair_support``
    qualifies a donor. ``confidence`` is max(best, validated hair_support),
    ``ear_occluded`` is a bounded [0,1] eligibility/ownership strength, and
    ``photographed`` excludes generated cleanup and inpainted samples.
    ``preserve`` protects cleanup, mouth and bottom; ``observed_hair`` protects
    positive photographic hair semantics independently of the scalp prior.

    Support >= .12 and all protected texels have exactly zero ownership/alpha.
    Donors require support > .15. Positive harmonic interpolation retains the
    photographed vertex anchors and cannot exceed their component color bounds.
    Apply once after earlier fallback with the separately saved prepared color
    before that fallback (``base``). This base may include verified cleanup and
    need not equal the purely photographic donor field ``photo_color``::

        current += ownership[:, None] * (base - current)
        current += alpha[:, None] * (estimate - base)

    Reserve this ownership from subsequent completion. Neither measured RGB nor
    physical coverage metadata is modified here. Unresolved estimates equal the
    input photo_color and have zero ownership. This is estimated appearance,
    not evidence that hidden head surfaces are skin rather than hair.
    """
    p, f = np.asarray(vertices), np.asarray(faces)
    triangles = np.asarray(binding['triangles'])
    tids = np.asarray(binding['triangleIds'])
    bary = np.asarray(binding['weights'])
    color = np.asarray(photo_color)
    part, labels = np.asarray(parts), np.asarray(vertex_parts)
    strength, occlusion = np.asarray(confidence), np.asarray(ear_occluded)
    source = np.asarray(photographed, dtype=bool)
    n, count = len(p), len(color)
    protected = (
        np.zeros(count, bool) if preserve is None else np.asarray(preserve, bool)
    )
    hair = (
        np.zeros(count, bool)
        if observed_hair is None
        else np.asarray(observed_hair, bool)
    )
    if (
        p.shape != (n, 3)
        or f.ndim != 2
        or f.shape[1] != 3
        or triangles.ndim != 2
        or triangles.shape[1] != 3
        or color.shape != (count, 3)
        or bary.shape != (count, 3)
        or tids.shape != (count,)
        or labels.shape != (n,)
        or any(
            a.shape != (count,)
            for a in (part, strength, occlusion, source, protected, hair)
        )
    ):
        raise ValueError('Invalid ear-surface completion arrays.')
    for array, bound in ((f, n), (triangles, n), (tids, len(triangles))):
        if not np.issubdtype(array.dtype, np.integer) or (
            array.size and (array.min() < 0 or array.max() >= bound)
        ):
            raise ValueError('Invalid ear-surface mesh binding.')
    if (
        not all(
            np.isfinite(a).all()
            for a in (p, color, strength, occlusion, bary, part, labels)
        )
        or np.any(strength < 0)
        or np.any(occlusion < 0)
        or np.any(occlusion > 1)
        or np.any(bary < -1.1e-5)
        or np.any(np.maximum(bary, 0).sum(axis=1) <= 0)
    ):
        raise ValueError(
            'Ear-surface inputs must be finite with valid weights and support.'
        )
    estimate = color.copy().astype(float)
    alpha, ownership = np.zeros(count), np.zeros(count)
    audit = dict(
        estimated=True,
        method='Connected head-domain harmonic continuation from unmasked photographic boundary anchors.',
        targetTexels=0,
        resolvedTexels=0,
        unresolvedTargetTexels=0,
        donorTexels=0,
        targetTriangles=0,
        boundaryTriangles=0,
        excludedCapTriangles=0,
        mixedLabelTargetTexelsExcluded=0,
        unsupportedTopologyTargetTexelsExcluded=0,
        components=[],
        maximumComponentAabbDiagonalMm=0.0,
        physicalCoverageChanged=False,
        limitation='Estimated hidden appearance on a temporary categorical head submesh; no claim of observed skin or metric-bounded donor influence.',
    )
    if not len(f) or not count:
        return estimate, alpha, ownership, audit
    used = np.unique(f)
    cut = p[used, 1].min()
    cap = np.all(p[f, 1] <= cut + 0.0001, axis=1)
    audit['excludedCapTriangles'] = int(cap.sum())
    candidate = (part == 0) & (strength < 0.12) & (occlusion > 0) & ~protected & ~hair
    mixed = (labels[triangles] != 0).any(axis=1)
    original_mixed = mixed[tids]
    from scripts.head_surface_domain import clip_head_surface

    p, safe_faces, binding, allowed, clip_audit = clip_head_surface(
        p, f[~cap], labels, binding, texel_parts=part
    )
    audit['headDomain'] = clip_audit
    audit['mixedLabelTargetTexelsExcluded'] = int(
        np.count_nonzero(candidate & original_mixed & ~allowed)
    )
    audit['mixedLabelTargetTexelsIncluded'] = int(
        np.count_nonzero(candidate & original_mixed & allowed)
    )
    audit['unsupportedTopologyTargetTexelsExcluded'] = int(
        np.count_nonzero(candidate & ~allowed & ~original_mixed)
    )
    triangles = np.asarray(binding['triangles'])
    tids = np.asarray(binding['triangleIds'])
    bary = np.asarray(binding['weights'])
    n = len(p)
    target = candidate & allowed
    audit['targetTexels'] = int(target.sum())
    audit['unresolvedTargetTexels'] = int(target.sum())
    if not target.any():
        return estimate, alpha, ownership, audit
    target_triangles = np.unique(tids[target])
    domain = np.zeros(n, bool)
    domain[triangles[target_triangles].ravel()] = True
    touches = domain[triangles].any(axis=1)
    donors = (
        source & (part == 0) & (strength > 0.15) & ~protected & allowed & touches[tids]
    )
    # The boundary ring contributes only photographed anchors. Its unsupported
    # vertices are not added to the unknown domain, so it cannot grow the solve.
    donor_triangles = np.unique(tids[donors])
    solve_keys = {
        tuple(row)
        for row in np.sort(triangles[np.r_[target_triangles, donor_triangles]], axis=1)
    }
    solve_faces = np.asarray(
        [row for row in safe_faces if tuple(sorted(row)) in solve_keys], dtype=int
    ).reshape(-1, 3)
    audit['targetTriangles'] = int(len(target_triangles))
    audit['boundaryTriangles'] = int(
        len(np.setdiff1d(donor_triangles, target_triangles))
    )
    audit['donorTexels'] = int(donors.sum())
    field, resolved, solve_audit = complete_surface_colors(
        p, solve_faces, binding, color, donors, domain
    )
    audit['surfaceSolve'] = solve_audit
    # Report the actual active graph, including only supported boundary vertices.
    anchors = np.zeros(n, bool)
    donor_ids = np.flatnonzero(donors)
    for start in range(0, len(donor_ids), 65536):
        ids = donor_ids[start : start + 65536]
        corners = triangles[tids[ids]]
        anchors[corners[np.maximum(bary[ids], 0) > 0]] = True
    active = domain | anchors
    edges = np.unique(
        np.sort(
            np.concatenate(
                [solve_faces[:, [0, 1]], solve_faces[:, [1, 2]], solve_faces[:, [2, 0]]]
            ),
            axis=1,
        ),
        axis=0,
    )
    edges = edges[active[edges].all(axis=1)]
    graph = coo_matrix(
        (
            np.ones(2 * len(edges)),
            (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]]),
        ),
        shape=(n, n),
    ).tocsr()
    _, components = connected_components(graph, directed=False)
    for component in np.unique(components[domain]):
        ids = np.flatnonzero(active & (components == component))
        extent = float(np.linalg.norm(np.ptp(p[ids], axis=0)) * 1000)
        audit['components'].append(
            dict(
                domainVertices=int(domain[ids].sum()),
                anchoredVertices=int(anchors[ids].sum()),
                resolvedDomainVertices=int((domain[ids] & resolved[ids]).sum()),
                extentAabbDiagonalMm=extent,
            )
        )
        audit['maximumComponentAabbDiagonalMm'] = max(
            audit['maximumComponentAabbDiagonalMm'], extent
        )
    target_ids = np.flatnonzero(target)
    for start in range(0, len(target_ids), 65536):
        ids = target_ids[start : start + 65536]
        corners = triangles[tids[ids]]
        valid = resolved[corners].all(axis=1)
        ids, corners = ids[valid], corners[valid]
        weights = np.maximum(bary[ids].astype(float), 0)
        weights /= weights.sum(axis=1, keepdims=True)
        estimate[ids] = np.sum(field[corners] * weights[:, :, None], axis=1)
        fade = np.clip((0.12 - strength[ids]) / 0.12, 0, 1)
        fade = fade * fade * (3 - 2 * fade)
        ownership[ids] = occlusion[ids]
        alpha[ids] = ownership[ids] * fade
        audit['resolvedTexels'] += int(len(ids))
    audit['unresolvedTargetTexels'] -= audit['resolvedTexels']
    return estimate, alpha, ownership, audit
