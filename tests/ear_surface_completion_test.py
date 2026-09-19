"""Connected occlusion completion must not erase photographed head appearance."""

import unittest
import numpy as np

from scripts.ear_surface_completion import continue_ear_surface


def strip(length=0.12, columns=13):
    p = np.array(
        [[x, y, 0.0] for x in np.linspace(0, length, columns) for y in (0.0, 0.01)]
    )
    f = np.array(
        [[2 * i, 2 * i + 1, 2 * i + 2] for i in range(columns - 1)]
        + [[2 * i + 1, 2 * i + 3, 2 * i + 2] for i in range(columns - 1)]
    )
    tids = np.repeat(np.arange(len(f)), 3)
    weights = np.tile(np.eye(3), (len(f), 1))
    x = p[f[tids][np.arange(len(tids)), np.tile(np.arange(3), len(f))], 0]
    source = (x == 0) | (x == length)
    colors = np.full((len(tids), 3), 0.05)
    colors[x == 0] = [0.2, 0.3, 0.4]
    colors[x == length] = [0.8, 0.6, 0.5]
    return (
        dict(
            vertices=p,
            faces=f,
            binding=dict(triangles=f.copy(), triangleIds=tids, weights=weights),
            photo_color=colors,
            parts=np.zeros(len(tids), int),
            vertex_parts=np.zeros(len(p), int),
            confidence=source.astype(float),
            ear_occluded=(~source).astype(float),
            photographed=source,
        ),
        x,
    )


