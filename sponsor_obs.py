"""Optional Sentry wiring for the Python side. Every function is a no-op unless both
`sentry-sdk` is installed and a DSN is configured, so importing this can never break a service.

One browser click should read as ONE trace: page -> server.py -> pipeline subprocess -> each
PipelineTimer stage, plus the OMNI coach calls as AI spans. Photographs, landmarks and request
bodies are never attached; only names, durations, counts and status.
"""

from contextlib import contextmanager
from pathlib import Path
import json, os, threading, time

ROOT = Path(__file__).resolve().parent
ENABLED = False
SERVICE = 'punching-face'
_job = threading.local()
try:
    import sentry_sdk
except Exception:
    sentry_sdk = None
# The structured-log API is a submodule, not an attribute: probing with hasattr() would silently drop every log.
try:
    from sentry_sdk import logger as sentry_logs
except Exception:
    sentry_logs = None


def _dsn():
    saved = {}
    try:
        saved = json.loads((ROOT / '.local/secrets/sentry.json').read_text())
    except (OSError, ValueError):
        pass
    return (
        os.environ.get('SENTRY_DSN')
        or saved.get('pythonDsn')
        or saved.get('browserDsn'),
        os.environ.get('SENTRY_ENVIRONMENT') or saved.get('environment') or 'hackathon',
    )


def release():
    """`punching-face@<commit>`, shared by the browser and every service, so Sentry can compare a
    number before and after a fix. SENTRY_RELEASE (or "release" in sentry.json) overrides it.
    """
    saved = {}
    try:
        saved = json.loads((ROOT / '.local/secrets/sentry.json').read_text())
    except (OSError, ValueError):
        pass
    named = os.environ.get('SENTRY_RELEASE') or saved.get('release')
    if named:
        return str(named)[:80]
    try:
        head = (ROOT / '.git/HEAD').read_text().strip()
        if head.startswith('ref:'):
            ref = head[4:].strip()
            try:
                head = (ROOT / '.git' / ref).read_text().strip()
            except OSError:
                packed = (ROOT / '.git/packed-refs').read_text().splitlines()
                head = next(
                    (line.split()[0] for line in packed if line.endswith(' ' + ref)), ''
                )
        return 'punching-face@' + head[:12] if head else None
    except OSError:
        return None


# Asked every few seconds while a build runs. The build itself is traced in full (the pipeline's
# stages, a Meshy job's stages); a thin sample of the asking is enough to see if a poll is slow.
POLLED = ('/api/meshy-job', '/api/face-status', '/api/arm-status', '/api/meshy-status')


def _sampler(context):
    # /physics/step runs at 30 Hz. Keep a thin sample so its latency stays visible without
    # drowning the quota or adding per-frame overhead; polls are thinned too; every action a
    # person took is rare and kept.
    name = (context.get('transaction_context') or {}).get('name', '')
    if 'physics/step' in name:
        return 0.02
    return 0.05 if any(route in name for route in POLLED) else 1.0


def init(service, transport=None):
    """Call once per process. `transport` lets tests capture envelopes without a network."""
    global ENABLED, SERVICE
    SERVICE = service
    if os.environ.get('SENTRY_DISABLED') == '1':
        ENABLED = False
        return False
    dsn, environment = _dsn()
    if not sentry_sdk or not (dsn or transport):
        return False
    options = dict(
        dsn=dsn or 'https://public@o0.ingest.sentry.io/0',
        environment=environment,
        release=release(),
        traces_sampler=_sampler,
        send_default_pii=False,
        max_request_body_size='never',
        include_local_variables=False,
        server_name='punching-face-' + service,
    )
    if transport:
        options['transport'] = transport
    try:
        sentry_sdk.init(
            enable_logs=True,
            profile_session_sample_rate=1.0,
            profile_lifecycle='trace',
            **options,
        )
    except TypeError:
        sentry_sdk.init(**options)  # older sentry-sdk without logs/continuous profiling
    sentry_sdk.set_tag('service', service)
    ENABLED = True
    return True


def capture(error, extra=None):
    if not ENABLED:
        return
    with sentry_sdk.new_scope() as scope:
        for key, value in (extra or {}).items():
            scope.set_extra(key, value)
        sentry_sdk.capture_exception(error)


def log(message, **attributes):
    """Structured Sentry log plus the usual stdout line that pipeline.log already collects."""
    print(message, flush=True)
    if ENABLED and sentry_logs:
        sentry_logs.info(message, attributes={'service': SERVICE, **attributes})


