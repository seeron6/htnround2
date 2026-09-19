"""Surface transport preserves guide evidence while following bound topology."""

import copy
import unittest
import numpy as np
import trimesh
from scripts.hair_surface_transport import transport_photo_groom


def unit(values):
    return values / np.maximum(np.linalg.norm(values, axis=-1, keepdims=True), 1e-30)


def bound_positions(groom, positions):
    ids = np.asarray(groom['photoGuides']['curveBindings']['triangles']).reshape(-1, 3)
    weights = np.asarray(groom['photoGuides']['curveBindings']['weights']).reshape(
        -1, 3
    )
    return np.einsum('ij,ijk->ik', weights, positions[ids]).reshape(
        groom['rootCount'], -1, 3
    )


def rendered_centerlines(groom, positions):
    # Exactly the reference-length centerline used by photo-hair-strands.js,
    # before intentional fiber relief/frizz; root identity is not reprojected.
    ids = np.asarray(groom['rootTriangles']).reshape(-1, 3)
    weights = np.asarray(groom['rootWeights']).reshape(-1, 3)
    roots = np.einsum('ij,ijk->ik', weights, positions[ids])
    offsets = np.asarray(groom['photoGuides']['curveOffsets']).reshape(len(ids), -1, 3)
    return roots[:, None] + offsets


