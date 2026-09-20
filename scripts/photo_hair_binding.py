"""Bind the saved photographic hair curves to the repaired native head.

The local capture and the eyewear repair do not preserve the vertex order of
the earlier photo-hair surface.  This adapter keeps the observed strand flow,
but rebinds every sampled root to a triangle on the final independent head so
the fibers remain a separate, rigid accessory in the browser.
"""

import numpy as np
from scipy.spatial import cKDTree


def _barycentric(point, triangle):
    a, b, c = triangle
    v0, v1, v2 = b - a, c - a, point - a
    d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
    d20, d21 = v2 @ v0, v2 @ v1
    denominator = d00 * d11 - d01 * d01
    if denominator <= 1e-12:
        return np.array([1.0, 0.0, 0.0])
    u = (d11 * d20 - d01 * d21) / denominator
    v = (d00 * d21 - d01 * d20) / denominator
    result = np.clip([1 - u - v, u, v], 0, 1)
    return result / max(float(np.sum(result)), 1e-12)


def bind_photo_hair(mesh, source, max_roots=3000):
    """Return a browser ``photo-strands`` spec bound to ``mesh``.

    ``source`` is the saved photo pipeline ``mesh.json``.  If that historical
    strand artifact is unavailable, the caller can leave the accessory absent;
    the reconstructed head and separate eyewear remain valid on their own.
    """
    hair = (source or {}).get('accessories', {}).get('hair')
    guides = hair.get('photoGuides') if hair else None
    if not hair or hair.get('mode') != 'photo-strands' or not guides:
        return None, {'applied': False, 'reason': 'No photographic hair curves.'}
    old_positions = np.asarray((source or {}).get('positions', []), float).reshape(-1, 3)
    old_faces = np.asarray((source or {}).get('indices', []), int).reshape(-1, 3)
    old_triangles = np.asarray(hair.get('rootTriangles', []), int).reshape(-1, 3)
    old_weights = np.asarray(hair.get('rootWeights', []), float).reshape(-1, 3)
    if (
        not len(old_positions)
        or not len(old_faces)
        or len(old_triangles) != len(old_weights)
        or len(old_triangles) < 8
    ):
        return None, {'applied': False, 'reason': 'Saved hair roots are incomplete.'}
    roots = np.einsum('ij,ijk->ik', old_weights, old_positions[old_triangles])
    hairline = float(hair.get('hairlineY', 0.1))
    candidates = np.flatnonzero((roots[:, 1] > hairline + 0.005) & (roots[:, 2] < 0.02))
    if len(candidates) < 8:
        return None, {'applied': False, 'reason': 'No supported crown hair roots.'}
    stride = max(1, int(np.ceil(len(candidates) / max_roots)))
    selected = candidates[::stride][:max_roots]
    vertices = np.asarray(mesh.vertices, float)
    faces = np.asarray(mesh.faces, int)
    centers = vertices[faces].mean(axis=1)
    _, nearest = cKDTree(centers).query(roots[selected])
    root_triangles, root_weights = [], []
    for point, face_index in zip(roots[selected], nearest):
        tri = faces[int(face_index)]
        root_triangles.extend(int(i) for i in tri)
        root_weights.extend(_barycentric(point, vertices[tri]).tolist())
    segments = int(guides.get('segments', 0))
    if not 4 <= segments <= 32:
        return None, {'applied': False, 'reason': 'Saved hair curves have invalid segmentation.'}
    selected = selected.tolist()
    spec = {
        'mode': 'photo-strands',
        'seed': int(hair.get('seed', 42)),
        'hairlineY': hairline,
        'parameters': hair.get('parameters', {}),
        'rootTriangles': root_triangles,
        'rootWeights': root_weights,
        'sourceVertexCount': int(len(vertices)),
        'cap': {
            'enabled': True,
            'hairlineY': hairline,
            'capHeightMm': 18,
            'backDepthMm': 5,
            'shellOffsetMm': 1.2,
        },
        'photoGuides': {
            key: guides[key]
            for key in ('segments', 'observedOnly', 'surfaceConformed', 'referenceLengthMm')
            if key in guides
        },
    }
    root_blocks = np.concatenate([np.arange(i * 3, (i + 1) * 3) for i in selected])
    for key in ('directions', 'colors'):
        values = np.asarray(guides.get(key, []), float)
        if len(values) != len(old_triangles) * 3:
            return None, {'applied': False, 'reason': f'Saved hair guide {key} is incomplete.'}
        spec['photoGuides'][key] = values[root_blocks].tolist()
    confidence = np.asarray(guides.get('confidence', []), float)
    if len(confidence) != len(old_triangles):
        return None, {'applied': False, 'reason': 'Saved hair confidence is incomplete.'}
    spec['photoGuides']['confidence'] = confidence[selected].tolist()
    curve_blocks = np.concatenate(
        [
            np.arange(i * (segments + 1) * 3, (i + 1) * (segments + 1) * 3)
            for i in selected
        ]
    )
    for key in ('curveOffsets', 'curveNormals', 'curveColors'):
        values = np.asarray(guides.get(key, []), float)
        expected = len(old_triangles) * (segments + 1) * 3
        if len(values) != expected:
            return None, {'applied': False, 'reason': f'Saved hair curve {key} is incomplete.'}
        spec['photoGuides'][key] = values[curve_blocks].tolist()
    return spec, {
        'applied': True,
        'mode': 'photo-strands',
        'roots': len(selected),
        'fibers': len(selected) * 3,
        'cap': spec['cap'],
        'source': 'Registered photographic hair curves rebound to the final native head surface.',
    }
