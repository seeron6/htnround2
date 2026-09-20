"""Detection uncertainty and manifold orbital repair regression checks."""

import sys, unittest, tempfile, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from shapely.geometry import Polygon
from scripts.eyewear_separation import (
    detect_eyewear,
    require_separate_glasses,
    load_eyewear_detection,
    EyewearSeparationError,
)
from scripts.scan_eyewear import (
    constrained_grid,
    repair_scanned_eyewear,
    cleanup_references,
)


class EyewearTests(unittest.TestCase):
    def test_new_frame_reference_overrides_legacy_front_without_duplicate_vote(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            root = folder / 'glasses-reference'
            for sub, filename, model in [
                ('', 'front.png', 'old'),
                ('front', 'front.png', 'new'),
                ('profile', 'side.png', 'profile'),
            ]:
                path = root / sub
                path.mkdir(parents=True, exist_ok=True)
                (path / 'reference.json').write_text(
                    json.dumps({'filename': filename, 'model': model})
                )
            result = list(cleanup_references(folder))
            self.assertEqual(len(result), 2)
            self.assertEqual(
                {m['filename']: m['model'] for _, m in result},
                {'front.png': 'new', 'side.png': 'profile'},
            )

    def test_missing_or_uncertain_detection_is_not_no_glasses(self):
        self.assertEqual(detect_eyewear(None)['state'], 'unknown')
        for confidence in [0.2, float('nan')]:
            self.assertEqual(
                detect_eyewear(
                    {'glasses': {'present': False, 'confidence': confidence}}
                )['state'],
                'unknown',
            )

    def test_positive_and_negative_detection(self):
        self.assertEqual(
            detect_eyewear({'glasses': {'present': True, 'confidence': 0.98}})['state'],
            'present',
        )
        negative = detect_eyewear({'glasses': {'present': False, 'confidence': 0.96}})
        self.assertEqual(negative['state'], 'absent')
        sentinel = object()
        result, audit, spec = repair_scanned_eyewear(
            sentinel, None, None, None, None, None, None, None, None, None, negative
        )
        self.assertIs(result, sentinel)
        self.assertFalse(audit['applied'])
        self.assertIsNone(spec)

    def test_visible_contours_override_a_negative_classification(self):
        advice = {
            'glasses': {'present': False, 'confidence': 0.99},
            'views': [
                {'filename': 'front.png', 'imageLeftLens': [[0.2, 0.3], [0.3, 0.3]]}
            ],
        }
        self.assertEqual(detect_eyewear(advice)['state'], 'unknown')

    def test_positive_detection_cannot_silently_omit_frame(self):
        detection = {'state': 'present'}
        with self.assertRaises(EyewearSeparationError):
            require_separate_glasses(detection, None)
        with self.assertRaises(EyewearSeparationError):
            require_separate_glasses(detection, {'rims': [[], []], 'temples': [[], []]})

    def test_failed_cleanup_cannot_publish_a_positive_detection(self):
        from scripts.eyewear_separation import require_glasses_cleanup

        detected = {'state': 'present'}
        with self.assertRaises(EyewearSeparationError):
            require_glasses_cleanup(
                detected,
                {'views': [{'filename': 'front.png', 'available': True}]},
                'front.png',
            )
        require_glasses_cleanup(
            detected,
            {
                'views': [
                    {'filename': n, 'available': True}
                    for n in ['front.png', 'left.png', 'right.png']
                ]
            },
            'front.png',
        )

    def test_temples_are_moved_outside_the_actual_surface(self):
        import trimesh
        from scripts.eyewear_detail import clear_temple_arms

        mesh = trimesh.creation.box(extents=[0.2, 0.16, 0.2])
        spec = {
            'temples': [
                [[-0.12, 0.05, 0.12], [-0.08, 0.05, 0.05], [-0.08, 0.04, -0.08]],
                [[0.12, 0.05, 0.12], [0.08, 0.05, 0.05], [0.08, 0.04, -0.08]],
            ]
        }
        result = clear_temple_arms(mesh, spec)
        for arm in result['temples']:
            p = np.array(arm)
            inside = abs(p[:, 2]) < 0.1
            self.assertTrue((abs(p[inside, 0]) >= 0.1026 - 1e-8).all())
        self.assertGreater(result['templeClearance']['maximumOutwardCorrectionMm'], 20)

    def test_stale_analysis_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / 'capture.json').write_text('{}')
            (p / 'astra-head-completion.json').write_text(
                json.dumps({'captureHash': 'stale'})
            )
            with self.assertRaises(EyewearSeparationError):
                load_eyewear_detection(p)

    def test_remeshing_preserves_every_boundary_edge_including_concave_notch(self):
        boundary = np.array(
            [
                [0, 0],
                [0.02, 0],
                [0.02, 0.02],
                [0.011, 0.02],
                [0.011, 0.005],
                [0.009, 0.005],
                [0.009, 0.02],
                [0, 0.02],
            ]
        )
        p, f = constrained_grid(boundary, 0.0016)
        np.testing.assert_array_equal(p[: len(boundary)], boundary)
        edges = np.sort(
            np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1
        )
        edges, count = np.unique(edges, axis=0, return_counts=True)
        self.assertTrue((count <= 2).all())
        actual = {tuple(e) for e in edges[count == 1]}
        expected = {
            tuple(sorted([i, (i + 1) % len(boundary)])) for i in range(len(boundary))
        }
        self.assertEqual(actual, expected)
        area = sum(Polygon(p[t]).area for t in f)
        self.assertAlmostEqual(area, Polygon(boundary).area, places=12)


if __name__ == '__main__':
    unittest.main()
