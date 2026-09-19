"""Exercise native extraction and cache compatibility through both decoder paths."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from PIL import Image

from scripts.photo_detail import prepare_detail_frames
from scripts.pipeline_accel import stream_detail_frames
from scripts.verify_texture_bake import _cached_detail


class Decoder:
    def __init__(self, rgb):
        self.bgr = rgb[:, :, ::-1].copy()
        self.position = 0
        self.released = False

    def get(self, prop):
        return 30 if prop == cv2.CAP_PROP_FPS else 0

    def set(self, prop, value):
        if prop == cv2.CAP_PROP_POS_FRAMES:
            self.position = value
        return True

    def read(self):
        if self.position != 0:
            return False, None
        self.position += 1
        return True, self.bgr.copy()

    def grab(self):
        if self.position != 0:
            return False
        self.position += 1
        return True

    def retrieve(self):
        return True, self.bgr.copy()

    def release(self):
        self.released = True


class DetailFramesTests(unittest.TestCase):
    def test_existing_versions_are_reused_without_decoding_or_modifying_inputs(self):
        for version in (2, 3):
            for function in (prepare_detail_frames, stream_detail_frames):
                with self.subTest(version=version, function=function.__name__):
                    with tempfile.TemporaryDirectory() as temp:
                        folder = Path(temp)
                        data = {
                            'version': version,
                            'frames': [{'filename': 'frame.png'}],
                        }
                        manifest = folder / 'photo-detail.json'
                        manifest.write_text(json.dumps(data, indent=3))
                        (folder / 'detail-images').mkdir()
                        image = folder / 'detail-images/frame.png'
                        image.write_bytes(b'original RGB hash bound to cleanup cache')
                        before = manifest.read_bytes(), image.read_bytes()
                        with patch(
                            'cv2.VideoCapture',
                            side_effect=AssertionError('cache decoded'),
                        ):
                            self.assertEqual(function(folder), data)
                            self.assertEqual(_cached_detail(folder), data)
                        self.assertEqual(
                            before, (manifest.read_bytes(), image.read_bytes())
                        )

    def test_fresh_capture_uses_edge_safe_fusion_and_empty_foreground_is_rejected(self):
        captured = np.zeros((48, 56, 4), np.uint8)
        captured[8:40, 8:48] = [100, 80, 60, 255]
        alpha = cv2.resize(
            captured[:, :, 3], (112, 96), interpolation=cv2.INTER_NEAREST
        )
        native = np.full((96, 112, 3), 255, np.uint8)
        native[alpha > 0] = [120, 100, 80]
        outputs = []
        for function in (prepare_detail_frames, stream_detail_frames):
            with tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                (folder / 'images').mkdir()
                (folder / 'source-video').touch()
                Image.fromarray(captured).save(folder / 'images/valid.png')
                Image.fromarray(np.zeros_like(captured)).save(
                    folder / 'images/empty.png'
                )
                (folder / 'capture.json').write_text(
                    json.dumps(
                        {
                            'frames': [
                                {'filename': name, 'timeSeconds': 0}
                                for name in ('valid.png', 'empty.png')
                            ]
                        }
                    )
                )
                decoder = Decoder(native)
                with patch('cv2.VideoCapture', return_value=decoder):
                    result = function(folder)
                self.assertTrue(decoder.released)
                self.assertEqual(result['version'], 3)
                self.assertEqual(len(result['frames']), 1)
                frame = result['frames'][0]
                self.assertEqual(frame['decodedFrame'], 0)
                self.assertEqual(frame['matchError255'], 0)
                self.assertTrue(frame['colorFusion']['alphaPreserved'])
                self.assertGreater(frame['colorFusion']['edgeCorrectedPixels'], 0)
                path = folder / 'detail-images/valid.png'
                rgb = np.asarray(Image.open(path))
                np.testing.assert_array_equal(rgb[:, :, 3], alpha)
                self.assertLessEqual(
                    np.abs(rgb[alpha > 0, :3].astype(int) - [100, 80, 60]).max(), 1
                )
                self.assertFalse((folder / 'detail-images/empty.png').exists())
                self.assertEqual(_cached_detail(folder), result)
                outputs.append((result, path.read_bytes()))
        self.assertEqual(*outputs)

    def test_verifier_refuses_unknown_versions_or_missing_cached_files(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            for data in (
                {'version': 500, 'frames': []},
                {'version': 3, 'frames': [{'filename': 'absent.png'}]},
            ):
                (folder / 'photo-detail.json').write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    _cached_detail(folder)


if __name__ == '__main__':
    unittest.main()
