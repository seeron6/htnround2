"""Appearance repair must not change facial texels or the editable mesh."""

import io
import json
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from PIL import Image
import trimesh
from scripts.bake_crown_texture import blend_crown, replace_base_color


class CrownTextureTests(unittest.TestCase):
    def test_face_ears_and_vertical_hair_remain_exact(self):
        rng = np.random.default_rng(12)
        points = rng.uniform([-0.10, -0.10, -0.22], [0.10, 0.12, 0.02], (100, 3))
        points = np.vstack([points, [[0.10, 0.17, -0.1]] * 40, [[0, 0.17, -0.1]] * 40])
        normals = np.tile([0, 1, 0], (180, 1)).astype(float)
        normals[100:140] = [1, 0, 0]
        source = rng.integers(0, 256, (180, 3), dtype=np.uint8)
        donor = rng.integers(12, 80, (64, 64, 3), dtype=np.uint8)
        result, weight, _ = blend_crown(source, donor, points, normals)
        np.testing.assert_array_equal(result[:140], source[:140])
        self.assertTrue(np.all(weight[:140] == 0))
        self.assertTrue(np.any(result[140:] != source[140:]))

    def test_crown_contains_detail_and_duplicate_seams_agree(self):
        x, z = np.meshgrid(np.linspace(-0.08, 0.08, 32), np.linspace(-0.18, -0.04, 32))
        points = np.column_stack([x.ravel(), np.full(x.size, 0.17), z.ravel()])
        points = np.vstack([points, points])
        normals = np.tile([0, 1, 0], (len(points), 1))
        source = np.tile([30, 27, 24], (len(points), 1)).astype(np.uint8)
        donor = np.random.default_rng(5).integers(12, 90, (96, 96, 3), dtype=np.uint8)
        result, _, _ = blend_crown(source, donor, points, normals)
        np.testing.assert_array_equal(result[: x.size], result[x.size :])
        self.assertGreater(result[:, 0].std(), 5)

    def test_replacing_image_preserves_all_existing_binary_buffers(self):
        mesh = trimesh.creation.icosphere(subdivisions=1)
        mesh.visual = trimesh.visual.TextureVisuals(
            uv=np.full((len(mesh.vertices), 2), 0.5),
            image=Image.new('RGB', (8, 8), (30, 25, 20)),
        )
        original = mesh.export(file_type='glb')
        png = io.BytesIO()
        Image.new('RGB', (8, 8), (40, 30, 20)).save(png, format='PNG')
        result = replace_base_color(original, png.getvalue())

        def unpack(data):
            size = struct.unpack_from('<I', data, 12)[0]
            doc = json.loads(data[20 : 20 + size])
            return doc, data[28 + size :]

        before, before_binary = unpack(original)
        after, after_binary = unpack(result)
        self.assertEqual(after_binary[: len(before_binary)], before_binary)
        for key in ('accessors', 'meshes', 'nodes', 'scenes', 'materials'):
            self.assertEqual(before[key], after[key])
        loaded = trimesh.load(
            io.BytesIO(result), file_type='glb', force='mesh', process=False
        )
        self.assertEqual(
            loaded.visual.material.baseColorTexture.getpixel((0, 0))[:3], (40, 30, 20)
        )


if __name__ == '__main__':
    unittest.main()
