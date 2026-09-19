"""Temporary categorical head submesh for appearance solves, never geometry edits."""

import numpy as np


def _clip(polygon, normal):
    """Intersect a convex barycentric polygon with normal dot bary >= 0."""
    output = []
    previous = polygon[-1]
    pv = float(previous @ normal)
    for current in polygon:
        cv = float(current @ normal)
        if (pv >= 0) != (cv >= 0):
            output.append(previous + (current - previous) * (pv / (pv - cv)))
        if cv >= 0:
            output.append(current)
        previous, pv = current, cv
    clean = []
    for point in output:
        if not clean or np.max(abs(point - clean[-1])) > 1e-12:
            clean.append(point)
    if len(clean) > 1 and np.max(abs(clean[0] - clean[-1])) <= 1e-12:
        clean.pop()
    return clean


def clip_head_surface(
    vertices,
    faces,
    vertex_parts,
    binding,
    *,
    texel_parts=None,
    return_vertex_bindings=False,
):
    """Return temporary vertices, faces, binding, valid texels, and JSON audit.

    The exact categorical head region is sum(bary at label 0) >= the sum for
    every other label. Label 0 wins ties, matching interpolate_part_labels.
    Convex clipping is performed in original barycentric coordinates, not UV
    or Euclidean proximity. Original edges share keyed midpoint vertices even
    across differently ordered faces and atlas charts. Three distinct labels
    can introduce a face-local barycenter. Nonhead regions supply no edges.

    ``faces`` is the caller's permitted original topology (e.g. cap removed).
    ``binding`` can have independently permuted/duplicated atlas triangles.
    Optional ``texel_parts`` additionally requires existing texel ownership 0.
    Invalid texels receive triangle index 0 and zero weights as placeholders;
    callers MUST gate their sources/targets with the returned validity mask.
    If no head faces exist, do not pass these placeholders into a solver.

    Tiny raster border barycentrics down to -1.1e-5 are clamped/renormalized,
    as in surface_completion. Mesh inputs and anatomical labels are unchanged.
    When requested, vertexSourceIndices/vertexSourceWeights in the returned
    binding preserve exact original-vertex provenance for temporary vertices.
    """
    p, f = np.asarray(vertices), np.asarray(faces)
    labels = np.asarray(vertex_parts)
    triangles = np.asarray(binding['triangles'])
    tids = np.asarray(binding['triangleIds'])
    weights = np.asarray(binding['weights'])
    n, count = len(p), len(tids)
    parts = None if texel_parts is None else np.asarray(texel_parts)
    if (
        p.shape != (n, 3)
        or f.ndim != 2
        or f.shape[1] != 3
        or triangles.ndim != 2
        or triangles.shape[1] != 3
        or labels.shape != (n,)
        or tids.shape != (count,)
        or weights.shape != (count, 3)
        or (parts is not None and parts.shape != (count,))
        or not np.isfinite(p).all()
        or not np.isfinite(labels).all()
        or np.any(labels < 0)
        or np.any(labels != np.floor(labels))
    ):
        raise ValueError('Invalid categorical head-domain arrays.')
    for values, bound in ((f, n), (triangles, n), (tids, len(triangles))):
        if not np.issubdtype(values.dtype, np.integer) or (
            values.size and (values.min() < 0 or values.max() >= bound)
        ):
            raise ValueError('Invalid categorical head-domain topology.')
    if parts is not None and not np.isfinite(parts).all():
        raise ValueError('Invalid categorical texel labels.')
    canonical = np.unique(np.sort(f, axis=1), axis=0)
    if len(canonical) and np.any(np.diff(canonical, axis=1) == 0):
        raise ValueError('Head-domain faces must have three distinct vertices.')
    points = list(p.astype(float))
    vertex_sources = [[i, i, i] for i in range(n)] if return_vertex_bindings else None
    vertex_weights = (
        [[1.0, 0.0, 0.0] for _ in range(n)] if return_vertex_bindings else None
    )
    shared = {}
    clipped_faces, correspondences = [], {}
    mixed_count = 0
    for face in canonical:
        face_labels = labels[face]
        if not np.any(face_labels == 0):
            continue
        polygon = list(np.eye(3))
        for label in np.unique(face_labels):
            if label != 0:
                polygon = _clip(
                    polygon, (face_labels == 0).astype(float) - (face_labels == label)
                )
        if len(polygon) < 3:
            continue
        mixed_count += int(np.any(face_labels != 0))
        vertex_ids = []
        for bary in polygon:
            nonzero = np.flatnonzero(bary > 1e-12)
            if len(nonzero) == 1:
                index = int(face[nonzero[0]])
            else:
                if len(nonzero) == 2:
                    # The categorical boundary on a head/nonhead edge is
                    # exactly its midpoint, independent of the third label.
                    edge = tuple(int(v) for v in face[nonzero])
                    key = ('edge',) + edge
                    position = p[list(edge)].mean(axis=0)
                else:
                    key = (
                        ('face',)
                        + tuple(int(v) for v in face)
                        + tuple(np.round(bary, 12))
                    )
                    position = bary @ p[face]
                if key not in shared:
                    shared[key] = len(points)
                    points.append(position)
                    if return_vertex_bindings:
                        if len(nonzero) == 2:
                            vertex_sources.append([edge[0], edge[1], edge[0]])
                            vertex_weights.append([0.5, 0.5, 0.0])
                        else:
                            vertex_sources.append(face.tolist())
                            vertex_weights.append(bary.tolist())
                index = shared[key]
            vertex_ids.append(index)
        entry = []
        for i in range(1, len(polygon) - 1):
            local = [0, i, i + 1]
            corners = np.asarray(polygon)[local]
            if abs(np.linalg.det(corners)) < 1e-12:
                continue
            new_id = len(clipped_faces)
            clipped_faces.append([vertex_ids[j] for j in local])
            # original bary = new bary @ corners
            entry.append((new_id, np.linalg.inv(corners)))
        correspondences[tuple(face)] = entry
    new_p = np.asarray(points, dtype=float).reshape(-1, 3)
    new_f = np.asarray(clipped_faces, dtype=np.int64).reshape(-1, 3)
    order = np.argsort(triangles, axis=1)
    canonical_binding = np.take_along_axis(triangles, order, axis=1)
    slots = max((len(v) for v in correspondences.values()), default=0)
    ids = np.full((len(triangles), slots), -1, np.int64)
    inverses = np.zeros((len(triangles), slots, 3, 3))
    for index, face in enumerate(canonical_binding):
        for slot, (new_id, inverse) in enumerate(correspondences.get(tuple(face), ())):
            ids[index, slot] = new_id
            inverses[index, slot] = inverse
    new_tids, new_weights = np.zeros(count, np.int64), np.zeros((count, 3), float)
    valid = np.zeros(count, bool)
    all_labels = np.unique(labels)
    maximum_position_error = 0.0
    for start in range(0, count, 65536):
        end = min(start + 65536, count)
        original_bary = weights[start:end].astype(float)
        if not np.isfinite(original_bary).all() or np.any(original_bary < -1.1e-5):
            raise ValueError('Invalid head-domain barycentric weights.')
        original_bary = np.maximum(original_bary, 0)
        total = original_bary.sum(axis=1, keepdims=True)
        if np.any(total <= 0):
            raise ValueError('Head-domain barycentric weights must have support.')
        original_bary /= total
        ti = tids[start:end]
        canonical_bary = np.take_along_axis(original_bary, order[ti], axis=1)
        corner_labels = labels[canonical_binding[ti]]
        head = np.sum(canonical_bary * (corner_labels == 0), axis=1)
        eligible = (
            np.ones(end - start, bool) if parts is None else parts[start:end] == 0
        )
        for label in all_labels:
            if label != 0:
                eligible &= (
                    head
                    >= np.sum(canonical_bary * (corner_labels == label), axis=1) - 1e-12
                )
        for slot in range(slots):
            pending = np.flatnonzero(
                eligible & ~valid[start:end] & (ids[ti, slot] >= 0)
            )
            if not len(pending):
                continue
            remapped = np.einsum(
                'ni,nij->nj', canonical_bary[pending], inverses[ti[pending], slot]
            )
            inside = np.min(remapped, axis=1) >= -2e-10
            pending, remapped = pending[inside], remapped[inside]
            remapped = np.maximum(remapped, 0)
            remapped /= remapped.sum(axis=1, keepdims=True)
            selected = pending + start
            new_tids[selected] = ids[ti[pending], slot]
            new_weights[selected] = remapped
            valid[selected] = True
            if len(selected):
                old_xyz = np.einsum(
                    'ni,nij->nj', original_bary[pending], p[triangles[ti[pending]]]
                )
                new_xyz = np.einsum(
                    'ni,nij->nj', remapped, new_p[new_f[new_tids[selected]]]
                )
                maximum_position_error = max(
                    maximum_position_error,
                    float(np.max(np.linalg.norm(old_xyz - new_xyz, axis=1))),
                )
    mixed_binding = (labels[triangles] != 0).any(axis=1)
    audit = dict(
        temporaryOnly=True,
        originalVertices=n,
        addedVertices=len(new_p) - n,
        originalFaces=len(f),
        headSubtriangles=len(new_f),
        clippedMixedFaces=mixed_count,
        sharedEdgeMidpoints=sum(key[0] == 'edge' for key in shared),
        remappedHeadTexels=int(valid.sum()),
        remappedMixedHeadTexels=int(np.count_nonzero(valid & mixed_binding[tids])),
        maximumRemapPositionErrorMm=maximum_position_error * 1000,
        ownershipRule='Head barycentric label sum >= each other label sum; head wins ties.',
    )
    remapped_binding = dict(triangles=new_f, triangleIds=new_tids, weights=new_weights)
    if return_vertex_bindings:
        remapped_binding.update(
            vertexSourceIndices=np.asarray(vertex_sources, dtype=np.int64).reshape(
                -1, 3
            ),
            vertexSourceWeights=np.asarray(vertex_weights, dtype=float).reshape(-1, 3),
        )
    return (
        new_p,
        new_f,
        remapped_binding,
        valid,
        audit,
    )
