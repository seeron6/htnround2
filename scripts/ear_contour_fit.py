"""Constrained multi-view refinement of the external ear rim.

Geometry proposals remain separate from publication. Semantic curves constrain
only their visible external arc; attachment closures and glasses gaps do not
become fitted contours. Inner folds remain a template estimate.
"""

import numpy as np
import cv2
import trimesh
from scipy.ndimage import distance_transform_edt, map_coordinates
from scipy.sparse import coo_matrix, diags, kron, vstack
from scipy.sparse.csgraph import dijkstra
from scipy.sparse.linalg import lsmr
from scipy.spatial import cKDTree


def capture_contour_views(folder, semantics, reconstruction, center, basis):
    """Build auditable camera observations from the exact semantic image crops."""
    from PIL import Image
    from scripts.ear_contour_observations import extract_ear_contour_observation

    images = {image.name: image for image in reconstruction.images.values()}
    output, audit = [], []
    for view in semantics.get('views', []):
        image = images.get(view['filename'])
        if image is None:
            continue
        camera = reconstruction.cameras[image.camera_id]
        path = folder / 'detail-images' / image.name
        if not path.exists():
            path = folder / 'images' / image.name
        with Image.open(path) as photograph:
            native_size = photograph.size
        origin = image.projection_center()
        local_origin = (origin - center) @ basis.T
        oblique = abs(local_origin[0]) > abs(local_origin[2]) * 0.2
        observations = []
        for key in ('imageLeftEar', 'imageRightEar'):
            observation = extract_ear_contour_observation(
                view[key],
                semantics['crops'][image.name],
                native_size=native_size,
                camera_size=(camera.width, camera.height),
                blur=view.get('blur'),
                opaque_glasses=view.get('opaqueGlassesRegions', []),
                source={
                    'filename': image.name,
                    'semanticInputHash': semantics.get('inputHash'),
                    'ear': key,
                },
            )
            audit.append(observation['audit'])
            observations.append((key, observation))

        accepted_count = sum(
            observation['audit']['accepted'] for _, observation in observations
        )
        for key, observation in observations:
            if not observation['audit']['accepted']:
                continue
            if not oblique and local_origin[2] <= 0:
                observation['audit'].update(
                    accepted=False,
                    reason='rear-image-side-correspondence-unresolved',
                    anatomicalSideResolved=False,
                )
                continue
            # Camera-side routing is valid only for a single observed ear.
            # With two accepted ears, image-side labels alone do not identify
            # which anatomical surface belongs to the oblique camera side.
            if oblique and accepted_count > 1:
                observation['audit'].update(
                    accepted=False,
                    reason='ambiguous-dual-ear-oblique-view',
                    anatomicalSideResolved=False,
                )
                continue
            sign = (
                int(np.sign(local_origin[0]))
                if oblique
                else (-1 if key == 'imageLeftEar' else 1)
            )
            pose = image.cam_from_world()
            output.append(
                dict(
                    filename=image.name,
                    sign=sign,
                    origin=origin,
                    camera=camera,
                    rotation=pose.rotation.matrix(),
                    translation=pose.translation,
                    observation=observation,
                )
            )
    return output, audit


def project_points(points, view, center, basis, scale):
    world = np.asarray(points) / scale @ basis + center
    cp = (view['rotation'] @ world.T).T + view['translation']
    return view['camera'].img_from_cam(cp), cp[:, 2]


def _surface_domain(points, faces, core, protected, anchors, graph):
    """Preserve categorical ear geometry while clipping its boundary exactly."""
    from scripts.head_surface_domain import clip_head_surface

    labels = np.ones(len(points), np.uint8)
    labels[core] = 0
    empty = dict(
        triangles=faces, triangleIds=np.empty(0, int), weights=np.empty((0, 3))
    )
    _, triangles, binding, _, _ = clip_head_surface(
        points, faces, labels, empty, return_vertex_bindings=True
    )
    # Binary clipping introduces exact source-edge midpoints. Identity comes
    # from the clipping keys, never from coincident positions on another fold.
    extra = binding['vertexSourceIndices'][len(points) :, :2]
    if not np.all(binding['vertexSourceWeights'][len(points) :] == [0.5, 0.5, 0]):
        raise ValueError('Expected binary ear-domain midpoint bindings.')
    distance = dijkstra(graph, indices=core, min_only=True, directed=False, limit=0.015)
    weight = np.clip(1 - distance / 0.015, 0, 1)
    weight = weight * weight * (3 - 2 * weight)
    weight[protected] = 0
    weight[anchors] = 0
    return dict(triangles=triangles, extraEdges=extra, weight=weight)


