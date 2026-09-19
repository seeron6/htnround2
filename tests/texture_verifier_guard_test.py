"""Private-candidate verification must protect borrowed capture inputs too."""

from pathlib import Path
import tempfile
import unittest

from scripts.verify_texture_bake import _offline_source_guard


class BorrowedInputGuardTests(unittest.TestCase):
    def test_borrowed_directory_and_video_are_read_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate, capture, output = (
                root / name for name in ('candidate', 'capture', 'output')
            )
            for path in (candidate, capture, output):
                path.mkdir()
            (capture / 'images').mkdir()
            image = capture / 'images' / 'frame.png'
            image.write_bytes(b'original')
            video = capture / 'source-video'
            video.write_bytes(b'video')
            (candidate / 'images').symlink_to(
                capture / 'images', target_is_directory=True
            )
            (candidate / 'source-video').symlink_to(video)
            with _offline_source_guard(candidate):
                self.assertEqual(
                    (candidate / 'images' / 'frame.png').read_bytes(), b'original'
                )
                for path in (
                    image,
                    candidate / 'images' / 'frame.png',
                    video,
                    candidate / 'source-video',
                ):
                    with self.assertRaisesRegex(RuntimeError, 'modify source'):
                        path.write_bytes(b'overwritten')
                with self.assertRaisesRegex(RuntimeError, 'modify source'):
                    image.unlink()
                (output / 'new.png').write_bytes(b'new')
            self.assertEqual(image.read_bytes(), b'original')
            self.assertEqual(video.read_bytes(), b'video')
            self.assertEqual((output / 'new.png').read_bytes(), b'new')
