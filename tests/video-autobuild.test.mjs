import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the real capture/import/build/stop methods with deterministic frames. This
// catches interruptions and automatic submission without needing a webcam or API key.
const source = (
  await readFile(new URL('../src/face-capture.js', import.meta.url), 'utf8')
)
  .replace(/^import .*;\n/gm, '')
  .replace('export class FaceCapture', 'globalThis.FaceCapture = class FaceCapture')
  .replaceAll('import.meta.env.VITE_CONTACT_FAST_CAPTURE', "'0'");

function harness({
  meshy = false,
  stopAt = 0,
  failAt = 0,
  readyTimingError = false,
  overlapInit = false,
  initError = false,
  frameCount = 24,
  allowNaming = false,
} = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: true,
        open: true,
        pause() {},
        close() {
          this.open = false;
        },
      });
    return elements.get(id);
  };
  class Video extends EventTarget {
    duration = 15.4;
    videoWidth = 640;
    videoHeight = 480;
    load() {
      queueMicrotask(() => this.dispatchEvent(new Event('loadeddata')));
    }
    pause() {}
    removeAttribute() {}
  }
  const calls = [],
    tracked = [];
  let metadata = null;
  let finishInit;
  const context = {
    document: {
      getElementById: element,
      createElement: (name) =>
        name === 'video' ? new Video() : { getContext: () => ({ drawImage() {} }) },
    },
    performance,
    Date,
    setTimeout,
    clearTimeout,
    console,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    createImageBitmap: async () => ({ width: 640, height: 480, close() {} }),
    nameFromFile: (name) => name.replace(/\.[^.]+$/, ''),
    requestHeadName: () => {
      if (allowNaming) return 'Photo head';
      throw new Error('Video upload must not pause for naming.');
    },
    trackScanJob: (job) => tracked.push(job),
    fetch: async (url, options) => {
      const body =
        options?.headers?.['Content-Type'] === 'application/json'
          ? JSON.parse(options.body)
          : null;
      calls.push({ url, body });
      let data = {};
      if (url === '/api/face-status?id=scan1')
        data = {
          status: 'complete',
          photoModel: true,
          message: 'Head ready.',
          source: {
            uploadStartedAt: Date.now() / 1000 - 100,
            extractionComplete: true,
          },
          timing: {
            status: 'complete',
            requestedAt: Date.now() / 1000 - 80,
            reconstructionSeconds: 79,
          },
        };
      if (url === '/api/face-captures') data = { id: 'scan1' };
      if (url === '/api/face-timing') {
        if (body.kind === 'ready' && readyTimingError)
          return {
            ok: false,
            json: async () => ({ error: 'Unknown timing metadata.' }),
          };
        metadata = body;
        data = { source: body, timing: null };
      }
      if (url === '/api/face-video-frames') {
        finishInit?.();
        data = {
          orientationApplied: true,
          width: 640,
          height: 480,
          frames: Array.from({ length: frameCount }, (_, i) => ({
            image: `/frame/${i}`,
            timeSeconds: i,
          })),
        };
      }
      if (url === '/api/face-train') data = { id: 'scan1', status: 'running' };
      return { ok: true, json: async () => data, blob: async () => ({}) };
    },
  };
  vm.runInNewContext(source, context);
  const capture = Object.create(context.FaceCapture.prototype);
  let meshyBuilds = 0,
    processed = 0;
  Object.assign(capture, {
    count: 0,
    samples: [],
    engines: {
      meshy,
      minimumViews: meshy ? 1 : 24,
      build: async () => {
        meshyBuilds++;
        capture.jobRunning = true;
      },
    },
    controls() {},
    refresh: async () => {},
    showTiming(source, timing) {
      this.source = source;
      this.timing = timing;
    },
    poll: async () => {},
    init: async () => {
      capture.worker = { postMessage() {}, terminate() {} };
      if (initError) throw new Error('Tracking initialization failed.');
      if (overlapInit)
        await new Promise((resolve) => {
          finishInit = resolve;
        });
    },
    process: async (bitmap, options) => {
      if (options?.calibrateOnly) return { ok: true, yaw: 0 };
      processed++;
      if (processed === stopAt) void capture.finishCapture();
      if (processed === failAt) throw new Error('Tracking failed.');
      return { ok: true };
    },
    accept: async (data, generation) => {
      if (capture.running && capture.generation === generation) capture.count++;
    },
  });
  return {
    capture,
    calls,
    tracked,
    element,
    file: { name: 'My head.mov', size: 100, type: 'video/quicktime' },
    get metadata() {
      return metadata;
    },
    get meshyBuilds() {
      return meshyBuilds;
    },
    get feedback() {
      return element('face-scan-feedback').textContent;
    },
  };
}

test('a video automatically submits one build with full-quality options and filename naming', async () => {
  const h = harness();
  const before = Date.now() / 1000;
  await h.capture.importVideo(h.file);
  const creates = h.calls.filter(({ url }) => url === '/api/face-captures');
  assert.equal(creates[0].body.name, 'My head');
  const builds = h.calls.filter(({ url }) => url === '/api/face-train');
  assert.equal(builds.length, 1);
  assert.equal(builds[0].body.cloudReview, true);
  assert.equal(h.metadata.extractionComplete, true);
  assert.ok(h.metadata.uploadStartedAt >= before);
  assert.equal(h.tracked.length, 1);
  assert.equal(h.capture.loading, false);
  assert.match(h.feedback, /Reconstruction is running/);
});