def visible_boundary(points, faces, domain, view, center, basis, scale):
    from scripts.photo_geometry import zbuffer

    temporary = np.vstack([points, points[domain['extraEdges']].mean(axis=1)])
    xy, depth = project_points(points, view, center, basis, scale)
    camera = view['camera']
    first = zbuffer(xy, depth, faces, camera.width, camera.height)
    xy, depth = project_points(temporary, view, center, basis, scale)
    ear = zbuffer(xy, depth, domain['triangles'], camera.width, camera.height)
    visible = np.isfinite(ear) & (ear <= first + 0.0001 / scale)
    contours, _ = cv2.findContours(
        np.uint8(visible), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
    )
    border = np.zeros(visible.shape, np.uint8)
    cv2.drawContours(border, contours, -1, 1, 1)
    y, x = np.where(border)
    return np.column_stack([x, y]).astype(float) + 0.5, border, temporary


def _trusted_reverse_points(border, observation):
    """Restrict reverse checks to the Voronoi region of a trusted outer arc.

    Every removed/trimmed arc segment remains an exclusion. A point whose
    nearest full polygon location is elsewhere must not be pulled across an
    anterior attachment or a glasses gap.
    """
    source = np.asarray(observation['pointsCameraPx'], float)
    polygon = np.asarray(observation['polygonCameraPx'], float)
    if not len(border) or not len(source):
        return np.empty(0, int), np.empty(0, int), np.empty(0)
    distances, nearest = cKDTree(source).query(border)
    # Closest continuous polygon segment, not just its sampled endpoints.
    a, b = polygon, np.roll(polygon, -1, axis=0)
    edge = b - a
    t = np.clip(
        np.einsum('nij,ij->ni', border[:, None] - a, edge)
        / np.maximum(np.sum(edge * edge, axis=1), 1e-12),
        0,
        1,
    )
    closest = a[None] + edge[None] * t[:, :, None]
    index = np.argmin(np.sum((closest - border[:, None]) ** 2, axis=2), axis=1)
    foot = closest[np.arange(len(border)), index]
    arc = np.asarray(observation['untrimmedArcCameraPx'], float)
    sample_distance = np.asarray(observation['arcDistanceCameraPx'], float)
    segments = np.asarray(observation['segmentIds'])
    edge = np.diff(arc, axis=0)
    length = np.linalg.norm(edge, axis=1)
    t = np.clip(
        np.einsum('nij,ij->ni', foot[:, None] - arc[:-1], edge)
        / np.maximum(length**2, 1e-12),
        0,
        1,
    )
    on_arc = arc[None, :-1] + edge[None] * t[:, :, None]
    error = np.linalg.norm(on_arc - foot[:, None], axis=2)
    index = np.argmin(error, axis=1)
    arc_distance = (
        np.r_[0, np.cumsum(length)][index]
        + t[np.arange(len(foot)), index] * length[index]
    )
    keep = np.zeros(len(border), bool)
    for segment in np.unique(segments):
        interval = sample_distance[segments == segment]
        if len(interval) >= 2:
            keep |= (arc_distance >= interval.min() - 1e-9) & (
                arc_distance <= interval.max() + 1e-9
            )
    keep &= error[np.arange(len(foot)), index] <= 1e-7
    # Validation retains large errors. Only construction may reject a distant
    # attraction; otherwise a larger flap could evade the quality gate.
    ids = np.flatnonzero(keep)
    return ids, nearest[ids], distances[ids]


