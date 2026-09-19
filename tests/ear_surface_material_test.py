"""Integration of occlusion ownership with photo, hair and fallback layers."""

import unittest

import numpy as np

from scripts.ear_surface_material import complete_masked_ear_surface
from tests.ear_surface_completion_test import strip


def fixture():
    data, x = strip()
    source = data['photographed']
    photo = data['photo_color']
    n = len(x)
    args = {
        key: data[key]
        for key in ('vertices', 'faces', 'binding', 'vertex_parts', 'parts')
    }
    args.update(
        color=np.full_like(photo, 0.03),
        photographic_color=photo,
        prepared_color=photo.copy(),
        ear_hidden=(~source).astype(float),
        total=source.astype(float),
        estimated_total=np.zeros(n),
        best=source.astype(float),
        hair_support=np.zeros(n),
        hair_accum=np.zeros_like(photo),
        hair_total=np.zeros(n),
        hair_votes=np.zeros(n),
        hair_visibility=np.zeros(n),
        hair_semantic_best=np.zeros(n),
        preserve=np.zeros(n, bool),
    )
    return args, x, source


class EarSurfaceMaterialTests(unittest.TestCase):
    def test_estimate_replaces_prior_once_and_inputs_are_unchanged(self):
        a, x, source = fixture()
        a['photographic_color'][:] = [0.6, 0.4, 0.3]
        a['prepared_color'][:] = [0.9, 0.8, 0.7]
        saved = {
            key: value.copy()
            for key, value in a.items()
            if isinstance(value, np.ndarray)
        }
        result, audit = complete_masked_ear_surface(**a)
        np.testing.assert_allclose(
            result[~source], np.tile([0.6, 0.4, 0.3], ((~source).sum(), 1))
        )
        np.testing.assert_array_equal(result[source], a['color'][source])
        self.assertEqual(audit['unresolvedTargetTexels'], 0)
        self.assertFalse(audit['physicalCoverageChanged'])
        for key, before in saved.items():
            np.testing.assert_array_equal(a[key], before)

    def test_relaxed_hair_anchors_use_hair_rgb_instead_of_mixed_skin(self):
        a, x, source = fixture()
        a['photographic_color'][:] = [0.9, 0.6, 0.4]
        a['best'][source] = 0.05
        a['hair_support'][source] = 0.4
        a['hair_total'][source] = 0.2
        a['hair_accum'][source] = np.array([0.08, 0.06, 0.04]) * 0.2
        a['hair_semantic_best'][source] = 0.5
        a['hair_visibility'][source] = 1
        a['hair_votes'][source] = 1
        result, audit = complete_masked_ear_surface(**a)
        np.testing.assert_allclose(
            result[~source], np.tile([0.08, 0.06, 0.04], ((~source).sum(), 1))
        )
        np.testing.assert_array_equal(result[source], a['color'][source])
        self.assertTrue(audit['relaxedHairDonorsUseHairOnlyRGB'])

    def test_semantic_hair_cleanup_and_unmasked_skin_keep_current_color(self):
        a, x, source = fixture()
        probes = np.flatnonzero((x > 0.02) & (x < 0.09))[:4]
        a['hair_semantic_best'][probes[0]] = 0.5
        a['hair_votes'][probes[0]] = 0.8
        a['hair_visibility'][probes[0]] = 1
        a['preserve'][probes[1]] = True
        a['ear_hidden'][probes[2]] = 0
        a['best'][probes[3]] = 0.12
        result, audit = complete_masked_ear_surface(**a)
        np.testing.assert_array_equal(result[probes], a['color'][probes])
        self.assertEqual(audit['protectedChanged'], 0)


if __name__ == '__main__':
    unittest.main()