def warn(message, **attributes):
    """Something a person should look at, that is not an exception: a fallback, a retry, a refusal."""
    print(message, flush=True)
    if ENABLED and sentry_logs:
        sentry_logs.warning(message, attributes={'service': SERVICE, **attributes})


def metric(name, value, unit=None, **attributes):
    """A distribution in Sentry's trace-connected metrics: p50/p95 over time, split by attribute.
    For numbers that are asked about in aggregate (first-token latency by voice engine), where a
    span attribute only answers for one trace at a time."""
    if not ENABLED or value is None:
        return
    try:
        from sentry_sdk import metrics

        metrics.distribution(
            name,
            float(value),
            unit=unit,
            attributes={
                'service': SERVICE,
                **{k: v for k, v in attributes.items() if v is not None},
            },
        )
    except Exception:
        pass  # an older sentry-sdk without metrics: the span attributes still carry the number


def count(name, **attributes):
    if not ENABLED:
        return
    try:
        from sentry_sdk import metrics

        metrics.count(
            name,
            1,
            attributes={
                'service': SERVICE,
                **{k: v for k, v in attributes.items() if v is not None},
            },
        )
    except Exception:
        pass


def instrument_http(handler):
    """Wrap a BaseHTTPRequestHandler so each request continues the browser's trace. The service name
    comes from init(): one process, one service tag."""
    if not ENABLED:
        return
    send = handler.send_response

    def send_response(self, code, message=None):
        self._sentry_status = code
        result = send(self, code, message)
        # Every answer names its trace, so a slow or failed call seen in the browser's network tab
        # (or in curl) is one search away in Sentry. Also how sentry_doctor.py sees Sentry is on.
        trace_id = getattr(self, '_sentry_trace_id', None)
        if trace_id:
            self.send_header('X-Sentry-Trace-Id', trace_id)
        return result

    handler.send_response = send_response
    for method in ('do_GET', 'do_POST'):
        original = getattr(handler, method, None)
        if not original:
            continue

        def wrapped(self, original=original):
            route = self.path.split('?')[0]
            with sentry_sdk.isolation_scope():
                transaction = sentry_sdk.continue_trace(
                    dict(self.headers.items()),
                    op='http.server',
                    name='%s %s' % (self.command, route),
                    source='route',
                )
                with sentry_sdk.start_transaction(transaction) as active:
                    self._sentry_trace_id = getattr(active, 'trace_id', None)
                    try:
                        return original(self)
                    finally:
                        status = getattr(self, '_sentry_status', None)
                        if status:
                            active.set_http_status(status)
                        if status and status >= 500:
                            # These handlers answer a crash with a sentence and a 500 and swallow
                            # the exception. The issue this opens is tied to the trace, and through
                            # the browser's own report of the 500, to the replay of what led to it.
                            sentry_sdk.capture_message(
                                '%s answered %d' % (active.name, status), level='error'
                            )

        setattr(handler, method, wrapped)


def traced(target, name, op='job', **tags):
    """Wrap a thread target so a background job is its own transaction in the trace of the request
    that started it. The request's transaction ends with its response, long before a cloud build
    does, so spans started later in the thread would otherwise be dropped with it."""
    if not ENABLED:
        return target
    headers = {
        'sentry-trace': sentry_sdk.get_traceparent() or '',
        'baggage': sentry_sdk.get_baggage() or '',
    }

    def run(*args, **kwargs):
        with sentry_sdk.isolation_scope():
            transaction = sentry_sdk.continue_trace(
                headers, op=op, name=name, source='task'
            )
            with sentry_sdk.start_transaction(transaction) as active:
                for key, value in tags.items():
                    if value is not None:
                        active.set_tag(key, str(value)[:100])
                _job.transaction, _job.span, _job.stage = active, None, None
                try:
                    result = target(*args, **kwargs)
                    if (
                        not active.status
                    ):  # job_state() marks a failure; silence means it worked
                        active.set_status('ok')
                    return result
                except BaseException:
                    active.set_status('internal_error')
                    raise
                finally:
                    _close_job_stage()
                    _job.transaction = None
                    sentry_sdk.flush(timeout=4)

    return run


def _close_job_stage(status='ok'):
    span = getattr(_job, 'span', None)
    if span:
        span.set_status(status)
        span.finish()
    _job.span = _job.stage = None


