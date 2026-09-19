"""Persisted contour proposals must preserve the accepted surface contract."""

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from scripts.ear_contour_pipeline import refine_capture_ear_contours
from scripts.ear_deformation import surface_quality


class EarContourPipelineTests(unittest.TestCase):
    def fixture(self):
        cage = np.zeros((468, 3), np.float32)
        cage[:, 2] = -0.25
        surface = np.array(
            [[0, 0, 0], [0.02, 0, 0], [0, 0.02, 0], [0.02, 0.02, 0]], np.float32
        )
        points = np.vstack([cage, surface]).astype(float)
        faces = np.array([[468, 469, 470], [469, 471, 470]])
        return points, faces

    def invoke(
        self,
        points,
        faces,
        *,
        baseline=None,
        semantics=None,
        regions=None,
        face_count=1,
    ):
        return refine_capture_ear_contours(
            Path('/unused-observation-fixture'),
            points,
            faces,
            face_count,
            regions or {},
            semantics,
            SimpleNamespace(images={}, cameras={}),
            np.zeros(3),
            np.eye(3),
            {'scale': 1.0},
            baseline=points if baseline is None else baseline,
        )

    def proposed(self, points, faces, proposal, **kw):
        with (
            patch(
                'scripts.ear_contour_fit.capture_contour_views',
                return_value=(['camera-observation'], [{'source': 'fixture'}]),
            ),
            patch(
                'scripts.ear_contour_fit.fit_ear_contours',
                return_value=(proposal, {'accepted': True}),
            ) as solver,
        ):
            output, audit = self.invoke(
                points, faces, semantics={'views': ['fixture']}, **kw
            )
        return output, audit, solver.call_args

    def test_missing_semantics_is_exact_noop_without_reading_sources_or_fitting(self):
        p, f = self.fixture()
        with (
            patch(
                'scripts.ear_contour_fit.capture_contour_views',
                side_effect=AssertionError('No source read'),
            ),
            patch(
                'scripts.ear_contour_fit.fit_ear_contours',
                side_effect=AssertionError('No fit'),
            ),
        ):
            q, audit = self.invoke(p, f, semantics=None)
        np.testing.assert_array_equal(q, p)
        self.assertFalse(audit['accepted'])
        self.assertIn('No source', audit['reason'])
        self.assertIsNot(q, p)

    def test_empty_semantic_views_do_not_move_geometry(self):
        p, f = self.fixture()
        q, audit = self.invoke(p, f, semantics={'views': []})
        np.testing.assert_array_equal(q, p)
        self.assertFalse(audit['accepted'])
        self.assertEqual(audit['observations'], [])

    def test_safe_saved_proposal_preserves_canonical_face_and_cage_exactly(self):
        p, f = self.fixture()
        desired = p.copy()
        desired[471] += [0.00000012345, 0.00000023456, 0.00100012345]
        original = p.copy()
        baseline = p.copy()
        baseline[471, 2] = -0.0002
        q, audit, call = self.proposed(p, f, desired, baseline=baseline)
        np.testing.assert_array_equal(q, desired.astype(np.float32).astype(float))
        np.testing.assert_array_equal(q[:468], p[:468])
        np.testing.assert_array_equal(q[np.unique(f[:1])], p[np.unique(f[:1])])
        np.testing.assert_array_equal(p, original)
        np.testing.assert_array_equal(call.args[0], p)
        np.testing.assert_array_equal(
            call.kwargs['baseline'], baseline.astype(np.float32).astype(float)
        )
        self.assertTrue(audit['accepted'])
        self.assertEqual(audit['persistedQuality']['newCrossings'], 0)
        self.assertEqual(audit['observations'], [{'source': 'fixture'}])

    def test_float32_rounding_can_reject_a_previously_valid_area_ratio(self):
        # The narrow face spans exactly8ULPs at x=1. A0.251 area-ratio
        # proposal is valid in float64, but rounds to exactly2ULPs (ratio.25).
        p, _ = self.fixture()
        p[468] = [1, 0, 0]
        p[469] = [np.float32(1 + 1e-6), 0, 0]
        p[470] = [1, 1, 0]
        f = np.array([[468, 469, 470]])
        desired = p.copy()
        desired[469, 0] = 1 + (p[469, 0] - 1) * 0.251
        self.assertGreater(surface_quality(p, desired, f)['minimumAreaRatio'], 0.25)
        self.assertEqual(
            surface_quality(p, desired.astype(np.float32).astype(float), f)[
                'minimumAreaRatio'
            ],
            0.25,
        )
        q, audit, _ = self.proposed(p, f, desired, face_count=0)
        np.testing.assert_array_equal(q, p)
        self.assertFalse(audit['accepted'])
        self.assertIn('Persisted', audit['reason'])

    def test_independent_pre_ear_baseline_quality_is_not_replaced_by_current_rest(self):
        p, f = self.fixture()
        desired = p.copy()
        desired[471, 2] = 0.001
        baseline = p.copy()
        baseline[[469, 470]] = baseline[[470, 469]]
        self.assertGreater(
            surface_quality(p, desired, f)['minimumNormalAgreement'], 0.9
        )
        self.assertGreater(
            surface_quality(baseline, desired, f)['reversedTriangles'], 0
        )
        q, audit, _ = self.proposed(p, f, desired, baseline=baseline)
        np.testing.assert_array_equal(q, p)
        self.assertFalse(audit['accepted'])
        self.assertGreater(audit['persistedQuality']['reversedTriangles'], 0)

    def test_persisted_guard_rejects_safe_but_changed_cage_face_or_anchor(self):
        p, f = self.fixture()
        for vertex, regions in (
            (0, {}),
            (468, {}),
            (471, {'-1': {'anchors': {'top': 471}}}),
        ):
            with self.subTest(vertex=vertex):
                desired = p.copy()
                desired[vertex, 2] += 0.0001
                self.assertGreater(
                    surface_quality(p, desired, f)['minimumNormalAgreement'], 0.9
                )
                q, audit, _ = self.proposed(p, f, desired, regions=regions)
                np.testing.assert_array_equal(q, p)
                self.assertFalse(audit['accepted'])


if __name__ == '__main__':
    unittest.main()
