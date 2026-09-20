"""Bake estimated hair detail into the crown of an aligned local head GLB.

Explicit appearance operation for the metre-scaled Object Capture candidate.
The generated donor is not photographic evidence of the subject's hair. All
geometry, UV, normal and physics buffer bytes remain untouched in the GLB.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, map_coordinates
import trimesh


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def crown_weight(points, normals):
    # Forehead is at +100 mm in this candidate's aligned head coordinates.
    # Fade into the upper hair while preserving the face, ears and sideburns.
    return smoothstep((points[..., 1] - 0.128) / 0.030) * smoothstep(
        (normals[..., 1] - 0.10) / 0.55
    )


def raster_surface(mesh, width, height):
    """Bind texel centers to the original UV triangles, including seam copies."""
    world = np.zeros((height, width, 3), np.float32)
    normal = np.zeros_like(world)
    covered = np.zeros((height, width), bool)
    vertices, faces = mesh.vertices, mesh.faces
    # UV seams must not create seams in the blend mask's surface normals.
    unique, inverse = np.unique(np.round(vertices, 7), axis=0, return_inverse=True)
    normals = trimesh.Trimesh(unique, inverse[faces], process=False).vertex_normals[
        inverse
    ]
    uv = mesh.visual.uv * [width, height]
    uv[:, 1] = height - uv[:, 1]
    for face in faces:
        t = uv[face]
        lo = np.maximum(np.floor(t.min(0)).astype(int), 0)
        hi = np.minimum(np.ceil(t.max(0)).astype(int), [width - 1, height - 1])
        if np.any(lo > hi):
            continue
        a, b = t[1] - t[0], t[2] - t[0]
        determinant = a[0] * b[1] - a[1] * b[0]
        if abs(determinant) < 1e-10:
            continue
        xx, yy = np.meshgrid(
            np.arange(lo[0], hi[0] + 1) + 0.5,
            np.arange(lo[1], hi[1] + 1) + 0.5,
        )
        xx, yy = xx - t[0, 0], yy - t[0, 1]
        u = (xx * b[1] - yy * b[0]) / determinant
        v = (yy * a[0] - xx * a[1]) / determinant
        weights = np.stack([1 - u - v, u, v], axis=-1)
        inside = np.all(weights >= -1e-6, axis=-1)
        region = np.s_[lo[1] : hi[1] + 1, lo[0] : hi[0] + 1]
        world[region][inside] = (weights @ vertices[face])[inside]
        normal[region][inside] = (weights @ normals[face])[inside]
        covered[region] |= inside
    normal /= np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-12)
    return world, normal, covered


def blend_crown(source, donor, points, normals):
    """Project one continuous crown image in X/Z, independent of atlas islands."""
    weight = crown_weight(points, normals)
    core = weight > 0.95
    if core.sum() < 32:
        raise ValueError('No supported upper crown in the aligned head.')
    # The image's top is the posterior; bottom is the front/quiff. This is an
    # explicit local-head projection, not an automatic arbitrary-GLB hair mask.
    column = np.clip((points[:, 0] + 0.115) / 0.225, 0, 1)
    row = np.clip((points[:, 2] + 0.230) / 0.245, 0, 1)
    coords = [row * (donor.shape[0] - 1), column * (donor.shape[1] - 1)]
    sampled = np.column_stack(
        [
            map_coordinates(donor[..., c].astype(float), coords, order=1)
            for c in range(3)
        ]
    )
    # Match the existing dark-hair tone. Keep the donor's local strand contrast;
    # blending original low-frequency cap colors per triangle reintroduces seams.
    target = np.median(source[core], axis=0) * 1.08
    gain = target / np.maximum(np.median(sampled[core], axis=0), 1)
    matched = sampled * gain
    amount = 0.96 * weight[:, None]
    result = np.uint8(
        np.clip(np.rint(source * (1 - amount) + matched * amount), 0, 255)
    )
    result[weight == 0] = source[weight == 0]
    return result, weight, target


def replace_base_color(glb, png):
    """Append a replacement image; never re-export or quantize mesh buffers."""
    magic, version, size = struct.unpack_from('<III', glb)
    if magic != 0x46546C67 or version != 2 or size != len(glb):
        raise ValueError('Expected a complete GLB v2.')
    chunks = []
    offset = 12
    while offset < len(glb):
        length, kind = struct.unpack_from('<II', glb, offset)
        chunks.append((kind, glb[offset + 8 : offset + 8 + length]))
        offset += 8 + length
    if [kind for kind, _ in chunks] != [0x4E4F534A, 0x004E4942]:
        raise ValueError('Expected one JSON and one embedded binary GLB chunk.')
    doc = json.loads(chunks[0][1])
    if len(doc.get('meshes', [])) != 1 or len(doc['meshes'][0]['primitives']) != 1:
        raise ValueError('Crown bake requires a single textured surface.')
    primitive = doc['meshes'][0]['primitives'][0]
    material = doc['materials'][primitive['material']]
    texture_id = material['pbrMetallicRoughness']['baseColorTexture']['index']
    image_id = doc['textures'][texture_id]['source']
    binary = chunks[1][1]
    view_id = len(doc['bufferViews'])
    doc['bufferViews'].append(
        {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(png)}
    )
    doc['images'][image_id] = {'bufferView': view_id, 'mimeType': 'image/png'}
    binary += png
    binary += b'\0' * (-len(binary) % 4)
    doc['buffers'][0]['byteLength'] = len(binary)
    encoded = json.dumps(doc, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    body = (
        struct.pack('<II', len(encoded), 0x4E4F534A)
        + encoded
        + struct.pack('<II', len(binary), 0x004E4942)
        + binary
    )
    return struct.pack('<III', magic, version, len(body) + 12) + body


def bake(source_path, donor_path, output_path):
    if output_path.exists():
        raise FileExistsError(
            'Use a new output file; keep the original for comparison.'
        )
    original = source_path.read_bytes()
    mesh = trimesh.load(
        io.BytesIO(original), file_type='glb', force='mesh', process=False
    )
    source = np.asarray(mesh.visual.material.baseColorTexture.convert('RGB'))
    donor = np.asarray(Image.open(donor_path).convert('RGB'))
    height, width = source.shape[:2]
    points, normals, covered = raster_surface(mesh, width, height)
    values, weight, target = blend_crown(
        source[covered], donor, points[covered], normals[covered]
    )
    result = source.copy()
    result[covered] = values
    # Fill only the empty gutter adjacent to changed hair. Covered skin/ear
    # texels are never borrowed, even at another UV island's boundary.
    distance, nearest = distance_transform_edt(~covered, return_indices=True)
    influence = np.zeros(covered.shape, bool)
    influence[covered] = weight > 0
    gutter = (~covered) & (distance <= 3) & influence[nearest[0], nearest[1]]
    result[gutter] = result[nearest[0][gutter], nearest[1][gutter]]
    protected = covered & ~influence
    if not np.array_equal(result[protected], source[protected]):
        raise ValueError('The crown bake altered a protected texel.')
    image = io.BytesIO()
    Image.fromarray(result).save(image, format='PNG')
    output = replace_base_color(original, image.getvalue())
    reloaded = trimesh.load(
        io.BytesIO(output), file_type='glb', force='mesh', process=False
    )
    for name, before, after in (
        ('positions', mesh.vertices, reloaded.vertices),
        ('indices', mesh.faces, reloaded.faces),
        ('UVs', mesh.visual.uv, reloaded.visual.uv),
        ('normals', mesh.vertex_normals, reloaded.vertex_normals),
    ):
        if not np.array_equal(before, after):
            raise ValueError('The crown bake altered ' + name)
    audit = {
        'sourceSha256': hashlib.sha256(original).hexdigest(),
        'donorSha256': hashlib.sha256(donor_path.read_bytes()).hexdigest(),
        'modelSha256': hashlib.sha256(output).hexdigest(),
        'estimatedAppearance': True,
        'method': 'Generated crown hair, continuous X/Z projection, matched dark tone and feathered upper-scalp blend.',
        'geometryBuffersUnchanged': True,
        'protectedTexelsUnchanged': int(protected.sum()),
        'changedTexels': int(np.any(result != source, axis=-1).sum()),
        'gutterTexels': int(gutter.sum()),
        'crownMedianRGB': target.tolist(),
        'textureSize': [width, height],
        'limitation': 'Estimated crown strands; does not recover unseen hair or add volumetric geometry.',
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(output)
    output_path.with_suffix('.crown.json').write_text(
        json.dumps(audit, indent=2) + '\n'
    )
    return audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('donor', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(json.dumps(bake(args.source, args.donor, args.output), indent=2))
