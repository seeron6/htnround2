"""Contour evidence must not depend on polygon storage or unobserved anatomy."""

import copy
import unittest
import numpy as np
from scripts.ear_contour_observations import extract_ear_contour_observation


class EarContourObservationsTests(unittest.TestCase):
    def setUp(self):
        self.ear = dict(
            visible=True,
            confidence=0.93,
            outline=[
                [0.5, 0.15],
                [0.3, 0.25],
                [0.2, 0.5],
                [0.3, 0.75],
                [0.5, 0.85],
                [0.6, 0.7],
                [0.65, 0.5],
                [0.6, 0.3],
            ],
            top=[0.5, 0.15],
            bottom=[0.5, 0.85],
            tragus=[0.6, 0.5],
        )
        self.kw = dict(native_size=(400, 600), camera_size=(200, 300), blur='usable')
        self.crop = [100, 100, 300, 500]

    def run_arc(self, ear=None, **kw):
        return extract_ear_contour_observation(
            self.ear if ear is None else ear, self.crop, **dict(self.kw, **kw)
        )

    def test_external_arc_avoids_anterior_attachment_and_keeps_extrema(self):
        r = self.run_arc()
        self.assertTrue(r['audit']['accepted'])
        self.assertTrue(np.all(r['pointsCameraPx'][:, 0] < 100))
        np.testing.assert_allclose(
            r['untrimmedArcCameraPx'],
            [[100, 80], [80, 100], [70, 150], [80, 200], [100, 220]],
        )
        np.testing.assert_allclose(r['extremaCameraPx']['top'], [100, 80])
        np.testing.assert_allclose(r['extremaCameraPx']['bottom'], [100, 220])
        self.assertGreater(r['arcDistanceCameraPx'][0], 0)
        self.assertLess(r['pointsCameraPx'][0, 0], 100)
        np.testing.assert_allclose(r['pointsNativePx'], r['pointsCameraPx'] * 2)

    def test_direction_cyclic_origin_and_duplicate_closing_point_invariant(self):
        expected = self.run_arc()['pointsCameraPx']
        for reverse in (False, True):
            for shift in range(len(self.ear['outline'])):
                e = copy.deepcopy(self.ear)
                p = np.roll(e['outline'], shift, axis=0)
                if reverse:
                    p = p[::-1]
                e['outline'] = np.vstack([p, p[0]]).tolist()
                np.testing.assert_allclose(
                    self.run_arc(e)['pointsCameraPx'], expected, atol=1e-10
                )

    def test_heavily_uneven_densification_cannot_choose_attachment_path(self):
        e = copy.deepcopy(self.ear)
        p = np.array(e['outline'])
        dense = []
        for i, (a, b) in enumerate(zip(p, np.roll(p, -1, axis=0))):
            # 100 times more samples on the near-tragus path, same geometry.
            dense.extend(
                a
                + (b - a)
                * np.linspace(0, 1, 101 if i >= 4 else 2, endpoint=False)[:, None]
            )
        e['outline'] = dense
        np.testing.assert_allclose(
            self.run_arc(e)['pointsCameraPx'],
            self.run_arc()['pointsCameraPx'],
            atol=1e-9,
        )

    def test_camera_scaling_and_crop_translation_are_explicit(self):
        a = self.run_arc()
        b = self.run_arc(
            camera_size=(400, 600), sample_spacing_px=3, glasses_margin_px=4
        )
        np.testing.assert_allclose(b['pointsCameraPx'], a['pointsCameraPx'] * 2)
        np.testing.assert_allclose(a['pointsNativePx'], b['pointsNativePx'])
        shifted = extract_ear_contour_observation(
            self.ear, [120, 140, 320, 540], **self.kw
        )
        np.testing.assert_allclose(
            shifted['pointsCameraPx'], a['pointsCameraPx'] + [10, 20]
        )

    def test_opaque_margin_uses_camera_pixels_and_preserves_sample_gaps(self):
        polygon = [[0.17, 0.46], [0.23, 0.46], [0.23, 0.54], [0.17, 0.54]]
        r = self.run_arc(opaque_glasses=[polygon])
        q = r['pointsCameraPx']
        self.assertTrue(r['audit']['accepted'])
        self.assertGreater(r['audit']['samplesExcludedOpaque'], 0)
        self.assertEqual(len(np.unique(r['segmentIds'])), 2)
        # Opaque rectangle camera bounds x67..73 y142..158 +2px margin.
        self.assertFalse(
            np.any(
                (q[:, 0] >= 67) & (q[:, 0] <= 73) & (q[:, 1] >= 140) & (q[:, 1] <= 160)
            )
        )
        a = self.run_arc(
            opaque_glasses=[polygon],
            camera_size=(400, 600),
            sample_spacing_px=3,
            glasses_margin_px=4,
        )
        np.testing.assert_allclose(a['pointsCameraPx'], q * 2)
        np.testing.assert_array_equal(a['segmentIds'], r['segmentIds'])

    def test_opaque_extrema_not_usable_and_fully_occluded_rejected(self):
        top = [[0.4, 0.1], [0.6, 0.1], [0.6, 0.22], [0.4, 0.22]]
        r = self.run_arc(opaque_glasses=[top])
        self.assertFalse(r['extremaEligible']['top'])
        self.assertTrue(r['extremaEligible']['bottom'])
        r = self.run_arc(opaque_glasses=[[[0, 0], [1, 0], [1, 1], [0, 1]]])
        self.assertEqual(r['audit']['reason'], 'insufficient-unoccluded-arc')
        self.assertEqual(r['pointsCameraPx'].shape, (0, 2))

    def test_missing_anchor_visibility_confidence_blur_fail_closed(self):
        for field, value, reason in [
            ('tragus', [0, 0], 'missing-anchor'),
            ('top', [0, 0], 'missing-anchor'),
            ('bottom', [0, 0], 'missing-anchor'),
            ('visible', False, 'not-visible'),
            ('confidence', 0.77, 'low-or-invalid-confidence'),
        ]:
            e = copy.deepcopy(self.ear)
            e[field] = value
            self.assertEqual(self.run_arc(e)['audit']['reason'], reason)
        for blur in ('blurred', 'clear', 'unknown', None):
            self.assertFalse(self.run_arc(blur=blur)['audit']['accepted'])

    def test_degenerate_crossed_invalid_and_ambiguous_annotations_rejected(self):
        for outline in (
            [[0.2, 0.2], [0.5, 0.5], [0.8, 0.8]],
            [[0.2, 0.2], [0.8, 0.8], [0.2, 0.8], [0.8, 0.2]],
            [[0.2, 0.2], [1.2, 0.5], [0.8, 0.8]],
        ):
            e = copy.deepcopy(self.ear)
            e['outline'] = outline
            self.assertFalse(self.run_arc(e)['audit']['accepted'])
        e = copy.deepcopy(self.ear)
        e['tragus'] = [0.5, 0.5]
        self.assertEqual(
            self.run_arc(e)['audit']['reason'], 'degenerate-anchor-geometry'
        )
        e = copy.deepcopy(self.ear)
        e['bottom'] = e['top']
        self.assertFalse(self.run_arc(e)['audit']['accepted'])

    def test_missing_tragus_stays_rejected_even_if_confidence_gate_relaxed(self):
        e = copy.deepcopy(self.ear)
        e.update(confidence=0.77, tragus=[0, 0])
        self.assertEqual(
            self.run_arc(e, min_confidence=0.75)['audit']['reason'], 'missing-anchor'
        )

    def test_invalid_coordinate_system_raises(self):
        for kw in (
            {'camera_size': (0, 10)},
            {'native_size': (100, 100)},
            {'trim_fraction': 0.5},
            {'sample_spacing_px': 0},
            {'glasses_margin_px': -1},
        ):
            with self.assertRaises(ValueError):
                self.run_arc(**kw)

    def test_repeat_is_deterministic_and_does_not_mutate_input(self):
        before = copy.deepcopy(self.ear)
        a = self.run_arc()
        b = self.run_arc()
        self.assertEqual(self.ear, before)
        np.testing.assert_array_equal(a['pointsCameraPx'], b['pointsCameraPx'])
        self.assertEqual(a['audit'], b['audit'])


if __name__ == '__main__':
    unittest.main()
