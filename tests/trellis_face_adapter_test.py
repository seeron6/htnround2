"""Adapter contracts only; these tests do not run pretrained neural inference."""

import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
import numpy as np
from PIL import Image
from scripts.trellis_face_adapter import (
    FaceConditionedFlow,
    ViewCondition,
    select_head_views,
    prepare_capture,
    specialize_pipeline,
    generate_geometry,
    fit_measured_landmarks,
)


def frame(name, yaw):
    return {'filename': name, 'yaw': yaw, 'landmarks': [{'x': 0.5, 'y': 0.5}]}


class ConditioningTests(unittest.TestCase):
    def setUp(self):
        self.frames = [
            frame('front.png', 0),
            frame('left.png', -55),
            frame('right.png', 55),
            frame('held.png', -60),
        ]
        self.allowed = ['front.png', 'left.png', 'right.png']

    def test_held_out_views_never_condition_the_network(self):
        result = select_head_views(self.frames, self.allowed)
        self.assertEqual([v['filename'] for v in result], self.allowed)
        np.testing.assert_allclose([v['weight'] for v in result], [0.4, 0.3, 0.3])

    def test_duplicate_frontal_frames_do_not_change_weights(self):
        frames = self.frames + [frame(f'extra{i}', 3) for i in range(60)]
        actual = select_head_views(
            frames, self.allowed + [f'extra{i}' for i in range(60)]
        )
        self.assertEqual(actual, select_head_views(self.frames, self.allowed))

    def test_untracked_unknown_angle_is_not_invented_as_rear(self):
        self.frames.append({'filename': 'unknown', 'landmarks': None, 'yaw': None})
        self.assertEqual(
            len(select_head_views(self.frames, self.allowed + ['unknown'])), 3
        )

    def test_registered_rear_adds_distinct_evidence(self):
        self.frames.append({'filename': 'rear', 'landmarks': None, 'cameraYaw': 179})
        result = select_head_views(self.frames, self.allowed + ['rear'])
        self.assertEqual(result[-1]['filename'], 'rear')
        self.assertAlmostEqual(sum(v['weight'] for v in result), 1)

    def test_missing_profile_and_nonfinite_angles_refused(self):
        for value in (None, float('nan'), float('inf'), True):
            frames = self.frames[:3]
            frames[1] = frame('left.png', value)
            with self.assertRaises(ValueError):
                select_head_views(frames, self.allowed)

    def test_private_bundle_has_exact_source_hashes_and_no_source_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / 'capture', Path(tmp) / 'experiment'
            (source / 'images').mkdir(parents=True)
            for name in self.allowed:
                image = Image.new('RGBA', (100, 100), (0, 0, 0, 0))
                image.paste((180, 130, 100, 255), (30, 20, 70, 90))
                image.save(source / 'images' / name)
            manifest = json.dumps({'frames': self.frames})
            (source / 'capture.json').write_text(manifest)
            result = prepare_capture(source, self.allowed, output)
            self.assertEqual((source / 'capture.json').read_text(), manifest)
            self.assertEqual(len(result['views']), 3)
            self.assertFalse(result['generatedGeometryIsMeasured'])
            self.assertTrue(all(len(v['sha256']) == 64 for v in result['views']))
            with self.assertRaises(FileExistsError):
                prepare_capture(source, self.allowed, output)
            with self.assertRaisesRegex(ValueError, 'outside'):
                prepare_capture(source, self.allowed, source / 'experiment')


