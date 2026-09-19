"""Shared estimated skin must join without modifying photographed features."""

import copy
import unittest

import numpy as np

from scripts.attachment_continuation import continue_attachment_color
from scripts.photo_geometry import interpolate_part_labels


def fixture():
    p = np.array([[x * 0.003, y * 0.004, 0] for y in range(4) for x in range(-3, 5)])
    f = []
    for y in range(3):
        for x in range(7):
            a = y * 8 + x
            f += [[a, a + 1, a + 8], [a + 1, a + 9, a + 8]]
    f = np.array(f)
    labels = np.where(p[:, 0] > 0, 3, 0)
    # Each triangle has interior samples near every corner and its centroid.
    samples = np.array([[0.8, 0.1, 0.1], [0.1, 0.8, 0.1], [0.1, 0.1, 0.8], [1 / 3] * 3])
    tids = np.repeat(np.arange(len(f)), len(samples))
    bary = np.tile(samples, (len(f), 1))
    # Two sides of the exact category boundary on one shared physical facet.
    mixed = int(
        np.flatnonzero((labels[f] == 0).any(axis=1) & (labels[f] == 3).any(axis=1))[0]
    )
    ear = int(np.flatnonzero(labels[f[mixed]] == 3)[0])
    for t in (0.499, 0.501):
        w = np.full(3, (1 - t) / 2)
        w[ear] = t
        bary = np.vstack([bary, w])
        tids = np.r_[tids, mixed]
    parts = interpolate_part_labels(bary, labels[f[tids]])
    color = np.where((parts == 0)[:, None], [0.72, 0.52, 0.41], [0.29, 0.16, 0.11])
    return dict(
        vertices=p,
        faces=f,
        binding=dict(triangles=f.copy(), triangleIds=tids, weights=bary),
        vertex_parts=labels,
        parts=parts,
        color=color,
        support=np.zeros(len(tids)),
        preserve=np.zeros(len(tids), bool),
    )


