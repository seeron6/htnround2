import test from 'node:test';
import assert from 'node:assert/strict';
import { headCaptureMask, headOutline } from '../public/head-capture-mask.js';
import { FACE_OVAL } from '../src/face-quality.js';

function fixture() {
  const width = 100,
    height = 120,
    labels = new Uint8Array(width * height);
  const paint = (x0, y0, x1, y1, label) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) labels[y * width + x] = label;
  };
  return { width, height, labels, paint };
}

test('moving head silhouette is not clipped to the previous frontal rectangle', () => {
  const f = fixture();
  f.paint(38, 8, 68, 35, 1);
  f.paint(42, 30, 65, 68, 3);
  const result = headCaptureMask({ ...f, previous: [20, 20, 55, 48] });
  assert.equal(result.mask[8 * f.width + 38], 1, 'crown retained above old top');
  assert.equal(result.mask[68 * f.width + 65], 1, 'chin retained below old bottom');
  assert.equal(result.mask[20 * f.width + 68], 1, 'profile retained past old side');
});

test('glasses pixels stay inside the face even when pose is unsuitable for fitting', () => {
  const f = fixture();
  f.paint(30, 20, 65, 65, 3);
  f.paint(28, 10, 67, 25, 1);
  f.paint(30, 33, 65, 42, 5);
  const oval = [
    { x: 0.3, y: 20 / 120 },
    { x: 0.66, y: 20 / 120 },
    { x: 0.66, y: 66 / 120 },
    { x: 0.3, y: 66 / 120 },
  ];
  const result = headCaptureMask({ ...f, oval });
  for (let y = 33; y <= 42; y++)
    for (let x = 31; x < 65; x++) assert.equal(result.mask[y * 100 + x], 1);
});

test('profile glasses survive without any detected facial landmarks', () => {
  const f = fixture();
  f.paint(30, 20, 65, 65, 3);
  f.paint(28, 10, 67, 25, 1);
  f.paint(27, 33, 65, 42, 5);
  const result = headCaptureMask(f);
  assert.equal(result.mask[36 * 100 + 28], 1, 'projecting frame retained');
  assert.equal(result.mask[36 * 100 + 45], 1, 'lens interior retained');
});

test('rear head retains hair, ears and a short neck while excluding shoulders and a hand', () => {
  const f = fixture();
  f.paint(35, 10, 65, 45, 1);
  f.paint(33, 32, 34, 48, 2);
  f.paint(66, 32, 67, 48, 2);
  f.paint(40, 45, 60, 65, 2);
  f.paint(10, 66, 90, 105, 2);
  f.paint(25, 35, 30, 43, 2);
  const result = headCaptureMask(f);
  assert.equal(result.mask[36 * 100 + 33], 1, 'ear retained');
  assert.equal(result.mask[48 * 100 + 50], 1, 'neck retained');
  assert.equal(result.mask[70 * 100 + 50], 0, 'shoulders excluded');
  assert.equal(result.mask[38 * 100 + 28], 0, 'detached hand excluded');
});

test('true source-edge clipping remains visible to the capture rejection gate', () => {
  const f = fixture();
  f.paint(30, 0, 65, 30, 1);
  f.paint(35, 25, 60, 60, 3);
  assert.equal(headCaptureMask(f).bounds[1], 0);
});

test('mask never invents yaw or landmarks for a rear view', () => {
  const f = fixture();
  f.paint(30, 20, 65, 60, 1);
  const result = headCaptureMask(f);
  assert.equal(result.yaw, undefined);
  assert.equal(result.landmarks, undefined);
  assert.equal(headOutline(null, FACE_OVAL), null);
  assert.equal(headCaptureMask(fixture()), null);
});