def job_state(state):
    """Call on every state change of a job running under traced(). A new `stage` closes the last
    span and opens the next, so the waterfall reads prepare -> upload -> queued -> generating ->
    download. `status: failed` marks the stage and the job failed and says why in a log.
    """
    if not ENABLED or not getattr(_job, 'transaction', None):
        return
    stage, status = state.get('stage'), state.get('status')
    failed = status == 'failed'
    if failed:
        _close_job_stage('internal_error')
        _job.transaction.set_status('internal_error')
        warn(
            'job failed',
            job=_job.transaction.name,
            reason=str(state.get('message'))[:200],
        )
    elif stage and stage != getattr(_job, 'stage', None):
        _close_job_stage()
        if status != 'complete':
            _job.span = sentry_sdk.start_span(op='job.stage', name=str(stage))
            _job.stage = stage
        log('job stage: ' + str(stage), job=_job.transaction.name, stage=str(stage))
    span = getattr(_job, 'span', None)
    for key in ('progress', 'consumedCredits', 'seconds', 'aiModel', 'resumable'):
        if state.get(key) is not None:
            (span or _job.transaction).set_data('job.' + key, state[key])


def child_env():
    """Environment for a subprocess that should join the current trace."""
    env = dict(os.environ)
    if ENABLED:
        trace, baggage = sentry_sdk.get_traceparent(), sentry_sdk.get_baggage()
        if trace:
            env['SENTRY_TRACE'] = trace
        if baggage:
            env['SENTRY_BAGGAGE'] = baggage
    return env


@contextmanager
def continue_from_env(name, op='pipeline'):
    """Transaction for a subprocess, parented to whatever request spawned it."""
    if not ENABLED:
        yield None
        return
    headers = {
        'sentry-trace': os.environ.get('SENTRY_TRACE', ''),
        'baggage': os.environ.get('SENTRY_BAGGAGE', ''),
    }
    transaction = sentry_sdk.continue_trace(headers, op=op, name=name, source='task')
    with sentry_sdk.start_transaction(transaction) as active:
        try:
            yield active
        except BaseException:
            active.set_status('internal_error')
            raise
        finally:
            sentry_sdk.flush(timeout=4)


def patch_pipeline_timer():
    """Each PipelineTimer stage becomes a span, so Sentry shows the same stages as timing.json."""
    if not ENABLED:
        return
    from pipeline_timing import PipelineTimer

    mark, finish = PipelineTimer.mark, PipelineTimer.finish

    def close(timer, status='ok'):
        span = getattr(timer, '_sentry_span', None)
        if span:
            span.set_status(status)
            span.finish()
            timer._sentry_span = None

    def traced_mark(self, stage):
        close(self)
        self._sentry_span = sentry_sdk.start_span(op='pipeline.stage', name=str(stage))
        log('stage: ' + str(stage), stage=str(stage), capture=self.folder.name)
        return mark(self, stage)

    def traced_finish(self, state='complete'):
        close(self, 'ok' if state == 'complete' else 'internal_error')
        result = finish(self, state)
        log(
            'pipeline ' + state,
            state=state,
            capture=self.folder.name,
            seconds=result.get('reconstructionSeconds'),
        )
        return result

    PipelineTimer.mark, PipelineTimer.finish = traced_mark, traced_finish


@contextmanager
def stage(op, name, **data):
    """Generic child span for cold-start / hot-path phases. No-op without Sentry."""
    if not ENABLED:
        yield None
        return
    with sentry_sdk.start_span(op=op, name=name) as span:
        for key, value in data.items():
            if value is not None:
                span.set_data(key, value)
        yield span


def note(**tags):
    """Attach short tags to the active transaction so Sentry can filter by them."""
    if not ENABLED:
        return
    for key, value in tags.items():
        if value is None:
            continue
        sentry_sdk.set_tag(key, str(value)[:100])


# Rough OpenAI-compatible price table (USD per 1M tokens). Approximate at time of writing;
# adjust when the gateway publishes rates. Used only for gen_ai.usage.cost_usd on spans.
AI_PRICES = {
    'qwen3.5-omni-flash': (0.10, 0.30),
    'qwen3.5-omni-plus': (0.30, 0.90),
    'qwen3.5-omni-plus-realtime': (0.60, 1.80),
    'gpt-6-astra': (2.50, 10.00),
    'gpt-image-2': (0.00, 0.00),
}


def _cost_usd(model, usage):
    if not usage:
        return None
    prices = AI_PRICES.get((model or '').lower())
    if not prices:
        return None
    inp, out = prices
    return round(
        (
            (usage.get('prompt_tokens', 0) or 0) * inp
            + (usage.get('completion_tokens', 0) or 0) * out
        )
        / 1_000_000,
        6,
    )


