"""Central facial features and separate surface parts keep their own appearance."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from scripts.camera_texture import CameraTexture, lower_lateral_region


class CameraTextureTests(unittest.TestCase):
    def test_reblend_reuses_exact_accepted_colors_without_reprojecting(self):
        # A boundary sample accepted in the first pass must never be sampled
        # again against differently rounded projection/mask coordinates.
        count = 64
        vertices = np.zeros((468, 3))
        vertices[0, 0], vertices[2, 0] = -0.1, 0.1
        vertices[17, 1], vertices[152, 1] = -0.05, -0.1
        faces = np.array([[0, 1, 2]])
        points = np.tile([0.09, -0.03, 0.0], (count, 1))
        binding = {
            'triangles': faces,
            'triangleIds': np.zeros(count, dtype=int),
            'weights': np.tile([1.0, 0.0, 0.0], (count, 1)),
        }
        views = [
            SimpleNamespace(name='front'),
            SimpleNamespace(name='side'),
            SimpleNamespace(name='occluded'),
        ]
        ownership = CameraTexture(
            vertices, faces, points, np.zeros(count), np.zeros(468), binding, views
        )
        near = np.arange(count)
        red = np.tile([0.31, 0.12, 0.08], (count, 1))
        blue = np.tile([0.11, 0.17, 0.41], (count, 1))
        weight = np.ones(count)
        side_weight = weight.copy()
        side_weight[0] = 0  # Rejected source colors must never contribute.
        ownership.observe(views[0], near, weight, red)
        ownership.observe(views[1], near, side_weight, blue * side_weight[:, None])
        # A third camera is rejected even on texels whose other weights change.
        ownership.observe(views[2], near, np.zeros(count), np.zeros_like(red))
        # Simulate the smoother preferring front, while retaining its support
        # rule; this test isolates the color reuse from the diffusion solver.
        revised = np.tile([0.75, 0.25, 0], (count, 1))
        revised[0] = [1, 0, 0]
        with (
            patch(
                'scripts.head_material.photographed_scalp_region',
                return_value=np.zeros(count),
            ),
            patch(
                'scripts.camera_ownership.fit_camera_ownership_delta',
            return_value=(np.zeros((468, 3)), {}),
            ),
            patch(
                'scripts.camera_ownership.apply_camera_ownership_delta',
                return_value=(revised, {}),
            ),
        ):
            selected, colors, audit = ownership.reblend(
                views,
                np.ones(count),
                np.zeros(count),
                np.zeros(count),
                np.ones(count),
                np.zeros(count),
            )
        np.testing.assert_array_equal(selected, np.arange(1, count))
        np.testing.assert_array_equal(colors, (red * 0.75 + blue * 0.25)[1:])
        self.assertEqual(audit['projectionPasses'], 1)
        self.assertTrue(audit['physicalSupportUnchanged'])
        self.assertFalse(ownership.colors)

    def test_central_features_and_separate_parts_are_excluded(self):
        face = np.zeros((468, 3))
        face[0, 0] = -0.1
        face[1] = [0, 0, 0]
        face[2, 0] = 0.1
        face[17, 1] = -0.05
        face[152, 1] = -0.1
        points = np.array(
            [
                [0, 0, 0],
                [0, -0.05, 0],
                [0.09, 0.05, 0],
                [0.09, -0.03, 0],
                [0.09, -0.03, 0],
            ]
        )
        result = lower_lateral_region(points, face, np.array([0, 0, 0, 0, 3]))
        np.testing.assert_array_equal(result[[0, 1, 2, 4]], 0)
        self.assertGreater(result[3], 0.99)


if __name__ == '__main__':
    unittest.main()
