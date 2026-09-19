"""Immutable contour-stage snapshots are independent of pre-ear regularization."""

import copy
import io
import unittest
import numpy as np
from scripts.ear_contour_rest import contour_rest_fields, load_contour_rest


class EarContourRestTests(unittest.TestCase):
    def fixture(self):
        points = np.zeros((472, 3), np.float32)
        points[468:] = [[0, 0, 0], [0.02, 0, 0], [0, 0.02, 0], [0.02, 0.02, 0.004]]
        faces = np.array([[468, 469, 470], [469, 471, 470]], np.int64)
        measurements = {
            '-1': {
                'landmarks': {
                    'top': [0.07, 0.02, -0.08],
                    'bottom': [0.06, -0.02, -0.08],
                },
                'audit': {'views': 2, 'confidence': 0.9},
            }
        }
        return points, faces, measurements

    def test_npz_roundtrip_preserves_independent_baseline_and_returns_detached_rest(
        self,
    ):
        p, f, m = self.fixture()
        independent = p.astype(float)
        independent[471, 2] -= 0.003
        fields = contour_rest_fields(p, f, m)
        buffer = io.BytesIO()
        np.savez_compressed(buffer, positions=independent, indices=f, **fields)
        buffer.seek(0)
        with np.load(buffer, allow_pickle=False) as saved:
            reference = p.copy()
            reference[471, 0] += 0.002  # Accepted contour can differ here.
            result = load_contour_rest(saved, reference, f, 1, m)
            np.testing.assert_array_equal(result, p)
            np.testing.assert_array_equal(saved['positions'], independent)
            result[471, 2] += 1
            np.testing.assert_array_equal(saved['contourRestPositions'], p)

    def test_snapshot_creation_detaches_canonical_float32_input(self):
        p, f, m = self.fixture()
        before = p.copy()
        fields = contour_rest_fields(p, f, m)
        p[471, 0] += 0.003
        np.testing.assert_array_equal(fields['contourRestPositions'], before)
        loaded = load_contour_rest(fields, before, f, 1, m)
        np.testing.assert_array_equal(loaded, before)

    def test_creation_canonicalizes_positions_but_load_rejects_extra_precision(self):
        p, f, m = self.fixture()
        p = p.astype(float)
        p[471, 0] += 0.000000000001
        fields = contour_rest_fields(p, f, m)
        self.assertEqual(fields['contourRestPositions'].dtype, np.float32)
        np.testing.assert_array_equal(
            load_contour_rest(fields, p, f, 1, m), p.astype(np.float32)
        )
        fields['contourRestPositions'] = fields['contourRestPositions'].astype(float)
        fields['contourRestPositions'][471, 0] += 0.000000000001
        # Float32 hash still matches: explicit canonical-value validation must reject.
        with self.assertRaises(ValueError):
            load_contour_rest(fields, p, f, 1, m)

    def test_legacy_without_snapshot_returns_none_but_partial_snapshot_rejected(self):
        p, f, m = self.fixture()
        self.assertIsNone(load_contour_rest({'positions': p, 'indices': f}, p, f, 1, m))
        complete = contour_rest_fields(p, f, m)
        for key in complete:
            partial = copy.deepcopy(complete)
            partial.pop(key)
            with self.subTest(missing=key), self.assertRaises(ValueError):
                load_contour_rest(partial, p, f, 1, m)

    def test_each_hash_and_rest_payload_tampering_rejected(self):
        p, f, m = self.fixture()
        fields = contour_rest_fields(p, f, m)
        for key in fields:
            changed = copy.deepcopy(fields)
            if key == 'contourRestPositions':
                changed[key][471, 2] += 0.001
            else:
                changed[key] = '0' * 64
            with self.subTest(field=key), self.assertRaises(ValueError):
                load_contour_rest(changed, p, f, 1, m)

    def test_topology_identity_not_only_vertex_count_is_required(self):
        p, f, m = self.fixture()
        fields = contour_rest_fields(p, f, m)
        for changed in (
            f[::-1],
            f[:, ::-1],
            np.array([[468, 469, 470], [468, 471, 470]]),
        ):
            with self.assertRaises(ValueError):
                load_contour_rest(fields, p, changed, 1, m)

    def test_measurement_key_order_is_canonical_but_values_are_bound(self):
        p, f, m = self.fixture()
        fields = contour_rest_fields(p, f, m)
        reordered = {
            '-1': {
                'audit': {'confidence': 0.9, 'views': 2},
                'landmarks': {
                    'bottom': [0.06, -0.02, -0.08],
                    'top': [0.07, 0.02, -0.08],
                },
            }
        }
        np.testing.assert_array_equal(load_contour_rest(fields, p, f, 1, reordered), p)
        changed = copy.deepcopy(m)
        changed['-1']['landmarks']['top'][0] += 0.0001
        with self.assertRaises(ValueError):
            load_contour_rest(fields, p, f, 1, changed)

    def test_protected_cage_and_observed_face_must_match_but_free_ear_may_differ(self):
        p, f, m = self.fixture()
        fields = contour_rest_fields(p, f, m)
        for vertex in (0, 467, 468, 469, 470):
            ref = p.copy()
            ref[vertex, 0] += 0.0001
            with self.subTest(vertex=vertex), self.assertRaises(ValueError):
                load_contour_rest(fields, ref, f, 1, m)
        ref = p.copy()
        ref[471, 0] += 0.01
        np.testing.assert_array_equal(load_contour_rest(fields, ref, f, 1, m), p)

    def test_malformed_positions_and_topology_rejected(self):
        p, f, m = self.fixture()
        for bad in (p.ravel(), np.full_like(p, np.nan)):
            with self.assertRaises(ValueError):
                contour_rest_fields(bad, f, m)
        invalid_faces = [
            f.astype(float) + 0.1,
            f.ravel(),
            np.array([[468, 469, 472]]),
            np.array([[468, 468, 470]]),
        ]
        for bad in invalid_faces:
            with self.subTest(faces=bad.tolist()), self.assertRaises(ValueError):
                contour_rest_fields(p, bad, m)
        fields = contour_rest_fields(p, f, m)
        fields['contourRestPositions'] = fields['contourRestPositions'].ravel()
        with self.assertRaises(ValueError):
            load_contour_rest(fields, p.ravel(), f, 1, m)


if __name__ == '__main__':
    unittest.main()