def contour_error(points, faces, domain, view, center, basis, scale):
    border, raster, _ = visible_boundary(
        points, faces, domain, view, center, basis, scale
    )
    observation = view['observation']
    source = np.asarray(observation['pointsCameraPx'], float)
    if not len(border) or not len(source):
        return dict(
            valid=False,
            filename=view['filename'],
            reason='No visible contour correspondence.',
        )
    distance = distance_transform_edt(raster == 0)
    # Pixel centers define the raster; use the same coordinates for both directions.
    forward = map_coordinates(
        distance, (source - 0.5).T[::-1], order=1, mode='constant', cval=999
    )
    _, _, reverse = _trusted_reverse_points(border, observation)
    extrema = np.asarray(
        [
            point
            for key, point in observation['extremaCameraPx'].items()
            if observation.get('extremaEligible', {}).get(key, True)
        ],
        float,
    )
    extremum_error = cKDTree(border).query(extrema)[0] if len(extrema) else np.empty(0)

    def summary(values):
        return (
            dict(
                count=len(values),
                medianPx=float(np.median(values)),
                p95Px=float(np.percentile(values, 95)),
                meanSquaredPx=float(np.mean(np.minimum(values, 20) ** 2)),
            )
            if len(values)
            else None
        )

    return dict(
        valid=True,
        filename=view['filename'],
        sourceToModel=summary(forward),
        modelToSource=summary(reverse),
        untrimmedExtrema=summary(extremum_error),
    )


def _constraints(points, faces, domain, view, center, basis, scale):
    border, _, temporary = visible_boundary(
        points, faces, domain, view, center, basis, scale
    )
    source = np.asarray(view['observation']['pointsCameraPx'], float)
    if not len(border) or not len(source):
        return None
    distance, nearest = cKDTree(border).query(source)
    keep = distance < 15
    pixels, targets = border[nearest[keep]], source[keep]
    source_segments = np.asarray(view['observation']['segmentIds'])
    segments = source_segments[keep]
    reverse, target_ids, reverse_distance = _trusted_reverse_points(
        border, view['observation']
    )
    reverse, target_ids = (
        reverse[reverse_distance < 15],
        target_ids[reverse_distance < 15],
    )
    pixels = np.vstack([pixels, border[reverse]])
    targets = np.vstack([targets, source[target_ids]])
    segments = np.r_[segments, source_segments[target_ids]]
    pixels, inverse = np.unique(pixels, axis=0, return_inverse=True)
    sums = np.zeros_like(pixels)
    np.add.at(sums, inverse, targets)
    targets = sums / np.bincount(inverse)[:, None]
    # Reject a shared pixel selected by different observed runs. Averaging
    # across a glasses gap would invent an unobserved target in the gap.
    minimum = np.full(len(pixels), np.iinfo(np.int64).max, np.int64)
    maximum = np.full(len(pixels), np.iinfo(np.int64).min, np.int64)
    np.minimum.at(minimum, inverse, segments)
    np.maximum.at(maximum, inverse, segments)
    unambiguous = minimum == maximum
    pixels, targets = pixels[unambiguous], targets[unambiguous]
    if not len(pixels):
        return None
    camera = view['camera']
    rays = np.column_stack([camera.cam_from_img(pixels), np.ones(len(pixels))])
    directions = rays @ view['rotation'] @ basis.T
    directions /= np.linalg.norm(directions, axis=1, keepdims=True)
    origin = (view['origin'] - center) @ basis.T * scale
    ear = trimesh.Trimesh(temporary, domain['triangles'], process=False)
    locations, ray_ids, triangle_ids = ear.ray.intersects_location(
        np.tile(origin, (len(directions), 1)), directions, multiple_hits=False
    )
    if not len(locations):
        return None
    corners = domain['triangles'][triangle_ids]
    barycentric = trimesh.triangles.points_to_barycentric(temporary[corners], locations)
    rows, columns, values = [], [], []
    for row, (indices, weights) in enumerate(zip(corners, barycentric)):
        for index, weight in zip(indices, weights):
            source_ids = (
                [index]
                if index < len(points)
                else domain['extraEdges'][index - len(points)]
            )
            for source_id in source_ids:
                rows.append(row)
                columns.append(source_id)
                values.append(weight / len(source_ids))
    binding = coo_matrix(
        (values, (rows, columns)), shape=(len(locations), len(points))
    ).tocsr()
    if np.max(abs(binding @ points - locations)) > 1e-8:
        raise ValueError('Ear contour ray binding changed the sampled surface point.')
    return binding, targets[ray_ids]


