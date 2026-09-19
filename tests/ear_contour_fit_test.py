"""Regression fixtures for contour provenance, exclusions and protected surfaces."""

import unittest
import copy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from scipy.sparse import coo_matrix
from scripts import ear_contour_fit as fit


class Pinhole:
    width = 120
    height = 120

    def img_from_cam(self, points):
        p = np.asarray(points)
        return p[:, :2] / p[:, 2, None] * 100 + 60

    def cam_from_img(self, pixels):
        return (np.asarray(pixels) - 60) / 100


def graph_for(points, faces):
    edges = np.unique(
        np.sort(faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1), axis=0
    )
    a, b = edges.T
    length = np.linalg.norm(points[a] - points[b], axis=1)
    return coo_matrix(
        (np.r_[length, length], (np.r_[a, b], np.r_[b, a])),
        shape=(len(points), len(points)),
    ).tocsr()


def observation():
    return dict(
        pointsCameraPx=np.array(
            [[40, 42], [40, 43], [40, 44], [40, 46], [40, 47], [40, 48]], float
        ),
        polygonCameraPx=np.array([[40, 40], [50, 40], [50, 50], [40, 50]], float),
        segmentIds=np.array([0, 0, 0, 1, 1, 1]),
        arcDistanceCameraPx=np.array([2, 3, 4, 6, 7, 8], float),
        untrimmedArcCameraPx=np.array([[40, 40], [40, 50]], float),
        extremaCameraPx={},
        extremaEligible={},
        audit={'accepted': True},
    )


