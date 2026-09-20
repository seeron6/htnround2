"""Crown topology, protected regions and source-silhouette limits."""

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import trimesh
from PIL import Image
from scripts.crown_geometry import (
    complete_capture_crown_geometry,
    silhouette_limits,
    smooth_bounded_delta,
    subdivide_crown,
)
from scripts.prepare_object_capture_head import Camera


class CrownGeometryTests(unittest.TestCase):
    def test_adaptive_subdivision_closes_seams_and_preserves_lower_triangles(self):
        box = trimesh.creation.box(extents=[0.1, 0.12, 0.1])
        box.vertices[:, 1] += 0.15
        # Every triangle is a separate UV island, but shares geometric edges.
        vertices = box.vertices[box.faces].reshape(-1, 3)
        faces = np.arange(len(vertices)).reshape(-1, 3)
        uv = np.tile([[0.1, 0.1], [0.9, 0.1], [0.1, 0.9]], (len(faces), 1))
        source = Image.new('RGB', (8, 8), (52, 43, 35))
        mesh = trimesh.Trimesh(
            vertices,
            faces,
            process=False,
            visual=trimesh.visual.TextureVisuals(uv=uv, image=source),
        )
        result = subdivide_crown(mesh, 0.16, 0.02)
        self.assertGreater(len(result.faces), len(mesh.faces))
        np.testing.assert_array_equal(result.vertices[: len(vertices)], vertices)
        np.testing.assert_array_equal(result.visual.uv[: len(uv)], uv)
        lower = faces[np.max(vertices[faces, 1], axis=1) < 0.16]
        for face in lower:
            self.assertTrue(np.any(np.all(result.faces == face, axis=1)))
        result.merge_vertices(merge_tex=True, merge_norm=True)
        self.assertTrue(result.is_watertight)
        self.assertTrue(result.is_winding_consistent)
        self.assertAlmostEqual(result.volume, box.volume, places=10)

    def test_smoothing_never_moves_protected_points_or_exceeds_permitted_range(self):
        mesh = trimesh.creation.icosphere(subdivisions=2, radius=0.1)
        delta = np.sin(np.arange(len(mesh.vertices))) * 0.006
        delta[mesh.vertices[:, 1] < 0.03] = 0
        result = smooth_bounded_delta(mesh.vertices, mesh.faces, delta)
        np.testing.assert_array_equal(result[delta == 0], delta[delta == 0])
        self.assertTrue(np.all(result <= np.maximum(delta, 0)))
        self.assertTrue(np.all(result >= np.minimum(delta, 0)))
        self.assertTrue(np.isfinite(result).all())
        self.assertLess(np.linalg.norm(result), np.linalg.norm(delta))

    def test_vertical_proposals_are_limited_by_registered_alpha(self):
        pose = SimpleNamespace(
            rotation=SimpleNamespace(matrix=lambda: np.eye(3)), translation=np.zeros(3)
        )
        image = SimpleNamespace(
            name='frame.png', camera_id=0, cam_from_world=lambda: pose
        )
        camera = Camera([[100, 0, 16], [0, 100, 16], [0, 0, 1]], (32, 32), (32, 32))
        rec = SimpleNamespace(images={0: image}, cameras={0: camera})
        with tempfile.TemporaryDirectory() as temp:
            capture = Path(temp)
            (capture / 'images').mkdir()
            rgba = np.zeros((32, 32, 4), np.uint8)
            rgba[4:28, 4:28] = [90, 80, 70, 255]
            Image.fromarray(rgba).save(capture / 'images/frame.png')
            points = np.array([[0, 0.08, 1], [0, 0, 1], [0, -0.08, 1]])
            delta = np.array([0.15, 0, -0.15])
            result, audit = silhouette_limits(
                points, delta, capture, rec, np.zeros(3), np.eye(3), 1
            )
            self.assertEqual(result[1], 0)
            self.assertTrue(0 < result[0] < 0.04)
            self.assertTrue(-0.05 < result[2] < 0)
            self.assertEqual(audit['limitedVertices'], 2)
            self.assertEqual(audit['views'], 1)

    def test_incompatible_hair_is_exact_bypass(self):
        mesh = trimesh.creation.icosphere(subdivisions=1)
        result, audit = complete_capture_crown_geometry(
            mesh, None, None, None, None, None, None, {'hair': {'present': False}}
        )
        self.assertIs(result, mesh)
        self.assertFalse(audit['applied'])


if __name__ == '__main__':
    unittest.main()
