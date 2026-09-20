// The flight recorder: what the app was doing when something went wrong, observed from outside.
// main.js is edited by several people and agents at once, so nothing here needs a line in it.
// It listens to what the app already publishes (the `punching-face-contact` event, the HUD's
// latency read-outs, window.__punchingFace.state) and wraps three browser entry points (Worker,
// getUserMedia, fetch) with pass-throughs that only take notes.
//
// Everything goes through `obs`, so without a Sentry DSN this file costs one rAF callback and
// records nothing. With one, a Session Replay of this app has a blank canvas by design (the 3D
// head is a face), and these notes are what make it readable anyway: every punch is a breadcrumb
// with its speed and side, so the replay's timeline reads like a fight log.
import { obs } from './sentry.js';

const bare = (url) => String(url || '').split('?')[0];
// Vite fingerprints bundled workers (impact-worker-B7x2kQ1a.js): group them under one name. A
// blob: URL is a random id each time (Sentry's own replay compressor is one), so it gets none.
const workerName = (url) =>
  /^(blob|data):/.test(String(url))
    ? 'inline-worker'
    : bare(url)
        .split('/')
        .pop()
        .replace(/-[A-Za-z0-9_-]{8}(\.m?js)$/, '$1') || 'worker';
const at = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const state = () => {
  try {
    return window.__punchingFace?.state || null;
  } catch {
    return null; // the getter reads live scene objects; never let a half-built scene throw here
  }
};

// Hand tracking, face capture, impact preparation and the target camera each run in a worker. An
// exception in one never reaches window.onerror on the page, so to Sentry it never happened, and
// to the person at the table "the camera just stopped". This makes each one visible: how long it
// took to answer for the first time (MediaPipe's model load is in there), and how it died.
function watchWorkers() {
  const Native = window.Worker;
  if (!Native || Native.__recorded) return;
  class Recorded extends Native {
    constructor(url, options) {
      super(url, options);
      try {
        const name = workerName(url),
          born = performance.now();
        let ready = false;
        this.addEventListener(
          'message',
          () => {
            ready = true;
            const ms = Math.round(performance.now() - born);
            obs.log('worker.ready', { worker: name, ms });
            obs.metric('worker.boot', ms, 'millisecond', { worker: name });
          },
          { once: true },
        );
        this.addEventListener('error', (event) => {
          obs.error(
            new Error(
              `${name}: ${event.message || 'failed to load, or crashed without a message'}`,
            ),
            { worker: name, file: bare(event.filename), line: event.lineno, ready },
          );
          obs.count('worker.error', { worker: name, ready });
        });
        this.addEventListener('messageerror', () =>
          obs.warn('worker.messageerror', { worker: name }),
        );
      } catch {
        /* taking notes must never cost the app its worker */
      }
    }
  }
  Recorded.__recorded = true;
  window.Worker = Recorded;
}

// The first thing to fail at a demo table is the camera or the microphone: refused, in use by
// another tab, or missing. The app already falls back; this says how often, and why.
function watchMedia() {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia || devices.getUserMedia.__recorded) return;
  const native = devices.getUserMedia.bind(devices);
  const recorded = async (constraints) => {
    const asked =
        [constraints?.video && 'camera', constraints?.audio && 'microphone']
          .filter(Boolean)
          .join('+') || 'nothing',
      began = performance.now();
    try {
      const stream = await native(constraints),
        ms = Math.round(performance.now() - began),
        video = stream.getVideoTracks()[0]?.getSettings?.() || {};
      // The device's label can name a person's phone or headset; its numbers cannot.
      obs.log('media.granted', {
        asked,
        ms,
        width: video.width,
        height: video.height,
        fps: video.frameRate && Math.round(video.frameRate),
      });
      obs.metric('media.open', ms, 'millisecond', { asked });
      return stream;
    } catch (error) {
      obs.warn('media.refused', {
        asked,
        reason: error?.name || 'Error',
        ms: Math.round(performance.now() - began),
      });
      obs.count('media.refused', { asked, reason: error?.name || 'Error' });
      throw error;
    }
  };
  recorded.__recorded = true;
  try {
    devices.getUserMedia = recorded;
  } catch {
    /* a browser that freezes mediaDevices keeps its own */
  }
}

// Frame pacing, as the person sees it. One log and one metric every five seconds while the tab is
// visible: p50/p95/max frame time and how many frames took longer than 50 ms. Tagged with what
// was on screen, so "it stutters" can be answered with "only with the 180k-triangle head".
function watchFrames(everyMs = 5000) {
  let last = 0,
    frames = [],
    long = 0;
  const tick = (now) => {
    const took = now - last;
    // Over a second is the tab coming back from the background, not a frame.
    if (last && took < 1000) {
      frames.push(took);
      if (took > 50) long++;
    }
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const sample = frames,
      slow = long;
    frames = [];
    long = 0;
    if (!obs.enabled || document.hidden || sample.length < 30) return;
    sample.sort((a, b) => a - b);
    const now = state(),
      head = now?.representation || 'none',
      p95 = +at(sample, 0.95).toFixed(1);
    obs.log('render.frames', {
      fps: +(1000 / at(sample, 0.5)).toFixed(1),
      p50_ms: +at(sample, 0.5).toFixed(1),
      p95_ms: p95,
      max_ms: +sample[sample.length - 1].toFixed(1),
      long_frames: slow,
      frames: sample.length,
      head,
      triangles: now?.triangles && Math.round(now.triangles),
    });
    obs.metric('render.frame_p95', p95, 'millisecond', { head });
    if (slow) obs.metric('render.long_frames', slow, undefined, { head });
  }, everyMs);
}

