"""Source scoring must not mutate the model being replaced by a reconstruction."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from head_artifacts import HeadArtifactTransaction, published_folder
from scripts import frame_evidence
from tests.head_artifacts_test import bundle


class FrameEvidenceCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / ('e' * 32)
        images = self.folder / 'images'
        images.mkdir(parents=True)
        rng = np.random.default_rng(71)
        pixels = rng.integers(30, 220, (32, 40, 4), dtype=np.uint8)
        pixels[:, :, 3] = 255
        Image.fromarray(pixels).save(images / 'frame.png')
        (self.folder / 'capture.json').write_text(
            json.dumps(
                {
                    'frames': [{'filename': 'frame.png'}],
                }
            )
        )

    def test_uncached_first_build_can_publish_its_staged_evidence(self):
        with HeadArtifactTransaction(self.folder) as tx:
            measured = frame_evidence.assess_frames(self.folder)
            self.assertFalse((self.folder / 'frame-evidence.json').exists())
            staged = frame_evidence.assess_frames(self.folder, output_folder=tx.stage)
            self.assertEqual(measured, staged)
            bundle(tx.stage)
            release = tx.commit()
        self.assertIn('frame-evidence.json', release['files'])
        self.assertEqual(
            json.loads(
                (published_folder(self.folder) / 'frame-evidence.json').read_text()
            )['frames'],
            measured,
        )
        self.assertTrue((self.folder / 'frame-evidence-cache.json').exists())
        self.assertFalse((self.folder / 'frame-evidence.json').exists())

    def test_stale_legacy_audit_is_never_modified_during_reconstruction(self):
        bundle(self.folder)
        legacy = self.folder / 'frame-evidence.json'
        accepted = '{"version": 1, "inputHash": "old", "frames": {}}'
        legacy.write_text(accepted)
        with HeadArtifactTransaction(self.folder) as tx:
            measured = frame_evidence.assess_frames(self.folder)
            frame_evidence.assess_frames(self.folder, output_folder=tx.stage)
            self.assertEqual(legacy.read_text(), accepted)
            self.assertIn('frame.png', measured)
            bundle(tx.stage)
            tx.commit()
        self.assertEqual(legacy.read_text(), accepted)

    def test_matching_legacy_cache_is_reused_without_rescoring_or_rewriting(self):
        measured = frame_evidence.assess_frames(self.folder)
        source = self.folder / 'frame-evidence-cache.json'
        legacy = self.folder / 'frame-evidence.json'
        source.replace(legacy)
        accepted = legacy.read_bytes()
        with patch.object(
            frame_evidence.cv2, 'resize', side_effect=AssertionError('rescored')
        ):
            self.assertEqual(frame_evidence.assess_frames(self.folder), measured)
        self.assertEqual(legacy.read_bytes(), accepted)
        self.assertEqual(source.read_bytes(), accepted)

    def test_concurrent_uncached_readers_publish_one_complete_source_cache(self):
        resize = frame_evidence.cv2.resize
        readers = threading.Barrier(4)

        def together(*args, **kwargs):
            readers.wait(timeout=3)
            return resize(*args, **kwargs)

        with patch.object(frame_evidence.cv2, 'resize', side_effect=together):
            with ThreadPoolExecutor(4) as pool:
                results = list(
                    pool.map(
                        lambda _: frame_evidence.assess_frames(self.folder), range(4)
                    )
                )
        self.assertTrue(all(value == results[0] for value in results))
        cache = json.loads((self.folder / 'frame-evidence-cache.json').read_text())
        self.assertEqual(cache['frames'], results[0])
        self.assertFalse((self.folder / 'frame-evidence.json').exists())
        self.assertEqual(list(self.folder.glob('.frame-evidence-*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
