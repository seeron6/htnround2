"""Rebuilding a head must retain the source-measured accessory detail."""

import ast
import copy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image

from scripts.fitted_eyewear import fit_photo_glasses


class FittedEyewearTests(unittest.TestCase):
    def invoke(self, folder, advice, rec=None):
        return fit_photo_glasses(
            folder,
            np.zeros((468, 3)),
            advice,
            rec,
            {},
            np.zeros(3),
            np.eye(3),
            {'scale': 1.0},
        )

    def test_absent_advice_or_glasses_never_requests_detail_pixels(self):
        with patch('scripts.fitted_eyewear.build_glasses', return_value=None) as build:
            with patch('scripts.fitted_eyewear.refine_glasses_detail') as refine:
                self.assertIsNone(self.invoke(Path('/unused'), None))
                build.assert_not_called()
                self.assertIsNone(
                    self.invoke(Path('/unused'), {'glasses': {'present': False}})
                )
                refine.assert_not_called()

    def test_rebuild_returns_real_pixel_measurements_and_keeps_input_immutable(self):
        # Camera pixels are half native resolution. The synthetic dark rims are
        # six native pixels wide against light skin, with known metric scale.
        focal, side = 700.0, 512
        project = (
            lambda p: np.asarray(p)[:, :2] / np.asarray(p)[:, 2:] * focal + side / 2
        )
        camera = SimpleNamespace(
            width=side,
            height=side,
            img_from_cam=project,
            cam_from_img=lambda xy: (np.asarray(xy) - side / 2) / focal,
        )
        pose = SimpleNamespace(
            rotation=SimpleNamespace(matrix=lambda: np.eye(3)),
            translation=np.array([0, 0, 0.5]),
        )
        im = SimpleNamespace(
            name='front.png',
            camera_id=1,
            cam_from_world=lambda: pose,
            projection_center=lambda: np.array([0, 0, -0.5]),
        )
        rec = SimpleNamespace(images={1: im}, cameras={1: camera})
        angle = np.arange(32) * (2 * np.pi / 32)
        rims = [
            np.c_[x + 0.023 * np.cos(angle), 0.022 * np.sin(angle), np.full(32, 0.01)]
            for x in [-0.032, 0.032]
        ]
        spec = {
            'version': 2,
            'rims': [p.tolist() for p in rims],
            'radius': 0.002,
            'frameColor': [0.08, 0.06, 0.04],
        }
        original = copy.deepcopy(spec)
        paths = [project(p + pose.translation) for p in rims]
        advice = {
            'frontFilename': im.name,
            'glasses': {
                'description': 'Dark acetate with pale metal accents',
                'frameColorSrgb': [0.08, 0.06, 0.04],
            },
            'views': [
                {
                    'filename': im.name,
                    'imageLeftLens': (paths[0] / side).tolist(),
                    'imageRightLens': (paths[1] / side).tolist(),
                }
            ],
            'crops': {im.name: [0, 0, side, side]},
        }
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / 'images').mkdir()
            (folder / 'detail-images').mkdir()
            pixels = np.full((side * 2, side * 2, 4), [210, 170, 145, 255], np.uint8)
            for xy in paths:
                cv2.polylines(
                    pixels,
                    [np.rint(xy * 2).astype(np.int32)],
                    True,
                    (20, 15, 10, 255),
                    6,
                )
            Image.fromarray(pixels).save(folder / 'detail-images' / im.name)
            Image.fromarray(pixels).resize((side, side), Image.Resampling.BOX).save(
                folder / 'images' / im.name
            )
            with patch('scripts.fitted_eyewear.build_glasses', return_value=spec):
                result = self.invoke(folder, advice, rec)
                repeated = self.invoke(folder, advice, rec)
        self.assertEqual(spec, original)
        self.assertEqual(result, repeated)
        self.assertEqual(result['version'], 3)
        self.assertGreater(min(result['detailEvidence']['acceptedWidthSamples']), 35)
        for widths in result['rimWidths']:
            self.assertEqual(len(widths), 48)
            self.assertTrue(0.0018 < np.median(widths) < 0.003)
        self.assertEqual(len(result['rims'][0]), 48)
        self.assertIn('templeAccent', result)
        self.assertIn('Opaque photo', result['colorSource'])
        np.testing.assert_allclose(
            result['frameColor'], [20 / 255, 15 / 255, 10 / 255], atol=0.02
        )

    def test_both_pipeline_entrypoints_use_the_shared_fitter(self):
        root = Path(__file__).resolve().parents[1]
        for name in ['build_photo_face.py', 'rebuild_head_details.py']:
            tree = ast.parse((root / 'scripts' / name).read_text())
            calls = [
                n.func.id
                for n in ast.walk(tree)
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
            ]
            self.assertIn('fit_photo_glasses', calls, name)
            self.assertNotIn('build_glasses', calls, name)


if __name__ == '__main__':
    unittest.main()
