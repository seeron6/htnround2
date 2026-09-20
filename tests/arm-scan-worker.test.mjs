import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../public/tracking-worker.js', import.meta.url),
  'utf8',
);
function workerHarness() {
  const messages = [],
    created = [];
  const self = { postMessage: (data, transfers) => messages.push({ data, transfers }) };
  const pose = [{ x: 0.4, y: 0.6, z: 0, visibility: 1 }];
  const importScripts = (path) => {
    if (path.includes('target-motion')) {
      self.TargetMotion = { motionOf: () => ({}) };
      return;
    }
    self.exports = {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      HandLandmarker: {
        createFromOptions: async () => ({
          detectForVideo: () => ({
            landmarks: [pose],
            worldLandmarks: [pose],
            handedness: [],
          }),
        }),
      },
      PoseLandmarker: {
        createFromOptions: async (_, options) => {
          const detector = {
            options,
            closed: false,
            close() {
              this.closed = true;
            },
            detectForVideo(bitmap, time, callback) {
              callback({
                landmarks: [pose],
                worldLandmarks: [pose],
                segmentationMasks: options.outputSegmentationMasks
                  ? [
                      {
                        width: 2,
                        height: 2,
                        getAsFloat32Array: () => new Float32Array(4).fill(1),
                      },
                    ]
                  : [],
              });
            },
          };
          created.push(detector);
          return detector;
        },
      },
    };
  };
  class Canvas {
    constructor(width, height) {
      Object.assign(this, { width, height });
    }
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({
          data: new Uint8ClampedArray(this.width * this.height * 4).fill(128),
        }),
      };
    }
    async convertToBlob() {
      return 'png-fixture';
    }
  }
  new Function('self', 'importScripts', 'OffscreenCanvas', source)(
    self,
    importScripts,
    Canvas,
  );
  return { messages, created, send: (data) => self.onmessage({ data }) };
}

test('quick scan transfers source pixels with matching pose, and sends no pixels once scanning stops', async () => {
  const h = workerHarness();
  await h.send({ type: 'init', origin: 'http://localhost' });
  await h.send({ type: 'enablePose' });
  let closed = 0;
  const bitmap = {
    width: 960,
    height: 540,
    close() {
      closed++;
    },
  };
  await h.send({ type: 'frame', bitmap, timestamp: 100, scanArms: true });
  const { data, transfers } = h.messages.at(-1);
  assert.equal(data.type, 'result');
  assert.equal(data.pose.timestamp, data.timestamp);
  assert.equal(data.armSample.width, 960);
  assert.equal(data.armSample.height, 540);
  assert.equal(transfers[0], data.armSample.data.buffer);
  assert.equal(closed, 1);
  await h.send({ type: 'frame', bitmap, timestamp: 200, scanArms: false });
  assert.equal(h.messages.at(-1).data.armSample, undefined);
  assert.equal(closed, 2);
});

test('legacy multiview capture can upgrade a pose model warmed by quick scanning', async () => {
  const h = workerHarness();
  await h.send({ type: 'init', origin: 'http://localhost' });
  await h.send({ type: 'enablePose', wantSegmentation: false });
  await h.send({ type: 'enablePose', wantSegmentation: true });
  assert.equal(h.created.length, 2);
  assert.equal(h.created[0].closed, true);
  assert.equal(h.messages.at(-1).data.segmentation, true);
  await h.send({
    type: 'frame',
    bitmap: { width: 960, height: 540, close() {} },
    timestamp: 300,
    capture: 'left',
  });
  assert.equal(h.messages.at(-1).data.capture.side, 'left');
  assert.equal(h.messages.at(-1).data.capture.image, 'png-fixture');
  assert.equal(h.messages.at(-1).data.capture.mask.length, 4);
});