// Every landed punch, from the event main.js already dispatches. The breadcrumb is what a replay
// shows in place of the canvas; the metrics are the app's own HUD numbers, kept over time.
function watchPunches() {
  const hud = (id) => {
    const value = Number(document.getElementById(id)?.textContent);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  window.addEventListener('punching-face-contact', (event) => {
    const hit = event.detail;
    if (!hit || !Number.isFinite(hit.speed)) return;
    const speed = +hit.speed.toFixed(2),
      tags = { source: hit.source, side: hit.side, mode: hit.mode };
    obs.crumb('punch', `${hit.source} ${hit.side} ${speed} m/s`, {
      ...tags,
      speed,
      vertices_moved: hit.affected,
    });
    obs.count('punch.landed', tags);
    obs.metric('punch.speed', speed, undefined, tags);
    if (hit.source === 'webcam') {
      // Camera frame -> landed contact, and the vision model's share of it, as the HUD shows them.
      obs.metric('punch.camera_to_contact', hud('hit-latency'), 'millisecond');
      obs.metric('punch.vision_inference', hud('cv-latency'), 'millisecond');
    }
  });
}

// A hidden tab pauses rendering, the physics loop and the arena's video stream. Guests see a
// frozen head and nothing is wrong in any log: unless the log says the tab was hidden.
function watchTab() {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = performance.now();
      obs.crumb('tab', 'hidden');
    } else if (hiddenAt) {
      obs.warn('tab.was_hidden', {
        ms: Math.round(performance.now() - hiddenAt),
        effect: 'rendering, physics and the arena stream were paused',
      });
      hiddenAt = 0;
    }
  });
  // Does not bubble, but capture still passes through the document on the way down.
  document.addEventListener(
    'webglcontextlost',
    (event) =>
      obs.error(new Error('WebGL context lost: the 3D head went blank'), {
        canvas: event.target?.id || event.target?.parentElement?.id || 'unknown',
        triangles: state()?.triangles,
      }),
    true,
  );
  document.addEventListener(
    'webglcontextrestored',
    () => obs.log('webgl.restored'),
    true,
  );
}

// The requests that ARE a user's action, each as a trace of its own: browser -> service ->
// subprocess or cloud job. Everything else (status polls, the physics loop) stays out of them.
const FLOWS = [
  [/^\/api\/save\b/, 'scan.save'],
  [/^\/api\/meshy-train\b/, 'scan.meshy_build'],
  [/^\/api\/meshy-headshot\b/, 'scan.meshy_headshot'],
  [/^\/api\/arm-(train|capture)\b/, 'arm.train'],
  [/^\/api\/reference-(search|evidence)\b/, 'reference.search'],
  [/^\/physics\/open\b/, 'physics.open'],
];

// Must run after Sentry starts: this wrapper has to sit outside Sentry's own fetch wrapper, so
// that the request is made while the flow's span is the active one and becomes its child.
function traceFlows() {
  const next = window.fetch;
  if (!next || next.__recorded) return;
  const recorded = function (input, init) {
    let flow = null;
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input),
        path = url.startsWith(location.origin)
          ? url.slice(location.origin.length)
          : url,
        method = String(init?.method || input?.method || 'GET').toUpperCase();
      flow =
        method === 'POST' && obs.enabled
          ? FLOWS.find(([route]) => route.test(path))
          : null;
      if (flow) flow = { name: flow[1], route: bare(path) };
    } catch {
      flow = null;
    }
    if (!flow) return next.call(window, input, init);
    const began = performance.now();
    return obs.flow(flow.name, { 'http.route': flow.route }, async (span, within) => {
      const response = await within(() => next.call(window, input, init));
      span.setAttribute('http.response.status_code', response.status);
      if (!response.ok) span.setStatus({ code: 2, message: 'http_' + response.status });
      obs.metric('flow.request', Math.round(performance.now() - began), 'millisecond', {
        flow: flow.name,
        ok: response.ok,
      });
      return response;
    });
  };
  recorded.__recorded = true;
  window.fetch = recorded;
}

// "Report a problem" in the dock. Anyone at the table can say what went wrong in their own words;
// it lands in Sentry attached to the replay and trace of the session it happened in.
function mountFeedback(dock) {
  const body = dock?.querySelector('.sd-body');
  if (!body || body.querySelector('[data-k=report]')) return;
  const row = document.createElement('div');
  row.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;' +
    'padding-top:8px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;opacity:.75';
  row.innerHTML =
    '<span title="Tracing, logs, replay and profiling are on. The webcam, the 3D head and what was said are never recorded.">Flight recorder on</span>' +
    '<button type="button" data-k="report" style="font:inherit;color:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer">Report a problem</button>';
  body.append(row);
  obs.feedback(row.querySelector('[data-k=report]'));
}

// Installed the moment the page starts, before the DSN is known: a worker that fails to boot in
// the first second is exactly the one worth hearing about. `obs` keeps the notes until then.
export function startFlightRecorder() {
  if (typeof window === 'undefined' || window.__flightRecorder) return;
  window.__flightRecorder = true;
  for (const start of [watchWorkers, watchMedia, watchFrames, watchPunches, watchTab]) {
    try {
      start();
    } catch (error) {
      console.warn('Flight recorder: ' + start.name + ' did not start.', error);
    }
  }
}

export function afterSentryStarts(dock) {
  try {
    traceFlows();
    mountFeedback(dock);
  } catch (error) {
    console.warn('Flight recorder: flows are not traced.', error);
  }
}
