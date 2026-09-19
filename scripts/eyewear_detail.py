"""Fit acetate edge width and rim centerlines to the original frontal photograph.

The analysis contours identify which dark edges are glasses; a bounded local
pixel fit refines them. Hidden hinge cross sections remain modeling estimates.
"""

import numpy as np
from PIL import Image
from scipy.interpolate import CubicSpline
from scipy.ndimage import map_coordinates, gaussian_filter1d


def refine_glasses_detail(folder, spec, advice, rec, center, basis, scale):
    if not spec:
        return None
    im = next(
        (im for im in rec.images.values() if im.name == advice['frontFilename']), None
    )
    if im is None:
        return spec
    cam = rec.cameras[im.camera_id]
    pose = im.cam_from_world()
    image_path = folder / 'detail-images' / im.name
    if not image_path.exists():
        image_path = folder / 'images' / im.name
    pixels = np.asarray(Image.open(image_path).convert('RGBA'))
    rgb = pixels[:, :, :3].astype(float) / 255
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722])
    factor = np.array([pixels.shape[1] / cam.width, pixels.shape[0] / cam.height])

    def project(p):
        world = p / scale @ basis + center
        return (
            cam.img_from_cam(world @ pose.rotation.matrix().T + pose.translation)
            * factor
        )

    def lift(xy, z):
        origin = (im.projection_center() - center) @ basis.T * scale
        rays = (
            np.c_[cam.cam_from_img(xy / factor), np.ones(len(xy))]
            @ pose.rotation.matrix()
            @ basis.T
        )
        return origin + rays * ((z - origin[2]) / rays[:, 2])[:, None]

    rims = []
    widths = []
    counts = []
    shifts = []
    for old in spec['rims']:
        old = np.asarray(old)
        spline = CubicSpline(
            np.arange(len(old) + 1), np.vstack([old, old[:1]]), bc_type='periodic'
        )
        p = spline(np.arange(48) * len(old) / 48)
        xy = project(p)
        tangent = np.roll(xy, -1, axis=0) - np.roll(xy, 1, axis=0)
        tangent /= np.linalg.norm(tangent, axis=1)[:, None]
        normal = np.c_[-tangent[:, 1], tangent[:, 0]]
        worldnormal = np.c_[
            -(np.roll(p, -1, axis=0) - np.roll(p, 1, axis=0))[:, 1],
            (np.roll(p, -1, axis=0) - np.roll(p, 1, axis=0))[:, 0],
            np.zeros(len(p)),
        ]
        worldnormal /= np.linalg.norm(worldnormal, axis=1)[:, None]
        ppm = np.linalg.norm(project(p + worldnormal * 0.001) - xy, axis=1) / 0.001
        ys = p[:, 1]
        default = spec['radius'] * (1.25 + 0.75 * (ys - ys.min()) / np.ptp(ys))
        offsets = np.linspace(-12, 12, 97)
        coords = xy[:, None] + normal[:, None] * offsets[None, :, None]
        lum = map_coordinates(
            luma, coords[:, :, ::-1].reshape(-1, 2).T, order=1, mode='nearest'
        ).reshape(len(p), -1)
        alpha = map_coordinates(
            pixels[:, :, 3],
            coords[:, :, ::-1].reshape(-1, 2).T,
            order=1,
            mode='nearest',
        ).reshape(len(p), -1)
        w = default.copy()
        shift = np.zeros(len(p))
        accepted = 0
        for i, row in enumerate(lum):
            # Broad lens shadows, brows and clipped silhouettes cannot establish a rim width.
            threshold = min(0.34, float(np.min(row[32:65])) + 0.075)
            mask = (row < threshold) & (alpha[i] > 240)
            edges = np.diff(np.r_[False, mask, False].astype(int))
            starts = np.where(edges == 1)[0]
            ends = np.where(edges == -1)[0] - 1
            choices = []
            for a, b in zip(starts, ends):
                mid = (offsets[a] + offsets[b]) / 2
                size = offsets[b] - offsets[a]
                if (
                    a == 0
                    or b == len(offsets) - 1
                    or not 1.5 < size < 14
                    or abs(mid) > 8
                ):
                    continue
                if np.mean(row[a : b + 1]) > 0.29:
                    continue
                choices.append((abs(mid) + np.mean(row[a : b + 1]) * 5, mid, size))
            if not choices:
                continue
            _, mid, size = min(choices)
            estimate = size / ppm[i]
            if not 0.001 < estimate < 0.006:
                continue
            w[i] = estimate
            shift[i] = mid
            accepted += 1
        shift = gaussian_filter1d(shift, 1, mode='wrap')
        w = gaussian_filter1d(w, 1.2, mode='wrap')
        p = lift(xy + normal * shift[:, None], p[:, 2])
        rims.append(p.tolist())
        # The contour fit measures the dark centreline reliably, but the
        # antialiased source edge underestimates the physical acetate section.
        # Apply a bounded display correction after fitting so the exported
        # rims retain the photographed rounded, substantial frame rather than
        # collapsing into a black stroke at review size.
        widths.append(np.clip(w * 1.38, 0.002, 0.0068).tolist())
        counts.append(accepted)
        shifts.append(float(np.max(abs(shift))))
    result = {
        **spec,
        'version': 3,
        'rims': rims,
        'rimWidths': widths,
        'rimDepth': 0.0048,
        'bridgeWidth': 0.0052,
        'bridgeDepth': 0.0048,
        'lensThickness': 0.0016,
        'detailEvidence': {
            'source': im.name,
            'method': 'Bounded dark-edge fit in original source pixels',
            'acceptedWidthSamples': counts,
            'maximumContourAdjustmentPx': shifts,
            'hiddenHardwareEstimated': True,
        },
    }
    # The source analysis identifies pale hardware; do not add it to plain frames.
    description = advice['glasses'].get('description', '').lower()
    if 'metal' in description and any(
        x in description for x in ['accent', 'pale', 'silver']
    ):
        result['templeAccent'] = {'length': 0.014, 'width': 0.0011, 'offset': 0.004}
    return result


