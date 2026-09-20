"""Keep known provider limits visible as failed jobs, without crash alerts."""

from contextlib import contextmanager

from openai_capture import OpenAIRateLimitError


@contextmanager
def handle_api_limits():
    # Wrap the CLI, not build.run(): the pipeline must first finish its failed
    # status/timing and roll back any unpublished model artifacts.
    try:
        yield
    except OpenAIRateLimitError as error:
        try:
            from sponsor_obs import warn
        except ImportError:
            print(str(error), flush=True)
        else:
            warn(str(error), provider='openai', reason=error.kind)
        # A nonzero exit preserves failure for callers. SystemExit is handled
        # by Python; Sentry's excepthook must only see unexpected crashes.
        raise SystemExit(1) from None