class EarContourFitTests(unittest.TestCase):
    def capture_adapter_fixture(self, origin, left_valid=True, right_valid=True):
        from PIL import Image

        ear = dict(
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
        left, right = copy.deepcopy(ear), copy.deepcopy(ear)
        for key in ('outline', 'top', 'bottom', 'tragus'):
            points = np.asarray(right[key], float).copy()
            points[..., 0] = 1 - points[..., 0]
            right[key] = points.tolist()
        if not left_valid:
            left['confidence'] = 0.7
        if not right_valid:
            right['confidence'] = 0.7
        origin = np.asarray(origin, float)
        pose = SimpleNamespace(
            rotation=SimpleNamespace(matrix=lambda: np.eye(3)), translation=-origin
        )
        image = SimpleNamespace(
            name='frame.png',
            camera_id=1,
            projection_center=lambda: origin,
            cam_from_world=lambda: pose,
        )
        reconstruction = SimpleNamespace(images={1: image}, cameras={1: Pinhole()})
        semantics = dict(
            inputHash='fixture-source',
            crops={'frame.png': [0, 0, 240, 240]},
            views=[
                dict(
                    filename='frame.png',
                    imageLeftEar=left,
                    imageRightEar=right,
                    blur='sharp',
                    opaqueGlassesRegions=[],
                )
            ],
        )
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'images').mkdir()
            Image.new('RGB', (240, 240)).save(folder / 'images/frame.png')
            return fit.capture_contour_views(
                folder, semantics, reconstruction, np.zeros(3), np.eye(3)
            )

    def test_adapter_rejects_both_reliable_ears_in_oblique_view(self):
        for x in (-0.4, 0.4):
            views, audit = self.capture_adapter_fixture([x, 0, 1])
            self.assertEqual(views, [])
            self.assertEqual(len(audit), 2)
            self.assertTrue(
                all(a['reason'] == 'ambiguous-dual-ear-oblique-view' for a in audit)
            )
            self.assertTrue(all(not a['accepted'] for a in audit))
            self.assertEqual(
                {a['source']['ear'] for a in audit}, {'imageLeftEar', 'imageRightEar'}
            )
            self.assertTrue(
                all(a['source']['semanticInputHash'] == 'fixture-source' for a in audit)
            )

    def test_adapter_preserves_single_reliable_oblique_ear_for_either_image_side(self):
        for x in (-0.4, 0.4):
            for left, right in ((True, False), (False, True)):
                views, audit = self.capture_adapter_fixture([x, 0, 1], left, right)
                self.assertEqual(len(views), 1)
                self.assertEqual(views[0]['sign'], int(np.sign(x)))
                self.assertEqual(sum(a['accepted'] for a in audit), 1)
                rejected = next(a for a in audit if not a['accepted'])
                self.assertEqual(rejected['reason'], 'low-or-invalid-confidence')
                np.testing.assert_array_equal(views[0]['origin'], [x, 0, 1])

    def test_adapter_preserves_frontal_image_side_mapping(self):
        views, audit = self.capture_adapter_fixture([0.1, 0, 1])
        self.assertEqual([v['sign'] for v in views], [-1, 1])
        self.assertTrue(all(a['accepted'] for a in audit))
        self.assertEqual(
            [v['observation']['audit']['source']['ear'] for v in views],
            ['imageLeftEar', 'imageRightEar'],
        )

    def test_adapter_does_not_apply_frontal_side_mapping_to_rear_view(self):
        views, audit = self.capture_adapter_fixture([0.1, 0, -1])
        self.assertEqual(views, [])
        self.assertTrue(all(not a['accepted'] for a in audit))
        self.assertTrue(
            all(
                a['reason'] == 'rear-image-side-correspondence-unresolved'
                for a in audit
            )
        )

    def test_projection_matches_independent_camera_construction(self):
        # Nonidentity model basis, scale, translation and camera rotation ensure
        # accidental transposes or a missing inverse model scale are visible.
        basis = np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], float)
        rotation = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)
        center = np.array([0.3, 0.4, 0.5])
        translation = np.array([0.1, 0.2, 3.0])
        world = np.array([[0.2, 0.7, 0.8], [0.5, 0.9, 0.6]])
        model = (world - center) @ basis.T * 2.3
        view = dict(rotation=rotation, translation=translation, camera=Pinhole())
        xy, z = fit.project_points(model, view, center, basis, 2.3)
        cp = np.array([rotation @ p + translation for p in world])
        np.testing.assert_allclose(xy, cp[:, :2] / cp[:, 2, None] * 100 + 60)
        np.testing.assert_allclose(z, cp[:, 2])

    def test_midpoint_binding_cannot_jump_to_coincident_disconnected_edge(self):
        # Coordinates coincide, topology does not. Only the second triangle is
        # ear-owned. A nearest-position lookup silently selects triangle1 edges.
        p = np.array(
            [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, -1, 0], [0, 1, 0], [1, 0, 0]], float
        )
        f = np.array([[0, 1, 2], [3, 4, 5]])
        d = fit._surface_domain(
            p, f, np.array([3]), np.zeros(6, bool), np.empty(0, int), graph_for(p, f)
        )
        self.assertEqual({tuple(sorted(x)) for x in d['extraEdges']}, {(3, 4), (3, 5)})
        q = p.copy()
        q[:3] += [0.2, 0.3, 0.4]
        np.testing.assert_array_equal(
            q[d['extraEdges']].mean(1), p[d['extraEdges']].mean(1)
        )

    def test_reverse_excludes_glasses_gap_and_anterior_closure(self):
        obs = observation()
        border = np.array([[38, 45], [52, 45], [38, 43]], float)
        ids, _, _ = fit._trusted_reverse_points(border, obs)
        np.testing.assert_array_equal(ids, [2])

    def test_reverse_validation_does_not_hide_a_large_external_flap(self):
        ids, _, dist = fit._trusted_reverse_points(
            np.array([[20, 43]], float), observation()
        )
        np.testing.assert_array_equal(ids, [0])
        self.assertGreater(dist[0], 15)

    def test_forward_targets_are_not_averaged_across_glasses_gap(self):
        obs = observation()
        obs['pointsCameraPx'] = np.array([[40, 44], [40, 46]], float)
        obs['segmentIds'] = np.array([0, 1])
        obs['arcDistanceCameraPx'] = np.array([4, 6], float)
        p = np.array([[-0.4, -0.4, 1], [0, -0.4, 1], [0, 0, 1], [-0.4, 0, 1]], float)
        f = np.array([[0, 1, 2], [0, 2, 3]])
        domain = dict(extraEdges=np.empty((0, 2), int), triangles=f, weight=np.ones(4))
        view = dict(
            camera=Pinhole(),
            rotation=np.eye(3),
            translation=np.zeros(3),
            origin=np.zeros(3),
            observation=obs,
        )
        pixel = np.array([[40.5, 45.5]])
        with patch.object(
            fit, 'visible_boundary', return_value=(pixel, np.zeros((120, 120)), p)
        ):
            pair = fit._constraints(p, f, domain, view, np.zeros(3), np.eye(3), 1)
        if pair is not None:
            # Either reject an ambiguous shared raster correspondence or select
            # a genuine retained run. Never invent a target inside the hole.
            for target in pair[1]:
                self.assertTrue(
                    any(np.allclose(target, s) for s in obs['pointsCameraPx'])
                )

    def test_actual_ray_binding_tracks_clipped_source_vertices(self):
        p = np.array(
            [[-0.1, -0.1, 1], [0.1, -0.1, 1], [0.1, 0.1, 1], [-0.1, 0.1, 1]], float
        )
        f = np.array([[0, 1, 2], [0, 2, 3]])
        d = fit._surface_domain(
            p, f, np.array([0, 1]), np.zeros(4, bool), np.empty(0, int), graph_for(p, f)
        )
        obs = dict(
            pointsCameraPx=np.array(
                [[52, 51], [56, 51], [60, 51], [64, 51], [68, 51]], float
            ),
            polygonCameraPx=np.array([[50, 50], [70, 50], [70, 60], [50, 60]], float),
            segmentIds=np.zeros(5, int),
            arcDistanceCameraPx=np.arange(5) * 4.0 + 2,
            untrimmedArcCameraPx=np.array([[50, 51], [70, 51]], float),
            audit={'accepted': True},
        )
        view = dict(
            camera=Pinhole(),
            rotation=np.eye(3),
            translation=np.zeros(3),
            origin=np.zeros(3),
            observation=obs,
        )
        pair = fit._constraints(p, f, d, view, np.zeros(3), np.eye(3), 1)
        self.assertIsNotNone(pair)
        binding, targets = pair
        np.testing.assert_allclose(np.asarray(binding.sum(1)).ravel(), 1)
        self.assertGreaterEqual(binding.data.min(), -1e-8)
        at = binding @ p
        # Barycentric source bindings must commute with arbitrary translation.
        delta = np.array([0.02, -0.01, 0.03])
        np.testing.assert_allclose(binding @ (p + delta), at + delta)
        self.assertEqual(len(targets), len(at))

    def fixture(self):
        cage = np.zeros((468, 3))
        cage[:, 2] = -10
        mesh = np.array(
            [
                [-0.01, -0.01, 0],
                [0.01, -0.01, 0],
                [0.01, 0.01, 0],
                [-0.01, 0.01, 0],
                [0, 0, 0.005],
            ]
        )
        p = np.vstack([cage, mesh])
        f = np.array(
            [[468, 469, 472], [469, 470, 472], [470, 471, 472], [471, 468, 472]]
        )
        region = {
            '-1': dict(
                coreVertices=[468, 469, 470, 471, 472],
                anchors={'top': 470, 'bottom': 468, 'tragus': 469},
            )
        }
        obs = observation()
        views = [
            dict(sign=-1, origin=np.array([x, 0, 1]), observation=obs, filename=str(x))
            for x in (-0.3, 0.3)
        ]
        return p, f, region, views

    def test_insufficient_or_same_pose_views_are_exact_noop(self):
        p, f, regions, views = self.fixture()
        for candidates in ([], views[:1], [views[0], views[0]]):
            with patch.object(
                fit,
                '_solve_step',
                side_effect=AssertionError('Must not fit insufficient views'),
            ):
                q, audit = fit.fit_ear_contours(
                    p, f, 0, regions, candidates, np.zeros(3), np.eye(3), 1
                )
            np.testing.assert_array_equal(q, p)
            self.assertFalse(audit['accepted'])

    def test_fixed_cage_face_and_anchors_are_exact(self):
        p, f, regions, views = self.fixture()
        domain = fit._surface_domain(
            p,
            f,
            np.array(regions['-1']['coreVertices']),
            np.arange(len(p)) < 468,
            np.array([468, 469, 470]),
            graph_for(p, f),
        )
        np.testing.assert_array_equal(domain['weight'][:468], 0)
        np.testing.assert_array_equal(domain['weight'][[468, 469, 470]], 0)
        self.assertGreater(domain['weight'][472], 0)
        # Even an errant solver moving a protected point cannot pass publication
        # quality solely because its image score improves.
        desired = p.copy()
        desired[0, 0] += 0.001
        desired[471, 0] += 0.001

        def error(q, *args):
            value = 10 if np.array_equal(q, p) else 1
            return dict(
                valid=True,
                sourceToModel={'meanSquaredPx': value},
                modelToSource=None,
                untrimmedExtrema=None,
            )

        with (
            patch.object(fit, '_solve_step', return_value=(desired, {})),
            patch.object(fit, 'contour_error', side_effect=error),
        ):
            q, audit = fit.fit_ear_contours(
                p, f, 0, regions, views, np.zeros(3), np.eye(3), 1
            )
        np.testing.assert_array_equal(q, p)
        self.assertFalse(audit['accepted'])

    def test_geometry_quality_rejects_unsafe_baseline_despite_better_contours(self):
        p, f, regions, views = self.fixture()
        desired = p.copy()
        desired[471, 0] += 0.001
        baseline = p.copy()
        baseline[472, 2] = -0.05  # Opposite orientation to accepted apex.

        # Keep direct observed-face triangle protected too.
        def error(q, *args):
            return dict(
                valid=True,
                sourceToModel={'meanSquaredPx': 1 if np.any(q != p) else 10},
                modelToSource=None,
                untrimmedExtrema=None,
            )

        with (
            patch.object(fit, '_solve_step', return_value=(desired, {})),
            patch.object(fit, 'contour_error', side_effect=error),
        ):
            q, audit = fit.fit_ear_contours(
                p, f, 1, regions, views, np.zeros(3), np.eye(3), 1, baseline=baseline
            )
        np.testing.assert_array_equal(q, p)
        self.assertFalse(audit['accepted'])

    def test_real_multiview_fit_improves_known_rim_with_exact_pins(self):
        class Camera:
            width = 160
            height = 160

            def img_from_cam(self, p):
                return p[:, :2] / p[:, 2, None] * 250 + 80

            def cam_from_img(self, p):
                return (p - 80) / 250

        cage = np.zeros((468, 3))
        cage[:, 2] = -10
        p0 = np.array(
            [
                [x, y, 0]
                for y in np.linspace(-0.12, 0.12, 7)
                for x in np.linspace(0, 0.12, 5)
            ]
        )
        f = []
        for j in range(6):
            for i in range(4):
                a = 468 + j * 5 + i
                f.extend([[a, a + 1, a + 6], [a, a + 6, a + 5]])
        p = np.vstack([cage, p0])
        f = np.array(f)
        region = {
            '-1': dict(
                coreVertices=list(range(468, len(p))),
                anchors={'top': 502, 'bottom': 472, 'tragus': 483},
            )
        }
        views = []
        t = np.linspace(0, 1, 25)
        arc = np.c_[
            0.12 - 0.025 * np.sin(t * np.pi), -0.12 + 0.24 * t, np.zeros(len(t))
        ]
        for x in (-0.3, 0.3):
            angle = np.arctan(x)
            c, s = np.cos(angle), np.sin(angle)
            R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
            origin = np.array([x, 0, -1.0])
            v = dict(
                camera=Camera(),
                rotation=R,
                translation=-R @ origin,
                origin=origin,
                filename=str(x),
                sign=-1,
            )
            xy, _ = fit.project_points(arc, v, np.zeros(3), np.eye(3), 1)
            ends, _ = fit.project_points(
                np.array([[0, -0.12, 0], [0, 0.12, 0]]), v, np.zeros(3), np.eye(3), 1
            )
            d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xy, axis=0), axis=1))]
            v['observation'] = dict(
                pointsCameraPx=xy[1:-1],
                untrimmedArcCameraPx=xy,
                polygonCameraPx=np.vstack([ends[0], xy, ends[1]]),
                segmentIds=np.zeros(len(xy) - 2, int),
                arcDistanceCameraPx=d[1:-1],
                extremaCameraPx={},
                extremaEligible={},
                audit={'accepted': True},
            )
            views.append(v)
        q, a = fit.fit_ear_contours(p, f, 1, region, views, np.zeros(3), np.eye(3), 1)
        self.assertTrue(a['accepted'])
        np.testing.assert_array_equal(q[:468], p[:468])
        np.testing.assert_array_equal(q[f[0]], p[f[0]])
        ids = list(region['-1']['anchors'].values())
        np.testing.assert_array_equal(q[ids], p[ids])
        self.assertLessEqual(np.linalg.norm(q - p, axis=1).max(), 0.012)
        for before, after in zip(a['ears']['-1']['before'], a['ears']['-1']['after']):
            self.assertLess(
                after['sourceToModel']['meanSquaredPx'],
                before['sourceToModel']['meanSquaredPx'] * 0.8,
            )
        self.assertEqual(a['quality']['newCrossings'], 0)
        self.assertGreater(a['quality']['minimumNormalAgreement'], 0.1)

    def test_ternary_clipped_vertices_keep_exact_source_barycentrics(self):
        from scripts.head_surface_domain import clip_head_surface

        p = np.array([[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]])
        labels = np.array([0, 1, 2])
        records = []
        for face in ([[0, 1, 2]], [[2, 0, 1]], [[2, 1, 0]]):
            faces = np.array(face)
            empty = dict(
                triangles=faces, triangleIds=np.empty(0, int), weights=np.empty((0, 3))
            )
            vertices, triangles, binding, _, _ = clip_head_surface(
                p, faces, labels, empty, return_vertex_bindings=True
            )
            indices = binding['vertexSourceIndices']
            weights = binding['vertexSourceWeights']
            np.testing.assert_allclose(weights.sum(1), 1)
            self.assertTrue(np.all(weights >= 0))
            np.testing.assert_allclose(
                (p[indices] * weights[:, :, None]).sum(1), vertices
            )
            center = np.flatnonzero(np.all(np.isclose(weights, 1 / 3), axis=1))
            self.assertEqual(len(center), 1)
            np.testing.assert_array_equal(indices[center[0]], [0, 1, 2])
            # Moving each source vertex independently must reproduce re-clipping,
            # including the three-label junction; no position lookup is allowed.
            q = p + np.array([[0.1, 0.2, 0.3], [0.4, -0.1, 0.2], [-0.2, 0.3, 0.1]])
            moved, _, _, _, _ = clip_head_surface(q, faces, labels, empty)
            np.testing.assert_allclose((q[indices] * weights[:, :, None]).sum(1), moved)
            records.append((vertices, triangles, indices, weights))
        for record in records[1:]:
            for value, expected in zip(record, records[0]):
                np.testing.assert_allclose(value, expected)


if __name__ == '__main__':
    unittest.main()