def _solve_step(
    rest, points, faces, domain, views, center, basis, scale, laplacian, stiffness
):
    ids = np.flatnonzero(domain['weight'] > 0)
    rows, right = [], []
    for view in views:
        pair = _constraints(points, faces, domain, view, center, basis, scale)
        if pair is None:
            continue
        binding, target = pair
        at = binding @ points
        current, _ = project_points(at, view, center, basis, scale)
        jacobian = []
        for axis in range(3):
            delta = np.zeros(3)
            delta[axis] = 1e-5
            plus, _ = project_points(at + delta, view, center, basis, scale)
            minus, _ = project_points(at - delta, view, center, basis, scale)
            jacobian.append((plus - minus) / 2e-5)
        jacobian = np.moveaxis(np.array(jacobian), 0, -1)
        residual = target - current
        magnitude = np.linalg.norm(residual, axis=1)
        # Annotation precision is finite. Do not fit subpixel raster noise or
        # force approximate semantic points to become exact geometry.
        residual *= np.maximum(1 - 2 / np.maximum(magnitude, 1e-12), 0)[:, None]
        pixel_scale = np.linalg.norm(jacobian, axis=2).mean(axis=1)
        factor = np.sqrt(np.minimum(1, 5 / np.maximum(magnitude, 1e-12))) / np.maximum(
            pixel_scale, 1e-6
        )
        active = binding[:, ids].tocoo()
        rr, cc, data = [], [], []
        for uv in range(2):
            for axis in range(3):
                rr.extend(active.row * 2 + uv)
                cc.extend(active.col * 3 + axis)
                data.extend(
                    active.data * jacobian[active.row, uv, axis] * factor[active.row]
                )
        rows.append(
            coo_matrix((data, (rr, cc)), shape=(len(at) * 2, len(ids) * 3)).tocsr()
        )
        right.append((residual * factor[:, None]).ravel())
    if not rows:
        return rest.copy(), dict(
            accepted=False, reason='No usable ray-bound contour constraints.'
        )
    rows.append(kron(laplacian[:, ids], np.eye(3), format='csr') * stiffness)
    right.append((-laplacian @ (points - rest)).ravel() * stiffness)
    tether = 0.1 + 1 - domain['weight'][ids]
    rows.append(kron(diags(tether), np.eye(3), format='csr'))
    right.append(((rest[ids] - points[ids]) * tether[:, None]).ravel())
    matrix, rhs = vstack(rows, format='csr'), np.concatenate(right)
    solution = lsmr(matrix, rhs, atol=1e-7, btol=1e-7, maxiter=600)
    proposal = points.copy()
    proposal[ids] += solution[0].reshape(-1, 3)
    if not np.isfinite(proposal).all():
        raise ValueError('Non-finite ear contour proposal.')
    return proposal, dict(
        accepted=True,
        equations=matrix.shape[0],
        variables=matrix.shape[1],
        solverStop=int(solution[1]),
        iterations=int(solution[2]),
        residual=float(solution[3]),
    )


def _acceptable_quality(report):
    return (
        report['minimumNormalAgreement'] > 0.1
        and report['minimumAreaRatio'] > 0.25
        and report['maximumAreaRatio'] < 3
    )