class FlowTests(unittest.TestCase):
    def test_fuse_predictions_not_tokens_and_keep_same_latent(self):
        calls = []

        def model(x, t, cond, **kwargs):
            calls.append((x, t, cond, kwargs))
            return x + cond**2

        wrapped = FaceConditionedFlow(model)
        latent = np.array([5.0])
        result = wrapped(
            latent,
            0.5,
            ViewCondition((np.array([1.0]), np.array([3.0])), (0.25, 0.75)),
            concat_cond='geometry',
        )
        np.testing.assert_allclose(result, [12.0])
        self.assertNotAlmostEqual(result.item(), 5 + (0.25 * 1 + 0.75 * 3) ** 2)
        self.assertTrue(
            all(
                call[0] is latent and call[3]['concat_cond'] == 'geometry'
                for call in calls
            )
        )
        calls.clear()
        wrapped(latent, 0.5, np.array([0.0]))
        self.assertEqual(len(calls), 1)  # unconditional prediction remains single pass

    def test_bad_weights_fail_before_inference(self):
        for weights in ((0.2, 0.2), (float('nan'), 1.0), (-1.0, 2.0)):
            with self.assertRaises(ValueError):
                ViewCondition((1, 2), weights)

    def test_pipeline_restored_after_exception_without_class_patching(self):
        model = SimpleNamespace(in_channels=32)
        pipe = SimpleNamespace(models={'shape_slat_flow_model_512': model})
        with self.assertRaisesRegex(RuntimeError, 'failure'):
            with specialize_pipeline(pipe):
                self.assertEqual(
                    pipe.models['shape_slat_flow_model_512'].in_channels, 32
                )
                with self.assertRaises(ValueError):
                    with specialize_pipeline(pipe):
                        pass
                raise RuntimeError('failure')
        self.assertIs(pipe.models['shape_slat_flow_model_512'], model)

    def test_geometry_pipeline_uses_three_views_for_one_head_and_no_textures(self):
        class Pipeline:
            def __init__(self):
                self.models = {
                    'sparse_structure_flow_model': lambda x, t, c: x + c,
                    'shape_slat_flow_model_512': lambda x, t, c: x + c,
                }
                self.feature_calls = []

            def get_cond(self, images, resolution, include_neg_cond):
                self.feature_calls.append((images, resolution))
                return {'cond': np.array(images, float), 'neg_cond': np.zeros(1)}

            def sample_sparse_structure(self, cond, res, samples):
                assert samples == 1 and res == 32
                return self.models['sparse_structure_flow_model'](
                    np.zeros(1), 1.0, cond['cond']
                )

            def sample_shape_slat(self, cond, model, coords):
                return model(coords, 0.5, cond['cond'])

            def decode_shape_slat(self, latent, resolution):
                return [latent], []

        pipe = Pipeline()
        result, evidence = generate_geometry(pipe, [1, 2, 3], [0.4, 0.3, 0.3])
        np.testing.assert_allclose(result, [3.8])
        self.assertEqual(len(pipe.feature_calls), 3)
        self.assertFalse(evidence['textureDiffusionUsed'])
        self.assertTrue(evidence['requiresAlignmentAndMeasurementFit'])
        self.assertFalse(
            isinstance(pipe.models['sparse_structure_flow_model'], FaceConditionedFlow)
        )


class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.positions = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], float)
        self.faces = np.array([[0, 1, 2], [0, 2, 3]])
        self.binding = {
            'vertices': [[0, 1, 2], [0, 1, 2], [0, 2, 3]],
            'weights': [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        }

    def test_known_alignment_refines_measurements_preserving_topology(self):
        targets = self.positions[[0, 1, 3]] + [0, 0, 0.03]
        fitted, audit = fit_measured_landmarks(
            self.positions, self.faces, self.binding, targets
        )
        self.assertLess(audit['finalRms'], audit['initialRms'] * 0.001)
        self.assertEqual(audit['quality']['reversedTriangles'], 0)
        self.assertEqual(fitted.shape, self.positions.shape)
        np.testing.assert_array_equal(self.positions[:, 2], 0)

    def test_template_correspondences_cannot_be_reused_on_another_topology(self):
        self.binding['vertices'][0] = [0, 1, 3]
        with self.assertRaisesRegex(ValueError, 'does not belong'):
            fit_measured_landmarks(
                self.positions, self.faces, self.binding, self.positions[[0, 1, 3]]
            )

    def test_nonfinite_measurement_refused(self):
        targets = self.positions[[0, 1, 3]].copy()
        targets[0, 0] = float('nan')
        with self.assertRaisesRegex(ValueError, 'Invalid landmark'):
            fit_measured_landmarks(self.positions, self.faces, self.binding, targets)


if __name__ == '__main__':
    unittest.main()
