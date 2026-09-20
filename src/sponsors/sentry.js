// Sentry for the browser, loaded only when a DSN is configured. Everything else calls `obs`,
// whose methods are no-ops until then, so no feature depends on Sentry being present.
//
// Privacy: the webcam <video> and every image are blocked from Session Replay, the 3D canvas is
// never recorded (no canvas integration), inputs are masked, the conversation with the face and
// the arena's names are masked, query strings are dropped, and no request bodies are attached.
// What Sentry sees is timing, status text, counts and errors: never a face, never what was said.
let sdk = null,
  feedback = null;
// The DSN arrives from the relay a moment after the page starts. What happened before that (a
// worker that failed to boot, a refused camera) is kept, in order, and sent once Sentry is on.
const waiting = [];
const later = (call) => {
  if (sdk) call(sdk);
  else if (waiting.length < 200) waiting.push(call);
};
const quietSpan = { setAttribute() {}, setAttributes() {}, setStatus() {}, end() {} };
const clean = (attributes = {}) =>
  Object.fromEntries(
    Object.entries(attributes).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );

export const obs = {
  enabled: false,
  span(name, attributes, work) {
    return sdk
      ? sdk.startSpan({ name, op: name.split('.')[0], attributes }, work)
      : work(quietSpan);
  },
  // One thing a person did (a punch answered, a scan saved), as a trace of its own.
  // `work(span, within)`: call `within(() => fetch(...))` for the requests that belong to it.
  // The span is deliberately NOT left active across awaits: this page has no async context, so
  // an active span would adopt every unrelated request made meanwhile, and the physics loop
  // makes thirty a second.
  flow(name, attributes, work) {
    if (!sdk) return work(quietSpan, (run) => run());
    let root;
    sdk.startNewTrace(() => {
      root = sdk.startInactiveSpan({
        name,
        op: name.split('.')[0],
        attributes: clean(attributes),
        forceTransaction: true,
      });
    });
    const finish = (error) => {
      if (error)
        root.setStatus({
          code: 2,
          message: error.name === 'AbortError' ? 'cancelled' : 'internal_error',
        });
      root.end();
    };
    try {
      return Promise.resolve(work(root, (run) => sdk.withActiveSpan(root, run))).then(
        (value) => (finish(), value),
        (error) => {
          finish(error || new Error('failed'));
          throw error;
        },
      );
    } catch (error) {
      finish(error);
      throw error;
    }
  },
  log(message, attributes = {}) {
    later((s) => s.logger?.info(message, clean(attributes)));
  },
  warn(message, attributes = {}) {
    later((s) => s.logger?.warn(message, clean(attributes)));
  },
  // A number asked about in aggregate: p50/p95 over the weekend, split by attribute.
  metric(name, value, unit, attributes = {}) {
    if (Number.isFinite(value))
      later((s) =>
        s.metrics?.distribution(name, value, { unit, attributes: clean(attributes) }),
      );
  },
  count(name, attributes = {}) {
    later((s) => s.metrics?.count(name, 1, { attributes: clean(attributes) }));
  },
  error(error, context) {
    if (!sdk) console.error(error);
    later((s) => s.captureException(error, context ? { extra: context } : undefined));
  },
  crumb(category, message, data) {
    later((s) => s.addBreadcrumb({ category, message, data, level: 'info' }));
  },
  tag(key, value) {
    later((s) => s.setTag(key, value));
  },
  // "Report a problem": the form goes to Sentry with this session's replay and trace attached.
  // No screenshot (it could hold a face), no name, no email.
  feedback(button) {
    later(() => feedback?.attachTo(button));
  },
};

// The physics step runs at 30 Hz and the status endpoints are polled: real work, but a span for
// each would bury everything else. The services still sample them thinly (sponsor_obs._sampler).
const HOT = /\/physics\/step|\/api\/(meshy-job|face-status|arm-status|scan-status)\b/;
const OURS = /\/(api|physics|sponsors)\//;
const bare = (url) => (typeof url === 'string' ? url.split('?')[0] : url);

// A broken endpoint that is polled every few seconds would otherwise send the same error until
// the quota is gone. Five of a kind per five minutes says everything the hundredth would.
const seen = new Map();
function worthSending(event) {
  const first = event.exception?.values?.[0],
    key = (first?.type || '') + '|' + (first?.value || event.message || ''),
    now = Date.now(),
    entry = seen.get(key);
  if (!entry || now - entry.since > 300000)
    return (seen.set(key, { since: now, n: 1 }), true);
  return ++entry.n <= 5;
}