def fit_ear_contours(
    points, faces, face_count, regions, views, center, basis, scale, *, baseline=None
):
    """Return a private validated proposal and audit; insufficient views are a no-op.

    ``views`` are explicit camera/observation records. Reserved validation views
    MUST be omitted. Each ear needs two valid independent poses separated by at
    least 15 degrees. All face vertices, the first 468 cage points, and ear
    anchors are exact pins. This function neither writes artifacts nor rebakes
    appearance, rebinds hair, or publishes a model.
    """
    from scripts.ear_deformation import bounded_surface_step, surface_quality
    from scripts.surface_intersections import new_crossings

    rest = np.asarray(points, float)
    faces = np.asarray(faces, int)
    baseline = rest if baseline is None else np.asarray(baseline)
    if baseline.shape != rest.shape or not np.isfinite(rest).all() or scale <= 0:
        raise ValueError('Invalid ear contour geometry or scale.')
    fixed = np.zeros(len(rest), bool)
    fixed[: min(468, len(rest))] = True
    fixed[np.unique(faces[:face_count])] = True
    for region in regions.values():
        fixed[list(region['anchors'].values())] = True
    edges = np.unique(
        np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1), axis=0
    )
    a, b = edges.T
    length = np.linalg.norm(rest[a] - rest[b], axis=1)
    rr, cc = np.r_[a, b], np.r_[b, a]
    graph = coo_matrix(
        (np.r_[length, length], (rr, cc)), shape=(len(rest), len(rest))
    ).tocsr()
    laplacian = (
        diags(np.bincount(rr, minlength=len(rest)))
        - coo_matrix((np.ones(len(rr)), (rr, cc)), shape=(len(rest), len(rest))).tocsr()
    )
    output, audit = rest.copy(), {}
    for sign, region in regions.items():
        selected = [
            v
            for v in views
            if int(v['sign']) == int(sign) and v['observation']['audit']['accepted']
        ]
        origins = [(v['origin'] - center) @ basis.T for v in selected]
        directions = np.array([o / max(np.linalg.norm(o), 1e-12) for o in origins])
        separated = len(directions) >= 2 and np.min(
            directions @ directions.T
        ) <= np.cos(np.radians(15))
        if not separated:
            audit[sign] = dict(
                accepted=False,
                reason='Two independent reliable contour views are required.',
            )
            continue
        core = np.asarray(
            region.get('anatomicalCoreVertices', region['coreVertices']), int
        )
        anchors = np.asarray(list(region['anchors'].values()), int)
        if not len(core):
            audit[sign] = dict(accepted=False, reason='No anatomical ear domain.')
            continue
        domain = _surface_domain(rest, faces, core, fixed, anchors, graph)
        before = [
            contour_error(rest, faces, domain, view, center, basis, scale)
            for view in selected
        ]
        candidate, iterations = rest.copy(), []
        for step in range(4):
            desired, solver = _solve_step(
                rest,
                candidate,
                faces,
                domain,
                selected,
                center,
                basis,
                scale,
                laplacian,
                2.0,
            )
            proposal, quality = bounded_surface_step(rest, desired, faces)
            for _ in range(24):
                original_quality = surface_quality(baseline, proposal, faces)
                if (
                    _acceptable_quality(original_quality)
                    and np.max(np.linalg.norm(proposal - rest, axis=1)) <= 0.012
                ):
                    break
                proposal = rest + (proposal - rest) * 0.75
            else:
                proposal = rest.copy()
            candidate = proposal
            iterations.append(
                dict(
                    step=step,
                    solver=solver,
                    quality=surface_quality(rest, candidate, faces),
                    baselineQuality=surface_quality(baseline, candidate, faces),
                )
            )
        after = [
            contour_error(candidate, faces, domain, view, center, basis, scale)
            for view in selected
        ]
        accepted = all(
            a['valid']
            and b['valid']
            and b['sourceToModel']['meanSquaredPx']
            <= a['sourceToModel']['meanSquaredPx'] + 0.25
            for a, b in zip(before, after)
        )
        # The reverse check prevents a good nearest-source score from hiding a
        # new flap. Extrema are checked separately from the trimmed fitting arc.
        for a, b in zip(before, after):
            for key in ('modelToSource', 'untrimmedExtrema'):
                if a.get(key) and b.get(key):
                    accepted &= b[key]['p95Px'] <= a[key]['p95Px'] + 1.0
        accepted &= all(
            np.array_equal(candidate[ids], rest[ids])
            for ids in (np.flatnonzero(fixed), anchors)
        )
        if accepted:
            initial_error = np.mean(
                [v['sourceToModel']['meanSquaredPx'] for v in before]
            )
            final_error = np.mean([v['sourceToModel']['meanSquaredPx'] for v in after])
            accepted &= initial_error - final_error >= max(0.25, initial_error * 0.05)
        crossing = new_crossings(baseline, candidate, faces)
        accepted &= not crossing['newCrossings']
        if accepted:
            output += candidate - rest
        audit[sign] = dict(
            accepted=bool(accepted),
            method='Camera-projected external rim constraints with fixed anchors and smooth mesh displacement.',
            before=before,
            after=after,
            iterations=iterations,
            baselineCrossings=crossing,
            maximumDisplacementMm=float(
                np.linalg.norm(candidate - rest, axis=1).max() * 1000
            ),
            geometryEstimated=True,
        )
    quality = surface_quality(baseline, output, faces)
    quality.update(new_crossings(baseline, output, faces))
    if (
        not _acceptable_quality(quality)
        or quality['newCrossings']
        or not np.array_equal(output[fixed], rest[fixed])
    ):
        return rest.copy(), dict(
            accepted=False,
            ears=audit,
            quality=quality,
            reason='Combined proposal failed protected-surface quality.',
        )
    return output, dict(
        accepted=bool(np.any(output != rest)),
        ears=audit,
        quality=quality,
        observedFaceUnchanged=True,
        limitation='Approximate source contour constraints; inner folds remain a template prior. Appearance and hair must be rebuilt before publication.',
    )
