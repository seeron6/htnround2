"""Output batches keep all evidence and reject incomplete annotation sets."""

import copy
import math
import threading
import tempfile
from pathlib import Path
import unittest

from scripts.astra_head_completion import obj, num
from scripts.parallel_annotations import request_views

SCHEMA = obj(
    {
        'assessment': {'type': 'string'},
        'views': {
            'type': 'array',
            'items': obj({'filename': {'type': 'string'}, 'confidence': num(0, 1)}),
        },
    }
)


def response(schema):
    names = (
        schema['properties']
        .get('views', {})
        .get('items', {})
        .get('properties', {})
        .get('filename', {})
        .get('enum', [])
    )
    result = {}
    if 'views' in schema['properties']:
        result['views'] = [
            {'filename': name, 'confidence': 0.75} for name in reversed(names)
        ]
    if 'assessment' in schema['properties']:
        result['assessment'] = 'All images compared.'
    return result


class ParallelAnnotationsTests(unittest.TestCase):
    def test_overlapping_batches_keep_all_images_and_merge_in_original_order(self):
        names = [f'view-{index}.png' for index in range(8)]
        content = [{'type': 'input_text', 'text': 'Original precise instructions.'}]
        content += [
            {'type': 'input_image', 'detail': 'high', 'image_url': name}
            for name in names
        ]
        original_content, original_schema = copy.deepcopy(content), copy.deepcopy(
            SCHEMA
        )
        rendezvous = threading.Barrier(9)
        calls = []

        def request(batch_content, batch_schema, **options):
            calls.append((batch_content, batch_schema, options))
            rendezvous.wait(timeout=3)  # Fails if the batches run serially.
            return response(batch_schema)

        options = dict(
            model_override='gpt-6-astra', reasoning='low', max_output_tokens=32000
        )
        result = request_views(content, SCHEMA, names, request, **options)
        self.assertEqual([view['filename'] for view in result['views']], names)
        self.assertEqual(result['assessment'], 'All images compared.')
        self.assertEqual(len(calls), 9)
        for batch_content, batch_schema, batch_options in calls:
            self.assertEqual(batch_content[:-1], original_content)
            self.assertEqual(batch_options, {**options, 'max_output_tokens': 8192})
            if 'views' in batch_schema['properties']:
                self.assertEqual(
                    batch_schema['properties']['views']['items']['properties'][
                        'confidence'
                    ],
                    num(0, 1),
                )
                self.assertEqual(batch_schema['properties']['views']['maxItems'], 1)
        self.assertEqual(
            sum('assessment' in schema['properties'] for _, schema, _ in calls), 1
        )
        self.assertEqual(content, original_content)
        self.assertEqual(SCHEMA, original_schema)

    def test_invalid_or_incomplete_outputs_are_rejected(self):
        names = [f'{index}.png' for index in range(6)]
        for defect in ['duplicate', 'missing', 'unknown', 'nan', 'bounds', 'global']:
            with self.subTest(defect=defect):

                def request(content, schema, **options):
                    result = response(schema)
                    if 'views' in result:
                        if defect == 'duplicate':
                            result['views'].append(result['views'][0])
                        elif defect == 'missing':
                            result['views'].pop()
                        elif defect == 'unknown':
                            result['views'][0]['filename'] = 'unrequested.png'
                        elif defect == 'nan':
                            result['views'][0]['confidence'] = math.nan
                        elif defect == 'bounds':
                            result['views'][0]['confidence'] = 1.1
                    if defect == 'global' and 'assessment' in result:
                        del result['assessment']
                    return result

                with self.assertRaises(ValueError):
                    request_views([], SCHEMA, names, request)

    def test_request_failure_propagates_without_partial_result(self):
        def request(content, schema, **options):
            if 'assessment' not in schema['properties']:
                raise TimeoutError('upstream timed out')
            return response(schema)

        with self.assertRaisesRegex(TimeoutError, 'upstream timed out'):
            request_views([], SCHEMA, ['a', 'b', 'c'], request)

    def test_one_view_keeps_global_and_per_view_fields_separate(self):
        calls = []

        def request(content, schema, **options):
            calls.append(schema)
            return response(schema)

        result = request_views([], SCHEMA, ['only.png'], request)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result['views'][0]['filename'], 'only.png')
        self.assertIn('assessment', result)

    def test_retry_reuses_successful_parts_but_never_publishes_partial_result(self):
        calls = []
        failing = True

        def request(content, schema, **options):
            result = response(schema)
            name = result.get('views', [{}])[0].get('filename', 'global')
            calls.append(name)
            if failing and name == 'b':
                raise TimeoutError('upstream timed out')
            return result

        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            with self.assertRaises(TimeoutError):
                request_views([], SCHEMA, ['a', 'b', 'c'], request, cache=cache)
            self.assertEqual(len(list(cache.glob('*.json'))), 3)
            failing = False
            result = request_views([], SCHEMA, ['a', 'b', 'c'], request, cache=cache)
            self.assertEqual(
                [view['filename'] for view in result['views']], ['a', 'b', 'c']
            )
            self.assertEqual(calls.count('b'), 2)
            for name in ['a', 'c', 'global']:
                self.assertEqual(calls.count(name), 1)
            # A changed photo invalidates every request that used that evidence.
            request_views(
                [{'type': 'input_image', 'image_url': 'changed'}],
                SCHEMA,
                ['a', 'b', 'c'],
                request,
                cache=cache,
            )
            self.assertEqual(len(calls), 9)


if __name__ == '__main__':
    unittest.main()
