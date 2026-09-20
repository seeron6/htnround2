"""Bounded crown completion for the independently reconstructed photo head.

Unseen crown volume and hair relief are priors, not recovered strands. Adaptive
edge subdivision preserves UV seams and all lower-head triangles. Registered
source silhouettes limit the proposal before surface-integrity checks.
"""

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates
from scipy.optimize import least_squares

from scripts.crown_material import DONOR, compatible_hair, smooth
from scripts.ear_deformation import bounded_surface_step, surface_quality


def subdivide_crown(mesh, floor, edge_length):
    """Split selected geometric edges on every incident face, including UV seams."""
    vertices, faces, uv = mesh.vertices.copy(), mesh.faces.copy(), mesh.visual.uv.copy()
    for _ in range(8):
        unique, inverse = np.unique(np.round(vertices, 8), axis=0, return_inverse=True)
        normals = trimesh.Trimesh(unique, inverse[faces], process=False).face_normals
        edges = faces[:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
        lengths = np.linalg.norm(vertices[edges[:, 0]] - vertices[edges[:, 1]], axis=1)
        selected = (
            (lengths > edge_length)
            & (vertices[edges, 1].min(axis=1) > floor)
            & np.repeat(normals[:, 1] > 0.15, 3)
        )
        marked = set(map(tuple, np.sort(inverse[edges[selected]], axis=1)))
        if not marked:
            break
        midpoints, new_vertices, new_uv, new_faces = {}, list(vertices), list(uv), []
        for face, triangle_edges in zip(faces, edges.reshape(-1, 3, 2)):
            mid = []
            for edge in triangle_edges:
                key = tuple(sorted(map(int, edge)))
                if tuple(sorted(map(int, inverse[edge]))) in marked:
                    if key not in midpoints:
                        midpoints[key] = len(new_vertices)
                        new_vertices.append(vertices[edge].mean(axis=0))
                        new_uv.append(uv[edge].mean(axis=0))
                    mid.append(midpoints[key])
                else:
                    mid.append(-1)
            count = sum(i >= 0 for i in mid)
            if count == 3:
                a, b, c = face
                x, y, z = mid
                new_faces.extend([[a, x, z], [x, b, y], [z, y, c], [x, y, z]])
            elif count == 0:
                new_faces.append(face)
            elif count == 1:
                i = next(i for i in range(3) if mid[i] >= 0)
                a, b, c = np.roll(face, -i)
                m = mid[i]
                new_faces.extend([[a, m, c], [m, b, c]])
            else:
                i = next(i for i in range(3) if mid[i] < 0)
                a, b, c = np.roll(face, -i)
                _, x, y = np.roll(mid, -i)
                new_faces.extend([[a, b, x], [a, x, y], [y, x, c]])
        vertices, uv, faces = (
            np.asarray(new_vertices),
            np.asarray(new_uv),
            np.asarray(new_faces),
        )
    result = trimesh.Trimesh(
        vertices,
        faces,
        process=False,
        visual=trimesh.visual.TextureVisuals(
            uv=uv, material=mesh.visual.material.copy()
        ),
        metadata=mesh.metadata.copy(),
    )
    welded = result.copy()
    welded.merge_vertices(merge_tex=True, merge_norm=True)
    if not welded.is_watertight or not welded.is_winding_consistent:
        raise ValueError('Crown subdivision broke the closed head surface.')
    return result


def silhouette_limits(points, delta, capture, rec, center, basis, scale):
    """Bound vertical movement by the existing registered alpha footprints."""
    delta_array = np.asarray(delta)
    ids = (
        np.flatnonzero(abs(delta_array) > 1e-10)
        if delta_array.ndim == 1
        else np.flatnonzero(np.linalg.norm(delta_array, axis=1) > 1e-10)
    )
    original = points[ids]
    fraction = np.ones(len(ids))
    observations = []
    for image in rec.images.values():
        path = capture / 'images' / image.name
        if not path.is_file():
            continue
        with Image.open(path) as source:
            alpha = np.asarray(source.convert('RGBA'))[:, :, 3] > 128
        distance = distance_transform_edt(alpha) - distance_transform_edt(~alpha)
        camera, pose = rec.cameras[image.camera_id], image.cam_from_world()

        def values(p):
            world = p / scale @ basis + center
            cp = world @ pose.rotation.matrix().T + pose.translation
            xy = camera.img_from_cam(cp) * [
                alpha.shape[1] / camera.width,
                alpha.shape[0] / camera.height,
            ]
            return map_coordinates(
                distance, [xy[:, 1], xy[:, 0]], order=1, mode='constant', cval=-1000
            )

        before = values(original)
        threshold = np.minimum(before - 0.5, -0.5)
        for _ in range(12):
            moved = original.copy()
            shift = delta[ids]
            if np.asarray(shift).ndim == 1:
                moved[:, 1] += shift * fraction
            else:
                moved += shift * fraction[:, None]
            bad = values(moved) < threshold
            if not bad.any():
                break
            fraction[bad] *= 0.5
        else:
            fraction[bad] = 0
        observations.append(image.name)
    result = delta.copy()
    if delta_array.ndim == 1:
        result[ids] *= fraction
    else:
        result[ids] *= fraction[:, None]
    return result, {
        'views': len(observations),
        'limitedVertices': int(np.count_nonzero(fraction < 1)),
        'tolerancePx': 0.5,
        'method': 'Vertex projections must not expand existing source-alpha disagreement.',
        'fullSilhouetteValidated': False,
    }


def posterior_crown_proposal(
    points, normals, capture, rec, center, basis, scale, hairline
):
    """Estimate a small rear crown expansion from registered source alpha.

    Object Capture preserves the front well but contracts the posterior hair
    cap. Use only the outward-facing upper shell and the source's rear frames;
    the result is later passed through the all-view silhouette guard.
    """
    radial = np.c_[points[:, 0], np.zeros(len(points)), points[:, 2] + 0.11]
    radial_norm = np.linalg.norm(radial, axis=1)
    radial /= np.maximum(radial_norm[:, None], 1e-9)
    active = np.flatnonzero(
        # Include the upper rear transition ring. The captured top contour
        # falls just below the nominal hairline landmark, so a 40 mm cutoff
        # skipped the very vertices that needed the registered rear lift.
        (points[:, 1] > hairline + 0.025)
        & (points[:, 2] < -0.035)
        & (np.sum(normals * radial, axis=1) > 0.45)
    )
    if not len(active):
        return np.zeros_like(points), {
            'available': False,
            'reason': 'No outward-facing posterior crown shell.',
        }
    # Rear frames are the unlabelled section of this capture. Sampling every
    # second image keeps the solve bounded while retaining both sides of the
    # posterior orbit.
    rear = [
        image
        for image in rec.images.values()
        if image.name.startswith(('frame_001', 'frame_002', 'frame_003', 'frame_004'))
        and int(image.name[6:10]) in set(range(11, 29)) | set(range(38, 46))
    ][::2]
    if len(rear) < 4:
        return np.zeros_like(points), {
            'available': False,
            'reason': 'Insufficient registered rear alpha frames.',
        }
    world = points / scale @ basis + center
    # Solve the image-boundary correction in x/y/z. The older two-axis solve
    # could widen/deepen the posterior but could never raise a crown that was
    # captured too low in the rear alpha silhouettes.
    hessian = np.zeros((len(active), 3, 3))
    rhs = np.zeros((len(active), 3))
    support = np.zeros(len(active), int)
    used = 0
    for image in rear:
        path = capture / 'images' / image.name
        if not path.is_file():
            continue
        with Image.open(path) as source:
            alpha = np.asarray(source.convert('RGBA'))[:, :, 3] > 128
        signed = gaussian_filter(
            distance_transform_edt(alpha) - distance_transform_edt(~alpha), 0.7
        )
        gy, gx = np.gradient(signed)
        camera, pose = rec.cameras[image.camera_id], image.cam_from_world()
        camera_points = world @ pose.rotation.matrix().T + pose.translation
        projected = camera.img_from_cam(camera_points)
        xy = projected[active]
        ix = np.clip(xy[:, 0], 0, alpha.shape[1] - 1)
        iy = np.clip(xy[:, 1], 0, alpha.shape[0] - 1)
        distance = map_coordinates(
            signed, [iy, ix], order=1, mode='constant', cval=-1000
        )
        grad_x = map_coordinates(gx, [iy, ix], order=1, mode='constant', cval=0)
        grad_y = map_coordinates(gy, [iy, ix], order=1, mode='constant', cval=0)
        usable = (
            # The raw cap can sit dozens of pixels inside the rear silhouette
            # before its first vertex reaches the alpha edge. Include that
            # interior band so the solve can actually raise the top contour.
            (distance > 0)
            & (distance < 60)
            & (camera_points[active, 2] > 0)
            & (xy[:, 0] > 2)
            & (xy[:, 0] < alpha.shape[1] - 3)
            & (xy[:, 1] > 2)
            & (xy[:, 1] < alpha.shape[0] - 3)
        )
        jacobian = np.zeros((len(active), 2, 3))
        for axis_index, axis in enumerate(
            ([1, 0, 0], [0, 1, 0], [0, 0, 1])
        ):
            shifted = world[active] + np.asarray(axis)[None, :] / scale @ basis
            shifted = shifted @ pose.rotation.matrix().T + pose.translation
            jacobian[:, :, axis_index] = (
                camera.img_from_cam(shifted) - xy
            ) / 0.0005
        image_normal = grad_x[:, None] * jacobian[:, 0, :] + grad_y[:, None] * jacobian[:, 1, :]
        target = np.clip(8 - distance, -24, 8)
        weight = np.where(usable, np.clip((60 - distance) / 58, 0, 1), 0)
        hessian += weight[:, None, None] * image_normal[:, :, None] * image_normal[:, None, :]
        rhs += weight[:, None] * image_normal * target[:, None]
        support += usable
        used += 1
    trace = np.trace(hessian, axis1=1, axis2=2)
    hessian += np.eye(3)[None] * np.maximum(trace[:, None, None] * 0.03, 1e-3)
    try:
        solution = np.linalg.solve(hessian, rhs[..., None])[..., 0]
    except np.linalg.LinAlgError:
        solution = np.einsum(
            'nij,nj->ni', np.linalg.pinv(hessian), rhs
        )
    solved = np.zeros_like(points)
    solved[active] = solution
    raw_length = np.linalg.norm(solved, axis=1)
    # Keep the proposal a bounded outward crown correction. The source-alpha
    # guard below remains authoritative for every registered view.
    length = np.linalg.norm(solved, axis=1)
    solved *= np.minimum(1, 0.020 / np.maximum(length, 1e-9))[:, None]
    return solved, {
        'available': True,
        'views': used,
        'activeVertices': int(len(active)),
        'supportedVertices': int(np.sum(support > 0)),
        'maximumProposalMm': float(np.linalg.norm(solved, axis=1).max(initial=0) * 1000),
        'rawMaximumSolutionMm': float(raw_length.max(initial=0) * 1000),
        'rawMaximumVerticalMm': float(np.max(np.abs(solved[:, 1]), initial=0) * 1000),
        'method': 'Rear alpha-bound radial crown proposal; final all-view silhouette guard applied.',
    }


def smooth_bounded_delta(points, faces, delta, strength=5):
    """Smooth inside each point's permitted interval; keep protected zeros exact."""
    from scripts.prepare_object_capture_head import laplacian

    matrix = laplacian(points, faces)
    degree = matrix.diagonal()
    result = delta.copy()
    lower, upper = np.minimum(delta, 0), np.maximum(delta, 0)
    degree_term = degree[:, None] if np.asarray(delta).ndim == 2 else degree
    for _ in range(180):
        neighbors = degree_term * result - matrix @ result
        updated = np.clip(
            (delta + strength * neighbors) / (1 + strength * degree_term), lower, upper
        )
        if np.max(abs(updated - result), initial=0) < 1e-8:
            result = updated
            break
        result = updated
    return result


def complete_capture_crown_geometry(
    mesh, capture, rec, center, basis, scale, landmarks, advice
):
    if not compatible_hair(advice):
        return mesh, {
            'applied': False,
            'reason': 'No compatible confident wavy-hair classification.',
        }
    if not DONOR.is_file():
        return mesh, {'applied': False, 'reason': 'Crown detail prior is unavailable.'}
    height = float(landmarks[10, 1] - landmarks[152, 1])
    # This builder uses canonical forehead/chin coordinates at +/- half height.
    if not np.isfinite(height) or height <= 0:
        raise ValueError('Crown completion requires aligned facial landmarks.')
    ratio = height / 0.2
    original_mesh = mesh
    mesh = subdivide_crown(mesh, 0.13 * ratio, 0.0022 * ratio)
    unique, inverse = np.unique(np.round(mesh.vertices, 8), axis=0, return_inverse=True)
    points = unique / ratio
    normals = trimesh.Trimesh(unique, inverse[mesh.faces], process=False).vertex_normals
    ring = (points[:, 1] > 0.12) & (normals[:, 1] > 0.2) & (normals[:, 1] < 0.7)
    if ring.sum() < 32:
        return original_mesh, {
            'applied': False,
            'reason': 'Insufficient sloping crown observations.',
        }
    sample = points[ring]

    def cap(parameters, p):
        top, ax, az, x0, z0 = parameters
        return top - ax * (p[:, 0] - x0) ** 2 - az * (p[:, 2] - z0) ** 2

    fit = least_squares(
        lambda t: np.r_[
            cap(t, sample) - sample[:, 1],
            (t[0] - 0.185) * 0.8,
            t[3],
            (t[4] + 0.11) * 0.2,
        ],
        [0.185, 3, 2, 0, -0.11],
        bounds=([0.16, 0.5, 0.5, -0.02, -0.15], [0.205, 8, 8, 0.02, -0.06]),
        loss='soft_l1',
        f_scale=0.004,
    )
    radius = ((points[:, 0] + 0.005) / 0.098) ** 2 + (
        (points[:, 2] + 0.105) / 0.11
    ) ** 2
    weight = smooth((points[:, 1] - 0.132) / 0.023) * smooth((1 - radius) / 0.35)
    inner = ((points[:, 0] + 0.005) / 0.105) ** 2 + ((points[:, 2] + 0.11) / 0.12) ** 2
    dome = np.clip(cap(fit.x, points) - points[:, 1], 0, 0.010) * smooth(
        (1 - inner) / 0.35
    )
    with Image.open(DONOR) as image:
        donor = np.asarray(image.convert('RGB'), float).mean(axis=2) / 255
    detail = gaussian_filter(donor, 5) - gaussian_filter(donor, 35)
    detail = np.clip(detail / max(np.std(detail) * 2, 1e-9), -1, 1)
    upper = points[points[:, 1] > 0.125]
    lo, hi = upper.min(axis=0), upper.max(axis=0)
    x = (points[:, 0] - (hi[0] + lo[0]) * 0.5) / ((hi[0] - lo[0]) * 1.04)
    z = (points[:, 2] - (hi[2] + lo[2]) * 0.5) / ((hi[2] - lo[2]) * 1.04)
    angle = np.radians(float(advice['hair'].get('flowDegrees', 15)) - 15)
    u = (
        0.5
        + np.cos(angle) * x
        - np.sin(angle) * z
        - float(advice['hair'].get('partOffset', 0)) * 0.10
    )
    v = 0.5 + np.sin(angle) * x + np.cos(angle) * z
    relief = (
        map_coordinates(
            detail,
            [v * (detail.shape[0] - 1), u * (detail.shape[1] - 1)],
            order=1,
            mode='nearest',
        )
        * 0.0028
    )
    posterior, posterior_audit = posterior_crown_proposal(
        unique,
        normals,
        capture,
        rec,
        center,
        basis,
        scale,
        float(landmarks[10, 1]),
    )
    proposal, silhouette = silhouette_limits(
        unique,
        np.c_[
            np.zeros(len(unique)),
            weight * (dome + relief) * ratio,
            np.zeros(len(unique)),
        ]
        + posterior,
        capture,
        rec,
        center,
        basis,
        scale,
    )
    delta = smooth_bounded_delta(unique, inverse[mesh.faces], proposal)
    # Smoothing stays inside the permitted interval. Recheck the final sample
    # because a pixel-alpha boundary need not be monotone along a projected ray.
    delta, final_silhouette = silhouette_limits(
        unique, delta, capture, rec, center, basis, scale
    )
    result_vertices = (unique + delta)[inverse]
    actual = result_vertices - mesh.vertices
    result = trimesh.Trimesh(
        result_vertices,
        mesh.faces,
        visual=mesh.visual,
        process=False,
    )
    mesh.vertices = result_vertices
    audit = {
        'applied': bool(np.any(actual)),
        'estimatedGeometry': True,
        'method': 'Conforming crown subdivision, bounded rounded prior and generated hair relief.',
        'triangles': len(mesh.faces),
        'maximumDisplacementMm': float(
            np.max(np.linalg.norm(actual, axis=1), initial=0) * 1000
        ),
        'fitRmsMm': float(
            np.sqrt(np.mean((cap(fit.x, sample) - sample[:, 1]) ** 2)) * 1000 * ratio
        ),
        'surfaceQuality': surface_quality(unique, unique + delta, inverse[mesh.faces]),
        'silhouetteProposal': silhouette,
        'silhouetteFinal': final_silhouette,
        'posteriorProposal': posterior_audit,
        'posteriorAppliedMaximumMm': float(
            np.max(
                np.linalg.norm(delta[np.linalg.norm(posterior, axis=1) > 1e-12], axis=1),
                initial=0,
            )
            * 1000
        ),
        'posteriorAppliedMeanMm': float(
            np.mean(
                np.linalg.norm(delta[np.linalg.norm(posterior, axis=1) > 1e-12], axis=1)
            )
            * 1000
        ),
        'frontQuiffProposal': {
            'applied': False,
            'appliedScale': 0.0,
            'surfaceQuality': surface_quality(
                unique, unique + delta, inverse[mesh.faces]
            ),
            'method': 'Measured source prior retained for final-stage application; alpha-bounded solve uses posterior volume only.',
        },
        'lowerHeadUnchanged': bool(
            np.all(actual[mesh.vertices[:, 1] <= 0.132 * ratio] == 0)
        ),
        'limitation': 'Hidden crown and hair clumps are estimated; not a recovered strand geometry or a full silhouette validation.',
    }
    mesh.metadata.setdefault('reconstruction', {})['crownGeometry'] = audit
    return mesh, audit


def apply_front_hair_volume(mesh):
    """Add the measured swept-quiff volume after all crown completion steps.

    This is intentionally a final-stage, upper-shell-only deformation. Applying
    it after the crown/texture builder keeps the source pipeline's closed
    surface checks authoritative while preserving the face, eye sockets, and
    independently attached eyewear.
    """
    # Preserve each exported vertex coordinate. Near-duplicate UV seam
    # vertices can differ by a few nanometres; welding them before the
    # deformation makes GLB quantization introduce false seam crossings.
    points = np.asarray(mesh.vertices, dtype=float).copy()
    front_crown = smooth((points[:, 1] - 0.132) / 0.055)
    front_extent = smooth((points[:, 2] + 0.06) / 0.105)
    front_side = smooth((0.09 - np.abs(points[:, 0])) / 0.06)
    front_sweep = 0.58 + 0.42 * smooth((-points[:, 0] + 0.005) / 0.095)
    rear_extent = smooth((-points[:, 2] - 0.005) / 0.18)
    hair_lift = 0.040 * front_extent * front_crown * front_side * front_sweep
    hair_forward = 0.006 * front_extent * front_crown * front_side
    rear_roll = 0.014 * rear_extent * front_crown * (0.55 + 0.45 * front_side)
    # The captured posterior hair boundary is too box-like at the nape. Pull
    # only the lower rear crown inward and lift its center into a shallow arch;
    # the face, ears, and neck stay outside this upper-shell mask.
    nape = smooth((0.158 - points[:, 1]) / 0.042)
    posterior_nape = rear_extent * nape * smooth((points[:, 1] - 0.108) / 0.038)
    rear_taper = 0.14 * posterior_nape
    rear_nape_arch = 0.009 * posterior_nape
    rear_radius = np.sqrt(
        (points[:, 0] / 0.12) ** 2 + ((points[:, 2] + 0.11) / 0.14) ** 2
    )
    rear_crown_lift = (
        0.010
        * rear_extent
        * front_crown
        * smooth((0.98 - rear_radius) / 0.38)
    )
    hair_delta = np.c_[
        -points[:, 0] * rear_taper,
        hair_lift - rear_roll + rear_nape_arch + rear_crown_lift,
        hair_forward,
    ]
    scale = 1.0
    candidate = points + hair_delta
    quality = None
    crossing = None
    from scripts.surface_intersections import crossing_pairs
    for _ in range(8):
        quality = surface_quality(points, candidate, mesh.faces)
        if (
            quality['reversedTriangles'] == 0
            and quality['minimumAreaRatio'] > 0.05
            and quality['maximumAreaRatio'] < 3.0
        ):
            checked = trimesh.Trimesh(candidate, mesh.faces, process=False)
            checked.vertices = np.asarray(checked.vertices, dtype=np.float32)
            checked.merge_vertices(merge_tex=True, merge_norm=True)
            crossing = {'newCrossings': len(crossing_pairs(checked.vertices, checked.faces))}
        if crossing is not None and crossing['newCrossings'] == 0:
            break
        scale *= 0.5
        candidate = points + hair_delta * scale
    result = mesh.copy()
    result.vertices = candidate
    audit = {
        'applied': bool(np.any(np.abs(candidate - points) > 1e-10)),
        'method': 'Final upper-shell swept-quiff prior from source hair silhouette; face and eyewear vertices untouched.',
        'maximumLiftMm': float(np.max(np.abs(hair_lift)) * 1000),
        'maximumForwardMm': float(np.max(np.abs(hair_forward)) * 1000),
        'maximumRearRollMm': float(np.max(np.abs(rear_roll)) * 1000),
        'appliedScale': scale,
        'surfaceQuality': quality,
        'surfaceIntersections': crossing,
    }
    result.metadata.setdefault('reconstruction', {})['frontHairVolume'] = audit
    return result, audit
