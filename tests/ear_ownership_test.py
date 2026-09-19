"""Anatomical identity must not be inferred from missing photographic evidence."""

import copy
from pathlib import Path
import unittest
from unittest.mock import patch
import numpy as np
from scripts.ear_fit import refine_ear_ownership, ear_vertex_labels


class UnusedCameraEvidence:
    def __getattr__(self, name):
        raise AssertionError('Anatomical ownership must not query camera visibility')


class EarOwnershipTests(unittest.TestCase):
    def invoke(self, regions, semantics=None):
        p = np.arange(24, dtype=float).reshape(8, 3) * 0.001
        faces = np.array([[0, 1, 2], [3, 4, 5]])
        original_points, original_faces = p.copy(), faces.copy()
        with patch('scripts.ear_fit.source_ear_mask') as source_mask:
            audit = refine_ear_ownership(
                Path('/not-read-for-anatomical-identity'),
                p,
                faces,
                regions,
                semantics,
                UnusedCameraEvidence(),
                np.zeros(3),
                np.eye(3),
                {'scale': 1},
            )
        source_mask.assert_not_called()
        np.testing.assert_array_equal(p, original_points)
        np.testing.assert_array_equal(faces, original_faces)
        return audit

    def test_unknown_transparent_and_background_evidence_cannot_remove_identity(self):
        # These cases historically either lacked source evidence or gave the
        # photo mask no ear pixels. Neither supplies anatomical negative evidence.
        for evidence in (
            None,
            {'views': []},
            {
                'views': [
                    {
                        'filename': 'alpha-zero.png',
                        'imageLeftEar': {'visible': False, 'outline': []},
                    }
                ]
            },
            {
                'views': [
                    {
                        'filename': 'background.png',
                        'imageLeftEar': {
                            'visible': True,
                            'confidence': 0.95,
                            'outline': [[0.8, 0.8], [0.9, 0.8], [0.9, 0.9]],
                        },
                    }
                ]
            },
        ):
            with self.subTest(evidence=evidence):
                regions = {
                    '-1': {'coreVertices': [0, 1, 2]},
                    '1': {'coreVertices': [3, 4, 5]},
                }
                self.invoke(regions, evidence)
                np.testing.assert_array_equal(
                    ear_vertex_labels(8, regions), [3, 3, 3, 4, 4, 4, 0, 0]
                )

    def test_pruned_core_restores_original_identity_and_preserves_other_metadata(self):
        regions = {
            '-1': {
                'coreVertices': [1],
                'anatomicalCoreVertices': [0, 1, 2],
                'vertices': [0, 1, 2, 6],
                'weights': [1, 0.7, 0.9, 0.2],
                'anchors': {'top': 0},
                'observedLandmarks': {'top': [1, 2, 3]},
            }
        }
        before = copy.deepcopy(regions)
        audit = self.invoke(regions)
        self.assertEqual(regions['-1']['coreVertices'], [0, 1, 2])
        for key in ('vertices', 'weights', 'anchors', 'observedLandmarks'):
            self.assertEqual(regions['-1'][key], before['-1'][key])
        self.assertEqual(audit['-1']['earVertices'], 3)
        self.assertFalse(audit['-1']['geometryChanged'])
        self.assertIn('independently of photographic visibility', audit['-1']['method'])

    def test_repeated_calls_cannot_shrink_or_alias_retained_anatomy(self):
        regions = {'-1': {'coreVertices': [0, 1, 2]}}
        expected = self.invoke(regions)
        self.assertIsNot(
            regions['-1']['coreVertices'], regions['-1']['anatomicalCoreVertices']
        )
        for _ in range(3):
            regions['-1']['coreVertices'].pop()
            self.assertEqual(regions['-1']['anatomicalCoreVertices'], [0, 1, 2])
            self.assertEqual(self.invoke(regions), expected)
            self.assertEqual(regions['-1']['coreVertices'], [0, 1, 2])

    def test_missing_anatomical_history_retains_current_core_without_expanding_support(
        self,
    ):
        regions = {'1': {'coreVertices': [3, 4], 'vertices': [2, 3, 4, 5, 6]}}
        self.invoke(regions)
        self.assertEqual(regions['1']['anatomicalCoreVertices'], [3, 4])
        self.assertEqual(regions['1']['coreVertices'], [3, 4])
        np.testing.assert_array_equal(
            ear_vertex_labels(8, regions), [0, 0, 0, 4, 4, 0, 0, 0]
        )


if __name__ == '__main__':
    unittest.main()