class AttachmentTests(unittest.TestCase):
    def excluded_face_fixture(self, kind='eye', cap_connected=False):
        p = np.array(
            [
                [0, 0.01, 0],
                [0.001, 0.011, 0],
                [-0.001, 0.011, 0],
                [-0.02, 0.02, 0],
                [0.02, 0.02, 0],
                [0, 0.012, 0.001],
                [0.001, 0.012, 0.001],
            ]
        )
        f = np.array([[0, 1, 2], [0, 3, 4], [0, 5, 6]])
        labels = np.array([0, 3, 3, 0, 0, 1, 1])
        parts = np.array([3, 0, 1])
        support = np.array([0, 0.2, 0.2])
        if kind == 'cap':
            p[5:, 1] = 0.01
            labels[5:] = 0
            parts[2] = 0
            if cap_connected:
                f = np.vstack([f, [[5, 1, 3], [6, 2, 4]]])
                support[2] = 0
        return dict(
            vertices=p,
            faces=f,
            binding=dict(
                triangles=f,
                triangleIds=np.arange(3),
                weights=np.array([[0.2, 0.4, 0.4], [0.1, 0.45, 0.45], [0.4, 0.3, 0.3]]),
            ),
            vertex_parts=labels,
            parts=parts,
            support=support,
            preserve=np.zeros(3, bool),
        )

    def test_excluded_eye_and_cap_cannot_donate_through_shared_vertices(self):
        for kind in ('eye', 'cap'):
            args = self.excluded_face_fixture(kind)
            results = []
            for excluded_color in ([1.0, 1.0, 1.0], [0.0, 0.0, 1.0]):
                color = np.array([[0.5, 0.5, 0.5], [1.0, 1.0, 1.0], excluded_color])
                results.append(continue_attachment_color(**args, color=color)[0])
            with self.subTest(kind=kind):
                np.testing.assert_array_equal(results[0][0], results[1][0])

    def test_excluded_cap_is_not_target_even_when_all_corners_are_connected(self):
        args = self.excluded_face_fixture('cap', cap_connected=True)
        color = np.array([[0.5, 0.5, 0.5], [1.0, 1.0, 1.0], [0.0, 0.0, 1.0]])
        expected = continue_attachment_color(**args, color=color)[0]
        np.testing.assert_array_equal(expected[2], color[2])
        # Atlas triangles can reorder original faces and their vertices.
        b = args['binding']
        b['triangles'] = b['triangles'][::-1][:, [2, 0, 1]]
        b['triangleIds'] = len(args['faces']) - 1 - b['triangleIds']
        b['weights'] = b['weights'][:, [2, 0, 1]]
        result = continue_attachment_color(**args, color=color)[0]
        np.testing.assert_allclose(result, expected, rtol=0, atol=1e-12)

    def test_shared_facet_has_one_field_across_categorical_boundary(self):
        args = fixture()
        result, audit = continue_attachment_color(**args)
        self.assertGreater(np.linalg.norm(args['color'][-1] - args['color'][-2]), 0.5)
        self.assertLess(np.linalg.norm(result[-1] - result[-2]), 0.002)
        self.assertGreater(audit['changedTexels'], 0)
        self.assertFalse(audit['physicalCoverageChanged'])
        self.assertTrue(audit['surfaceSolve']['anchorsIncludePriorEstimates'])
        self.assertTrue((result >= args['color'].min(axis=0) - 1e-12).all())
        self.assertTrue((result <= args['color'].max(axis=0) + 1e-12).all())

    def test_photographs_hair_cleanup_and_separate_parts_stay_exact(self):
        args = fixture()
        for i in (40, 41, 42):
            args['preserve'][i] = True  # Caller-resolved hair/cleanup/face.
        args['support'][43:47] = [0.08, 0.12, 0.6, 1.0]
        args['parts'][47:49] = [1, 2]
        args['color'][40:49] = [0.07, 0.11, 0.02]
        saved = copy.deepcopy(args)
        result, audit = continue_attachment_color(**args)
        np.testing.assert_array_equal(result[40:49], args['color'][40:49])
        self.assertEqual(audit['protectedChanged'], 0)
        for key in args:
            if key == 'binding':
                for field in args[key]:
                    np.testing.assert_array_equal(args[key][field], saved[key][field])
            else:
                np.testing.assert_array_equal(args[key], saved[key])

    def test_uv_duplicates_and_permuted_binding_keep_same_field(self):
        args = fixture()
        expected = continue_attachment_color(**args)[0]
        p = [2, 0, 1]
        args['faces'] = args['faces'][::-1][:, p]
        args['binding']['triangles'] = args['binding']['triangles'][:, p]
        args['binding']['weights'] = args['binding']['weights'][:, p]
        actual = continue_attachment_color(**args)[0]
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12)
        # Repeating every sample in another UV chart supplies equal evidence.
        args = fixture()
        for key in ('color', 'parts', 'support', 'preserve'):
            args[key] = np.concatenate([args[key], args[key]])
        for key in ('triangleIds', 'weights'):
            args['binding'][key] = np.concatenate(
                [args['binding'][key], args['binding'][key]]
            )
        doubled = continue_attachment_color(**args)[0]
        np.testing.assert_allclose(
            doubled, np.tile(expected, (2, 1)), rtol=0, atol=1e-12
        )

    def test_disconnected_unknown_component_is_not_filled_from_nearby_skin(self):
        p = np.array(
            [
                [0, 0, 0],
                [0.001, 0.001, 0],
                [0, 0.002, 0],
                [0, 0, 0.0001],
                [0.001, 0.001, 0.0001],
                [0, 0.002, 0.0001],
            ]
        )
        f = np.array([[0, 1, 2], [3, 4, 5]])
        color = np.array([[0.1, 0.2, 0.3], [0.8, 0.7, 0.6]])
        result, audit = continue_attachment_color(
            p,
            f,
            dict(triangles=f, triangleIds=np.arange(2), weights=np.full((2, 3), 1 / 3)),
            [0, 3, 3, 0, 0, 0],
            [3, 0],
            color,
            support=[0, 1],
            preserve=[False, False],
        )
        np.testing.assert_array_equal(result, color)
        self.assertEqual(audit['unresolvedTargetTexels'], 1)

    def test_cap_and_no_ear_are_not_junctions(self):
        args = fixture()
        args['vertex_parts'][:] = 0
        args['parts'][:] = 0
        result, audit = continue_attachment_color(**args)
        np.testing.assert_array_equal(result, args['color'])
        self.assertEqual(audit['boundaryTriangles'], 0)
        args = fixture()
        args['vertices'][:, 1] = 0
        result, audit = continue_attachment_color(**args)
        np.testing.assert_array_equal(result, args['color'])
        self.assertEqual(audit['excludedCapTriangles'], len(args['faces']))

    def test_far_fields_are_exact_and_malformed_binding_fails(self):
        args = fixture()
        result, _ = continue_attachment_color(**args)
        corners = args['binding']['triangles'][args['binding']['triangleIds']]
        positions = np.sum(
            args['vertices'][corners] * args['binding']['weights'][:, :, None], axis=1
        )
        far = (positions[:, 0] < -0.005) | (positions[:, 0] > 0.009)
        self.assertTrue(far.any())
        np.testing.assert_array_equal(result[far], args['color'][far])
        for key, value in [
            ('support', np.full(len(result), np.nan)),
            ('preserve', np.full(len(result), 2)),
            ('collar_width', 0),
        ]:
            invalid = copy.deepcopy(args)
            invalid[key] = value
            with self.assertRaises(ValueError):
                continue_attachment_color(**invalid)
        args['binding']['triangleIds'][0] = len(args['faces'])
        with self.assertRaises(ValueError):
            continue_attachment_color(**args)


if __name__ == '__main__':
    unittest.main()
