import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { Tracking } from '../src/hands.js';

const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css'))
      return { format: 'module', source: '', shortCircuit: true };
    if (url.endsWith('arm-mask.js?url'))
      return {
        format: 'module',
        source: "export default '/src/arm-mask.js'",
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
const { LiveArms } = await import('../src/live-arms.js');
hooks.deregister();

function bitmapMock(t, factory) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: factory,
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  });
}

function tracker(t, factory = async () => ({ close() {} })) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  bitmapMock(t, factory);
  let callback;
  const messages = [],
    cancelled = [];
  const video = {
    readyState: 2,
    currentTime: 1,
    requestVideoFrameCallback(fn) {
      callback = fn;
      return 7;
    },
    cancelVideoFrameCallback(id) {
      cancelled.push(id);
    },
  };
  const tracking = new Tracking(video, () => {});
  tracking.worker = {
    postMessage: (message) => messages.push(message),
    terminate() {},
  };
  tracking.active = true;
  t.after(() => tracking.stop());
  return { tracking, video, messages, cancelled, fire: () => callback() };
}

test('tracking still submits fresh frames when the hidden preview stops video callbacks', async (t) => {
  const { tracking, video, messages } = tracker(t);
  tracking.scheduleFrame();
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(messages.length, 1, 'watchdog recovers the missing callback');
  tracking.busy = false;
  tracking.scheduleFrame();
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(messages.length, 1, 'a frozen video frame is never submitted twice');
  video.currentTime = 2;
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(messages.length, 2, 'new camera frame resumes tracking');
});

test('video callback and watchdog cannot double-submit; disconnect cancels both', async (t) => {
  const { tracking, messages, cancelled, fire } = tracker(t);
  tracking.trackArmView = true;
  tracking.scheduleFrame();
  await fire();
  t.mock.timers.tick(100);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].trackArmView, true, 'requests the matching CV image');
  assert.equal(messages[0].trackBody, false, 'CV never runs pose on the hand worker');
  tracking.busy = false;
  tracking.scheduleFrame();
  tracking.stop();
  await fire();
  t.mock.timers.tick(100);
  assert.equal(messages.length, 1);
  assert.ok(cancelled.length >= 2);
});

test('a frame captured during disconnect is closed instead of sent to a replacement worker', async (t) => {
  let resolve,
    closed = false;
  const { tracking, fire, messages } = tracker(
    t,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  tracking.scheduleFrame();
  const pending = fire();
  tracking.stop();
  tracking.active = true;
  tracking.worker = { postMessage: (m) => messages.push(m), terminate() {} };
  resolve({
    close() {
      closed = true;
    },
  });
  await pending;
  assert.equal(closed, true);
  assert.equal(messages.length, 0);
});

function liveController() {
  const video = { readyState: 2, currentTime: 2, style: {} };
  const source = { width: 960, height: 540, exposure: 'landmark exposure' };
  const messages = [];
  const live = Object.create(LiveArms.prototype);
  const fields = {
    'arm-display': { value: 'live' },
    'arm-source': { value: 'punch' },
    'body-camera-mirror': { checked: false },
  };
  Object.assign(live, {
    tracking: {
      active: true,
      poseReady: true,
      video,
      stream: { id: 'camera' },
      results: { timestamp: 1000, frame: source, landmarks: [[{ x: 0.2, y: 0.3 }]] },
    },
    ready: true,
    busy: false,
    key: 'camera',
    epoch: 1,
    lastSent: -Infinity,
    target: {},
    canvas: {},
    $: (id) => fields[id],
    worker: { postMessage: (message) => messages.push(message) },
    status(message) {
      this.message = message;
    },
  });
  return { live, video, source, messages };
}

test('front CV uses the image belonging to its landmarks, even after the live video moves', async (t) => {
  const { live, video, source, messages } = liveController();
  const inputs = [];
  bitmapMock(t, async (input) => {
    inputs.push(input);
    return { close() {} };
  });
  live.update(1100);
  await Promise.resolve();
  assert.deepEqual(inputs, [source], 'does not pair old landmarks with current video');
  assert.equal(messages[0].timestamp, 1000, 'keeps the original exposure time');
  live.busy = false;
  video.currentTime = 3;
  live.update(1150);
  await Promise.resolve();
  assert.equal(messages.length, 1, 'a detection is only segmented once');
});

test('an unfinished elbow inference does not block hand cutouts', async (t) => {
  const { live, messages } = liveController();
  bitmapMock(t, async () => ({ close() {} }));
  live.poseReady = true;
  live.poseBusy = true;
  live.pose = { timestamp: 200, landmarks: [[]] };
  live.update(1100);
  await Promise.resolve();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].pose, null, 'stale elbow cannot drag the arm mask');
  assert.equal(messages[0].landmarks.length, 1);
});

test('CV distinguishes stalled input and detector failures from a hand outside the frame', (t) => {
  const { live } = liveController();
  bitmapMock(t, async () => {
    throw new Error('must not sample stale frames');
  });
  live.update(2200);
  assert.match(live.message, /fresh camera frames/);
  live.tracking.results.detectError = 'GPU context lost';
  live.update(2300);
  assert.match(live.message, /Hand tracking failed: GPU context lost/);
});

