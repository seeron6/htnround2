"""Automatic crown completion preserves evidence and adapts to each capture."""

from copy import deepcopy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image

from scripts.crown_capture import photo_opportunity
from scripts.crown_material import complete_crown


class CrownPipelineTests(unittest.TestCase):
    def fixture(self):
        xx, zz = np.meshgrid(
            np.linspace(-0.09, 0.09, 32), np.linspace(-0.20, -0.02, 32)
        )
        points = np.c_[xx.ravel(), np.full(xx.size, 0.17), zz.ravel()]
        landmarks = np.zeros((468, 3))
        landmarks[10, 1], landmarks[152, 1] = 0.1, -0.1
        vertices = np.vstack([points, landmarks])
        return dict(
            color=np.tile([0.14, 0.12, 0.10], (len(points), 1)),
            points=points,
            normals=np.tile([0, 1, 0], (len(points), 1)),
            vertices=vertices,
            landmarks=landmarks,
            completion={
                'hair': {
                    'present': True,
                    'type': 'wavy',
                    'confidence': 0.9,
                    'density': 0.9,
                    'lengthMm': 80,
                    'flowDegrees': 15,
                }
            },
            scalp=np.ones(len(points)),
            support=np.zeros(len(points)),
            preserve=np.zeros(len(points), bool),
        )

    def test_missing_crown_completes_without_changing_inputs(self):
        inputs = self.fixture()
        before = deepcopy(inputs)
        result, audit = complete_crown(**inputs)
        self.assertTrue(audit['applied'])
        self.assertGreater(np.std(result[:, 0]), 0.01)
        self.assertEqual(audit['protectedPhotographedTexels'], 0)
        for key, value in inputs.items():
            if isinstance(value, np.ndarray):
                np.testing.assert_array_equal(value, before[key])

    def test_trusted_photos_and_semantic_skin_ears_cleanup_stay_exact(self):
        inputs = self.fixture()
        inputs['support'][:200] = 0.12
        inputs['scalp'][200:400] = 0
        inputs['preserve'][400:600] = True
        inputs['points'][600:700, 1] = 0.1  # Forehead.
        result, audit = complete_crown(**inputs)
        self.assertTrue(audit['applied'])
        np.testing.assert_array_equal(result[:700], inputs['color'][:700])
        self.assertEqual(audit['protectedPhotographedTexels'], 200)

    def test_adequately_photographed_crown_is_an_exact_noop(self):
        inputs = self.fixture()
        inputs['support'][:] = 0.20
        result, audit = complete_crown(**inputs)
        self.assertFalse(audit['applied'])
        np.testing.assert_array_equal(result, inputs['color'])

    def test_bald_unknown_sparse_and_incompatible_styles_are_not_overpainted(self):
        for patch in [
            None,
            {'present': False},
            {'type': 'bald'},
            {'type': 'straight'},
            {'type': 'curly'},
            {'type': 'coily'},
            {'type': 'braided'},
            {'type': 'locs'},
            {'confidence': 0.2},
            {'density': 0.2},
            {'lengthMm': 5},
            {'lengthMm': 200},
        ]:
            with self.subTest(patch=patch):
                inputs = self.fixture()
                if patch is None:
                    inputs['completion'] = None
                else:
                    inputs['completion']['hair'].update(patch)
                result, audit = complete_crown(**inputs)
                self.assertFalse(audit['applied'])
                np.testing.assert_array_equal(result, inputs['color'])

    def test_projection_tracks_head_scale_position_and_width(self):
        inputs = self.fixture()
        original, _ = complete_crown(**inputs)
        # Same proportions after coordinate scale and translation, plus wider
        # skull. A hardcoded one-model crop would shift or stretch the strands.
        scale = np.array([2.2, 1.7, 1.7])
        for key in ('points', 'vertices', 'landmarks'):
            inputs[key] = inputs[key] * scale + [0.3, 0.4, -0.6]
        adjusted, _ = complete_crown(**inputs)
        np.testing.assert_allclose(original, adjusted, atol=1e-12)

    def test_captured_hair_color_and_recognized_flow_drive_result(self):
        inputs = self.fixture()
        inputs['color'][:] = [0.7, 0.6, 0.4]
        inputs['support'][:100] = 0.2
        result, audit = complete_crown(**inputs)
        np.testing.assert_allclose(audit['captureMedianSrgb'], [0.7, 0.6, 0.4])
        self.assertGreater(np.median(result[:, 0]), 0.6)
        self.assertEqual(audit['colorSource'], 'Supported captured upper hair')
        inputs['completion']['hair']['flowDegrees'] = -40
        other, _ = complete_crown(**inputs)
        self.assertGreater(np.mean(abs(result[100:] - other[100:])), 0.03)
        np.testing.assert_array_equal(other[:100], inputs['color'][:100])

    def test_missing_asset_retains_existing_fallback_without_failing_build(self):
        inputs = self.fixture()
        with tempfile.TemporaryDirectory() as folder:
            inputs['donor_path'] = Path(folder) / 'not-installed.png'
            result, audit = complete_crown(**inputs)
        self.assertFalse(audit['applied'])
        np.testing.assert_array_equal(result, inputs['color'])

    def test_capture_support_respects_source_alpha_and_camera_facing(self):
        from scripts.prepare_object_capture_head import Camera

        camera = Camera([[20, 0, 16], [0, 20, 16], [0, 0, 1]], (32, 32), (32, 32))
        pose = SimpleNamespace(
            rotation=SimpleNamespace(matrix=lambda: np.eye(3)), translation=np.zeros(3)
        )
        image = SimpleNamespace(
            name='frame.png',
            camera_id=1,
            projection_center=lambda: np.zeros(3),
            cam_from_world=lambda: pose,
        )
        rec = SimpleNamespace(cameras={1: camera}, images={1: image})
        points = np.array([[-0.3, 0, 1], [0, 0, 1], [0.3, 0, 1]])
        normals = np.array([[0, 0, -1], [0, 0, -1], [0, 0, 1]])
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            (folder / 'images').mkdir()
            rgba = np.full((32, 32, 4), 255, np.uint8)
            rgba[14:19, 14:19, 3] = 0
            Image.fromarray(rgba).save(folder / 'images/frame.png')
            support, views = photo_opportunity(
                points, normals, rec, folder, np.zeros(3), np.eye(3), 1
            )
        self.assertEqual(views, 1)
        self.assertGreater(support[0], 0.8)
        self.assertEqual(support[1], 0)  # Masked background cannot protect hair.
        self.assertEqual(support[2], 0)  # Back-facing camera cannot observe hair.


if __name__ == '__main__':
    unittest.main()