class EarSurfaceTests(unittest.TestCase):
    def test_wide_missing_component_has_continuous_bounded_transition(self):
        a, x = strip()
        before = a['photo_color'].copy()
        estimate, alpha, ownership, audit = continue_ear_surface(**a)
        unknown = ~a['photographed']
        self.assertTrue((alpha[unknown] == 1).all())
        self.assertEqual(audit['unresolvedTargetTexels'], 0)
        self.assertGreater(audit['maximumComponentAabbDiagonalMm'], 120)
        middle = estimate[np.isclose(x, 0.06)].mean(axis=0)
        self.assertGreater(middle[0], 0.4)
        self.assertLess(middle[0], 0.6)
        means = np.array([estimate[np.isclose(x, v), 0].mean() for v in np.unique(x)])
        self.assertTrue((np.diff(means) > 0).all())
        self.assertLess(np.diff(means).max(), 0.09)
        self.assertTrue((estimate[unknown] >= [0.2, 0.3, 0.4]).all())
        self.assertTrue((estimate[unknown] <= [0.8, 0.6, 0.5]).all())
        np.testing.assert_array_equal(a['photo_color'], before)
        for result, repeated in zip(
            (estimate, alpha, ownership), continue_ear_surface(**a)[:3]
        ):
            np.testing.assert_array_equal(result, repeated)

    def test_protected_hair_photographs_and_other_parts_are_exact(self):
        a, x = strip()
        candidates = np.flatnonzero((x > 0.025) & (x < 0.095))[:6]
        a['preserve'] = np.zeros(len(x), bool)
        a['observed_hair'] = np.zeros(len(x), bool)
        a['confidence'][candidates[0]] = 0.12
        a['preserve'][candidates[1]] = True
        a['observed_hair'][candidates[2]] = True  # low RGB weight does not erase hair
        a['parts'][candidates[3:5]] = [3, 1]
        a['ear_occluded'][candidates[5]] = 0
        current = a['photo_color'].copy()
        current[candidates] = [0.71, 0.31, 0.21]
        estimate, alpha, ownership, _ = continue_ear_surface(**a)
        result = (
            current
            + ownership[:, None] * (a['photo_color'] - current)
            + alpha[:, None] * (estimate - a['photo_color'])
        )
        np.testing.assert_array_equal(result[candidates], current[candidates])
        np.testing.assert_array_equal(
            result[a['photographed']], current[a['photographed']]
        )
        np.testing.assert_array_equal(ownership[candidates], 0)

    def test_no_anchors_retains_fallback_and_disconnected_sheet_cannot_donate(self):
        a, x = strip()
        n, t, c = len(a['vertices']), len(a['faces']), len(x)
        a['vertices'] = np.concatenate([a['vertices'], a['vertices'] + [0, 0, 0.0001]])
        a['faces'] = np.concatenate([a['faces'], a['faces'] + n])
        a['vertex_parts'] = np.zeros(2 * n, int)
        a['binding'] = dict(
            triangles=a['faces'],
            triangleIds=np.r_[
                a['binding']['triangleIds'], a['binding']['triangleIds'] + t
            ],
            weights=np.tile(a['binding']['weights'], (2, 1)),
        )
        for key in (
            'photo_color',
            'parts',
            'confidence',
            'ear_occluded',
            'photographed',
        ):
            a[key] = np.concatenate([a[key], a[key]])
        a['photographed'][c:] = False
        a['confidence'][c:] = 0
        a['ear_occluded'][c:] = 1
        estimate, alpha, ownership, audit = continue_ear_surface(**a)
        np.testing.assert_array_equal(ownership[c:], 0)
        np.testing.assert_array_equal(alpha[c:], 0)
        np.testing.assert_array_equal(estimate[c:], a['photo_color'][c:])
        self.assertEqual(audit['unresolvedTargetTexels'], c)
        self.assertEqual(len(audit['components']), 2)
        self.assertEqual(
            sum(item['anchoredVertices'] == 0 for item in audit['components']), 1
        )

    def test_ear_faces_block_shortcut_and_mixed_labels_are_reported(self):
        a, x = strip()
        a['vertex_parts'][np.isclose(a['vertices'][:, 0], 0.06)] = 3
        a['photographed'][x == 0.12] = False
        a['confidence'][x == 0.12] = 0
        a['ear_occluded'][x == 0.12] = 1
        _, alpha, ownership, audit = continue_ear_surface(**a)
        np.testing.assert_array_equal(ownership[x > 0.075], 0)
        np.testing.assert_array_equal(alpha[x > 0.075], 0)
        self.assertGreater(audit['mixedLabelTargetTexelsExcluded'], 0)
        self.assertGreater(audit['unresolvedTargetTexels'], 0)

    def test_constant_photographic_boundary_avoids_double_fallback_band(self):
        a, x = strip()
        a['photo_color'][:] = [0.6, 0.4, 0.3]
        unknown = ~a['photographed']
        a['confidence'][unknown] = x[unknown] / 0.12 * 0.119
        a['ear_occluded'][unknown] = 0.7
        estimate, alpha, ownership, _ = continue_ear_surface(**a)
        current = np.full_like(estimate, 0.05)
        actual = (
            current
            + ownership[:, None] * (a['photo_color'] - current)
            + alpha[:, None] * (estimate - a['photo_color'])
        )
        expected = (
            current * (1 - ownership[:, None]) + a['photo_color'] * ownership[:, None]
        )
        np.testing.assert_allclose(actual, expected, atol=1e-14)
        np.testing.assert_allclose(ownership[unknown], 0.7)
        self.assertTrue(np.isfinite(actual).all())

    def test_observed_dark_hair_can_anchor_without_becoming_skin(self):
        a, x = strip()
        a['photo_color'][a['photographed']] = [0.08, 0.06, 0.04]
        a['observed_hair'] = a['photographed'].copy()
        a['confidence'][a['photographed']] = 0.45  # caller's validated hair support
        estimate, _, _, audit = continue_ear_surface(**a)
        np.testing.assert_allclose(estimate, np.tile([0.08, 0.06, 0.04], (len(x), 1)))
        self.assertEqual(audit['donorTexels'], int(a['photographed'].sum()))

    def test_immediate_boundary_donates_but_remote_photo_cannot_cross_unknown_gap(self):
        a, x = strip()
        # A short central component, a measured ring on its left, and a bright
        # remote photograph separated from the component by unsupported mesh.
        a['photographed'] = (x <= 0.04) | (x >= 0.10)
        a['confidence'] = a['photographed'].astype(float)
        a['ear_occluded'] = ((x >= 0.05) & (x <= 0.06)).astype(float)
        a['photo_color'][x <= 0.04] = [0.2, 0.3, 0.4]
        a['photo_color'][x >= 0.10] = [1, 1, 1]
        estimate, _, ownership, audit = continue_ear_surface(**a)
        np.testing.assert_allclose(
            estimate[ownership > 0],
            np.tile([0.2, 0.3, 0.4], (np.count_nonzero(ownership), 1)),
        )
        self.assertGreater(audit['boundaryTriangles'], 0)
        self.assertLess(audit['donorTexels'], int(a['photographed'].sum()))
        saved = estimate.copy()
        a['photo_color'][x >= 0.10] = [0, 0, 0]
        changed = continue_ear_surface(**a)[0]
        np.testing.assert_array_equal(changed[ownership > 0], saved[ownership > 0])

    def test_planar_cap_cannot_create_connection(self):
        a, x = strip()
        a['vertices'][:, 1] = 0
        _, _, ownership, audit = continue_ear_surface(**a)
        np.testing.assert_array_equal(ownership, 0)
        self.assertEqual(audit['excludedCapTriangles'], len(a['faces']))
        self.assertGreater(audit['unsupportedTopologyTargetTexelsExcluded'], 0)

    def test_invalid_inputs_rejected_and_border_barycentric_tolerance(self):
        a, _ = strip()
        a['binding']['weights'][0] = [1, -1e-5, 1e-5]
        continue_ear_surface(**a)
        for name, replacement in [
            ('confidence', np.full(len(a['parts']), np.nan)),
            ('ear_occluded', np.full(len(a['parts']), 1.1)),
            ('parts', np.zeros(3)),
        ]:
            bad = dict(a, **{name: replacement})
            with self.assertRaises(ValueError):
                continue_ear_surface(**bad)
        a['binding']['weights'][0, 1] = -0.1
        with self.assertRaises(ValueError):
            continue_ear_surface(**a)


if __name__ == '__main__':
    unittest.main()
