import test from 'node:test';
import assert from 'node:assert/strict';
import { coverRect, compositeArms } from '../src/arm-composite.js';

test('wide camera and portrait camera cover the viewport without stretching', () => {
  assert.deepEqual(coverRect(1600, 900, 800, 800), {
    x: -311.1111111111111,
    y: 0,
    width: 1422.2222222222222,
    height: 800,
  });
  assert.deepEqual(coverRect(400, 800, 800, 800), {
    x: 0,
    y: -400,
    width: 800,
    height: 1600,
  });
});

test('live pixels and their mask share crop and reflection, then restore the context', () => {
  const calls = [];
  const context = Object.fromEntries(
    ['clearRect', 'save', 'translate', 'scale', 'drawImage', 'restore'].map((name) => [
      name,
      (...args) => calls.push([name, ...args]),
    ]),
  );
  const video = { videoWidth: 1280, videoHeight: 720 },
    mask = {};
  compositeArms(context, video, mask, 640, 360, true);
  const draws = calls.filter((c) => c[0] === 'drawImage');
  assert.equal(draws[0][1], video);
  assert.equal(draws[1][1], mask);
  assert.deepEqual(draws[0].slice(2), draws[1].slice(2));
  assert.deepEqual(calls.slice(2, 4), [
    ['translate', 640, 0],
    ['scale', -1, 1],
  ]);
  assert.equal(context.globalCompositeOperation, 'destination-in');
  assert.equal(calls.at(-1)[0], 'restore');
});

test('a worker frame bitmap retains its exact mask alignment in a cropped viewport', () => {
  const draws = [];
  const context = {
    clearRect() {},
    save() {},
    restore() {},
    drawImage(...args) {
      draws.push(args);
    },
  };
  const frame = { width: 1280, height: 720 },
    mask = { width: 256, height: 144 };
  compositeArms(context, frame, mask, 600, 600, false);
  assert.equal(draws[0][0], frame, 'renders the captured frame returned with the mask');
  assert.equal(draws[1][0], mask);
  assert.deepEqual(draws[0].slice(1), draws[1].slice(1));
  assert.ok(
    draws
      .flat()
      .filter((v) => typeof v === 'number')
      .every(Number.isFinite),
  );
});