def clear_temple_arms(mesh, spec, clearance=0.0026):
    """Keep complete arm curves outside the scanned temples, including between knots."""
    from scipy.interpolate import PchipInterpolator

    result = dict(spec)
    arms = []
    maximum = 0
    for old in spec['temples']:
        old = np.asarray(old)
        distance = np.r_[0, np.cumsum(np.linalg.norm(np.diff(old, axis=0), axis=1))]
        points = PchipInterpolator(distance, old, axis=0)(
            np.linspace(0, distance[-1], 32)
        )
        sign = np.sign(points[:, 0].mean())
        origins = np.c_[np.zeros(len(points)), points[:, 1], points[:, 2]]
        directions = np.tile([sign, 0, 0], (len(points), 1))
        locations, rays, _ = mesh.ray.intersects_location(
            origins, directions, multiple_hits=True
        )
        outer = np.zeros(len(points))
        np.maximum.at(outer, rays, locations[:, 0] * sign)
        desired = np.maximum(abs(points[:, 0]), outer + clearance)
        # Smooth the clearance envelope without reducing any required clearance.
        desired = np.maximum(desired, gaussian_filter1d(desired, 1, mode='nearest'))
        changes = desired - abs(points[:, 0])
        maximum = max(maximum, float(changes.max()))
        points[:, 0] = sign * desired
        # The first point is the hinge, well in front of the skin. Preserve its rim junction.
        points[0] = old[0]
        arms.append(points.tolist())
    result['temples'] = arms
    result['templeClearance'] = {
        'targetMm': clearance * 1000,
        'maximumOutwardCorrectionMm': maximum * 1000,
        'method': 'Ray-fitted to repaired scan surface; hidden ear hooks estimated',
    }
    return result
