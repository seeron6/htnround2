import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardReadyHold, handsInGuardTargets } from '../src/guard-readiness.js';

const hand = (x, y) => Array.from({ length: 21 }, () => ({ x, y }));
const preview = { left: 40, top: 30, width: 460, height: 258.75 };
const targets = [
  { left: 95, top: 82, width: 101, height: 147 },
  { left: 344, top: 82, width: 101, height: 147 },
];
const video = { width: 960, height: 540 };

test('requires a palm in each mirrored target, with open hands or fists', () => {
  const left = hand(0.77, 0.49);
  const right = hand(0.23, 0.49);
  assert.deepEqual(handsInGuardTargets([left, right], video, preview, targets), [
    true,
    true,
  ]);
  assert.deepEqual(handsInGuardTargets([right, left], video, preview, targets), [
    true,
    true,
  ]);
  assert.deepEqual(handsInGuardTargets([left, left], video, preview, targets), [
    true,
    false,
  ]);
  assert.deepEqual(
    handsInGuardTargets([hand(0.5, 0.5), right], video, preview, targets),
    [false, true],
  );
  // Moving fingertips without moving the palm must not interrupt a hold.
  for (const index of [4, 8, 12, 16, 20]) left[index] = { x: 0.5, y: 0.8 };
  assert.deepEqual(handsInGuardTargets([left, right], video, preview, targets), [
    true,
    true,
  ]);
});

test('aligns target detection with a cropped 4:3 webcam and resized preview', () => {
  const croppedVideo = { width: 640, height: 480 };
  const projectedHand = (target) =>
    hand(
      0.5 - (target.left + target.width / 2 - preview.left - preview.width / 2) / 460,
      0.5 + (target.top + target.height / 2 - preview.top - preview.height / 2) / 345,
    );
  const palms = targets.map(projectedHand);
  assert.deepEqual(handsInGuardTargets(palms, croppedVideo, preview, targets), [
    true,
    true,
  ]);
  const shrink = (rect) =>
    Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value / 2]));
  assert.deepEqual(
    handsInGuardTargets(palms, croppedVideo, shrink(preview), targets.map(shrink)),
    [true, true],
  );
});

test('rejects missing camera dimensions, invalid landmarks, and rounded target corners', () => {
  assert.deepEqual(handsInGuardTargets([[]], video, preview, targets), [false, false]);
  assert.deepEqual(
    handsInGuardTargets([hand(0.77, 0.49)], { width: 0, height: 0 }, preview, targets),
    [false, false],
  );
  const corner = hand(
    1 - (targets[0].left + 1 - preview.left) / preview.width,
    (targets[0].top + 1 - preview.top) / preview.height,
  );
  assert.deepEqual(handsInGuardTargets([corner], video, preview, targets), [
    false,
    false,
  ]);
});

test('calibrates once after three seconds of continuously observed guard', () => {
  const hold = new GuardReadyHold();
  for (let time = 0; time < 3000; time += 100) {
    const result = hold.update(true, time, time + 20);
    assert.equal(result.complete, false);
    assert.equal(result.progress, time / 3000);
  }
  assert.deepEqual(hold.update(true, 3000, 3020), { progress: 1, complete: true });
  assert.deepEqual(hold.update(true, 3100, 3120), { progress: 1, complete: false });
});

test('losing either target requires a new full three-second hold', () => {
  const hold = new GuardReadyHold();
  for (let time = 0; time <= 2000; time += 100) hold.update(true, time, time);
  assert.deepEqual(hold.update(false, 2100, 2100), { progress: 0, complete: false });
  for (let time = 2200; time < 5200; time += 100)
    assert.equal(hold.update(true, time, time).complete, false);
  assert.equal(hold.update(true, 5200, 5200).complete, true);
});

test('stale frames cannot advance or complete the countdown', () => {
  const hold = new GuardReadyHold();
  for (let time = 0; time <= 2900; time += 100) hold.update(true, time, time);
  assert.equal(hold.update(true, 2900, 3050).complete, false);
  assert.deepEqual(hold.update(true, 2900, 3500), { progress: 0, complete: false });
  assert.equal(hold.update(true, 3600, 3600).progress, 0);
});

test('resets after a suspended loop, camera restart, or leaving the page', () => {
  for (const interruptedBy of ['gap', 'restart', 'reset']) {
    const hold = new GuardReadyHold();
    for (let time = 1000; time <= 3000; time += 100) hold.update(true, time, time);
    if (interruptedBy === 'reset') hold.reset();
    const resumedAt = interruptedBy === 'restart' ? 100 : 4000;
    assert.deepEqual(hold.update(true, resumedAt, resumedAt), {
      progress: 0,
      complete: false,
    });
  }
});
