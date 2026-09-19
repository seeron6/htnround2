"""Independent contours must outrank inferred ellipse ownership, not RGB."""

import copy
import unittest
import numpy as np
from scripts.ear_donor_evidence import (
    ear_donor_observation,
    predicted_ear_donor_multiplier,
    resolve_ear_side,
)


class EarDonorEvidenceTests(unittest.TestCase):
    def observation(self, camera='a', angle=0, distance=None, **kw):
        distance = np.array(
            [-6, 12, -6, -6, -6] if distance is None else distance, float
        )
        n = len(distance)
        fields = dict(
            side=1,
            annotation_confidence=0.94,
            annotation_visible=True,
            blur='usable',
            inside=np.ones(n, bool),
            visible=np.ones(n, bool),
            alpha=np.ones(n),
            facing=np.full(n, 0.8),
            edge=np.ones(n),
            masked=np.zeros(n, bool),
        )
        parts = kw.pop('parts', np.array([4, 4, 0, 3, 1]) if n == 5 else np.full(n, 4))
        fields.update(kw)
        angle = np.deg2rad(angle)
        return ear_donor_observation(
            camera, [np.sin(angle), 0, np.cos(angle)], parts, distance, **fields
        )

    def test_false_ellipse_cheek_rejected_real_concha_and_hair_preserved(self):
        # Synthetic projected ellipse includes every sample. Two independent
        # true outlines exclude cheek(0), include concha(1); others are not ears.
        a = self.observation()
        b = self.observation('b', 32)
        weight, audit = predicted_ear_donor_multiplier([a, b], 5)
        np.testing.assert_array_equal(weight, [0, 1, 1, 1, 1])
        colors = np.array(
            [[190, 145, 120], [94, 48, 36], [19, 12, 7], [170, 120, 99], [80, 70, 60]]
        )
        saved = colors.copy()
        # Gate applies before accumulation: contaminated strong ellipse sample
        # cannot count as observed support or become a harmonic donor.
        quality = np.array([0.34, 0.7, 0.8, 0.4, 0.5]) * weight
        self.assertEqual(quality[0], 0)
        np.testing.assert_array_equal(quality[1:], [0.7, 0.8, 0.4, 0.5])
        np.testing.assert_array_equal(colors, saved)
        self.assertEqual(audit['rejectedSamples'], 1)

    def test_trustworthy_positive_blocks_even_many_exterior_views(self):
        observations = [self.observation(str(i), i * 20) for i in range(6)]
        observations.append(self.observation('inside', 125, [8, 12, -6, -6, -6]))
        weight, _ = predicted_ear_donor_multiplier(observations, 5)
        np.testing.assert_array_equal(weight, np.ones(5))

    def test_single_duplicate_and_adjacent_poses_cannot_veto(self):
        a = self.observation()
        for rows in ([a], [a, copy.deepcopy(a)], [a, self.observation('b', 5)]):
            np.testing.assert_array_equal(
                predicted_ear_donor_multiplier(rows, 5)[0], np.ones(5)
            )
        bad = copy.deepcopy(a)
        bad['direction'] = np.array([1.0, 0, 0])
        with self.assertRaisesRegex(ValueError, 'conflicting poses'):
            predicted_ear_donor_multiplier([a, bad], 5)

    def test_unknown_not_negative_and_no_invented_interior(self):
        a = self.observation()
        variants = [
            dict(side=None),
            dict(annotation_visible=False),
            dict(annotation_confidence=0.79),
            dict(blur=None),
            dict(blur='blurry'),
            dict(visible=np.zeros(5, bool)),
            dict(inside=np.zeros(5, bool)),
            dict(masked=np.ones(5, bool)),
            dict(alpha=np.zeros(5)),
            dict(facing=np.full(5, 0.1)),
            dict(edge=np.full(5, 0.5)),
        ]
        for fields in variants:
            with self.subTest(fields=fields):
                b = self.observation('b', 32, **fields)
                np.testing.assert_array_equal(
                    predicted_ear_donor_multiplier([a, b], 5)[0], np.ones(5)
                )

    def test_signed_distance_tapers_without_a_hard_source_pixel_jump(self):
        distances = np.array([-2.0, -2.0001, -2.5, -3.0, -3.5, -4.0, np.nan])
        a = self.observation(distance=distances)
        b = self.observation('b', 32, distances)
        w, _ = predicted_ear_donor_multiplier([a, b], len(distances))
        self.assertEqual(w[0], 1)
        self.assertGreater(w[1], 0.9999)
        self.assertTrue(np.all(np.diff(w[:6]) <= 0))
        self.assertAlmostEqual(w[3], 0.5)
        self.assertEqual(w[5], 0)
        self.assertEqual(w[6], 1)

    def test_facing_alpha_and_edge_have_continuous_entry(self):
        for field, values in [
            ('facing', [0.3, 0.300001, 0.4, 0.5]),
            ('alpha', [230 / 255, 230 / 255 + 1e-6, 242.5 / 255, 1]),
            ('edge', [0.9, 0.900001, 0.95, 1]),
        ]:
            a = self.observation(distance=[-6] * 4, **{field: np.array(values)})
            b = self.observation('b', 32, [-6] * 4, **{field: np.array(values)})
            w, _ = predicted_ear_donor_multiplier([a, b], 4)
            self.assertEqual(w[0], 1)
            self.assertGreater(w[1], 0.9999)
            self.assertAlmostEqual(w[2], 0.5, places=6)
            self.assertEqual(w[3], 0)

    def test_order_and_chunked_full_subset_are_exact(self):
        rows = [
            self.observation('a', 0),
            self.observation('b', 32),
            self.observation('c', 80),
        ]
        original = copy.deepcopy(rows)
        full, _ = predicted_ear_donor_multiplier(rows, 5)
        np.testing.assert_array_equal(
            full, predicted_ear_donor_multiplier(rows[::-1], 5)[0]
        )
        ids = np.array([3, 0, 4, 1])
        subset = [
            {**r, 'negative': r['negative'][ids], 'positive': r['positive'][ids]}
            for r in rows
        ]
        np.testing.assert_array_equal(
            full[ids], predicted_ear_donor_multiplier(subset, 4)[0]
        )
        for a, b in zip(rows, original):
            for field in ('direction', 'negative', 'positive'):
                np.testing.assert_array_equal(a[field], b[field])

    def test_generic_side_mapping_rejects_ambiguous_oblique_and_rear(self):
        self.assertEqual(resolve_ear_side('imageRightEar', [-2, 0, 1], 1), -1)
        self.assertEqual(resolve_ear_side('imageLeftEar', [2, 0, 1], 1), 1)
        for side in ('imageLeftEar', 'imageRightEar'):
            self.assertIsNone(resolve_ear_side(side, [2, 0, 1], 2))
            self.assertIsNone(resolve_ear_side(side, [0, 0, -1], 1))
        self.assertEqual(resolve_ear_side('imageLeftEar', [0, 0, 1], 2), -1)
        self.assertEqual(resolve_ear_side('imageRightEar', [0, 0, 1], 2), 1)
        self.assertIsNone(resolve_ear_side('imageLeftEar', [0, 0, 1], 0))

    def test_left_and_right_do_not_cross_vote(self):
        a = self.observation(parts=np.full(5, 3), side=-1)
        b = self.observation('b', 32, parts=np.full(5, 3), side=1)
        np.testing.assert_array_equal(
            predicted_ear_donor_multiplier([a, b], 5)[0], np.ones(5)
        )

    def test_empty_and_malformed_inputs(self):
        np.testing.assert_array_equal(
            predicted_ear_donor_multiplier([], 3)[0], np.ones(3)
        )
        self.assertEqual(len(predicted_ear_donor_multiplier([], 0)[0]), 0)
        for kw in (
            dict(alpha=np.full(5, 255)),
            dict(visible=np.ones(4)),
            dict(facing=np.full(5, np.nan)),
            dict(uncertainty_px=0),
        ):
            with self.assertRaises(ValueError):
                self.observation(**kw)
        with self.assertRaises(ValueError):
            predicted_ear_donor_multiplier([self.observation()], 4)
        with self.assertRaises(ValueError):
            predicted_ear_donor_multiplier([], 3, min_angle_degrees=0)


if __name__ == '__main__':
    unittest.main()
