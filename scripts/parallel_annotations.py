"""Parallel output batches that each retain the complete multiview input."""

import copy
import hashlib
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from face_pipeline import atomic


def _validate(value, schema, path='annotation'):
    """Check the bounded JSON types used by the photographic annotation schemas."""
    kind = schema['type']
    valid = {
        'object': lambda: isinstance(value, dict),
        'array': lambda: isinstance(value, list),
        'string': lambda: isinstance(value, str),
        'boolean': lambda: isinstance(value, bool),
        'number': lambda: type(value) in (int, float) and math.isfinite(value),
    }[kind]()
    if not valid:
        raise ValueError(f'Invalid {path}: expected {kind}.')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(f'Invalid {path}: value is outside the allowed set.')
    if kind == 'object':
        properties = schema['properties']
        if not set(schema.get('required', [])).issubset(value) or (
            schema.get('additionalProperties') is False
            and not set(value).issubset(properties)
        ):
            raise ValueError(f'Invalid {path}: mismatched fields.')
        for key, item in value.items():
            if key in properties:
                _validate(item, properties[key], f'{path}.{key}')
    elif kind == 'array':
        if (
            not schema.get('minItems', 0)
            <= len(value)
            <= schema.get('maxItems', math.inf)
        ):
            raise ValueError(f'Invalid {path}: mismatched item count.')
        for index, item in enumerate(value):
            _validate(item, schema['items'], f'{path}[{index}]')
    elif kind == 'number' and not schema.get(
        'minimum', -math.inf
    ) <= value <= schema.get('maximum', math.inf):
        raise ValueError(f'Invalid {path}: number is outside the allowed range.')


def request_views(
    content,
    schema,
    names,
    request_fn,
    *,
    workers=9,
    label='annotations',
    cache=None,
    **options,
):
    """Return one validated annotation set, with no partial publication.

    Each request sees every original image at its original quality. Only the
    output filenames are partitioned. Global fields get an independent request
    so the first view is not delayed by the head/style assessment. Merge in input
    order and publish only after every part passes validation.
    """
    names = list(names)
    if not names or len(set(names)) != len(names):
        raise ValueError('Annotations require unique, nonempty source filenames.')
    if type(workers) is not int or not 1 <= workers <= 9:
        raise ValueError('Annotation workers must be between one and nine.')
    count = min(workers, len(names))
    batches = [names[index::count] for index in range(count)]

    globals_schema = copy.deepcopy(schema)
    globals_schema['properties'].pop('views')
    globals_schema['required'] = [
        key for key in globals_schema['required'] if key != 'views'
    ]

    def validate_part(result, part_schema):
        _validate(result, part_schema)
        if 'views' in result:
            returned = [view['filename'] for view in result['views']]
            expected = part_schema['properties']['views']['items']['properties'][
                'filename'
            ]['enum']
            if len(returned) != len(set(returned)) or set(returned) != set(expected):
                raise ValueError('Annotations returned mismatched source frames.')

    def call(instruction, part_schema, view_count):
        part_content = [*content, {'type': 'input_text', 'text': instruction}]
        part_options = options.copy()
        if 'max_output_tokens' in options:
            # Keep room for reasoning and all original contour vertices, without
            # reserving the entire multiview response budget for every crop.
            part_options['max_output_tokens'] = min(
                options['max_output_tokens'],
                max(
                    8192,
                    math.ceil(options['max_output_tokens'] * view_count / len(names))
                    + 2048,
                ),
            )
        path = None
        if cache is not None:
            signature = hashlib.sha256(
                json.dumps(
                    [part_content, part_schema, part_options], sort_keys=True
                ).encode()
            ).hexdigest()
            path = Path(cache) / (signature + '.json')
            if path.exists():
                try:
                    result = json.loads(path.read_text())
                    validate_part(result, part_schema)
                    return result
                except (ValueError, OSError):
                    pass
        result = request_fn(part_content, part_schema, **part_options)
        validate_part(result, part_schema)
        # Completed batches can survive another batch failing. These are private
        # request caches, never a partial head/annotation artifact.
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic(path, result)
        return result

    def run(index):
        started = time.perf_counter()
        if index == count:
            result = call(
                'Compare ALL supplied images with the original precision '
                'requirements. Return only the global fields in this schema. '
                'Per-view contours are handled by concurrent requests; do not '
                'output views or repeat coordinates in descriptions.',
                globals_schema,
                0,
            )
            print(
                f'astra_batch {label} globals: {time.perf_counter() - started:.3f}s',
                flush=True,
            )
            return result
        batch = batches[index]
        batch_schema = copy.deepcopy(schema)
        batch_schema['properties'] = {'views': batch_schema['properties']['views']}
        batch_schema['required'] = ['views']
        views_schema = batch_schema['properties']['views']
        views_schema['minItems'] = views_schema['maxItems'] = len(batch)
        views_schema['items']['properties']['filename']['enum'] = batch
        instruction = (
            'All images above are shared multiview context: compare ALL of them '
            'with the original detail and precision requirements. For this '
            'output batch return exactly one views entry for each filename in '
            f'{json.dumps(batch)}, and no other views. This output assignment '
            'narrows any earlier instruction to return every supplied filename; '
            'it does not narrow the visual evidence or annotation detail. '
        )
        instruction += (
            'Global fields are handled by another request; return only views.'
        )
        result = call(instruction, batch_schema, len(batch))
        print(
            f'astra_batch {label} views {index + 1}/{count}: {time.perf_counter() - started:.3f}s',
            flush=True,
        )
        return result

    has_globals = bool(globals_schema['properties'])
    with ThreadPoolExecutor(
        count + int(has_globals), thread_name_prefix='photo-annotations'
    ) as pool:
        results = list(pool.map(run, range(count + int(has_globals))))
    result = results[-1].copy() if has_globals else {}
    by_name = {
        view['filename']: view for batch in results[:count] for view in batch['views']
    }
    result['views'] = [by_name[name] for name in names]
    _validate(result, schema)
    return result