class HairSurfaceTransportTests(unittest.TestCase):
    def fixture(self):
        square = np.array(
            [[0, 0, 0], [0.02, 0, 0], [0.02, 0.02, 0], [0, 0.02, 0]], float
        )
        p = np.vstack([square, square, [[0.1, 0, 0], [0.12, 0, 0], [0.1, 0.02, 0]]])
        f = np.array([[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7], [8, 9, 10]])
        roots = np.array([[0, 1, 2], [4, 5, 6], [8, 9, 10]])
        rw = np.tile([0.6, 0.2, 0.2], (3, 1))
        station_ids = np.repeat(roots[:, None], 5, axis=1)
        # Guide0 deliberately crosses to the coincident disconnected component.
        # Its recorded binding, not spatial proximity, determines movement.
        station_ids[0, 2:] = [4, 5, 6]
        weights = np.array(
            [[0.6 - 0.08 * j, 0.2 + 0.04 * j, 0.2 + 0.04 * j] for j in range(5)]
        )
        sw = np.tile(weights, (3, 1, 1))
        stations = np.einsum('nsj,nsjk->nsk', sw, p[station_ids])
        root_points = np.einsum('ij,ijk->ik', rw, p[roots])
        # Existing serialization residual must survive transport rather than a
        # nearest-surface snap or a fresh six-decimal rounding of all offsets.
        residual = np.array([0.23e-6, -0.17e-6, 0.31e-6])
        offsets = stations - root_points[:, None] + residual
        normals = np.asarray(trimesh.Trimesh(p, f, process=False).vertex_normals)
        cn = unit(np.einsum('nsj,nsjk->nsk', sw, normals[station_ids]))
        directions = unit(offsets[:, -1] - offsets[:, 0])
        groom = dict(
            version=5,
            type='strand-hair',
            mode='photo-strands',
            rootCount=3,
            sourceVertexCount=len(p),
            rootTriangles=roots.ravel().tolist(),
            rootWeights=rw.ravel().tolist(),
            seed=42,
            estimated=True,
            parameters={'lengthMm': 30, 'frizz': 0.15},
            hairlineY=0.03,
            photoGuides=dict(
                surfaceConformed=True,
                observedOnly=True,
                segments=4,
                referenceLengthMm=30,
                directions=directions.ravel().tolist(),
                colors=[0.1, 0.2, 0.3, 0.2, 0.3, 0.4, 0.3, 0.4, 0.5],
                confidence=[0.9, 0.7, 0.8],
                curveOffsets=offsets.ravel().tolist(),
                curveNormals=cn.ravel().tolist(),
                curveColors=np.tile([0.12, 0.18, 0.21], 15).tolist(),
                curveBindings={
                    'triangles': station_ids.ravel().tolist(),
                    'weights': sw.ravel().tolist(),
                },
            ),
        )
        return groom, p, f

    def test_none_and_exact_geometry_noop(self):
        groom, p, f = self.fixture()
        result, audit = transport_photo_groom(None, p, p, f)
        self.assertIsNone(result)
        result, audit = transport_photo_groom(groom, p, p.copy(), f)
        self.assertEqual(result, groom)
        self.assertIsNot(result, groom)
        self.assertIsNot(result['photoGuides'], groom['photoGuides'])
        result['parameters']['lengthMm'] = 99
        self.assertEqual(groom['parameters']['lengthMm'], 30)

    def test_cross_triangle_station_follows_binding_and_retains_quantization_residual(
        self,
    ):
        groom, old, f = self.fixture()
        new = old.copy()
        new[:4] += [0.001, -0.002, 0.0003]
        new[4:8] += [-0.003, 0.001, 0.004]
        result, audit = transport_photo_groom(groom, old, new, f)
        original_residual = rendered_centerlines(groom, old) - bound_positions(
            groom, old
        )
        expected = bound_positions(groom, new) + original_residual
        np.testing.assert_allclose(
            rendered_centerlines(result, new), expected, atol=1e-12, rtol=0
        )
        # A station on component2 moves differently than the root on component1.
        delta = np.asarray(result['photoGuides']['curveOffsets']).reshape(
            3, 5, 3
        ) - np.asarray(groom['photoGuides']['curveOffsets']).reshape(3, 5, 3)
        np.testing.assert_allclose(delta[0, 2], [-0.004, 0.003, 0.0037], atol=1e-12)
        np.testing.assert_allclose(delta[0, 0], 0, atol=1e-12)

    def test_coincident_disconnected_vertices_do_not_share_motion(self):
        groom, old, f = self.fixture()
        new = old.copy()
        new[4:8, 2] += 0.004
        result, _ = transport_photo_groom(groom, old, new, f)
        delta = rendered_centerlines(result, new) - rendered_centerlines(groom, old)
        np.testing.assert_allclose(delta[0, :2], 0, atol=1e-12)
        np.testing.assert_allclose(
            delta[0, 2:], np.tile([0, 0, 0.004], (3, 1)), atol=1e-12
        )
        np.testing.assert_allclose(delta[2], 0, atol=1e-12)

    def test_photographic_evidence_identity_and_inputs_are_unchanged(self):
        groom, old, f = self.fixture()
        saved = copy.deepcopy(groom)
        positions = old.copy()
        faces = f.copy()
        new = old.copy()
        new[2, 2] += 0.003
        result, _ = transport_photo_groom(groom, old, new, f)
        self.assertEqual(groom, saved)
        np.testing.assert_array_equal(old, positions)
        np.testing.assert_array_equal(f, faces)
        for key in (
            'rootTriangles',
            'rootWeights',
            'rootCount',
            'sourceVertexCount',
            'parameters',
            'seed',
            'estimated',
        ):
            self.assertEqual(result[key], groom[key])
        for key in (
            'colors',
            'confidence',
            'curveColors',
            'curveBindings',
            'observedOnly',
            'referenceLengthMm',
        ):
            self.assertEqual(result['photoGuides'][key], groom['photoGuides'][key])
        # The remote third guide is fully untouched, including stored floats.
        for key, width in [
            ('curveOffsets', 15),
            ('curveNormals', 15),
            ('directions', 3),
        ]:
            self.assertEqual(
                result['photoGuides'][key][2 * width : 3 * width],
                groom['photoGuides'][key][2 * width : 3 * width],
            )

    def test_neighbor_face_changes_normals_at_unmoved_bound_vertex(self):
        groom, old, f = self.fixture()
        # Every station of guide0 binds vertex0, whose position remains fixed.
        # Vertex2 motion still rotates both incident face normals at vertex0.
        b = groom['photoGuides']['curveBindings']
        b['triangles'][:15] = np.tile([0, 1, 2], 5).tolist()
        b['weights'][:15] = np.tile([1.0, 0, 0], 5).tolist()
        root = (
            np.asarray(groom['rootWeights'][:3])
            @ old[np.asarray(groom['rootTriangles'][:3])]
        )
        groom['photoGuides']['curveOffsets'][:15] = (
            np.tile(old[0] - root + [0.23e-6, -0.17e-6, 0.31e-6], (5, 1))
            .ravel()
            .tolist()
        )
        new = old.copy()
        new[2, 2] = 0.005
        result, _ = transport_photo_groom(groom, old, new, f)
        normals = np.asarray(trimesh.Trimesh(new, f, process=False).vertex_normals)
        actual = np.asarray(result['photoGuides']['curveNormals']).reshape(3, 5, 3)
        np.testing.assert_allclose(actual[0], np.tile(normals[0], (5, 1)), atol=1e-6)
        self.assertGreater(np.linalg.norm(actual[0, 0] - [0, 0, 1]), 0.05)

    def test_changed_straight_guide_direction_follows_tangent(self):
        groom, old, f = self.fixture()
        new = old.copy()
        # Rigidly rotate component2; guide1 remains straight with rotated tangent.
        theta = 0.3
        rotation = np.array(
            [
                [np.cos(theta), 0, np.sin(theta)],
                [0, 1, 0],
                [-np.sin(theta), 0, np.cos(theta)],
            ]
        )
        new[4:8] = old[4:8] @ rotation.T
        result, _ = transport_photo_groom(groom, old, new, f)
        curve = rendered_centerlines(result, new)[1]
        tangent = unit((curve[-1] - curve[0])[None])[0]
        direction = np.asarray(result['photoGuides']['directions']).reshape(3, 3)[1]
        np.testing.assert_allclose(direction, tangent, atol=1e-6)
        self.assertTrue(np.isfinite(direction).all())

    def test_missing_conformed_bindings_and_invalid_fields_rejected(self):
        groom, old, f = self.fixture()
        new = old.copy()
        new[2, 2] += 0.001
        mutations = [
            lambda g: g['photoGuides'].pop('curveBindings'),
            lambda g: g['photoGuides']['curveBindings']['triangles'].__setitem__(
                0, len(old)
            ),
            lambda g: g['photoGuides']['curveBindings']['triangles'].__setitem__(
                0, 0.5
            ),
            lambda g: g['photoGuides']['curveBindings']['weights'].__setitem__(0, -0.1),
            lambda g: g['photoGuides']['curveBindings']['weights'].__setitem__(0, 0.1),
            lambda g: g['photoGuides']['curveOffsets'].__setitem__(0, float('nan')),
            lambda g: g['photoGuides']['curveNormals'].pop(),
            lambda g: g.__setitem__('sourceVertexCount', len(old) + 1),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                broken = copy.deepcopy(groom)
                mutate(broken)
                with self.assertRaises(ValueError):
                    transport_photo_groom(broken, old, new, f)
        # A valid-index triple which is not an actual face is not a binding.
        broken = copy.deepcopy(groom)
        broken['photoGuides']['curveBindings']['triangles'][:3] = [0, 1, 3]
        with self.assertRaises(ValueError):
            transport_photo_groom(broken, old, new, f)

    def test_shape_or_nonfinite_geometry_rejected(self):
        groom, p, f = self.fixture()
        with self.assertRaises(ValueError):
            transport_photo_groom(groom, p, p[:-1], f)
        q = p.copy()
        q[1, 0] = np.nan
        with self.assertRaises(ValueError):
            transport_photo_groom(groom, p, q, f)

    def test_stale_conformed_centerline_is_rejected_even_on_noop(self):
        groom, p, f = self.fixture()
        groom['photoGuides']['curveOffsets'][7] += 0.0001
        with self.assertRaises(ValueError):
            transport_photo_groom(groom, p, p.copy(), f)

    def test_missing_root_binding_cannot_be_recovered_by_nearest_surface(self):
        groom, p, f = self.fixture()
        groom.pop('rootTriangles')
        with self.assertRaises(ValueError):
            transport_photo_groom(groom, p, p.copy(), f)


if __name__ == '__main__':
    unittest.main()
