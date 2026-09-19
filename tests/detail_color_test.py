"""Mask boundaries cannot import hidden background into measured RGB detail."""

import unittest
import cv2
import numpy as np

from scripts.detail_color import fuse_native_detail


def legacy(captured, native):
    sigma = 1.4 * native.shape[1] / captured.shape[1]
    registered = cv2.resize(
        captured[:, :, :3],
        (native.shape[1], native.shape[0]),
        interpolation=cv2.INTER_CUBIC,
    ).astype(np.float32)
    n = native.astype(np.float32)
    return np.uint8(
        np.clip(
            cv2.GaussianBlur(registered, (0, 0), sigma)
            + n
            - cv2.GaussianBlur(n, (0, 0), sigma),
            0,
            255,
        )
    )


def fixture(scale=2, background=(0, 0, 0)):
    captured = np.zeros((48, 56, 4), np.uint8)
    captured[8:40, 8:48] = [100, 80, 60, 255]
    alpha = cv2.resize(
        captured[:, :, 3], (56 * scale, 48 * scale), interpolation=cv2.INTER_NEAREST
    )
    native = np.empty((*alpha.shape, 3), np.uint8)
    native[:] = background
    native[alpha > 0] = [120, 100, 80]
    return captured, native, alpha


class DetailColorTests(unittest.TestCase):
    def test_constant_foreground_has_no_black_white_or_color_background_halo(self):
        for scale in (1, 2):
            for background in ((0, 0, 0), (255, 255, 255), (10, 210, 240)):
                with self.subTest(scale=scale, background=background):
                    captured, native, alpha = fixture(scale, background)
                    result, audit = fuse_native_detail(captured, native)
                    np.testing.assert_array_equal(result[:, :, 3], alpha)
                    np.testing.assert_array_equal(result[alpha == 0, :3], 0)
                    difference = np.abs(
                        result[alpha > 0, :3].astype(int) - [100, 80, 60]
                    )
                    self.assertLessEqual(
                        difference.max(), 1
                    )  # float-to-byte truncation
                    self.assertGreater(audit['edgeCorrectedPixels'], 0)
                    self.assertEqual(audit['expandedForegroundPixels'], 0)
        # This fixture fails the old unnormalized colour-fusion path materially.
        captured, native, alpha = fixture(2, (255, 255, 255))
        self.assertGreater(
            np.abs(
                legacy(captured, native)[alpha > 0].astype(int) - [100, 80, 60]
            ).max(),
            25,
        )

    def test_arbitrary_hidden_registered_and_native_rgb_cannot_change_foreground(self):
        captured, native, alpha = fixture(2, (0, 0, 0))
        first, _ = fuse_native_detail(captured, native)
        rng = np.random.default_rng(7)
        captured[captured[:, :, 3] == 0, :3] = rng.integers(
            0, 256, (np.count_nonzero(captured[:, :, 3] == 0), 3), dtype=np.uint8
        )
        native[alpha == 0] = rng.integers(
            0, 256, (np.count_nonzero(alpha == 0), 3), dtype=np.uint8
        )
        second, _ = fuse_native_detail(captured, native)
        np.testing.assert_array_equal(first, second)

    def test_alpha_hole_does_not_darken_its_opaque_neighbors(self):
        captured, native, _ = fixture(2, (255, 255, 255))
        captured[20:24, 24:28] = 0
        alpha = cv2.resize(
            captured[:, :, 3], (112, 96), interpolation=cv2.INTER_NEAREST
        )
        native[alpha == 0] = [250, 20, 250]
        result, _ = fuse_native_detail(captured, native)
        self.assertLessEqual(
            np.abs(result[alpha > 0, :3].astype(int) - [100, 80, 60]).max(), 1
        )
        np.testing.assert_array_equal(result[alpha == 0], 0)

    def test_single_native_pixel_strand_keeps_extra_detail_and_original_alpha(self):
        native = np.full((80, 80, 3), 150, np.uint8)
        native[8:72, 39] = 40  # half a registered pixel in width
        registered = cv2.resize(native, (40, 40), interpolation=cv2.INTER_AREA)
        captured = np.dstack([registered, np.full((40, 40), 255, np.uint8)])
        result, _ = fuse_native_detail(captured, native)
        enlarged = cv2.resize(registered, (80, 80), interpolation=cv2.INTER_CUBIC)
        self.assertGreater(
            int(result[40, 38, 0]) - int(result[40, 39, 0]),
            int(enlarged[40, 38, 0]) - int(enlarged[40, 39, 0]) + 50,
        )
        self.assertEqual(int(np.argmin(result[40, :, 0])), 39)
        np.testing.assert_array_equal(result[:, :, 3], 255)

    def test_all_opaque_and_deep_interior_are_legacy_byte_exact(self):
        rng = np.random.default_rng(42)
        for scale in (1, 2):
            captured = rng.integers(0, 256, (48, 56, 4), dtype=np.uint8)
            captured[:, :, 3] = 255
            native = rng.integers(0, 256, (48 * scale, 56 * scale, 3), dtype=np.uint8)
            result, audit = fuse_native_detail(captured, native)
            np.testing.assert_array_equal(result[:, :, :3], legacy(captured, native))
            self.assertEqual(audit['edgeCorrectedPixels'], 0)
        captured, native, _ = fixture()
        result, audit = fuse_native_detail(captured, native)
        np.testing.assert_array_equal(
            result[40:56, 40:72, :3], legacy(captured, native)[40:56, 40:72]
        )
        self.assertGreater(audit['legacyInteriorPixels'], 0)

    def test_soft_alpha_and_empty_foreground_are_preserved_without_expansion(self):
        captured, native, _ = fixture()
        captured[8, 8:48, 3] = 64
        result, _ = fuse_native_detail(captured, native)
        expected = cv2.resize(
            captured[:, :, 3], (112, 96), interpolation=cv2.INTER_NEAREST
        )
        np.testing.assert_array_equal(result[:, :, 3], expected)
        captured[:, :, 3] = 0
        result, audit = fuse_native_detail(captured, native)
        np.testing.assert_array_equal(result, 0)
        self.assertEqual(audit['foregroundPixels'], 0)

    def test_downscale_cannot_hide_transparency_from_color_support(self):
        for size in (32, 16):
            with self.subTest(native_size=size):
                captured = np.full((64, 64, 4), [100, 80, 60, 255], np.uint8)
                captured[31, 31] = 0
                native = np.full((size, size, 3), [120, 100, 80], np.uint8)
                expected_alpha = cv2.resize(
                    captured[:, :, 3], (size, size), interpolation=cv2.INTER_NEAREST
                )
                first, audit = fuse_native_detail(captured, native)
                captured[31, 31, :3] = [255, 20, 220]
                second, _ = fuse_native_detail(captured, native)
                np.testing.assert_array_equal(first, second)
                np.testing.assert_array_equal(first[:, :, 3], expected_alpha)
                self.assertLessEqual(
                    np.abs(
                        first[expected_alpha > 0, :3].astype(int) - [100, 80, 60]
                    ).max(),
                    1,
                )
                self.assertEqual(audit['legacyInteriorPixels'], 0)

    def test_severe_downscale_retains_sparse_registered_foreground_color(self):
        captured = np.zeros((64, 64, 4), np.uint8)
        captured[0, 0] = [100, 80, 60, 255]
        native = np.full((8, 8, 3), [120, 100, 80], np.uint8)
        result, _ = fuse_native_detail(captured, native)
        self.assertEqual(int(result[0, 0, 3]), 255)
        self.assertLessEqual(
            np.abs(result[0, 0, :3].astype(int) - [100, 80, 60]).max(), 1
        )
        np.testing.assert_array_equal(result[1:, :], 0)
        np.testing.assert_array_equal(result[:, 1:], 0)

    def test_registered_dimension_rounding_keeps_native_coordinates(self):
        # Browser downscaling can round a dimension; the decoder already accepts
        # this aspect-ratio difference. Fusion must not turn it into a failure.
        captured = np.full((201, 100, 4), [90, 70, 50, 255], np.uint8)
        native = np.full((400, 200, 3), [100, 80, 60], np.uint8)
        result, audit = fuse_native_detail(captured, native)
        self.assertEqual(result.shape, (400, 200, 4))
        self.assertEqual(audit['nativeSize'], [200, 400])
        np.testing.assert_array_equal(result[:, :, 3], 255)
        np.testing.assert_array_equal(result[:, :, :3], legacy(captured, native))

    def test_invalid_shapes_types_and_camera_scale_are_rejected(self):
        captured, native, _ = fixture()
        for bad_captured, bad_native in [
            (captured[:, :, :3], native),
            (captured.astype(float), native),
            (captured, native.astype(float)),
            (captured, native[:90]),
            (captured[:0], native),
            (captured, np.zeros((96, 112, 4), np.uint8)),
        ]:
            with self.assertRaises(ValueError):
                fuse_native_detail(bad_captured, bad_native)


if __name__ == '__main__':
    unittest.main()
