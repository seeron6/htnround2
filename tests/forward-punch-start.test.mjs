import test from 'node:test';
import assert from 'node:assert/strict';
import { ForwardPunchStart } from '../src/forward-punch-start.js';
import { punchReplay } from './helpers/punch-replay.mjs';

const detector = () => new ForwardPunchStart({ videoWidth: 640, videoHeight: 480 });
const state = (frame, extra = {}) => ({
  ...frame,
  active: true,
  calibrated: true,
  ...extra,
});
const replay = (start, frames, extra = {}, enabled = true, delay = 8) =>
  frames.filter((frame) =>
    start.update(state(frame, extra), frame.timestamp + delay, enabled),
  );

test('a forward punch with either hand starts exactly once per ready screen', () => {
  for (const label of ['Left', 'Right']) {
    const start = detector();
    const frames = punchReplay().map((frame) => ({
      ...frame,
      handedness: [[{ categoryName: label, score: 0.95 }]],
    }));
    assert.equal(replay(start, frames).length, 1, label);
    assert.equal(replay(start, punchReplay('jab', { start: 900 })).length, 0);
    start.reset();
    assert.equal(replay(start, punchReplay('jab', { start: 1800 })).length, 1);
  }
});

test('hooks, uppercuts, overhands, and a stationary guard do not start the round', () => {
  for (const kind of ['left-hook', 'right-hook', 'uppercut', 'overhand'])
    assert.equal(replay(detector(), punchReplay(kind)).length, 0, kind);
  const frames = punchReplay();
  const stationary = frames.map((frame) => ({
    ...frames[0],
    timestamp: frame.timestamp,
  }));
  assert.equal(replay(detector(), stationary).length, 0);
});

test('only an active, calibrated, visible ready screen accepts the gesture', () => {
  const frames = punchReplay();
  assert.equal(replay(detector(), frames, { active: false }).length, 0);
  assert.equal(replay(detector(), frames, { calibrated: false }).length, 0);
  assert.equal(replay(detector(), frames, {}, false).length, 0);
  assert.equal(replay(detector(), frames, {}, true, 501).length, 0);
  assert.equal(replay(detector(), frames, {}, true, -1).length, 0);
});

test('a frozen approach frame cannot start a round as time passes', () => {
  const start = detector();
  const approach = punchReplay().filter((frame) => frame.timestamp < 160);
  assert.equal(replay(start, approach).length, 0);
  const last = state(approach.at(-1));
  for (let delay = 10; delay <= 700; delay += 10)
    assert.equal(start.update(last, last.timestamp + delay, true), false);
});

test('leaving readiness discards a pending punch before re-entry', () => {
  const start = detector();
  const frames = punchReplay();
  assert.equal(
    replay(
      start,
      frames.filter((frame) => frame.timestamp < 160),
    ).length,
    0,
  );
  start.update(state(frames[10]), frames[10].timestamp + 8, false);
  assert.equal(replay(start, frames.slice(10)).length, 0);
  assert.equal(replay(start, punchReplay('jab', { start: 1000 })).length, 1);
});
