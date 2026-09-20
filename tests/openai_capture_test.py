"""Retry only temporary throttling, without leaking error bodies or replaying batches."""

import io
import json
import threading
import unittest
from email.utils import formatdate
from unittest.mock import patch
from urllib.error import HTTPError

import openai_capture
from scripts.astra_head_completion import obj, num
from scripts.parallel_annotations import request_views


def failure(code='rate_limit_exceeded', retry_after=None, *, body=None, status=429):
    if body is None:
        body = json.dumps(
            {'error': {'code': code, 'message': 'sk-secret data:image/private-frame'}}
        ).encode()
    headers = {} if retry_after is None else {'Retry-After': retry_after}
    return HTTPError(
        'https://api.openai.com/v1/responses',
        status,
        'sk-secret',
        headers,
        io.BytesIO(body),
    )


def success(result=None):
    return io.BytesIO(
        json.dumps(
            {
                'status': 'completed',
                'output': [
                    {
                        'content': [
                            {
                                'type': 'output_text',
                                'text': json.dumps(result or {'connected': True}),
                            }
                        ]
                    }
                ],
            }
        ).encode()
    )


class OpenAICaptureRetryTests(unittest.TestCase):
    def setUp(self):
        self.config = patch.object(
            openai_capture, 'config', return_value=('sk-secret', 'gpt-6-astra')
        )
        self.config.start()
        self.addCleanup(self.config.stop)
        self.pause = patch.object(openai_capture.time, 'sleep')
        self.sleep = self.pause.start()
        self.addCleanup(self.pause.stop)
        self.jitter = patch.object(openai_capture.random, 'uniform', return_value=0.125)
        self.jitter.start()
        self.addCleanup(self.jitter.stop)

    def test_temporary_limit_retries_same_payload_and_preserves_quality_settings(self):
        content = [
            {'type': 'input_image', 'detail': 'high', 'image_url': 'private-frame'}
        ]
        with patch.object(
            openai_capture, 'urlopen', side_effect=[failure(retry_after='1'), success()]
        ) as call:
            result = openai_capture.request(
                content,
                model_override='gpt-6-astra',
                reasoning='low',
                max_output_tokens=32000,
                timeout=600,
            )
        self.assertEqual(result, {'connected': True})
        self.assertEqual(call.call_count, 2)
        original, retry = [item.args[0] for item in call.call_args_list]
        self.assertIs(original, retry)
        payload = json.loads(retry.data)
        self.assertEqual(payload['input'][0]['content'], content)
        self.assertEqual(payload['model'], 'gpt-6-astra')
        self.assertEqual(payload['reasoning'], {'effort': 'low'})
        self.assertEqual(payload['max_output_tokens'], 32000)
        self.assertFalse(payload['store'])
        self.sleep.assert_called_once_with(1.125)

    def test_quota_codes_and_types_never_retry_or_expose_provider_text(self):
        cases = [
            {'code': 'insufficient_quota'},
            {'code': 'credit_balance_exhausted'},
            {'code': 'organization_spend_limit_exceeded'},
            {'code': 'project_spend_limit_exceeded'},
            {'code': 'organization_usage_limit_exceeded'},
            {'code': 'rate_limit_exceeded', 'type': 'insufficient_quota'},
        ]
        for detail in cases:
            with self.subTest(detail=detail):
                detail['message'] = 'sk-secret data:image/private-frame'
                with patch.object(
                    openai_capture,
                    'urlopen',
                    side_effect=failure(
                        retry_after='1', body=json.dumps({'error': detail}).encode()
                    ),
                ) as call:
                    with self.assertRaisesRegex(
                        ValueError, 'quota or billing'
                    ) as caught:
                        openai_capture.request([])
                self.assertEqual(call.call_count, 1)
                self.assertIsInstance(
                    caught.exception, openai_capture.OpenAIRateLimitError
                )
                self.assertEqual(caught.exception.kind, 'quota')
                self.assertNotIn('sk-secret', str(caught.exception))
                self.assertNotIn('private-frame', str(caught.exception))
        self.sleep.assert_not_called()

    def test_retries_are_bounded_and_backoff_increases_without_retry_after(self):
        errors = [failure() for _ in range(3)]
        with patch.object(openai_capture, 'urlopen', side_effect=errors) as call:
            with self.assertRaisesRegex(
                openai_capture.OpenAIRateLimitError, 'temporary rate limit'
            ):
                openai_capture.request([])
        self.assertEqual(call.call_count, 3)
        self.assertEqual(
            [item.args[0] for item in self.sleep.call_args_list], [1.125, 2.125]
        )
        self.assertTrue(all(error.fp.closed for error in errors))

    def test_long_server_delays_are_not_shortened_to_force_a_retry(self):
        with patch.object(
            openai_capture, 'urlopen', side_effect=failure(retry_after='60')
        ) as call:
            with self.assertRaisesRegex(ValueError, 'temporary rate limit'):
                openai_capture.request([])
        self.assertEqual(call.call_count, 1)
        self.sleep.assert_not_called()

    def test_wait_budget_is_capped_even_with_repeated_maximum_server_delay(self):
        with (
            patch.object(
                openai_capture.random, 'uniform', side_effect=lambda low, high: high
            ),
            patch.object(
                openai_capture,
                'urlopen',
                side_effect=[failure(retry_after='10') for _ in range(3)],
            ) as call,
        ):
            with self.assertRaisesRegex(ValueError, 'temporary rate limit'):
                openai_capture.request([], timeout=600)
        self.assertEqual(call.call_count, 3)
        self.assertEqual(
            [item.args[0] for item in self.sleep.call_args_list], [10.0, 10.0]
        )

    def test_retry_after_http_date_and_invalid_header_fallback(self):
        for header, expected in [
            (formatdate(1005, usegmt=True), 5.125),
            ('broken header sk-secret', 1.125),
            ('nan', 1.125),
            ('-10', 1.125),
        ]:
            with self.subTest(header=header):
                self.sleep.reset_mock()
                with (
                    patch.object(openai_capture.time, 'time', return_value=1000),
                    patch.object(
                        openai_capture,
                        'urlopen',
                        side_effect=[failure(retry_after=header), success()],
                    ),
                ):
                    openai_capture.request([])
                self.sleep.assert_called_once_with(expected)

    def test_retry_does_not_extend_the_callers_overall_timeout(self):
        with (
            patch.object(openai_capture.time, 'monotonic', side_effect=[100, 100.5]),
            patch.object(
                openai_capture, 'urlopen', side_effect=failure(retry_after='1')
            ) as call,
        ):
            with self.assertRaisesRegex(ValueError, 'temporary rate limit'):
                openai_capture.request([], timeout=1)
        self.assertEqual(call.call_count, 1)
        self.sleep.assert_not_called()

    def test_retry_socket_timeout_uses_only_the_remaining_total_budget(self):
        with (
            patch.object(openai_capture.time, 'monotonic', side_effect=[100, 100, 102]),
            patch.object(
                openai_capture,
                'urlopen',
                side_effect=[failure(retry_after='1'), success()],
            ) as call,
        ):
            openai_capture.request([], timeout=60)
        self.assertEqual(
            [item.kwargs['timeout'] for item in call.call_args_list], [60, 58]
        )

    def test_unknown_or_malformed_errors_are_sanitized_and_not_retried(self):
        for body in [
            b'private-frame sk-secret',
            json.dumps(
                {'error': {'code': 'sk-secret', 'message': 'private-frame'}}
            ).encode(),
            b'{"error": {"code": ["rate_limit_exceeded"]}}',
            b'{"error": "sk-secret"}',
            b'[]',
        ]:
            with self.subTest(body=body):
                with patch.object(
                    openai_capture, 'urlopen', side_effect=failure(body=body)
                ) as call:
                    with self.assertRaises(ValueError) as caught:
                        openai_capture.request([])
                self.assertEqual(call.call_count, 1)
                self.assertNotIn('sk-secret', str(caught.exception))
                self.assertNotIn('private-frame', str(caught.exception))
        self.sleep.assert_not_called()

    def test_only_the_throttled_annotation_batch_is_repeated(self):
        schema = obj(
            {
                'assessment': {'type': 'string'},
                'views': {
                    'type': 'array',
                    'items': obj(
                        {'filename': {'type': 'string'}, 'confidence': num(0, 1)}
                    ),
                },
            }
        )
        counts = {}
        lock = threading.Lock()

        def upstream(request, **options):
            schema = json.loads(request.data)['text']['format']['schema']
            names = (
                schema['properties']['views']['items']['properties']['filename']['enum']
                if 'views' in schema['properties']
                else []
            )
            batch = names[0] if names else 'globals'
            with lock:
                counts[batch] = counts.get(batch, 0) + 1
                attempt = counts[batch]
            if batch == 'b' and attempt == 1:
                raise failure(retry_after='1')
            result = {}
            if names:
                result['views'] = [
                    {'filename': name, 'confidence': 0.9} for name in names
                ]
            if 'assessment' in schema['properties']:
                result['assessment'] = 'All views inspected.'
            return success(result)

        with patch.object(openai_capture, 'urlopen', side_effect=upstream):
            result = request_views([], schema, ['a', 'b', 'c'], openai_capture.request)
        self.assertEqual(counts, {'a': 1, 'b': 2, 'c': 1, 'globals': 1})
        self.assertEqual(result['assessment'], 'All views inspected.')
        self.assertEqual(
            [view['filename'] for view in result['views']], ['a', 'b', 'c']
        )


if __name__ == '__main__':
    unittest.main()
