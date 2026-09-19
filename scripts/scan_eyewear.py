"""Replace scan-fused eyewear with a socket surface and an independent fitted frame.

Only the orbital/temple band is remeshed. The remaining scan keeps its exact
geometry and atlas. Hidden skin comes from source-verified cached cleanup
references and is explicitly estimated. No network or Meshy assets are used.
"""

import json, hashlib
from pathlib import Path
import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import Delaunay, cKDTree
from scipy.interpolate import RBFInterpolator
from scipy.ndimage import map_coordinates, distance_transform_edt
from shapely.geometry import Polygon
from shapely import contains_xy
from scripts.eyewear_separation import EyewearSeparationError, require_separate_glasses
from scripts.head_accessories import build_glasses
from scripts.eyewear_detail import refine_glasses_detail, clear_temple_arms
from scripts.surface_intersections import crossing_pairs


def cross(a, b):
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


def cleanup_references(folder):
    """Prefer a newly registered per-frame edit over the legacy front cache."""
    root = folder / 'glasses-reference'
    seen = set()
    for path in [*sorted(root.glob('*/reference.json')), root / 'reference.json']:
        if not path.is_file():
            continue
        meta = json.loads(path.read_text())
        if meta['filename'] in seen:
            continue
        seen.add(meta['filename'])
        yield path.parent, meta


def constrained_grid(boundary, step=0.0018):
    p = Polygon(boundary)
    xs = np.arange(boundary[:, 0].min(), boundary[:, 0].max(), step)
    ys = np.arange(boundary[:, 1].min(), boundary[:, 1].max(), step)
    xx, yy = np.meshgrid(xs, ys)
    grid = np.c_[xx.ravel(), yy.ravel()]
    grid = grid[contains_xy(p.buffer(-step * 0.7), grid[:, 0], grid[:, 1])]
    uv = np.vstack([boundary, grid])
    tri = Delaunay(uv).simplices.copy()
    n = len(boundary)
    # Recover constrained boundary edges by flipping intersecting diagonals.
    for a in range(n):
        b = (a + 1) % n
        for attempt in range(500):
            edges = {}
            for ti, t in enumerate(tri):
                for i, j in [(0, 1), (1, 2), (2, 0)]:
                    edges.setdefault(tuple(sorted((t[i], t[j]))), []).append(ti)
            if tuple(sorted((a, b))) in edges:
                break
            keys = np.array([e for e, t in edges.items() if len(t) == 2])
            q = uv[keys]
            ab = uv[b] - uv[a]
            hit = (cross(ab, q[:, 0] - uv[a]) * cross(ab, q[:, 1] - uv[a]) < -1e-22) & (
                cross(q[:, 1] - q[:, 0], uv[a] - q[:, 0])
                * cross(q[:, 1] - q[:, 0], uv[b] - q[:, 0])
                < -1e-22
            )
            flipped = False
            for c, d in keys[hit]:
                i, j = edges[tuple(sorted((c, d)))]
                e = next(x for x in tri[i] if x not in (c, d))
                f = next(x for x in tri[j] if x not in (c, d))
                if (
                    cross(uv[f] - uv[e], uv[c] - uv[e])
                    * cross(uv[f] - uv[e], uv[d] - uv[e])
                    >= -1e-22
                ):
                    continue
                tri[i] = [e, f, c]
                tri[j] = [f, e, d]
                flipped = True
                break
            if not flipped:
                raise ValueError('Cannot recover boundary edge')
        else:
            raise ValueError('Constraint recovery exceeded limit')
    cen = uv[tri].mean(1)
    tri = tri[contains_xy(p, cen[:, 0], cen[:, 1])]
    area = cross(uv[tri[:, 1]] - uv[tri[:, 0]], uv[tri[:, 2]] - uv[tri[:, 0]])
    tri[area < 0] = tri[area < 0][:, [0, 2, 1]]
    return uv, tri


