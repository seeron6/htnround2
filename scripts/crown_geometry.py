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
from scripts.ear_deformation import bounded_surface_step


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
        (points[:, 1] > hairline + 0.04)
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
    hessian = np.zeros((len(active), 2, 2))
    rhs = np.zeros((len(active), 2))
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
            (distance > 0)
            & (distance < 20)
            & (camera_points[active, 2] > 0)
            & (xy[:, 0] > 2)
            & (xy[:, 0] < alpha.shape[1] - 3)
            & (xy[:, 1] > 2)
            & (xy[:, 1] < alpha.shape[0] - 3)
        )
        jacobian = np.zeros((len(active), 2, 2))
        for axis_index, axis in enumerate(([1, 0, 0], [0, 0, 1])):
            shifted = world[active] + np.asarray(axis)[None, :] / scale @ basis
            shifted = shifted @ pose.rotation.matrix().T + pose.translation
            jacobian[:, :, axis_index] = (
                camera.img_from_cam(shifted) - xy
            ) / 0.0005
        image_normal = grad_x[:, None] * jacobian[:, 0, :] + grad_y[:, None] * jacobian[:, 1, :]
        target = np.clip(2 - distance, -8, 8)
        weight = np.where(usable, np.clip((20 - distance) / 18, 0, 1), 0)
        hessian += weight[:, None, None] * image_normal[:, :, None] * image_normal[:, None, :]
        rhs += weight[:, None] * image_normal * target[:, None]
        support += usable
        used += 1
    trace = np.trace(hessian, axis1=1, axis2=2)
    hessian[:, 0, 0] += np.maximum(trace * 0.03, 1e-3)
    hessian[:, 1, 1] += np.maximum(trace * 0.03, 1e-3)
    determinant = hessian[:, 0, 0] * hessian[:, 1, 1] - hessian[:, 0, 1] * hessian[:, 1, 0]
    dx = (rhs[:, 0] * hessian[:, 1, 1] - rhs[:, 1] * hessian[:, 0, 1]) / np.maximum(
        determinant, 1e-12
    )
    dz = (hessian[:, 0, 0] * rhs[:, 1] - hessian[:, 1, 0] * rhs[:, 0]) / np.maximum(
        determinant, 1e-12
    )
    solved = np.zeros_like(points)
    solved[active, 0], solved[active, 2] = dx, dz
    scalar = np.clip(np.sum(solved * radial, axis=1), -0.002, 0.006)
    solved = radial * scalar[:, None]
    return solved, {
        'available': True,
        'views': used,
        'activeVertices': int(len(active)),
        'supportedVertices': int(np.sum(support > 0)),
        'maximumProposalMm': float(np.linalg.norm(solved, axis=1).max(initial=0) * 1000),
        'method': 'Rear alpha-bound radial crown proposal; final all-view silhouette guard applied.',
    }


def smooth_bounded_delta(points, faces, delta, strength=5):
    """Smooth inside each point's permitted interval; keep protected zeros exact."""
    from scripts.prepare_object_capture_head import laplacian

    matrix = laplacian(points, faces)
    degree = matrix.diagonal()
    result = delta.copy()
    lower, upper = np.minimum(delta, 0), np.maximum(delta, 0)
    for _ in range(180):
        neighbors = degree * result - matrix @ result
        updated = np.clip(
            (delta + strength * neighbors) / (1 + strength * degree), lower, upper
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
    desired = mesh.vertices.copy()
    desired[:, 1] += delta[inverse]
    result, quality = bounded_surface_step(mesh.vertices, desired, mesh.faces)
    actual = result - mesh.vertices
    mesh.vertices = result
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
        'surfaceQuality': quality,
        'silhouetteProposal': silhouette,
        'silhouetteFinal': final_silhouette,
        'posteriorProposal': posterior_audit,
        'lowerHeadUnchanged': bool(
            np.all(actual[mesh.vertices[:, 1] <= 0.132 * ratio] == 0)
        ),
        'limitation': 'Hidden crown and hair clumps are estimated; not a recovered strand geometry or a full silhouette validation.',
    }
    mesh.metadata.setdefault('reconstruction', {})['crownGeometry'] = audit
    return mesh, audit
