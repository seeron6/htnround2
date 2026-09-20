"""Native sampling preserves timestamps, orientation and decoded source pixels."""

import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import shutil
import subprocess

import cv2
import numpy as np
from scripts.video_frames import decode


class VideoFramesTests(unittest.TestCase):
    @unittest.skipUnless(
        shutil.which('ffmpeg'), 'ffmpeg is needed to write phone rotation metadata'
    )
    def test_phone_display_rotation_is_applied_once_before_tracking(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source_path = folder / 'landscape.mp4'
            writer = cv2.VideoWriter(
                str(source_path), cv2.VideoWriter_fourcc(*'mp4v'), 20, (160, 96)
            )
            self.assertTrue(writer.isOpened())
            for _ in range(80):
                pixels = np.zeros((96, 160, 3), np.uint8)
                pixels[:48, :80] = [0, 0, 255]
                pixels[:48, 80:] = [0, 255, 0]
                pixels[48:, :80] = [255, 0, 0]
                pixels[48:, 80:] = [80, 120, 200]
                writer.write(pixels)
            writer.release()
            source = cv2.VideoCapture(str(source_path))
            ok, unrotated = source.read()
            self.assertTrue(ok)
            source.release()
            capture = cv2.VideoCapture
            for rotation in [0, 90, 180, 270]:
                for default_auto in [0, 1]:
                    with self.subTest(rotation=rotation, default_auto=default_auto):
                        tagged = folder / 'tagged.mp4'
                        subprocess.run(
                            [
                                'ffmpeg',
                                '-v',
                                'error',
                                '-y',
                                '-display_rotation',
                                str(rotation),
                                '-i',
                                str(source_path),
                                '-c',
                                'copy',
                                str(tagged),
                            ],
                            check=True,
                            capture_output=True,
                        )
                        tagged.replace(folder / 'source-video')

                        def open_video(path):
                            decoder = capture(path)
                            decoder.set(cv2.CAP_PROP_ORIENTATION_AUTO, default_auto)
                            return decoder

                        with patch(
                            'scripts.video_frames.cv2.VideoCapture',
                            side_effect=open_video,
                        ):
                            result = decode(folder)
                        expected = np.rot90(unrotated, rotation // 90)
                        self.assertTrue(result['orientationApplied'])
                        self.assertEqual(
                            (result['height'], result['width']), expected.shape[:2]
                        )
                        for frame in result['frames']:
                            actual = cv2.imdecode(
                                np.frombuffer(
                                    base64.b64decode(frame['image'].split(',')[1]),
                                    np.uint8,
                                ),
                                cv2.IMREAD_COLOR,
                            )
                            np.testing.assert_array_equal(actual, expected)

    def test_samples_match_the_source_at_the_reported_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            path = folder / 'source.avi'
            writer = cv2.VideoWriter(
                str(path), cv2.VideoWriter_fourcc(*'MJPG'), 20, (96, 160)
            )
            self.assertTrue(writer.isOpened())
            for i in range(80):
                frame = np.zeros((160, 96, 3), np.uint8)
                frame[:] = [i * 2, 60, 190]
                frame[10:50, 20:60] = [0, 255, 0]
                writer.write(frame)
            writer.release()
            path.rename(folder / 'source-video')
            result = decode(folder)
            self.assertEqual(len(result['frames']), 48)
            times = [frame['timeSeconds'] for frame in result['frames']]
            self.assertEqual(times, sorted(set(times)))
            source = cv2.VideoCapture(str(folder / 'source-video'))
            try:
                for frame in result['frames']:
                    source.set(
                        cv2.CAP_PROP_POS_FRAMES, round(frame['timeSeconds'] * 20)
                    )
                    ok, expected = source.read()
                    self.assertTrue(ok)
                    actual = cv2.imdecode(
                        np.frombuffer(
                            base64.b64decode(frame['image'].split(',')[1]), np.uint8
                        ),
                        cv2.IMREAD_COLOR,
                    )
                    self.assertEqual(actual.shape, (160, 96, 3))
                    np.testing.assert_array_equal(actual, expected)
            finally:
                source.release()

    def test_missing_video_fails_without_returning_partial_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                decode(Path(tmp))

    def test_large_samples_preserve_resized_pixels_and_png_quality(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            path = folder / 'source.avi'
            writer = cv2.VideoWriter(
                str(path), cv2.VideoWriter_fourcc(*'MJPG'), 16, (1440, 810)
            )
            self.assertTrue(writer.isOpened())
            # Every frame differs, including high-frequency edges, so this
            # catches reordered samples and changes to resize or PNG settings.
            pixels = np.zeros((810, 1440, 3), np.uint8)
            for i in range(48):
                pixels[:] = [i * 4, 60, 190]
                pixels[:, i * 13 : i * 13 + 80 : 2] = [30, 240, 0]
                writer.write(pixels)
            writer.release()
            path.rename(folder / 'source-video')
            result = decode(folder)
            self.assertEqual((result['width'], result['height']), (1280, 720))
            self.assertEqual(len(result['frames']), 48)
            source = cv2.VideoCapture(str(folder / 'source-video'))
            try:
                for index, frame in enumerate(result['frames']):
                    self.assertEqual(frame['timeSeconds'], index / 16)
                    ok, expected = source.read()
                    self.assertTrue(ok)
                    expected = cv2.resize(
                        expected, (1280, 720), interpolation=cv2.INTER_AREA
                    )
                    ok, encoded = cv2.imencode(
                        '.png', expected, [cv2.IMWRITE_PNG_COMPRESSION, 1]
                    )
                    self.assertTrue(ok)
                    self.assertEqual(
                        frame['image'],
                        'data:image/png;base64,' + base64.b64encode(encoded).decode(),
                    )
            finally:
                source.release()


if __name__ == '__main__':
    unittest.main()
