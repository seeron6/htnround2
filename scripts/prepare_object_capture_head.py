"""Prepare an independent local photogrammetry candidate for the interaction lab.

The accepted scan is read-only. Geometry priors and the artificial neck closure
are explicitly estimated. No Meshy assets, cloud calls or new weights are used.
"""

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import subprocess
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import trimesh
from PIL import Image
from scipy.sparse import coo_matrix, diags, eye
from scipy.sparse.linalg import spsolve
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation
from head_artifacts import published_folder
from scripts.ear_deformation import bounded_surface_step, surface_quality
from scripts.surface_intersections import new_crossings, crossing_pairs


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def laplacian(vertices, faces):
    edges = np.unique(
        np.sort(
            np.vstack([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1
        ),
        axis=0,
    )
    a, b = edges.T
    w = np.clip(
        0.003 / np.maximum(np.linalg.norm(vertices[a] - vertices[b], axis=1), 0.0005),
        0.1,
        4,
    )
    adjacent = coo_matrix(
        (np.r_[w, w], (np.r_[a, b], np.r_[b, a])), shape=(len(vertices), len(vertices))
    ).tocsr()
    return diags(np.asarray(adjacent.sum(axis=1)).ravel()) - adjacent


class Camera:
    def __init__(self, intrinsics, image_size, source_size):
        self.k = np.asarray(intrinsics, float).copy()
        self.k[0] *= image_size[0] / source_size[0]
        self.k[1] *= image_size[1] / source_size[1]
        self.width, self.height = image_size

    def cam_from_img(self, xy):
        return (xy - self.k[:2, 2]) / np.diag(self.k)[:2]

    def img_from_cam(self, xyz):
        return xyz[:, :2] / xyz[:, 2, None] * np.diag(self.k)[:2] + self.k[:2, 2]


class CaptureImage:
    def __init__(self, row):
        self.name, self.camera_id = row['filename'], row['id']
        self.center = np.asarray(row['translation'])
        r = np.diag([1, -1, -1]) @ Rotation.from_quat(row['quaternion']).as_matrix().T
        self.pose = SimpleNamespace(
            rotation=SimpleNamespace(matrix=lambda: r), translation=-r @ self.center
        )

    def cam_from_world(self):
        return self.pose

    def projection_center(self):
        return self.center


def align_capture(capture, reconstruction, include_reconstruction=False):
    from scripts.photo_geometry import robust_landmarks, camera_rays, projection_error

    manifest = json.loads((capture / 'capture.json').read_text())
    frames = {f['filename']: f for f in manifest['frames']}
    rows = json.loads((reconstruction / 'poses.json').read_text())
    cameras = {}
    for row in rows:
        if 'intrinsicsColumns' not in row:
            raise ValueError('Camera intrinsics require macOS 26 or newer.')
        with Image.open(capture / 'detail-images' / row['filename']) as image:
            source_size = image.size
        cameras[row['id']] = Camera(
            np.asarray(row['intrinsicsColumns']).T, manifest['imageSize'], source_size
        )
    rec = SimpleNamespace(
        cameras=cameras, images={r['id']: CaptureImage(r) for r in rows}
    )
    ordered = sorted(
        [im for im in rec.images.values() if frames[im.name].get('landmarks')],
        key=lambda im: frames[im.name]['yaw'],
    )
    if len(ordered) < 12:
        raise ValueError(
            'At least 12 registered facial views are required for head alignment.'
        )
    held = ordered[2::5]
    points, _ = robust_landmarks(
        *camera_rays(rec, frames, [im for im in ordered if im not in held])
    )
    quality = projection_error(points, rec, frames, held)
    if quality['medianPx'] > 4 or quality['p95Px'] > 12:
        raise ValueError(
            'Recovered cameras do not explain reserved facial landmarks: '
            + str(quality)
        )
    center = (points[10] + points[152]) / 2
    right = points[263] - points[33]
    right /= np.linalg.norm(right)
    up = points[10] - points[152]
    up -= right * np.dot(up, right)
    up /= np.linalg.norm(up)
    basis = np.stack([right, up, np.cross(right, up)])
    aligned = (points - center) @ basis.T
    scale = 0.2 / (aligned[10, 1] - aligned[152, 1])
    result = (
        center,
        basis,
        scale,
        {
            'registeredViews': len(rows),
            'facialViews': len(ordered),
            'reservedViews': len(held),
            'landmarkProjection': quality,
            'absoluteScaleMeasured': False,
            'fullSurfaceValidated': False,
        },
    )
    return (*result, rec, frames, aligned * scale) if include_reconstruction else result


def regularize_volume(vertices, faces):
    """Round corners and shorten the unseen posterior using bounded priors."""
    v = vertices.copy()
    unique, inverse = np.unique(np.round(v, 7), axis=0, return_inverse=True)
    rounded = spsolve(
        eye(len(unique), format='csr') + 18 * laplacian(unique, inverse[faces]), unique
    )
    delta = rounded - unique
    delta *= np.minimum(1, 0.012 / np.maximum(np.linalg.norm(delta, axis=1), 1e-12))[
        :, None
    ]
    weight = smoothstep((unique[:, 1] - 0.11) / 0.025)
    v += delta[inverse] * weight[inverse, None]
    above = np.maximum(v[:, 1] - 0.11, 0)
    v[:, 1] -= 0.08 * above**2 / (above + 0.005)
    behind = np.maximum(-0.075 - v[:, 2], 0)
    # Keep the posterior hair volume visible in the registered rear frames.
    # The old contraction was tuned for an unseen skull prior and pulled the
    # captured crown too far toward the face, leaving a visibly narrow back
    # silhouette compared with the source photographs.
    v[:, 2] += 0.12 * behind**2 / (behind + 0.018)
    # The registered rear frames show a rounded crown rather than the flat
    # Object Capture cut plane. Apply a small posterior-only rolloff above the
    # hairline so the profile closes into the nape without changing the face.
    posterior = smoothstep((-v[:, 2] - 0.08) / 0.18)
    crown = smoothstep((v[:, 1] - 0.125) / 0.06)
    v[:, 1] -= 0.020 * posterior * crown
    # The source profile frames show a swept quiff that rolls over the side
    # planes instead of ending as a rectangular cap. Keep the correction on
    # the posterior upper shell and taper it toward the temple silhouette;
    # the facial surface and the measured independent eyewear stay untouched.
    upper = smoothstep((v[:, 1] - 0.118) / 0.07)
    rear = smoothstep((-v[:, 2] - 0.025) / 0.19)
    side = smoothstep((np.abs(v[:, 0]) - 0.032) / 0.058)
    roundover = 0.016 * upper * rear * side
    v[:, 1] -= roundover
    v[:, 0] *= 1 - 0.035 * upper * rear * side
    below = np.maximum(-0.105 - v[:, 1], 0)
    v[:, 1] += 0.60 * below**2 / (below + 0.004)
    return v


def hair_relief(vertices, faces, original, data):
    if not data or not data.get('accessories', {}).get('hair', {}).get('photoGuides'):
        return vertices, {'applied': False}
    groom = data['accessories']['hair']
    gp = np.asarray(data['positions']).reshape(-1, 3)
    ids = np.asarray(groom['rootTriangles']).reshape(-1, 3)
    weights = np.asarray(groom['rootWeights']).reshape(-1, 3)
    roots = np.einsum('ij,ijk->ik', weights, gp[ids])
    directions = np.asarray(groom['photoGuides']['directions']).reshape(-1, 3)
    selected = np.arange(0, len(roots), 24)
    if not len(selected):
        return vertices, {'applied': False}
    _, index = cKDTree(original).query(roots[selected])
    centers = vertices[index]
    unique, inverse = np.unique(np.round(vertices, 7), axis=0, return_inverse=True)
    normals = trimesh.Trimesh(unique, inverse[faces], process=False).vertex_normals[
        inverse
    ]
    direction = directions[selected].copy()
    rn = normals[index]
    direction -= np.sum(direction * rn, axis=1)[:, None] * rn
    direction /= np.maximum(np.linalg.norm(direction, axis=1)[:, None], 1e-12)
    _, near = cKDTree(centers).query(
        vertices, k=list(range(1, min(10, len(selected)) + 1))
    )
    delta = vertices[:, None] - centers[near]
    along = np.sum(delta * direction[near], axis=2)
    across = np.linalg.norm(delta - along[:, :, None] * direction[near], axis=2)
    width = 0.0028 + 0.0018 * (0.5 + 0.5 * np.sin(near * 12.98))
    ridge = np.exp(-((across / width) ** 2) - (along / 0.018) ** 2)
    relief = 0.0045 * ridge.max(1) * smoothstep((vertices[:, 1] - 0.11) / 0.025)
    result, quality = bounded_surface_step(
        vertices, vertices + normals * relief[:, None], faces
    )
    return result, {
        'applied': True,
        'estimated': True,
        'maximumChangeMm': float(
            np.linalg.norm(result - vertices, axis=1).max() * 1000
        ),
        'surfaceQuality': quality,
        'method': 'Photographic flow transferred onto the scalp; modeled ridge cross sections, not recovered strands.',
    }


def close_neck(mesh):
    """Replace the uncertain posterior crop with an explicit sloped closure."""
    normal = np.array([0, 1, 0.35])
    origin = np.array([0, -0.105, -0.18])
    surface = trimesh.intersections.slice_mesh_plane(mesh, normal, origin, cap=False)
    closed = trimesh.intersections.slice_mesh_plane(
        mesh, normal, origin, cap=True, engine='earcut'
    )
    capfaces = closed.faces[
        np.all(abs((closed.vertices[closed.faces] - origin) @ normal) < 1e-7, axis=1)
    ]
    if not len(capfaces):
        return mesh, {'applied': False}
    ids, inverse = np.unique(capfaces, return_inverse=True)
    capv = closed.vertices[ids]
    capf = inverse.reshape(-1, 3)
    material = mesh.visual.material
    image = (
        material.baseColorTexture
        if hasattr(material, 'baseColorTexture')
        else material.image
    ).convert('RGB')
    width, height = image.size
    strip = 512
    v = mesh.vertices
    donor = (
        (v[:, 1] > -0.085)
        & (v[:, 1] < -0.045)
        & (abs(v[:, 0]) > 0.055)
        & (v[:, 2] > -0.10)
        & (v[:, 2] < -0.035)
    )
    if not donor.any():
        raise ValueError('No photographic skin donors for the artificial closure.')
    colors = trimesh.visual.color.uv_to_color(mesh.visual.uv[donor], image)[:, :3]
    skin = np.median(colors, axis=0) * 0.82
    texture = np.zeros((height, width + strip, 3), np.uint8)
    texture[:, :width] = np.asarray(image)
    y = np.linspace(-1, 1, height)[:, None]
    x = np.linspace(-1, 1, strip)[None, :]
    texture[:, width:] = np.uint8(
        np.clip(skin * (0.99 - 0.08 * (x * x + y * y))[:, :, None], 0, 255)
    )
    uv = surface.visual.uv.copy()
    uv[:, 0] *= width / (width + strip)
    cu = np.empty((len(capv), 2))
    cu[:, 0] = (width + strip * 0.5) / (width + strip) + (
        capv[:, 0] / 0.15
    ) * strip * 0.35 / (width + strip)
    cu[:, 1] = 0.5 + ((capv[:, 2] + 0.13) / 0.15) * 0.35
    result = trimesh.Trimesh(
        np.vstack([surface.vertices, capv]),
        np.vstack([surface.faces, capf + len(surface.vertices)]),
        visual=trimesh.visual.TextureVisuals(
            uv=np.vstack([uv, cu]),
            material=trimesh.visual.material.PBRMaterial(
                baseColorTexture=Image.fromarray(texture), roughnessFactor=0.85
            ),
        ),
        process=False,
    )
    return result, {
        'applied': True,
        'estimated': True,
        'triangles': len(capf),
        'planeNormal': normal.tolist(),
        'planeOrigin': origin.tolist(),
    }


def prepare(capture, reconstruction, output):
    if output.exists():
        raise FileExistsError('Use a new candidate directory.')
    from scripts.eyewear_separation import load_eyewear_detection
    from scripts.scan_eyewear import repair_scanned_eyewear

    advice, detection = load_eyewear_detection(capture)
    center, basis, scale, alignment, rec, frames, landmarks = align_capture(
        capture, reconstruction, include_reconstruction=True
    )
    objects = list((reconstruction / 'model').glob('*.obj'))
    if len(objects) != 1:
        raise ValueError('Expected one Object Capture mesh.')
    mesh = trimesh.load(objects[0], force='mesh', process=False)
    mesh.vertices = (mesh.vertices - center) @ basis.T * scale
    vertices, faces, attr = trimesh.remesh.subdivide(
        mesh.vertices, mesh.faces, vertex_attributes={'uv': mesh.visual.uv}
    )
    shaped = regularize_volume(vertices, faces)
    model_path = published_folder(capture) / 'mesh.json'
    source = json.loads(model_path.read_text()) if model_path.exists() else None
    shaped, hair = hair_relief(shaped, faces, vertices, source)
    quality = {
        **surface_quality(vertices, shaped, faces),
        **new_crossings(vertices, shaped, faces),
    }
    if (
        quality['newCrossings']
        or quality['reversedTriangles']
        or quality['minimumAreaRatio'] <= 0.01
        or not np.isfinite(shaped).all()
    ):
        raise ValueError(
            'Candidate failed the surface integrity check: ' + str(quality)
        )
    result = trimesh.Trimesh(
        shaped,
        faces,
        visual=trimesh.visual.TextureVisuals(
            uv=attr['uv'], material=mesh.visual.material
        ),
        process=False,
    )
    result, closure = close_neck(result)
    welded = result.copy()
    welded.merge_vertices(merge_tex=True, merge_norm=True)
    if not welded.is_watertight:
        raise ValueError('Neck closure left an open surface.')
    result.metadata = {
        'appearance': True,
        'appearanceStats': {'material': 'photo'},
        'reconstruction': {
            'source': 'Independent local photogrammetry experiment',
            'registeredViews': alignment['registeredViews'],
            'usesSplats': False,
            'limitation': 'Estimated crown and neck. Baked photographic lighting; preview spring rig, not Newton.',
        },
    }
    result, eyewear, glasses = repair_scanned_eyewear(
        result,
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
    )
    from scripts.crown_geometry import (
        apply_front_hair_volume,
        complete_capture_crown_geometry,
    )
    from scripts.crown_capture import complete_capture_crown

    result, crown_shape = complete_capture_crown_geometry(
        result, capture, rec, center, basis, scale, landmarks, advice
    )

    result, crown = complete_capture_crown(
        result, capture, rec, center, basis, scale, landmarks, advice
    )
    result, front_hair = apply_front_hair_volume(result)
    crown_shape['frontQuiffFinal'] = front_hair
    from scripts.photo_hair_binding import bind_photo_hair

    hair_spec, hair_binding = bind_photo_hair(result, source)
    if hair_spec:
        result.metadata.setdefault('accessories', {})['hair'] = hair_spec
        result.metadata['accessories'].setdefault('visibility', {})['hair'] = True
    _ = result.vertex_normals
    audit = {
        'alignment': alignment,
        'surface': quality,
        'hair': hair,
        'photoHairBinding': hair_binding,
        'crownGeometry': crown_shape,
        'crownTexture': crown,
        'closure': closure,
        'eyewear': eyewear,
        'watertightAfterWelding': True,
        'captureSha256': hashlib.sha256(
            (capture / 'capture.json').read_bytes()
        ).hexdigest(),
        'sourceMeshSha256': hashlib.sha256(objects[0].read_bytes()).hexdigest(),
        'sourceGeometry': 'Apple Object Capture; no Meshy geometry',
        'acceptance': 'Candidate only; not qualified as superior to Meshy.',
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.head-candidate-', dir=output.parent))
    try:
        result.export(staging / 'model.glb')
        if glasses:
            subprocess.run(
                [
                    'node',
                    str(Path(__file__).with_name('package_head_eyewear.mjs')),
                    str(staging / 'model.glb'),
                ],
                check=True,
            )
        # Quantization can expose near-coincident lens surfaces that were not
        # detected in the float64 reconstruction. Preserve that distinction.
        scene = trimesh.load(staging / 'model.glb', force='scene', process=False)
        exported = max(scene.geometry.values(), key=lambda m: len(m.faces)).copy()
        exported.merge_vertices(merge_tex=True, merge_norm=True)
        pairs = crossing_pairs(exported.vertices, exported.faces)
        audit['exportedFloat32Surface'] = {
            'crossingPairs': len(pairs),
            'watertightAfterWelding': bool(exported.is_watertight),
            'requiresSurfaceCleanup': bool(pairs),
        }
        if pairs or not exported.is_watertight or not exported.is_winding_consistent:
            raise ValueError('Exported head failed the closed-surface integrity gate.')
        audit['modelSha256'] = hashlib.sha256(
            (staging / 'model.glb').read_bytes()
        ).hexdigest()
        (staging / 'shape-audit.json').write_text(json.dumps(audit, indent=2))
        (staging / 'review.json').write_text(
            json.dumps(
                {
                    'label': (
                        'Independent photo head · separate eyewear'
                        if glasses
                        else 'Independent photo head'
                    ),
                    'inputViews': alignment['registeredViews'],
                    'triangles': len(result.faces),
                    'method': 'Local photogrammetry with estimated crown, posterior and neck refinements. Eyewear is detected and separated; hidden eye-area skin is estimated when glasses are present. Experimental spring rig. Meshy is comparison only.',
                },
                indent=2,
            )
        )
        staging.rename(output)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(json.dumps(audit, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('reconstruction', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    prepare(
        args.capture.resolve(), args.reconstruction.resolve(), args.output.resolve()
    )
