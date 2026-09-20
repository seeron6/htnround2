"""Hair annotations publish only after every full-context batch is valid."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
from scripts.hair_recognition import MODEL, VERSION, recognize_hair
from scripts.head_semantics import analyze
from scripts.astra_head_completion import complete


def example(schema):
    if 'enum' in schema:
        return schema['enum'][0]
    kind = schema['type']
    if kind == 'object':
        return {key: example(value) for key, value in schema['properties'].items()}
    if kind == 'array':
        return [example(schema['items']) for _ in range(schema.get('minItems', 0))]
    if kind == 'number':
        return (schema['minimum'] + schema['maximum']) / 2
    if kind == 'boolean':
        return True
    return 'Observed multiview hair.'


class HairRecognitionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        (self.folder / 'images').mkdir()
        self.names = [f'{index}.png' for index in range(6)]
        for index, name in enumerate(self.names):
            Image.new('RGBA', (20, 30), (index * 30, 50, 90, 255)).save(
                self.folder / 'images' / name
            )
        self.completion = {
            'views': [{'filename': name} for name in self.names],
            'crops': {name: [0, 0, 20, 30] for name in self.names},
        }

    def request(self, content, schema, **options):
        self.assertEqual(options['model_override'], MODEL)
        self.assertEqual(options['reasoning'], 'low')
        self.assertEqual(options['max_output_tokens'], 8192)
        images = [item for item in content if item['type'] == 'input_image']
        self.assertEqual(len(images), len(self.names))
        self.assertTrue(all(item['detail'] == 'high' for item in images))
        result = example(schema)
        if 'views' in result:
            names = schema['properties']['views']['items']['properties']['filename'][
                'enum'
            ]
            for view, name in zip(result['views'], reversed(names)):
                view['filename'] = name
        return result

    def test_complete_results_are_merged_cached_and_reused(self):
        with patch(
            'scripts.hair_recognition.request', side_effect=self.request
        ) as call:
            result = recognize_hair(self.folder, self.completion)
            self.assertEqual(call.call_count, len(self.names) + 1)

            self.assertEqual(result['version'], VERSION)
            self.assertEqual(result['framesSent'], len(self.names))
            self.assertEqual([view['filename'] for view in result['views']], self.names)
            self.assertIn('hair', result)
            self.assertIn('evidence', result)
            self.assertEqual(recognize_hair(self.folder, self.completion), result)
            self.assertEqual(call.call_count, len(self.names) + 1)

    def test_head_completion_splits_all_views_and_reuses_only_complete_artifact(self):
        frames = [
            {'filename': name, 'landmarks': [0], 'yaw': yaw}
            for name, yaw in zip(self.names, [-85, -60, -30, 0, 30, 60])
        ]
        (self.folder / 'capture.json').write_text(json.dumps({'frames': frames}))
        with patch(
            'scripts.astra_head_completion.request', side_effect=self.request
        ) as call:
            result = complete(self.folder, {})
            self.assertEqual(call.call_count, len(self.names) + 1)
            self.assertEqual(
                {view['filename'] for view in result['views']}, set(self.names)
            )
            self.assertEqual(result['frontFilename'], self.names[3])
            for field in ['head', 'hair', 'glasses', 'crops', 'unobservedParts']:
                self.assertIn(field, result)
            self.assertEqual(complete(self.folder, {}), result)
            self.assertEqual(call.call_count, len(self.names) + 1)

    def test_failed_or_invalid_batch_never_replaces_a_previous_cache(self):
        path = self.folder / 'hair-recognition.json'
        previous = {'inputHash': 'old-input', 'sentinel': 'keep previous artifact'}
        for failure in ['request', 'duplicate', 'invalid-point']:
            with self.subTest(failure=failure):
                path.write_text(json.dumps(previous))

                def request(content, schema, **options):
                    result = self.request(content, schema, **options)
                    if 'hair' not in result:
                        if failure == 'request':
                            raise TimeoutError('upstream timed out')
                        if failure == 'duplicate':
                            result['views'].append(result['views'][0])
                        if failure == 'invalid-point':
                            result['views'][0]['flowPaths'] = [[[0, 0], [0, 0], [2, 0]]]
                    return result

                with patch('scripts.hair_recognition.request', side_effect=request):
                    with self.assertRaises((ValueError, TimeoutError)):
                        recognize_hair(self.folder, self.completion)
                self.assertEqual(json.loads(path.read_text()), previous)

    def test_semantics_preserves_all_context_and_caches_only_complete_results(self):
        calls = []

        def request(content, schema, **options):
            self.assertEqual(options['model_override'], MODEL)
            self.assertEqual(options['reasoning'], 'low')
            self.assertEqual(options['max_output_tokens'], 8192)
            images = [item for item in content if item['type'] == 'input_image']
            self.assertEqual(len(images), len(self.names))
            self.assertTrue(all(item['detail'] == 'high' for item in images))
            calls.append(content[:-1])
            result = example(schema)
            if 'views' in result:
                names = schema['properties']['views']['items']['properties'][
                    'filename'
                ]['enum']
                for view, name in zip(result['views'], reversed(names)):
                    view['filename'] = name
            return result

        def detail_image(folder, name):
            return np.asarray(Image.open(folder / 'images' / name).convert('RGBA'))

        with (
            patch('scripts.head_semantics.prepare_detail_frames'),
            patch('scripts.head_semantics.detail_image', side_effect=detail_image),
            patch('scripts.head_semantics.request', side_effect=request) as call,
        ):
            result = analyze(self.folder, self.completion)
            self.assertEqual(call.call_count, len(self.names) + 1)
            self.assertEqual(result['version'], 2)
            self.assertEqual(result['crops'], self.completion['crops'])
            self.assertEqual([view['filename'] for view in result['views']], self.names)
            self.assertEqual(calls[0], calls[1])
            self.assertEqual(calls[1], calls[2])
            self.assertEqual(analyze(self.folder, self.completion), result)
            self.assertEqual(call.call_count, len(self.names) + 1)
            path = self.folder / 'head-semantics.json'
            cached_bytes = path.read_bytes()
            changed = self.folder / 'images' / self.names[0]
            Image.new('RGBA', (20, 30), (30, 90, 30, 255)).save(changed)
            call.side_effect = TimeoutError('incomplete semantic review')
            with self.assertRaises(TimeoutError):
                analyze(self.folder, self.completion)
            self.assertEqual(path.read_bytes(), cached_bytes)


if __name__ == '__main__':
    unittest.main()