test('automatic video build respects the selected reconstruction engine', async () => {
  const h = harness({ meshy: true });
  await h.capture.importVideo(h.file);
  assert.equal(h.meshyBuilds, 1);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
});

test('stopping extraction saves partial timing and never submits a build', async () => {
  const h = harness({ stopAt: 25, frameCount: 30 });
  await h.capture.importVideo(h.file);
  assert.equal(h.capture.count, 24);
  assert.equal(h.metadata.extractionComplete, false);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.equal(h.capture.videoImport, null);
});

test('a failed extraction cleans up and never submits a partial head', async () => {
  const h = harness({ failAt: 25, frameCount: 30 });
  await assert.rejects(h.capture.importVideo(h.file), /Tracking failed/);
  assert.equal(h.capture.count, 24);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.equal(h.capture.loading, false);
  assert.equal(h.capture.videoImport, null);
});

test('an older server rejecting timing metadata cannot suppress model readiness', async () => {
  const h = harness({ readyTimingError: true });
  h.capture.id = 'scan1';
  delete h.capture.poll;
  await h.capture.poll();
  assert.equal(h.capture.ready, true);
  assert.equal(h.capture.jobRunning, false);
  assert.ok(Number.isFinite(h.capture.timing.readyObservedAt));
});

test(
  'video upload and decoding proceed while tracking initialization is pending',
  { timeout: 1000 },
  async () => {
    const h = harness({ overlapInit: true });
    await h.capture.importVideo(h.file);
    assert.equal(h.tracked.length, 1);
  },
);

test('tracking initialization rejection is joined safely before extraction', async () => {
  const h = harness({ initError: true });
  await assert.rejects(h.capture.importVideo(h.file), /Tracking initialization failed/);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.equal(h.capture.loading, false);
});

test('finishing a live recording waits for saved frames and submits exactly once', async () => {
  const h = harness();
  let saved;
  Object.assign(h.capture, {
    id: 'scan1',
    running: true,
    count: 23,
    inflight: new Promise((resolve) => {
      saved = () => {
        h.capture.count = 24;
        resolve();
      };
    }),
  });
  const first = h.capture.finishCapture();
  const second = h.capture.finishCapture();
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  saved();
  await Promise.all([first, second]);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 1);
  assert.equal(h.tracked.length, 1);
});

test('reaching the live capture limit automatically builds the head', async () => {
  const h = harness();
  Object.assign(h.capture, { id: 'scan1', running: true, count: 240 });
  await h.capture.loop();
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 1);
});

test('a failed final frame does not submit a partial live recording', async () => {
  const h = harness();
  Object.assign(h.capture, {
    id: 'scan1',
    running: true,
    count: 24,
    inflight: Promise.reject(new Error('Frame save failed.')),
  });
  await assert.rejects(h.capture.finishCapture(), /Frame save failed/);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
});

const photos = Array.from({ length: 30 }, (_, i) => ({ name: `Head ${i}.jpg` }));

test('a completed photo import automatically builds with the selected quality setting', async () => {
  const h = harness({ allowNaming: true });
  h.element('face-cloud-review').checked = false;
  await h.capture.importPhotos(photos);
  const builds = h.calls.filter(({ url }) => url === '/api/face-train');
  assert.equal(builds.length, 1);
  assert.equal(builds[0].body.cloudReview, false);
  assert.equal(h.capture.loading, false);
  assert.match(h.feedback, /Reconstruction is running/);
});

test('photo imports respect the selected engine and its minimum view count', async () => {
  const h = harness({ allowNaming: true, meshy: true });
  await h.capture.importPhotos(photos.slice(0, 1));
  assert.equal(h.meshyBuilds, 1);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
});

test('stopping a photo import never automatically builds its partial scan', async () => {
  const h = harness({ allowNaming: true, stopAt: 25 });
  await h.capture.importPhotos(photos);
  assert.equal(h.capture.count, 24);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.equal(h.capture.loading, false);
});

test('a failed photo import never automatically builds its partial scan', async () => {
  const h = harness({ allowNaming: true, failAt: 25 });
  await assert.rejects(h.capture.importPhotos(photos), /Tracking failed/);
  assert.equal(h.capture.count, 24);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.equal(h.capture.loading, false);
});

test('insufficient video views explain what is missing without submitting a build', async () => {
  const h = harness({ frameCount: 3 });
  await h.capture.importVideo(h.file);
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.match(h.feedback, /At least 24 usable views/);
});

test('closing the scan dialog does not submit an unfinished recording', async () => {
  const h = harness();
  Object.assign(h.capture, { id: 'scan1', running: true, count: 24 });
  await h.capture.close();
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
  assert.equal(h.element('face-scan-dialog').open, false);
});

test('automatic submission never rebuilds a head that is ready or already building', async () => {
  const h = harness();
  Object.assign(h.capture, { id: 'scan1', count: 24, ready: true });
  await h.capture.buildAutomatically();
  h.capture.ready = false;
  h.capture.jobRunning = true;
  await h.capture.buildAutomatically();
  assert.equal(h.calls.filter(({ url }) => url === '/api/face-train').length, 0);
});