def orbital_boundary(mesh, spec):
    v, inverse = np.unique(mesh.vertices, axis=0, return_inverse=True)
    f = inverse[mesh.faces]
    u = np.c_[np.arctan2(v[:, 0], v[:, 2] + 0.11) * 0.11, v[:, 1]]
    c = v[f].mean(1)
    t = np.c_[np.arctan2(c[:, 0], c[:, 2] + 0.11) * 0.11, c[:, 1]]
    rims = np.concatenate(spec['rims'])
    bottom = float(rims[:, 1].min()) - 0.0205
    top = float(rims[:, 1].max()) + 0.018
    low = bottom + (0.028 - bottom) * np.clip((abs(t[:, 0]) - 0.085) / 0.08, 0, 1)
    remove = (abs(t[:, 0]) < 0.188) & (t[:, 1] < top) & (t[:, 1] > low)
    edges = np.sort(
        np.concatenate(
            [f[remove][:, [0, 1]], f[remove][:, [1, 2]], f[remove][:, [2, 0]]]
        ),
        axis=1,
    )
    edges, counts = np.unique(edges, axis=0, return_counts=True)
    edges = edges[counts == 1]
    adjacency = {}
    for a, b in edges:
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)
    if not adjacency or any(len(a) != 2 for a in adjacency.values()):
        raise EyewearSeparationError(
            'The eyewear repair boundary is not a closed manifold loop.'
        )
    start = next(iter(adjacency))
    loop, current, previous = [], start, -1
    while True:
        loop.append(current)
        nxt = next(i for i in adjacency[current] if i != previous)
        previous, current = current, nxt
        if current == start:
            break
        if len(loop) > len(adjacency):
            raise EyewearSeparationError('Invalid orbital repair boundary.')
    if len(loop) != len(adjacency) or not Polygon(u[loop]).is_valid:
        raise EyewearSeparationError(
            'This scan needs a different repair domain; multiple eyewear boundary loops.'
        )
    return v, f, u, remove, np.asarray(loop)


