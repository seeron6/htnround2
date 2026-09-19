"""Unmasked evidence must retain real cutout losses and match registered frames."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from PIL import Image
from scripts.source_observations import matched_video_observation


class Decoder:
    def __init__(self, rgb, rotation=0, readable=True):
        self.rgb, self.rotation, self.readable = rgb, rotation, readable
        self.position, self.released = None, False

    def get(self, key):
        return self.rotation if key == cv2.CAP_PROP_ORIENTATION_META else 0

    def set(self, key, value):
        if key == cv2.CAP_PROP_POS_FRAMES:
            self.position = value

    def read(self):
        return self.readable, self.rgb[:, :, ::-1].copy()

    def release(self):
        self.released = True


class SourceObservationTests(unittest.TestCase):
    def fixture(self, folder):
        # Asymmetric spatial variation distinguishes a wrong or rotated frame
        # from a global decoder color offset, which the matcher permits.
        y, x = np.mgrid[:40, :60]
        rgb = np.stack([30 + x * 3, 20 + y * 4, 40 + x + y], axis=-1).astype(np.uint8)
        registered = np.dstack([rgb, np.full((40, 60), 255, np.uint8)])
        registered[:, :12] = 0  # Includes a real source feature omitted by the matte.
        (folder / 'images').mkdir()
        Image.fromarray(registered).save(folder / 'images/frame.png')
        (folder / 'source-video').touch()
        (folder / 'photo-detail.json').write_text(
            json.dumps(
                {
                    'version': 3,
                    'frames': [
                        {'filename': 'frame.png', 'decodedFrame': 7, 'size': [60, 40]}
                    ],
                }
            )
        )
        return rgb

    def test_unmasked_pixels_retained_and_inputs_byte_identical(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            rgb = self.fixture(folder)
            before = {
                str(p.relative_to(folder)): p.read_bytes()
                for p in folder.rglob('*')
                if p.is_file()
            }
            decoder = Decoder(rgb)
            with patch('cv2.VideoCapture', return_value=decoder):
                output, audit = matched_video_observation(folder, 'frame.png')
            after = {
                str(p.relative_to(folder)): p.read_bytes()
                for p in folder.rglob('*')
                if p.is_file()
            }
            self.assertEqual(before, after)
        np.testing.assert_array_equal(output, rgb)
        self.assertTrue(np.any(output[:, :12]))
        self.assertFalse(audit['segmented'])
        self.assertEqual(audit['matchError255'], 0)
        self.assertEqual(decoder.position, 7)
        self.assertTrue(decoder.released)

    def test_orientation_uses_the_same_registered_pixel_coordinates(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            rgb = self.fixture(folder)
            decoder = Decoder(np.rot90(rgb, 1).copy(), rotation=90)
            with patch('cv2.VideoCapture', return_value=decoder):
                output, audit = matched_video_observation(folder, 'frame.png')
        np.testing.assert_array_equal(output, rgb)
        self.assertEqual(audit['rotationDegrees'], 90)
        self.assertTrue(decoder.released)

    def test_changed_video_or_bad_dimensions_are_rejected(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            rgb = self.fixture(folder)
            for bad in [rgb[:, ::-1], rgb[:-1]]:
                decoder = Decoder(bad)
                with patch('cv2.VideoCapture', return_value=decoder):
                    with self.assertRaises(ValueError):
                        matched_video_observation(folder, 'frame.png')
                self.assertTrue(decoder.released)

    def test_missing_video_or_matching_record_is_not_invented(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            image, audit = matched_video_observation(folder, 'frame.png')
            self.assertIsNone(image)
            self.assertFalse(audit['available'])
            self.fixture(folder)
            with patch(
                'cv2.VideoCapture', side_effect=AssertionError('No decoder needed')
            ):
                image, audit = matched_video_observation(folder, 'missing.png')
            self.assertIsNone(image)
            self.assertFalse(audit['available'])

    def test_failed_decode_releases_native_resource(self):
        with TemporaryDirectory() as temp:
            folder = Path(temp)
            rgb = self.fixture(folder)
            decoder = Decoder(rgb, readable=False)
            with patch('cv2.VideoCapture', return_value=decoder):
                with self.assertRaisesRegex(ValueError, 'Cannot decode'):
                    matched_video_observation(folder, 'frame.png')
            self.assertTrue(decoder.released)


if __name__ == '__main__':
    unittest.main()
