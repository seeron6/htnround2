"""Transport an existing conformed groom through a bounded same-topology edit.

No source photographs are reinterpreted and no new roots/fibers are invented.
The stored curve bindings, rather than nearest geometry, define correspondence.
"""

from copy import deepcopy

import numpy as np
import trimesh


def transport_photo_groom(groom, old_positions, new_positions, faces):
    """Return copied groom and audit; reject unsupported or stale bindings.

    Preserve the old submicron curve-rounding residual while transporting each
    station by its barycentric surface displacement. Root-relative offsets must
    subtract the root displacement as well. Source colors/confidence stay exact.
    """
    if groom is None:
        return None, dict(changed=False, reason='No groom.')
    old, new = np.asarray(old_positions, float), np.asarray(new_positions, float)
    f = np.asarray(faces)
    if (
        old.ndim != 2
        or old.shape[1] != 3
        or new.shape != old.shape
        or not np.isfinite(old).all()
        or not np.isfinite(new).all()
        or f.ndim != 2
        or f.shape[1] != 3
        or not np.issubdtype(f.dtype, np.integer)
        or np.any(f < 0)
        or np.any(f >= len(old))
        or groom.get('sourceVertexCount') != len(old)
    ):
        raise ValueError('Groom transport requires valid matching mesh topology.')
    guide = groom.get('photoGuides') or {}
    if guide.get('surfaceConformed') is not True or not guide.get('curveBindings'):
        raise ValueError('Groom transport requires conformed station bindings.')
    count, segments = groom.get('rootCount'), guide.get('segments')
    if (
        not isinstance(count, int)
        or count < 1
        or not isinstance(segments, int)
        or not 4 <= segments <= 32
    ):
        raise ValueError('Invalid groom dimensions.')
    station_count = count * (segments + 1)
    topology = {tuple(row) for row in np.sort(f, axis=1)}

    def bindings(indices, weights, size):
        ids, w = np.asarray(indices), np.asarray(weights, float)
        if (
            ids.shape != (size * 3,)
            or not np.issubdtype(ids.dtype, np.integer)
            or w.shape != ids.shape
            or np.any(ids < 0)
            or np.any(ids >= len(old))
            or not np.isfinite(w).all()
            or np.any(w < 0)
            or np.any(w > 1)
        ):
            raise ValueError('Invalid groom surface binding.')
        ids, w = ids.reshape(-1, 3), w.reshape(-1, 3)
        if not np.allclose(w.sum(axis=1), 1, rtol=0, atol=1e-5) or any(
            tuple(row) not in topology
            for row in np.unique(np.sort(ids, axis=1), axis=0)
        ):
            raise ValueError('Groom bindings do not match the mesh.')
        return ids, w

    ri, rw = bindings(groom.get('rootTriangles'), groom.get('rootWeights'), count)
    binding = guide['curveBindings']
    si, sw = bindings(binding.get('triangles'), binding.get('weights'), station_count)

    def vectors(key, size):
        value = np.asarray(guide.get(key), float)
        if value.shape != (size * 3,) or not np.isfinite(value).all():
            raise ValueError('Invalid groom field: ' + key)
        return value.reshape(-1, 3)

    offsets = vectors('curveOffsets', station_count)
    normals = vectors('curveNormals', station_count)
    directions = vectors('directions', count)

    def interpolate(p, indices, weights):
        return np.einsum('ij,ijk->ik', weights, p[indices])

    old_roots = interpolate(old, ri, rw)
    old_stations = interpolate(old, si, sw)
    residual = old_roots.repeat(segments + 1, axis=0) + offsets - old_stations
    maximum_residual = float(np.linalg.norm(residual, axis=1).max())
    if maximum_residual > 0.000003:
        raise ValueError('Conformed groom is stale relative to its source surface.')
    result = deepcopy(groom)
    if np.array_equal(old, new):
        return result, dict(
            changed=False,
            roots=count,
            stations=station_count,
            maximumRestResidualMm=maximum_residual * 1000,
        )
    delta = new - old
    root_delta = interpolate(delta, ri, rw)
    station_delta = interpolate(delta, si, sw)
    updated = offsets + station_delta - root_delta.repeat(segments + 1, axis=0)

    def unit(v):
        length = np.linalg.norm(v, axis=1)
        if np.any(length < 1e-12):
            raise ValueError('Degenerate groom surface normal.')
        return v / length[:, None]

    old_normals = np.asarray(trimesh.Trimesh(old, f, process=False).vertex_normals)
    new_normals = np.asarray(trimesh.Trimesh(new, f, process=False).vertex_normals)
    old_station_normals = interpolate(old_normals, si, sw)
    new_station_normals = interpolate(new_normals, si, sw)
    normal_changed = np.any(new_station_normals != old_station_normals, axis=1)
    transported_normals = normals.copy()
    transported_normals[normal_changed] = unit(new_station_normals[normal_changed])
    changed_roots = np.any(
        updated.reshape(count, segments + 1, 3)
        != offsets.reshape(count, segments + 1, 3),
        axis=(1, 2),
    )
    curve = updated.reshape(count, segments + 1, 3)
    tangent = curve[:, -1] - curve[:, 0]
    valid_tangent = changed_roots & (np.linalg.norm(tangent, axis=1) > 1e-12)
    transported_directions = directions.copy()
    transported_directions[valid_tangent] = unit(tangent[valid_tangent])
    result['photoGuides']['curveOffsets'] = updated.ravel().tolist()
    result['photoGuides']['curveNormals'] = transported_normals.ravel().tolist()
    result['photoGuides']['directions'] = transported_directions.ravel().tolist()
    new_roots = interpolate(new, ri, rw)
    new_stations = interpolate(new, si, sw)
    new_residual = new_roots.repeat(segments + 1, axis=0) + updated - new_stations
    if not np.allclose(new_residual, residual, atol=1e-12, rtol=0):
        raise ValueError('Groom transport changed the bound centerline residual.')
    audit = dict(
        changed=True,
        roots=count,
        stations=station_count,
        shiftedRoots=int(np.any(root_delta != 0, axis=1).sum()),
        shiftedStations=int(np.any(station_delta != 0, axis=1).sum()),
        updatedStationNormals=int(normal_changed.sum()),
        maximumStationDisplacementMm=float(
            np.linalg.norm(station_delta, axis=1).max() * 1000
        ),
        maximumRestResidualMm=float(np.linalg.norm(new_residual, axis=1).max() * 1000),
        sourceAppearancePreserved=True,
        limitation='Existing photographic guides transported through an estimated mesh edit; no new hair observations.',
    )
    return result, audit
