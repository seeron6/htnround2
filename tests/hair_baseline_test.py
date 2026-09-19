"""A hair refit must survive reconstruction from the saved pre-ear surface."""

import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from scripts.rebuild_hair import update_refit_baseline


class HairBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.stage = Path(self.temp.name)
        self.old = np.zeros((471, 3), dtype=np.float32)
        self.old[468] = [0.01, 0.02, 0.03]  # Scalp.
        self.old[469] = [0.04, 0.05, 0.06]  # Fitted ear.
        self.old[470] = [0.03, 0.01, 0.02]  # Protected observed skin.
        self.faces = np.array([[0, 1, 470], [468, 469, 470]])
        self.rest = self.old.astype(np.float64)
        self.rest[469, 0] -= 0.012  # Pre-ear geometry must remain unfitted.
        self.rest[468, 2] += 1e-11  # Preserve existing baseline precision.
        self.before = {
            'positions': self.old.ravel().tolist(),
            'indices': self.faces.ravel().tolist(),
            'stats': {
                'observedFaceTriangles': 1,
                'templateFit': {
                    'regularization': 0.01,
                    'earRegions': {'1': {'vertices': [469]}},
                },
            },
        }
        (self.stage / 'physics-cage.json').write_text(
            json.dumps({'positions': self.old[:468].ravel().tolist()})
        )
        self.write_baseline()

    def write_baseline(self, positions=None, regularization=0.01):
        np.savez_compressed(
            self.stage / 'pre-ear-surface.npz',
            positions=self.rest if positions is None else positions,
            indices=self.faces,
            regularization=regularization,
            captureHash='original-capture',
            extraMetadata=np.array([3, 7]),
        )

    def after(self, new):
        return {**self.before, 'positions': new.astype(np.float32).ravel().tolist()}

    def test_refit_delta_survives_ear_rebuild_without_double_fitting_ears(self):
        new = self.old.copy()
        new[468] += [0.007, -0.009, 0.011]
        update_refit_baseline(self.stage, self.before, self.after(new))
        with np.load(self.stage / 'pre-ear-surface.npz', allow_pickle=False) as saved:
            delta = new.astype(float) - self.old.astype(float)
            np.testing.assert_array_equal(saved['positions'], self.rest + delta)
            np.testing.assert_array_equal(saved['positions'][469], self.rest[469])
            np.testing.assert_array_equal(saved['positions'][:468], self.rest[:468])
            np.testing.assert_array_equal(saved['indices'], self.faces)
            self.assertEqual(str(saved['captureHash']), 'original-capture')
            self.assertEqual(float(saved['regularization']), 0.01)
            np.testing.assert_array_equal(saved['extraMetadata'], [3, 7])
            # Refit only the ear, as the next detail pass does: scalp stays new.
            next_ear_surface = saved['positions'].copy()
            next_ear_surface[469] = self.old[469]
            np.testing.assert_array_equal(
                next_ear_surface[468].astype(np.float32), new[468]
            )
        # A repeated zero-displacement hair pass must not accumulate growth.
        baseline = (self.stage / 'pre-ear-surface.npz').read_bytes()
        update_refit_baseline(self.stage, self.after(new), self.after(new))
        self.assertEqual((self.stage / 'pre-ear-surface.npz').read_bytes(), baseline)

    def test_protected_cage_ear_and_observed_skin_movement_rejected(self):
        original = (self.stage / 'pre-ear-surface.npz').read_bytes()
        for vertex in (0, 469, 470):
            new = self.old.copy()
            new[vertex, 0] += 0.001
            with (
                self.subTest(vertex=vertex),
                self.assertRaisesRegex(ValueError, 'protected'),
            ):
                update_refit_baseline(self.stage, self.before, self.after(new))
            self.assertEqual(
                (self.stage / 'pre-ear-surface.npz').read_bytes(), original
            )

    def test_missing_stale_and_incompatible_baselines_rejected(self):
        path = self.stage / 'pre-ear-surface.npz'
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'requires'):
            update_refit_baseline(self.stage, self.before, self.before)
        self.write_baseline(regularization=0.025)
        with self.assertRaisesRegex(ValueError, 'identity fit'):
            update_refit_baseline(self.stage, self.before, self.before)
        stale = self.rest.copy()
        stale[0, 0] += 0.01
        self.write_baseline(stale)
        with self.assertRaisesRegex(ValueError, 'current facial surface'):
            update_refit_baseline(self.stage, self.before, self.before)

    def add_contour_snapshot(self):
        from scripts.ear_contour_rest import contour_rest_fields

        self.measurements = {
            '1': {'landmarks': {'top': [0.04, 0.05, 0.06]}, 'views': 2}
        }
        self.contour_rest = self.old.copy()
        self.contour_rest[469, 2] -= 0.002  # Separate post-ear/pre-contour stage.
        path = self.stage / 'pre-ear-surface.npz'
        with np.load(path, allow_pickle=False) as saved:
            payload = {key: saved[key].copy() for key in saved.files}
        self.contour_fields = contour_rest_fields(
            self.contour_rest, self.faces, self.measurements
        )
        np.savez_compressed(path, **payload, **self.contour_fields)
        (self.stage / 'ear-measurements.json').write_text(json.dumps(self.measurements))

    def test_refit_transports_both_independent_stage_inputs_with_unchanged_measurement_digest(
        self,
    ):
        from scripts.ear_contour_rest import load_contour_rest

        self.add_contour_snapshot()
        new = self.old.copy()
        new[468] += [0.007, -0.009, 0.011]
        update_refit_baseline(self.stage, self.before, self.after(new))
        delta = new.astype(float) - self.old.astype(float)
        with np.load(self.stage / 'pre-ear-surface.npz', allow_pickle=False) as saved:
            np.testing.assert_array_equal(saved['positions'], self.rest + delta)
            expected = (self.contour_rest.astype(float) + delta).astype(np.float32)
            loaded = load_contour_rest(saved, new, self.faces, 1, self.measurements)
            np.testing.assert_array_equal(loaded, expected)
            np.testing.assert_array_equal(
                loaded[[469, 470]], self.contour_rest[[469, 470]]
            )
            np.testing.assert_array_equal(loaded[:468], self.old[:468])
            self.assertEqual(
                str(saved['contourRestMeasurementsSha256']),
                self.contour_fields['contourRestMeasurementsSha256'],
            )
            self.assertEqual(
                str(saved['contourRestTopologySha256']),
                self.contour_fields['contourRestTopologySha256'],
            )
            self.assertNotEqual(
                str(saved['contourRestPositionsSha256']),
                self.contour_fields['contourRestPositionsSha256'],
            )
            self.assertEqual(str(saved['captureHash']), 'original-capture')
            np.testing.assert_array_equal(saved['extraMetadata'], [3, 7])
        previous = (self.stage / 'pre-ear-surface.npz').read_bytes()
        update_refit_baseline(self.stage, self.after(new), self.after(new))
        self.assertEqual((self.stage / 'pre-ear-surface.npz').read_bytes(), previous)

    def test_contour_transport_rejects_missing_or_changed_measurements_without_writing(
        self,
    ):
        self.add_contour_snapshot()
        baseline = self.stage / 'pre-ear-surface.npz'
        original = baseline.read_bytes()
        path = self.stage / 'ear-measurements.json'
        new = self.old.copy()
        new[468, 0] += 0.001
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'measurements'):
            update_refit_baseline(self.stage, self.before, self.after(new))
        self.assertEqual(baseline.read_bytes(), original)
        changed = {'1': {'landmarks': {'top': [0.041, 0.05, 0.06]}, 'views': 2}}
        path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, 'observations changed'):
            update_refit_baseline(self.stage, self.before, self.after(new))
        self.assertEqual(baseline.read_bytes(), original)

    def test_partial_contour_snapshot_is_not_silently_left_on_old_surface(self):
        self.add_contour_snapshot()
        path = self.stage / 'pre-ear-surface.npz'
        with np.load(path, allow_pickle=False) as saved:
            payload = {
                key: saved[key].copy()
                for key in saved.files
                if key != 'contourRestPositions'
            }
        np.savez_compressed(path, **payload)
        original = path.read_bytes()
        new = self.old.copy()
        new[468, 0] += 0.001
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            update_refit_baseline(self.stage, self.before, self.after(new))
        self.assertEqual(path.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
