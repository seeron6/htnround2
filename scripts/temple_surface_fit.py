"""Fit the photographed part of rigid spectacle arms outside a closed head.

Camera-ray motion preserves each profile observation. Hidden hooks are not
recovered by that constraint: keep them out of the visible fitted path rather
than projecting a fabricated hook over the pinna. The result remains an
estimated depth fit in the head's normalized, assumed-scale coordinates.
"""

import copy

import numpy as np
import trimesh


def fit_visible_temples(vertices, faces, spec, *, maximum_shift=0.06):
    """Return independent, surface-cleared shaft/bend segments or reject the fit.

    The renderer must consume ``fitted-polyline`` without straightening it again.
    A circumscribed section radius plus the sample-spacing error is reserved
    along every segment. The renderer must retain the fitted bend as a section.
    The final rendered geometry still needs an
    integration check; this is not a claim of measured spectacle depth.
    """
    p = np.asarray(vertices, dtype=float)
    f = np.asarray(faces, dtype=np.int64)
    if (
        p.ndim != 2
        or p.shape[1] != 3
        or not np.isfinite(p).all()
        or f.ndim != 2
        or f.shape[1] != 3
        or len(f) == 0
        or f.min() < 0
        or f.max() >= len(p)
        or not np.isfinite(maximum_shift)
        or not 0 < maximum_shift <= 0.1
    ):
        raise ValueError('Invalid head surface for glasses clearance.')
    mesh = trimesh.Trimesh(p, f, process=False)
    if not mesh.is_watertight or not mesh.is_winding_consistent:
        raise ValueError('Glasses clearance requires a closed, consistently wound head.')
    result = copy.deepcopy(spec)
    audits = result.get('templeFit', [])
    if len(audits) != len(result['temples']):
        raise ValueError('Glasses arms need registered profile evidence.')
    width = np.clip(float(result.get('templeWidth', 0.005)) * 1.4, 0.0024, 0.008)
    radius = float(np.hypot(width / 2, 0.0031 / 2))
    reports = []
    for index, (raw, audit) in enumerate(zip(result['temples'], audits)):
        points = np.asarray(raw, dtype=float)
        origin = np.asarray(audit.get('cameraOrigin', []), dtype=float)
        observed = audit.get('observedPointCount')
        if (
            points.ndim != 2
            or points.shape[1] != 3
            or not np.isfinite(points).all()
            or origin.shape != (3,)
            or not np.isfinite(origin).all()
            or not isinstance(observed, int)
            or not 3 <= observed <= len(points)
            or audit.get('method') != 'profile-contour'
        ):
            raise ValueError('Glasses arms need clear, registered profile contours.')
        hinge = points[0]
        # The final two observed knots define the visible bend. Interpolating
        # an arbitrary fraction of the 3D depth span changes its source pixel.
        shoulder = points[observed - 2]
        endpoint = points[observed - 1]
        # Signed distance is 1-Lipschitz outside the closed head. Reserve half
        # the maximum sample gap plus a numerical margin. The renderer inserts
        # each bend as a section so its triangles never shortcut the corner.
        step = 0.001
        reserve = step / 2 + 0.0001
        target = radius + reserve

        def distances(q):
            return -trimesh.proximity.signed_distance(mesh, np.asarray(q))

        if distances([hinge])[0] <= target:
            raise ValueError('The glasses hinge intersects the head; refit the front rims first.')

        def solve(start, destination):
            ray = origin - destination
            norm = np.linalg.norm(ray)
            if norm < maximum_shift:
                raise ValueError('Glasses profile camera is too close to its arm.')
            ray /= norm
            count = max(3, int(np.ceil((np.linalg.norm(destination - start) + maximum_shift) / step)) + 1)
            t = np.linspace(0, 1, count)[:, None]

            def clearance(shift):
                end = destination + ray * shift
                return float(distances(start * (1 - t) + end * t).min())

            initial = clearance(0)
            if initial >= target:
                return destination.copy(), 0.0, initial
            low, high = 0.0, min(0.001, maximum_shift)
            while clearance(high) < target:
                low = high
                if high >= maximum_shift:
                    raise ValueError('The glasses arm cannot clear this head within the depth bound.')
                high = min(high * 2, maximum_shift)
            # Refine a tested unsafe/safe bracket. Always return its checked
            # safe endpoint, never the unchecked final fixed-point iterate.
            for _ in range(12):
                mid = (low + high) / 2
                if clearance(mid) < target:
                    low = mid
                else:
                    high = mid
            final = clearance(high)
            if final < target:
                raise ValueError('The glasses clearance solve did not reach its bound.')
            return destination + ray * high, high, final

        fitted_shoulder, shoulder_shift, shaft_clearance = solve(hinge, shoulder)
        fitted_end, end_shift, bend_clearance = solve(fitted_shoulder, endpoint)
        arm = np.array([hinge, fitted_shoulder, fitted_end])
        if (np.linalg.norm(np.diff(arm, axis=0), axis=1) < 1e-5).any():
            raise ValueError('The source does not establish a distinct glasses shaft and bend.')
        result['temples'][index] = arm.tolist()
        reports.append({
            'view': audit['view'],
            'shoulderRayShiftMm': shoulder_shift * 1000,
            'endpointRayShiftMm': end_shift * 1000,
            'minimumCenterlineClearanceMm': min(shaft_clearance, bend_clearance) * 1000,
            'requiredCenterlineClearanceMm': target * 1000,
            'sectionRadiusMm': radius * 1000,
            'samplingReserveMm': reserve * 1000,
            'omittedEstimatedHook': observed < len(points),
            'preservedHinge': True,
        })
    result['templePathMode'] = 'fitted-polyline'
    result['templeClearance'] = {
        'version': 1,
        'method': 'Bounded profile-camera ray fit against the complete head surface',
        'depthEstimated': True,
        'hiddenHookReconstructed': False,
        'maximumAllowedShiftMm': maximum_shift * 1000,
        'views': reports,
    }
    return result
