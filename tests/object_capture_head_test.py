"""Coordinate, seam and closure regressions for the local head candidate."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import trimesh
from PIL import Image
from scipy.spatial.transform import Rotation
from scripts.prepare_object_capture_head import (
    Camera,
    CaptureImage,
    regularize_volume,
    close_neck,
)


class LocalHeadTests(unittest.TestCase):
    def test_apple_camera_basis_projects_forward_and_preserves_pixel_axes(self):
        rotation = Rotation.from_euler('xyz', [0.1, 0.3, -0.2])
        center = np.array([0.4, -0.2, 0.8])
        image = CaptureImage(
            {
                'id': 0,
                'filename': 'frame.png',
                'translation': center.tolist(),
                'quaternion': rotation.as_quat().tolist(),
            }
        )
        # Apple camera coordinates have +Y up and look along -Z.
        points = (
            np.array([[0.1, 0.2, -2], [-0.3, -0.1, -1]]) @ rotation.as_matrix().T
            + center
        )
        pose = image.cam_from_world()
        cv = points @ pose.rotation.matrix().T + pose.translation
        np.testing.assert_allclose(cv, [[0.1, -0.2, 2], [-0.3, 0.1, 1]], atol=1e-12)
        camera = Camera(
            [[1200, 0, 540], [0, 1250, 960], [0, 0, 1]], (540, 960), (1080, 1920)
        )
        pixels = camera.img_from_cam(cv)
        np.testing.assert_allclose(pixels, [[300, 417.5], [90, 542.5]])
        np.testing.assert_allclose(
            camera.cam_from_img(pixels), cv[:, :2] / cv[:, 2, None]
        )

    def test_shape_prior_keeps_central_face_and_duplicate_seams_exact(self):
        m = trimesh.creation.icosphere(subdivisions=2, radius=1)
        p = m.vertices * np.array([0.11, 0.17, 0.14]) + [0, 0.035, -0.115]
        original = np.vstack([p, p[[0, 2, 8]], [[0, 0.04, 0.025], [0.025, -0.06, 0]]])
        result = regularize_volume(original, m.faces)
        np.testing.assert_array_equal(result[-2:], original[-2:])
        np.testing.assert_array_equal(result[len(p) : len(p) + 3], result[[0, 2, 8]])
        self.assertTrue(np.isfinite(result).all())
        self.assertLess(result[:, 2].ptp(), original[:, 2].ptp())

    def test_neck_closure_is_watertight_and_uses_separate_texture_space(self):
        mesh = trimesh.creation.icosphere(subdivisions=3, radius=1)
        mesh.vertices = mesh.vertices * np.array([0.105, 0.16, 0.13]) + [
            0,
            0.035,
            -0.12,
        ]
        uv = np.column_stack(
            [
                np.linspace(0.1, 0.9, len(mesh.vertices)),
                np.full(len(mesh.vertices), 0.5),
            ]
        )
        source = Image.new('RGB', (256, 256), (170, 123, 97))
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv, image=source)
        result, audit = close_neck(mesh)
        self.assertTrue(audit['applied'])
        self.assertGreater(audit['triangles'], 0)
        self.assertTrue(np.isfinite(result.visual.uv).all())
        self.assertTrue(((result.visual.uv >= 0) & (result.visual.uv <= 1)).all())
        image = np.asarray(result.visual.material.baseColorTexture)
        np.testing.assert_array_equal(image[:, :256], np.asarray(source))
        result.merge_vertices(merge_tex=True, merge_norm=True)
        self.assertTrue(result.is_watertight)
        self.assertTrue(result.is_winding_consistent)


if __name__ == '__main__':
    unittest.main()
