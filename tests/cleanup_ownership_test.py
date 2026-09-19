"""Source-ear erasure must not masquerade as a verified glasses reference."""

import unittest
import numpy as np

from scripts.glasses_reference import cleanup_weights, supported_cleanup_coverage
from scripts.ear_appearance import hidden_scalp_completion


class CleanupOwnershipTests(unittest.TestCase):
    def weights(self, quality, excluded):
        quality = np.asarray(quality, float)
        one = np.ones(len(quality))
        return cleanup_weights(
            one, quality, one, one * 0.5, one, one, one, np.asarray(excluded, bool)
        )

    def test_erased_pixels_cannot_vote_through_either_ownership_branch(self):
        strength, coverage = self.weights([1, 0.00001, 1, 0.00001], [1, 1, 0, 0])
        np.testing.assert_array_equal(strength[:2], 0)
        np.testing.assert_array_equal(coverage[:2], 0)
        np.testing.assert_array_equal(coverage[2:], 1)
        self.assertTrue((strength[2:] > 0).all())

    def test_other_unoccluded_camera_still_supplies_reference_color(self):
        a, ca = self.weights([1], [1])
        b, cb = self.weights([0.01], [0])
        total = a + b
        color = (
            a[:, None] * [0.02, 0.01, 0.01] + b[:, None] * [0.6, 0.4, 0.3]
        ) / total[:, None]
        np.testing.assert_allclose(color, [[0.6, 0.4, 0.3]])
        np.testing.assert_array_equal(
            supported_cleanup_coverage(np.maximum(ca, cb), total), 1
        )

    def test_rejected_or_subthreshold_rgb_cannot_claim_aggregate_coverage(self):
        strength, coverage = self.weights([0, 1e-8, 1e-7, 1.1e-7], [0] * 4)
        np.testing.assert_array_equal(coverage, 1)  # relaxed branch is visible
        np.testing.assert_array_equal(
            supported_cleanup_coverage(coverage, strength), [0, 0, 0, 1]
        )
        np.testing.assert_array_equal(coverage, 1)  # inputs are untouched

    def test_valid_cleanup_fades_hair_prior_without_promoting_photo_support(self):
        cleaned = np.array([0, 0.25, 0.75, 1])
        result = hidden_scalp_completion(
            np.ones(4),
            np.zeros(4),
            np.zeros(4),
            np.ones(4),
            np.zeros(4),
            np.zeros(4),
            cleanup_coverage=cleaned,
        )
        np.testing.assert_allclose(result, 1 - cleaned)


if __name__ == '__main__':
    unittest.main()
