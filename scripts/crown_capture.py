"""Apply automatic crown completion inside the Object Capture build."""

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, map_coordinates

from scripts.bake_crown_texture import raster_surface
from scripts.crown_material import compatible_hair, complete_crown, smooth


def photo_opportunity(points, normals, rec, folder, center, basis, scale):
    """Conservative support from registered rays and actual source alpha.

    Object Capture does not export per-texel observation confidence. A usable
    projected footprint therefore protects the original texture even when it
    might be occluded. This can under-fill missing detail, never replace a
    visible well-supported photo merely because the existing cap looks flat.
    """
    world = points / scale @ basis + center
    world_normals = normals @ basis
    support = np.zeros(len(points))
    views = 0
    for image in rec.images.values():
        path = folder / 'images' / image.name
        if not path.is_file():
            continue
        camera = rec.cameras[image.camera_id]
        pose = image.cam_from_world()
        cp = world @ pose.rotation.matrix().T + pose.translation
        direction = image.projection_center() - world
        direction /= np.maximum(np.linalg.norm(direction, axis=1, keepdims=True), 1e-12)
        facing = np.clip(np.sum(direction * world_normals, axis=1), 0, 1)
        selected = np.flatnonzero((facing > 0.25) & (cp[:, 2] > 0))
        if not len(selected):
            continue
        xy = camera.img_from_cam(cp[selected])
        with Image.open(path) as source:
            alpha = (
                np.asarray(source.convert('RGBA').getchannel('A'), dtype=float) / 255
            )
        xy *= [alpha.shape[1] / camera.width, alpha.shape[0] / camera.height]
        visible_alpha = map_coordinates(
            alpha, [xy[:, 1], xy[:, 0]], order=1, mode='constant', cval=0
        )
        quality = (
            facing[selected] ** 2
            * smooth((facing[selected] - 0.25) / 0.15)
            * visible_alpha
        )
        support[selected] = np.maximum(support[selected], quality)
        views += 1
    return support, views


def complete_capture_crown(
    mesh, capture, rec, center, basis, scale, landmarks, completion
):
    if not compatible_hair(completion):
        return mesh, {
            'applied': False,
            'reason': 'No compatible confident wavy-hair classification.',
        }
    material = mesh.visual.material
    original = (
        material.baseColorTexture
        if hasattr(material, 'baseColorTexture')
        else material.image
    )
    source = np.asarray(original.convert('RGB'))
    height, width = source.shape[:2]
    points, normals, covered = raster_surface(mesh, width, height)
    p, n = points[covered], normals[covered]
    head_height = landmarks[10, 1] - landmarks[152, 1]
    eligible = (p[:, 1] > landmarks[10, 1] + 0.06 * head_height) & (n[:, 1] > 0.1)
    support = np.zeros(len(p))
    support[eligible], views = photo_opportunity(
        p[eligible], n[eligible], rec, capture, center, basis, scale
    )
    values, audit = complete_crown(
        source[covered] / 255,
        p,
        n,
        mesh.vertices,
        landmarks,
        completion,
        eligible.astype(float),
        support,
        preserve=~eligible,
    )
    audit.update(
        supportModel='Conservative registered camera-facing source-alpha footprint',
        supportViews=views,
    )
    if not audit['applied']:
        return mesh, audit
    result = source.copy()
    result[covered] = np.uint8(np.clip(np.rint(values * 255), 0, 255))
    changed = np.any(result != source, axis=-1)
    distance, nearest = distance_transform_edt(~covered, return_indices=True)
    gutter = (~covered) & (distance <= 3) & changed[nearest[0], nearest[1]]
    result[gutter] = result[nearest[0][gutter], nearest[1][gutter]]
    repaired = mesh.copy()
    repaired.visual.material = material.copy()
    if hasattr(material, 'baseColorTexture'):
        repaired.visual.material.baseColorTexture = Image.fromarray(result)
    else:
        repaired.visual.material.image = Image.fromarray(result)
    repaired.metadata.setdefault('appearanceStats', {})['crownCompletion'] = audit
    audit['protectedTexelsUnchanged'] = int(np.count_nonzero(~changed & covered))
    return repaired, audit