test('slow inference can display a completed cutout without making its contact timestamp fresh', async (t) => {
  const { live, source, messages } = liveController();
  bitmapMock(t, async () => ({ width: 960, height: 540, close() {} }));
  live.tracking.receivedAt = 1600;
  live.update(1610);
  await Promise.resolve();
  assert.equal(messages.length, 1, 'a just-delivered result survives 600 ms inference');
  assert.equal(messages[0].timestamp, 1000, 'contact checks still know the true age');
  const draws = [];
  Object.assign(live, {
    frame: source,
    mask: {},
    maskTime: 1000,
    maskReceivedAt: 1800,
    visiblePixels: 100,
    contactResults: { timestamp: 1000, landmarks: [[]] },
    stage: { clientWidth: 960, clientHeight: 540 },
    video: { style: {} },
    mirrored: () => false,
    context: {
      clearRect() {},
      save() {},
      restore() {},
      drawImage(image) {
        draws.push(image);
      },
    },
  });
  live.update(1810);
  assert.equal(live.canvas.hidden, false, 'newly completed cutout is visible');
  assert.equal(draws[0], source);
  assert.match(live.message, /delayed/);
  assert.equal(live.contactResults.timestamp, 1000);
  live.update(2210);
  assert.equal(live.canvas.hidden, true, 'stopped output still expires');
});

async function trackingWorker({ failPost = false, detectError = false } = {}) {
  const options = [],
    messages = [];
  const scope = {
    TargetMotion: {
      motionOf() {
        return {};
      },
    },
    postMessage(message, transfer) {
      if (failPost && message.type === 'result') throw new Error('transfer failed');
      messages.push({ message, transfer });
    },
  };
  const detector = {
    detectForVideo() {
      if (detectError) throw new Error('GPU context lost');
      return { landmarks: [], worldLandmarks: [], handedness: [] };
    },
  };
  const source = readFileSync(
    new URL('../public/tracking-worker.js', import.meta.url),
    'utf8',
  );
  new Function('self', 'importScripts', source)(scope, (url) => {
    if (!url.includes('vision_bundle')) return;
    scope.exports = {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      HandLandmarker: {
        createFromOptions: async (_, config) => {
          options.push(config);
          return detector;
        },
      },
    };
  });
  await scope.onmessage({ data: { type: 'init', origin: 'http://localhost' } });
  return { scope, messages, options };
}

test('worker transfers the matching image only for CV; errors still release untransferred frames', async () => {
  for (const trackArmView of [false, true]) {
    const { scope, messages, options } = await trackingWorker();
    let closed = 0;
    const bitmap = {
      close() {
        closed++;
      },
    };
    await scope.onmessage({
      data: { type: 'frame', timestamp: 1000, bitmap, trackArmView },
    });
    const { message, transfer } = messages.at(-1);
    assert.equal(message.type, 'result');
    assert.equal(message.frame, trackArmView ? bitmap : undefined);
    assert.equal(transfer.includes(bitmap), trackArmView);
    assert.equal(closed, trackArmView ? 0 : 1);
    assert.equal(options[0].minHandPresenceConfidence, 0.3);
  }
  const { scope, messages } = await trackingWorker({ failPost: true });
  let closed = 0;
  await scope.onmessage({
    data: {
      type: 'frame',
      timestamp: 1000,
      trackArmView: true,
      bitmap: {
        close() {
          closed++;
        },
      },
    },
  });
  assert.equal(closed, 1);
  assert.equal(messages.at(-1).message.type, 'error');
});

test('worker reports inference errors instead of disguising them as ordinary missing hands', async () => {
  const { scope, messages } = await trackingWorker({ detectError: true });
  await scope.onmessage({
    data: { type: 'frame', timestamp: 1000, bitmap: { close() {} } },
  });
  assert.equal(messages.at(-1).message.detectError, 'GPU context lost');
});

test('optional pose worker falls back to CPU and releases every source image', async () => {
  const delegates = [],
    messages = [],
    stamps = [];
  const scope = { postMessage: (message) => messages.push(message) };
  let failInference = false;
  const source = readFileSync(
    new URL('../public/arm-pose-worker.js', import.meta.url),
    'utf8',
  );
  new Function('self', 'importScripts', source)(scope, () => {
    scope.exports = {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      PoseLandmarker: {
        createFromOptions: async (_, options) => {
          delegates.push(options.baseOptions.delegate);
          if (options.baseOptions.delegate === 'GPU')
            throw new Error('GPU unavailable');
          return {
            detectForVideo(bitmap, timestamp) {
              if (failInference) throw new Error('pose unavailable');
              stamps.push(timestamp);
              return { landmarks: [[]] };
            },
          };
        },
      },
    };
  });
  await scope.onmessage({ data: { type: 'init', origin: 'http://localhost' } });
  assert.deepEqual(delegates, ['GPU', 'CPU']);
  assert.equal(messages.at(-1).type, 'ready');
  let closed = 0;
  const frame = {
    type: 'frame',
    timestamp: 1000,
    bitmap: {
      close() {
        closed++;
      },
    },
  };
  await scope.onmessage({ data: frame });
  await scope.onmessage({ data: frame });
  assert.deepEqual(stamps, [1000, 1001]);
  assert.equal(messages.at(-1).timestamp, 1000, 'preserves exposure time');
  failInference = true;
  await scope.onmessage({ data: frame });
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(closed, 3);
});
