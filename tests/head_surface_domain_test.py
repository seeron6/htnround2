"""Categorical head clipping must preserve correspondence and surface topology."""

import unittest
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from scripts.head_surface_domain import clip_head_surface
from scripts.ear_surface_completion import continue_ear_surface


def binding(triangles, weights, ids=None):
    return dict(
        triangles=np.asarray(triangles, int),
        weights=np.asarray(weights, float),
        triangleIds=(
            np.zeros(len(weights), int) if ids is None else np.asarray(ids, int)
        ),
    )


def area(p, f):
    return (
        np.linalg.norm(
            np.cross(p[f[:, 1]] - p[f[:, 0]], p[f[:, 2]] - p[f[:, 0]]), axis=1
        ).sum()
        / 2
    )


class HeadDomainTests(unittest.TestCase):
    def test_binary_and_three_label_regions_match_categorical_area(self):
        p = np.array([[0, 0, 0], [2, 0, 0], [0, 2, 0]], float)
        f = np.array([[0, 1, 2]])
        samples = [[0.5, 0.5, 0], [0.49, 0.51, 0], [1 / 3, 1 / 3, 1 / 3], [1, 0, 0]]
        for labels, fraction, expected in [
            ([0, 3, 3], 0.25, [True, False, False, True]),
            ([0, 0, 3], 0.75, [True, True, True, True]),
            ([0, 3, 4], 1 / 3, [True, False, True, True]),
            ([1, 3, 4], 0, [False] * 4),
        ]:
            with self.subTest(labels=labels):
                q, g, remap, valid, audit = clip_head_surface(
                    p, f, labels, binding(f, samples)
                )
                self.assertAlmostEqual(area(q, g), area(p, f) * fraction, places=12)
                np.testing.assert_array_equal(valid, expected)
                self.assertLess(audit['maximumRemapPositionErrorMm'], 1e-10)
                self.assertTrue((remap['weights'][valid] >= 0).all())
                np.testing.assert_allclose(remap['weights'][valid].sum(axis=1), 1)

    def test_shared_edge_midpoint_connects_head_across_atlas_seams(self):
        p = np.array([[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0]], float)
        f = np.array([[0, 1, 2], [1, 3, 2]])
        labels = np.array([0, 3, 0, 3])
        b = binding(f, [[0, 0.25, 0.75], [0.25, 0, 0.75]], [0, 1])
        q, g, rb, valid, _ = clip_head_surface(p, f, labels, b)
        self.assertTrue(valid.all())
        midpoint = np.flatnonzero(np.linalg.norm(q - [1, 1, 0], axis=1) < 1e-12)
        self.assertEqual(len(midpoint), 1)
        self.assertGreater(np.count_nonzero(g == midpoint[0]), 1)
        self.assertFalse(np.isin(g, [1, 3]).any())
        # The same point from both original triangles has the same nonzero
        # interpolation support, so even a nonconstant field cannot UV-seam.
        supports = []
        for i in range(2):
            supports.append(
                {
                    int(v): round(float(w), 12)
                    for v, w in zip(g[rb['triangleIds'][i]], rb['weights'][i])
                    if w > 1e-12
                }
            )
        self.assertEqual(*supports)
        edges = np.concatenate([g[:, [0, 1]], g[:, [1, 2]], g[:, [2, 0]]])
        graph = coo_matrix(
            (
                np.ones(2 * len(edges)),
                (np.r_[edges[:, 0], edges[:, 1]], np.r_[edges[:, 1], edges[:, 0]]),
            ),
            shape=(len(q), len(q)),
        ).tocsr()
        _, components = connected_components(graph, directed=False)
        self.assertEqual(len(np.unique(components[np.unique(g)])), 1)

    def test_permuted_mesh_faces_and_uv_vertex_order_are_identical(self):
        p = np.array([[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0]], float)
        f = np.array([[0, 1, 2], [1, 3, 2]])
        labels = [0, 3, 0, 4]
        bary = np.array([[0.4, 0.2, 0.4], [0.1, 0.1, 0.8], [0.1, 0.8, 0.1]])
        original = binding(f, bary, [0, 1, 0])
        first = clip_head_surface(p, f, labels, original)
        permutation = [2, 0, 1]
        changed = binding(f[::-1][:, permutation], bary[:, permutation], [1, 0, 1])
        second = clip_head_surface(p, f[::-1][:, [1, 2, 0]], labels, changed)
        for i in (0, 1, 3):
            np.testing.assert_array_equal(first[i], second[i])
        for key in ('triangles', 'triangleIds', 'weights'):
            np.testing.assert_array_equal(first[2][key], second[2][key])

    def test_original_ear_vertex_does_not_connect_separate_head_patches(self):
        p = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], float)
        f = np.array([[0, 1, 2], [0, 3, 4]])
        q, g, _, _, _ = clip_head_surface(
            p,
            f,
            [3, 0, 3, 0, 3],
            binding(f, [[0.2, 0.7, 0.1], [0.2, 0.7, 0.1]], [0, 1]),
        )
        self.assertFalse((g == 0).any())
        self.assertEqual(len(set(g[0]).intersection(g[1])), 0)
        self.assertTrue(len(q) > len(p))

    def test_duplicate_uv_triangles_share_one_temporary_surface(self):
        p = np.eye(3)
        f = np.array([[0, 1, 2]])
        b = binding([[0, 1, 2], [2, 0, 1]], [[0.6, 0.2, 0.2], [0.2, 0.6, 0.2]], [0, 1])
        _, g, remapped, valid, _ = clip_head_surface(p, f, [0, 3, 0], b)
        self.assertTrue(valid.all())
        self.assertEqual(len(g), 2)
        self.assertEqual(*remapped['triangleIds'])
        np.testing.assert_array_equal(*remapped['weights'])

    def test_head_texels_on_mixed_faces_resolve_without_ear_donors_or_targets(self):
        p = np.array([[0, 0, 0], [0.02, 0, 0], [0, 0.02, 0], [0.02, 0.02, 0]], float)
        f = np.array([[0, 1, 2], [1, 3, 2]])
        labels = np.array([0, 0, 0, 3])
        b = binding(
            f,
            [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
                [0.4, 0.2, 0.4],
                [0.25, 0.5, 0.25],
                [0.1, 0.8, 0.1],
                [0.15, 0.7, 0.15],
            ],
            [0, 0, 0, 1, 1, 1, 1],
        )
        colors = np.tile([0.6, 0.4, 0.3], (7, 1))
        colors[3:] = [0.98, 0.05, 0.1]
        args = dict(
            vertices=p,
            faces=f,
            vertex_parts=labels,
            binding=b,
            photo_color=colors,
            parts=np.array([0, 0, 0, 0, 0, 3, 3]),
            confidence=np.array([1, 1, 1, 0, 0, 1, 0]),
            ear_occluded=np.array([0, 0, 0, 1, 1, 0, 1]),
            photographed=np.array([1, 1, 1, 0, 0, 1, 0], bool),
        )
        saved = [v.copy() for v in (p, f, labels, b['weights'])]
        estimate, alpha, ownership, audit = continue_ear_surface(**args)
        np.testing.assert_allclose(estimate[3:5], [[0.6, 0.4, 0.3]] * 2)
        np.testing.assert_array_equal(ownership[3:5], 1)
        np.testing.assert_array_equal(alpha[5:], 0)
        np.testing.assert_array_equal(ownership[5:], 0)
        self.assertEqual(audit['mixedLabelTargetTexelsIncluded'], 2)
        self.assertEqual(audit['mixedLabelTargetTexelsExcluded'], 0)
        colors[5] = 0  # a changed measured ear must not affect head continuation
        np.testing.assert_array_equal(
            continue_ear_surface(**args)[0][3:5], estimate[3:5]
        )
        for before, after in zip(saved, (p, f, labels, b['weights'])):
            np.testing.assert_array_equal(before, after)

    def test_disallowed_topology_existing_part_and_invalid_inputs(self):
        p = np.eye(3)
        f = np.array([[0, 1, 2]])
        b = binding(f, [[0.6, 0.2, 0.2], [0.7, 0.1, 0.2]])
        _, _, _, valid, _ = clip_head_surface(p, f, [0, 3, 3], b, texel_parts=[0, 3])
        np.testing.assert_array_equal(valid, [True, False])
        _, g, _, valid, _ = clip_head_surface(p, np.empty((0, 3), int), [0, 3, 3], b)
        self.assertEqual(len(g), 0)
        self.assertFalse(valid.any())
        b['weights'][0, 0] = np.nan
        with self.assertRaises(ValueError):
            clip_head_surface(p, f, [0, 3, 3], b)

    def test_completion_without_any_head_face_returns_zero_ownership(self):
        p = np.eye(3)
        f = np.array([[0, 1, 2]])
        color = np.array([[0.5, 0.4, 0.3]])
        estimate, alpha, ownership, audit = continue_ear_surface(
            p,
            f,
            binding(f, [[0.8, 0.1, 0.1]]),
            color,
            [0],
            [3, 3, 3],
            [0],
            [1],
            photographed=[True],
        )
        np.testing.assert_array_equal(estimate, color)
        np.testing.assert_array_equal(alpha, 0)
        np.testing.assert_array_equal(ownership, 0)
        self.assertEqual(audit['mixedLabelTargetTexelsExcluded'], 1)
        self.assertNotIn('surfaceSolve', audit)


if __name__ == '__main__':
    unittest.main()