def repair_scanned_eyewear(
    mesh,
    capture,
    reconstruction,
    rec,
    frames,
    landmarks,
    center,
    basis,
    scale,
    advice,
    detection,
):
    if detection['state'] == 'absent':
        return mesh, {'detection': detection, 'applied': False}, None
    if detection['state'] != 'present':
        raise EyewearSeparationError(
            'Cannot publish a scan with uncertain eyewear ownership.'
        )
    spec = build_glasses(
        np.vstack([landmarks, mesh.vertices]),
        advice,
        rec,
        frames,
        center,
        basis,
        {'scale': scale},
    )
    require_separate_glasses(detection, spec)
    spec = refine_glasses_detail(capture, spec, advice, rec, center, basis, scale)
    m, folder, recon, lm, B = (
        mesh,
        Path(capture),
        Path(reconstruction),
        landmarks,
        basis,
    )
    v, f, u, remove, loop = orbital_boundary(m, spec)
    uv, tri = constrained_grid(u[loop])
    param = lambda v: np.c_[np.arctan2(v[:, 0], v[:, 2] + 0.11) * 0.11, v[:, 1]]
    radius = lambda v: np.hypot(v[:, 0], v[:, 2] + 0.11)
    lu = param(lm)
    poly = Polygon(u[loop])
    keep = contains_xy(poly.buffer(-0.004), lu[:, 0], lu[:, 1])
    keep &= (lm[:, 1] > -0.013) & (lm[:, 1] < 0.078)
    # Scattered measured facial controls reconstruct the socket; no scan lens depth is retained.
    train = np.vstack([u[loop], lu[keep]])
    rv = np.r_[radius(v[loop]), radius(lm[keep])]
    rbf = RBFInterpolator(
        train,
        rv,
        neighbors=min(48, len(train)),
        kernel='thin_plate_spline',
        smoothing=1e-8,
    )
    r = rbf(uv)
    pv = np.c_[
        r * np.sin(uv[:, 0] / 0.11), uv[:, 1], r * np.cos(uv[:, 0] / 0.11) - 0.11
    ]
    pv[: len(loop)] = v[loop]
    # Bake a separate cylindrical patch atlas from registered, cached glasses-free references.
    W, H = 2048, min(1024, m.visual.material.baseColorTexture.height)
    lo = u[loop].min(0) - 0.0001
    hi = u[loop].max(0) + 0.0001
    xx, yy = np.meshgrid(np.linspace(lo[0], hi[0], W), np.linspace(hi[1], lo[1], H))
    tu = np.c_[xx.ravel(), yy.ravel()]
    valid = contains_xy(poly, tu[:, 0], tu[:, 1])
    query = tu[valid]
    # Interpolate the actual triangulated patch, not a second independently fitted surface.
    d = Delaunay(uv)
    ix = d.find_simplex(query)
    tf = d.transform[ix]
    bary = np.einsum('ijk,ik->ij', tf[:, :2], query - tf[:, 2])
    bary = np.c_[bary, 1 - bary.sum(1)]
    tp = np.einsum('ij,ijk->ik', bary, pv[d.simplices[ix]])
    world = tp / scale @ B + center
    refs = []
    reference_audit = []
    for rd, meta in cleanup_references(folder):
        name = meta['filename']
        rgba = np.asarray(Image.open(folder / 'detail-images' / name).convert('RGBA'))
        if hashlib.sha256(rgba.tobytes()).hexdigest() != meta.get('sourceHash'):
            raise EyewearSeparationError(
                'A cleanup reference does not match the current source photograph.'
            )
        if (
            meta.get('registrationInliers', 0) < 16
            or meta.get('medianRegistrationErrorPx', 99) > 2.5
        ):
            raise EyewearSeparationError(
                'A cleanup reference has unreliable registration.'
            )
        im = next(im for im in rec.images.values() if im.name == name)
        src = np.asarray(
            Image.open(folder / 'detail-images' / name).convert('RGB')
        ).copy()
        crop = meta['crop']
        reg = np.asarray(Image.open(rd / 'registered.png').convert('RGB'))
        src[crop[1] : crop[3], crop[0] : crop[2]] = reg
        cam = rec.cameras[im.camera_id]
        xyz = world @ im.pose.rotation.matrix().T + im.pose.translation
        xy = cam.img_from_cam(xyz) * [
            src.shape[1] / cam.width,
            src.shape[0] / cam.height,
        ]
        color = np.stack(
            [
                map_coordinates(src[:, :, ch], xy[:, ::-1].T, order=1, mode='nearest')
                for ch in range(3)
            ],
            axis=1,
        )
        origin = (im.center - center) @ B.T * scale
        theta = np.arctan2(origin[0], origin[2] + 0.11)
        # Front reference owns both eyes; profile views gradually take over the temples.
        th = query[:, 0] / 0.11
        weight = np.exp(-(((th - theta) / 0.52) ** 4))
        inside = (
            (xy[:, 0] > crop[0])
            & (xy[:, 0] < crop[2])
            & (xy[:, 1] > crop[1])
            & (xy[:, 1] < crop[3])
        )
        weight *= inside

        if abs(theta) < 0.2:
            weight = (
                np.maximum(weight, 1 - np.clip((abs(th) - 0.55) / 0.25, 0, 1)) * inside
            )
        else:
            weight *= np.clip((abs(th) - 0.55) / 0.25, 0, 1)
        refs.append((color, weight))
        reference_audit.append(
            {
                'filename': name,
                'yaw': float(theta),
                'estimated': True,
                'sourceHash': meta['sourceHash'],
            }
        )
    if (
        len(refs) < 3
        or not any(abs(r['yaw']) < 0.25 for r in reference_audit)
        or not any(r['yaw'] < -0.6 for r in reference_audit)
        or not any(r['yaw'] > 0.6 for r in reference_audit)
    ):
        raise EyewearSeparationError(
            'Clean source-registered front and both profile references are required for eyewear separation.'
        )
    weights = np.stack([r[1] for r in refs])
    weights /= np.maximum(weights.sum(0), 1e-15)
    color = sum(c * w[:, None] for (c, _), w in zip(refs, weights))
    # Match the retained texture at the boundary, tapering over 12 mm.
    bdist, _ = cKDTree(u[loop]).query(query)
    alpha = np.clip(bdist / 0.012, 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)
    # Query old texture in its angular projection (front-most layer). 3D boundary donors are stable outside the frame.
    oldtree = cKDTree(u[np.unique(f[remove])])
    _, nearest = oldtree.query(query)
    oldids = np.unique(f[remove])[nearest]
    origidx = np.unique(m.vertices, axis=0, return_index=True)[1]
    oldrgb = trimesh.visual.color.uv_to_color(
        m.visual.uv[origidx[oldids]], m.visual.material.baseColorTexture
    )[:, :3]
    color = color * alpha[:, None] + oldrgb * (1 - alpha[:, None])
    tex = np.zeros((H * W, 3), np.uint8)
    tex[valid] = np.clip(color, 0, 255).astype('uint8')
    tex = tex.reshape(H, W, 3)
    # Extend colors into a gutter around patch UVs.
    _, nearest = distance_transform_edt(~valid.reshape(H, W), return_indices=True)
    tex[~valid.reshape(H, W)] = tex[
        nearest[0][~valid.reshape(H, W)], nearest[1][~valid.reshape(H, W)]
    ]
    img = m.visual.material.baseColorTexture.convert('RGB')
    ow, oh = img.size
    newimage = Image.new('RGB', (ow + W, oh))
    newimage.paste(img)
    newimage.paste(Image.fromarray(tex), (ow, 0))
    newuv = m.visual.uv.copy()
    newuv[:, 0] *= ow / (ow + W)
    pu = np.empty((len(pv), 2))
    pu[:, 0] = (ow + (uv[:, 0] - lo[0]) / (hi[0] - lo[0]) * (W - 1)) / (ow + W)
    pu[:, 1] = 1 - (hi[1] - uv[:, 1]) / (hi[1] - lo[1]) * (H - 1) / oh
    out = trimesh.Trimesh(
        np.vstack([m.vertices, pv]),
        np.vstack([m.faces[~remove], tri + len(m.vertices)]),
        visual=trimesh.visual.TextureVisuals(
            uv=np.vstack([newuv, pu]),
            material=trimesh.visual.material.PBRMaterial(
                baseColorTexture=newimage, roughnessFactor=0.9
            ),
        ),
        process=False,
    )
    spec = clear_temple_arms(out, spec)
    # The frame is fitted from this independent capture, never from Meshy.
    out.metadata = dict(m.metadata)
    out.metadata['coordinateSystem'] = 'punching-face-head-metres-v1'
    out.metadata['accessories'] = {'glasses': spec}
    out.metadata['reconstruction'][
        'limitation'
    ] += ' Hidden skin and socket shape are estimated; independent rigid glasses with photographic eye appearance.'
    out.remove_unreferenced_vertices()
    out.metadata['rigAnchors'] = {
        str(i): lm[i].tolist()
        for i in [
            1,
            10,
            13,
            14,
            33,
            50,
            61,
            133,
            145,
            152,
            159,
            168,
            234,
            263,
            280,
            291,
            362,
            374,
            386,
            454,
        ]
    }
    _ = out.vertex_normals

    welded = out.copy()
    welded.vertices = welded.vertices.astype(np.float32).astype(float)
    welded.merge_vertices(merge_tex=True, merge_norm=True)
    pairs = crossing_pairs(welded.vertices, welded.faces)
    if not welded.is_watertight or not welded.is_winding_consistent or pairs:
        raise EyewearSeparationError(
            'Eyewear repair failed the exported surface integrity check.'
        )
    audit = {
        'detection': detection,
        'applied': True,
        'version': 1,
        'removedFusedTriangles': int(remove.sum()),
        'replacementTriangles': len(tri),
        'separateRigidEyewear': True,
        'lensOpacity': 0.055 + spec.get('lensTint', 0) * 0.1,
        'hiddenSkinEstimated': True,
        'socketGeometryEstimated': True,
        'eyeAppearance': 'Registered reference; original expression retained, no extra refraction',
        'references': reference_audit,
        'watertightAfterWelding': True,
        'crossingPairsAfterFloat32': 0,
        'unaffectedTrianglesUnchanged': True,
    }
    out.metadata['reconstruction']['eyewearSeparation'] = audit
    return out, audit, spec