export async function initSentry({ dsn, environment, release }) {
  if (import.meta.env?.VITE_SENTRY_DISABLED === '1') return false;
  if (!dsn || sdk) return obs.enabled;
  const Sentry = await import('@sentry/browser');
  // js-profiling requires a Document-Policy header (added by vite.config.js). Chromium-only for now;
  // the SDK degrades cleanly in other browsers. Kept at 1.0 for the demo — this is not a public app.
  const profiling =
    typeof Sentry.browserProfilingIntegration === 'function'
      ? [Sentry.browserProfilingIntegration()]
      : [];
  feedback = Sentry.feedbackIntegration?.({
    autoInject: false,
    enableScreenshot: false,
    showName: false,
    showEmail: false,
    colorScheme: 'dark',
    formTitle: 'Tell the team what happened',
    messagePlaceholder: 'What did you try, and what did the face do?',
    submitButtonLabel: 'Send',
    successMessageText: 'Thanks. It is in Sentry, with this session attached.',
  });
  Sentry.init({
    dsn,
    environment: import.meta.env?.VITE_SENTRY_ENVIRONMENT || environment,
    release: release || undefined,
    sendDefaultPii: false,
    enableLogs: true,
    integrations: [
      Sentry.browserTracingIntegration({
        shouldCreateSpanForRequest: (url) => !HOT.test(url),
      }),
      Sentry.replayIntegration({
        maskAllText: false,
        maskAllInputs: true,
        blockAllMedia: true,
        // What was said to the face and what it said back, and the names guests typed.
        mask: ['.sd-log', '[data-k="board"]'],
        block: ['video', 'canvas'],
        // Belt and braces for the recording itself: no query strings, none of the hot loop.
        beforeAddRecordingEvent(event) {
          const payload = event.data?.payload;
          if (event.data?.tag !== 'performanceSpan' || !payload?.description)
            return event;
          if (HOT.test(payload.description) && !(payload.data?.statusCode >= 400))
            return null;
          payload.description = bare(payload.description);
          return event;
        },
      }),
      // A 5xx from one of our own services becomes an issue with the replay of what led to it.
      Sentry.httpClientIntegration({
        failedRequestStatusCodes: [[500, 599]],
        failedRequestTargets: [OURS],
      }),
      // Browser interventions (blocked autoplay, a throttled timer): this app is audio and rAF.
      Sentry.reportingObserverIntegration(),
      ...(feedback ? [feedback] : []),
      ...profiling,
    ],
    // Every trace is kept: this is a demo-sized app and the traces are the point.
    tracesSampleRate: 1,
    profilesSampleRate: 1,
    replaysSessionSampleRate: 1,
    replaysOnErrorSampleRate: 1,
    // Continue traces into the three local Python services (5174/5175 via the Vite proxy, 5176 direct).
    tracePropagationTargets: [
      /^\/(api|physics)\//,
      /^http:\/\/(127\.0\.0\.1|localhost):5176\//,
    ],
    // Capture ids travel in query strings. They are not secrets, and they are not Sentry's either.
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'console') return null;
      if (crumb.data?.url) {
        // Thirty physics steps a second would push every useful breadcrumb out of the trail in
        // three seconds (and into every replay). A step or a poll that FAILED is still kept.
        if (HOT.test(crumb.data.url) && !(crumb.data.status_code >= 400)) return null;
        crumb.data.url = bare(crumb.data.url);
      }
      return crumb;
    },
    beforeSendSpan(span) {
      if (span.description) span.description = span.description.replace(/\?\S*/, '');
      for (const key of ['url', 'http.url', 'url.full'])
        if (span.data?.[key]) span.data[key] = bare(span.data[key]);
      for (const key of ['http.query', 'url.query'])
        if (span.data) delete span.data[key];
      return span;
    },
    beforeSend(event) {
      if (event.request?.url) event.request.url = bare(event.request.url);
      delete event.request?.query_string;
      return worthSending(event) ? event : null;
    },
  });
  sdk = Sentry;
  obs.enabled = true;
  Sentry.setTag('js_profiling', profiling.length ? 'on' : 'unsupported');
  for (const call of waiting.splice(0)) {
    try {
      call(sdk);
    } catch {
      /* one bad record must not cost the rest */
    }
  }
  return true;
}

// Physics health as logs: the step loop runs at 30 Hz, far too hot to trace per call, so report a
// rolling summary instead. `metrics` comes from window.__punchingFace.state.physicsMetrics.
export function reportPhysics(readState, everyMs = 5000) {
  let samples = [];
  const collect = setInterval(() => {
    const m = readState()?.physicsMetrics;
    if (m && Number.isFinite(m.stepMs)) samples.push(m.stepMs);
  }, 250);
  const report = setInterval(() => {
    if (!samples.length || !obs.enabled) return void (samples = []);
    const sorted = samples.slice().sort((a, b) => a - b),
      p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    obs.log('physics.step', {
      p50_ms: +p(0.5).toFixed(1),
      p95_ms: +p(0.95).toFixed(1),
      max_ms: +sorted[sorted.length - 1].toFixed(1),
      samples: sorted.length,
    });
    obs.metric('physics.step_p95', +p(0.95).toFixed(1), 'millisecond');
    samples = [];
  }, everyMs);
  return () => {
    clearInterval(collect);
    clearInterval(report);
  };
}
