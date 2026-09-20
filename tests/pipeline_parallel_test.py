"""Exercise real pipeline scheduling through the first dependent shape stage."""

from contextlib import ExitStack
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from scripts import build_photo_face as build


class ShapeStageReached(Exception):
    pass


class ParallelSurfaceTests(unittest.TestCase):
    def run_to_shape(
        self, *, parallel=True, hair=True, hair_error=False, cloud_error=False
    ):
        template_ready = threading.Event()
        silhouette_started = threading.Event()
        silhouette_finished = threading.Event()
        advice_ready = threading.Event()
        received = {}
        points = np.zeros((468, 3))
        points[10] = [0, 0.1, 0]
        points[152] = [0, -0.1, 0]
        points[33] = [-0.035, 0.04, 0]
        points[263] = [0.035, 0.04, 0]
        points[1] = [0, 0.01, 0.03]
        template = np.arange(18, dtype=float).reshape(6, 3) / 100
        original = template.copy()
        triangles = np.array([[0, 1, 2], [3, 4, 5]])
        names = [f'{i}.png' for i in range(15)]
        rec = SimpleNamespace(
            images={
                i: SimpleNamespace(
                    name=name,
                    projection_center=lambda: np.array([0.1, 0, 0.3]),
                )
                for i, name in enumerate(names)
            }
        )

        def fit_template(*args):
            template_ready.set()
            return template, triangles, 1, {'earRegions': {}}

        def fit_hair(folder, vertices, *args):
            self.assertTrue(template_ready.is_set())
            silhouette_started.set()
            try:
                self.assertTrue(advice_ready.wait(3), 'AI and silhouette deadlocked')
                if hair_error:
                    raise ValueError('silhouette rejected')
                return vertices + 0.004, {'silhouetteViews': 12}
            finally:
                silhouette_finished.set()

        def complete(*args):
            if parallel:
                self.assertTrue(
                    silhouette_started.wait(3), 'Silhouette did not overlap the AI wait'
                )
            else:
                self.assertFalse(silhouette_started.is_set())
            advice_ready.set()
            if cloud_error:
                raise ValueError('cloud failed')
            return {
                'hair': {'present': hair},
                'glasses': {'present': False},
                'model': 'test',
                'framesSent': 15,
                'unobservedParts': [],
                'version': 1,
            }

        def shape(vertices, *args):
            received['positions'] = vertices.copy()
            raise ShapeStageReached()

        eyes = dict.fromkeys(
            ['summary', 'model', 'geometryEstimated', 'generationMethod', 'apiError']
        )
        eyes['eyes'] = {}
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            folder = Path(temp)
            output = folder / 'stage'
            output.mkdir()
            (folder / 'capture.json').write_text(
                json.dumps(
                    {
                        'captureRegion': 'head',
                        'frames': [
                            {'filename': name, 'yaw': i - 7, 'landmarks': [{'x': 0.5}]}
                            for i, name in enumerate(names)
                        ],
                    }
                )
            )
            stack.enter_context(
                patch.dict(
                    os.environ,
                    {
                        'CONTACT_PARALLEL_LOCAL': '1' if parallel else '0',
                    },
                )
            )
            replacements = {
                'recover': lambda *args: (rec, {}),
                'camera_rays': lambda *args: (),
                'robust_landmarks': lambda *args: (points, None),
                'projection_error': lambda *args: {'medianPx': 0, 'p95Px': 0},
                'fit_selected_template': fit_template,
                'fit_template_hair': fit_hair,
                'complete': complete,
                'recognize_hair': lambda *args: {},
                'hair_completion': lambda advice, _: advice,
                'scan_eyes': lambda *args: eyes,
                'apply_shape_prior': shape,
            }
            for name, value in replacements.items():
                stack.enter_context(patch.object(build, name, value))
            stack.enter_context(
                patch('scripts.head_semantics.analyze', return_value=None)
            )
            stack.enter_context(
                patch('scripts.ear_fit.triangulate_ears', return_value={})
            )
            expected = (
                'cloud failed'
                if cloud_error
                else 'silhouette rejected' if hair and hair_error else None
            )
            if expected:
                with self.assertRaisesRegex(ValueError, expected):
                    build._run(folder, True, SimpleNamespace(stage=output))
            else:
                with self.assertRaises(ShapeStageReached):
                    build._run(folder, True, SimpleNamespace(stage=output))
            if parallel:
                self.assertTrue(
                    silhouette_finished.is_set(), 'Worker outlived pipeline failure'
                )
            np.testing.assert_array_equal(template, original)
            return received.get('positions'), original

    def test_overlap_retains_the_same_surface_as_serial(self):
        parallel, original = self.run_to_shape()
        serial, _ = self.run_to_shape(parallel=False)
        np.testing.assert_array_equal(parallel, serial)
        np.testing.assert_array_equal(parallel, original + 0.004)

    def test_bald_advice_discards_a_completed_silhouette(self):
        positions, original = self.run_to_shape(hair=False)
        np.testing.assert_array_equal(positions, original)

    def test_bald_advice_does_not_raise_an_irrelevant_silhouette_error(self):
        positions, original = self.run_to_shape(hair=False, hair_error=True)
        np.testing.assert_array_equal(positions, original)

    def test_selected_silhouette_errors_remain_fatal(self):
        positions, _ = self.run_to_shape(hair_error=True)
        self.assertIsNone(positions)

    def test_cloud_failure_joins_the_speculative_worker_before_returning(self):
        positions, _ = self.run_to_shape(cloud_error=True)
        self.assertIsNone(positions)


if __name__ == '__main__':
    unittest.main()
