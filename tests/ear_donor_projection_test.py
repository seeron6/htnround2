"""Registered photographic coordinates, never an inferred ellipse, own evidence."""

import copy
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from scripts.ear_donor_projection import projected_ear_observations
from scripts.ear_donor_evidence import ear_donor_observation


class EarDonorProjectionTests(unittest.TestCase):
    def setUp(self):
        self.ear = dict(
            visible=True,
            confidence=0.94,
            outline=[[0.2, 0.1], [0.8, 0.1], [0.8, 0.9], [0.2, 0.9]],
        )
        self.semantics = dict(
            crops={'test.png': [60, 40, 240, 120]},
            views=[
                dict(
                    filename='test.png',
                    blur='usable',
                    imageLeftEar=dict(visible=False),
                    imageRightEar=self.ear,
                )
            ],
        )
        self.raw = np.full((160, 300, 4), 255, np.uint8)
        self.xy = np.array([[28.75, 40.25], [50, 40], [71.25, 40], [50, 59.25]])

    def run_projection(self, xy=None, semantics=None, raw=None, parts=None, **kw):
        xy = self.xy if xy is None else xy
        n = len(xy)
        fields = dict(
            inside=np.ones(n, bool),
            visible=np.ones(n, bool),
            facing=np.full(n, 0.8),
            edge=np.ones(n),
            masked=np.zeros(n, bool),
        )
        fields.update(kw)
        origin = fields.pop('origin', [2, 0, 1])
        return projected_ear_observations(
            self.semantics if semantics is None else semantics,
            'test.png',
            'exposure-a',
            origin,
            (100, 80),
            self.raw if raw is None else raw,
            xy,
            np.full(n, 4) if parts is None else parts,
            **fields,
        )

    def test_nonuniform_ratio_crop_and_exact_registered_coordinate(self):
        with patch(
            'scripts.ear_donor_projection.ear_donor_observation',
            wraps=ear_donor_observation,
        ) as observe:
            row = self.run_projection()[0]
        # Native crop rectangle maps to camera [32,24]..[68,56],
        # even though horizontal/vertical native scales differ (3 and 2).
        polygon = np.float32([[32, 24], [68, 24], [68, 56], [32, 56]])
        expected = np.array(
            [cv2.pointPolygonTest(polygon, tuple(p), True) for p in self.xy]
        )
        np.testing.assert_array_equal(observe.call_args.args[3], expected)
        self.assertEqual(expected[0], -3.25)
        self.assertAlmostEqual(row['negative'][0], 0.68359375)
        np.testing.assert_array_equal(row['positive'], [False, True, False, False])
        # A hidden +.5 camera-pixel adjustment would change this evidence.
        self.assertNotAlmostEqual(row['negative'][0], 0.31640625)

    def test_original_native_alpha_floor_without_coordinate_shift(self):
        raw = self.raw.copy()
        # floor([28.75,40.25]*[3,2]) == [86,80], not [88,81].
        raw[80, 86, 3] = 0
        row = self.run_projection(raw=raw)[0]
        self.assertEqual(row['negative'][0], 0)
        self.assertGreater(row['negative'][2], 0)
        self.assertTrue(row['positive'][1])

    def test_alpha_holes_masks_visibility_and_outside_never_become_exterior(self):
        xy = np.array(
            [
                [28.75, 40.25],
                [28.75, 40.25],
                [28.75, 40.25],
                [-0.01, 40],
                [100, 40],
                [20, 80],
                [np.nan, 40],
                [np.inf, 40],
            ]
        )
        masked = np.zeros(8, bool)
        masked[1] = True
        visible = np.ones(8, bool)
        visible[2] = False
        raw = self.raw.copy()
        raw[80, 86, 3] = 0
        row = self.run_projection(xy, raw=raw, masked=masked, visible=visible)[0]
        np.testing.assert_array_equal(row['negative'], np.zeros(8))
        np.testing.assert_array_equal(row['positive'], np.zeros(8, bool))
        self.assertEqual(row['audit']['projectionOutsideSamples'], 5)
        # Mask and visibility independently reject opaque samples too.
        row = self.run_projection(
            xy[:3],
            masked=np.array([True, False, False]),
            visible=np.array([True, False, True]),
            inside=np.array([True, True, False]),
        )[0]
        np.testing.assert_array_equal(row['negative'], np.zeros(3))

    def test_all_visible_ears_count_even_if_second_annotation_is_bad(self):
        sem = copy.deepcopy(self.semantics)
        sem['views'][0]['imageLeftEar'] = dict(
            visible=True, confidence=0.1, outline=[[0, 0]]
        )
        row = self.run_projection(semantics=sem)[0]
        self.assertIsNone(row['audit']['side'])
        self.assertFalse(row['audit']['acceptedAnnotation'])
        np.testing.assert_array_equal(row['negative'], np.zeros(4))

    def test_both_frontal_sides_remain_distinct(self):
        sem = copy.deepcopy(self.semantics)
        sem['views'][0]['imageLeftEar'] = copy.deepcopy(self.ear)
        rows = self.run_projection(
            xy=np.array([[50, 40], [50, 40]]),
            semantics=sem,
            parts=np.array([3, 4]),
            origin=[0, 0, 2],
        )
        self.assertEqual(len(rows), 2)
        np.testing.assert_array_equal(rows[0]['positive'], [True, False])
        np.testing.assert_array_equal(rows[1]['positive'], [False, True])
        self.assertEqual([r['audit']['side'] for r in rows], [-1, 1])

    def test_invalid_or_missing_annotation_is_unknown_not_negative(self):
        outlines = [
            None,
            [[0, 0]],
            [[0.1, 0.1], [1.1, 0.1], [0.5, 0.9]],
            [[0.1, 0.1], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1]],
            [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]],
            [[0.1, 0.1], [np.nan, 0.9], [0.9, 0.1]],
            [[0.1, 0.1], [0.7, 0.1], [0.3, 0.1], [0.7, 0.9], [0.1, 0.9]],
        ]
        for outline in outlines:
            sem = copy.deepcopy(self.semantics)
            sem['views'][0]['imageRightEar']['outline'] = outline
            with self.subTest(outline=outline):
                self.assertEqual(self.run_projection(semantics=sem), [])
        for crop in ([-1, 40, 240, 120], [60, 40, 301, 120], [60, 40, 60, 120], None):
            sem = copy.deepcopy(self.semantics)
            sem['crops']['test.png'] = crop
            self.assertEqual(self.run_projection(semantics=sem), [])
        for sem in ({}, {'views': []}, None):
            if sem is not None:
                self.assertEqual(self.run_projection(semantics=sem), [])
        sem = copy.deepcopy(self.semantics)
        sem['views'] *= 2
        self.assertEqual(self.run_projection(semantics=sem), [])

    def test_unknown_confidence_or_blur_produces_no_vote(self):
        for field, value in [
            ('confidence', None),
            ('confidence', np.nan),
            ('confidence', 0.7),
        ]:
            sem = copy.deepcopy(self.semantics)
            sem['views'][0]['imageRightEar'][field] = value
            row = self.run_projection(semantics=sem)[0]
            self.assertFalse(row['audit']['acceptedAnnotation'])
            np.testing.assert_array_equal(row['negative'], np.zeros(4))
        sem = copy.deepcopy(self.semantics)
        del sem['views'][0]['blur']
        self.assertFalse(
            self.run_projection(semantics=sem)[0]['audit']['acceptedAnnotation']
        )

    def test_cyclic_reversed_closed_polygon_and_subsets_are_identical(self):
        original = self.run_projection()[0]
        for p in (
            np.roll(self.ear['outline'], 2, axis=0).tolist(),
            self.ear['outline'][::-1],
            self.ear['outline'] + [self.ear['outline'][0]],
        ):
            sem = copy.deepcopy(self.semantics)
            sem['views'][0]['imageRightEar']['outline'] = p
            row = self.run_projection(semantics=sem)[0]
            np.testing.assert_array_equal(row['negative'], original['negative'])
        ids = [3, 0, 1]
        subset = self.run_projection(self.xy[ids])[0]
        for key in ['positive', 'negative']:
            np.testing.assert_array_equal(subset[key], original[key][ids])

    def test_inputs_unchanged_and_invalid_image_or_fields_rejected(self):
        sem = copy.deepcopy(self.semantics)
        raw = self.raw.copy()
        xy = self.xy.copy()
        self.run_projection()
        self.assertEqual(sem, self.semantics)
        np.testing.assert_array_equal(raw, self.raw)
        np.testing.assert_array_equal(xy, self.xy)
        for raw in (self.raw[:, :, :3], self.raw.astype(float)):
            with self.assertRaises(ValueError):
                self.run_projection(raw=raw)
        with self.assertRaises(ValueError):
            self.run_projection(parts=np.array([4]))
        with self.assertRaises(ValueError):
            self.run_projection(inside=np.full(4, 2))
        with self.assertRaises(ValueError):
            self.run_projection(origin=[0, 0, 0])


if __name__ == '__main__':
    unittest.main()