@contextmanager
def agent_span(agent, model=None, conversation=None, **data):
    """One whole turn of an agent. Sentry's AI Agents view groups what happens inside it: the
    model calls (ai_span), the tool calls (tool_span) and the voice. `data` is non-PII only.
    """
    if not ENABLED:
        yield None
        return
    with sentry_sdk.start_span(
        op='gen_ai.invoke_agent', name='invoke_agent ' + agent
    ) as span:
        span.set_data('gen_ai.operation.name', 'invoke_agent')
        span.set_data('gen_ai.agent.name', agent)
        if model:
            span.set_data('gen_ai.request.model', model)
        if conversation:
            span.set_data('gen_ai.conversation.id', str(conversation)[:64])
        for key, value in data.items():
            if value is not None:
                span.set_data('agent.' + key, value)
        yield span


def _start(parent, **span):
    """A child of `parent` when given one (work in another thread, which should still sit beside
    its siblings in the waterfall), else of whatever span is active here."""
    return parent.start_child(**span) if parent else sentry_sdk.start_span(**span)


@contextmanager
def tool_span(tool, agent=None, parent=None, **data):
    """A function the model called (the face's set_expression). Arguments are recorded only
    when they are from a closed vocabulary, never free text."""
    if not ENABLED:
        yield None
        return
    with _start(parent, op='gen_ai.execute_tool', name='execute_tool ' + tool) as span:
        span.set_data('gen_ai.operation.name', 'execute_tool')
        span.set_data('gen_ai.tool.name', tool)
        span.set_data('gen_ai.tool.type', 'function')
        if agent:
            span.set_data('gen_ai.agent.name', agent)
        for key, value in data.items():
            if value is not None:
                span.set_data('tool.' + key, value)
        yield span


@contextmanager
def ai_span(model, system, agent=None, parent=None, **shape):
    """Shaped for Sentry's AI agent monitoring (gen_ai.* attributes).

    `shape` accepts non-PII request descriptors: messages_count, system_prompt_len,
    frames_attached, audio_ms, has_voice, temperature, max_tokens, etc. Never prompts
    or images: send_default_pii is off and this is deliberately narrow.
    """
    if not ENABLED:
        yield None
        return
    with _start(parent, op='gen_ai.chat', name='chat ' + model) as span:
        span.set_data('gen_ai.operation.name', 'chat')
        span.set_data('gen_ai.system', system)
        span.set_data('gen_ai.provider.name', system)
        span.set_data('gen_ai.request.model', model)
        span.set_data('gen_ai.response.streaming', True)
        if agent:
            span.set_data('gen_ai.agent.name', agent)
        for key, value in shape.items():
            if value is None:
                continue
            span.set_data('gen_ai.request.' + key, value)
        yield span


def ai_usage(span, usage, first_token_ms, frames, finish_reason=None, model=None):
    if not span:
        return
    usage = usage or {}
    for key, field in (
        ('gen_ai.usage.input_tokens', 'prompt_tokens'),
        ('gen_ai.usage.output_tokens', 'completion_tokens'),
        ('gen_ai.usage.total_tokens', 'total_tokens'),
    ):
        if usage.get(field) is not None:
            span.set_data(key, usage[field])
    cost = _cost_usd(model, usage)
    if cost is not None:
        span.set_data('gen_ai.usage.cost_usd', cost)
        # The names Sentry's AI views total up. This gateway's model is not in Sentry's own price
        # list, so without these the cost column would stay empty.
        prices = AI_PRICES[(model or '').lower()]
        span.set_data('gen_ai.cost.total_tokens', cost)
        span.set_data(
            'gen_ai.cost.input_tokens',
            round((usage.get('prompt_tokens') or 0) * prices[0] / 1e6, 6),
        )
        span.set_data(
            'gen_ai.cost.output_tokens',
            round((usage.get('completion_tokens') or 0) * prices[1] / 1e6, 6),
        )
    if finish_reason:
        span.set_data('gen_ai.response.finish_reason', str(finish_reason)[:40])
        span.set_data('gen_ai.response.finish_reasons', str(finish_reason)[:40])
    if model:
        span.set_data('gen_ai.response.model', model)
    span.set_data('gen_ai.response.first_token_ms', first_token_ms)
    if first_token_ms is not None:
        span.set_data(
            'gen_ai.response.time_to_first_token', round(first_token_ms / 1000, 4)
        )
    span.set_data('gen_ai.request.frames_attached', frames)


def ai_error(span, status, detail=None):
    """Turn an HTTP failure from the gateway into a first-class AI span outcome."""
    if not span:
        return
    span.set_status('unknown_error' if status >= 500 else 'invalid_argument')
    span.set_data('gen_ai.response.finish_reason', 'error')
    span.set_data('gen_ai.response.http_status', int(status))
    if detail:
        span.set_data('gen_ai.response.error_class', str(detail)[:40])
