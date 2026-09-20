// Which arm a tracked hand drives, with no body pose to fall back on — the state option 3
// ("my 3D arms") runs in, because it never asks the worker for pose frames.
//
// The invariant is a coherence one: a hand is drawn at a mirrored image position (the user's
// right hand enters an unmirrored frame on the LEFT), while the first-person arm it feeds is
// anchored to a fixed shoulder. Put them on opposite sides and the arms cross on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracking, VirtualHand } from '../src/hands.js';

const landmarks = (centreX) =>
  Array.from({ length: 21 }, (_, i) => ({
    x: centreX + ((i % 5) - 2) * 0.012,
    y: 0.5 - Math.floor(i / 5) * 0.02,
    z: 0,
  })).map((p, i) =>
    i === 5
      ? { x: centreX + 0.03, y: 0.5, z: 0 }
      : i === 17
        ? { x: centreX - 0.03, y: 0.5, z: 0 }
        : i === 9
          ? { x: centreX, y: 0.48, z: 0 }
          : p,
  );

const drive = (detections) => {
  const tracking = new Tracking(
      { videoWidth: 1280, videoHeight: 720, readyState: 0 },
      () => {},
    ),
    hands = [new VirtualHand(-1), new VirtualHand(1)];
  tracking.active = true;
  tracking.tick(1005, hands, {
    timestamp: 1000,
    landmarks: detections.map((d) => landmarks(d.u)),
    handedness: detections.map((d) => [{ categoryName: d.label, score: 0.99 }]),
    worldLandmarks: [],
    pose: null,
  });
  return hands;
};

test('the label names the anatomical hand, so each hand drives the arm on its own side', () => {
  // Unmirrored webcam: the user's right hand (labelled "Right") is on the image's left.
  const hands = drive([
    { u: 0.3, label: 'Right' },
    { u: 0.7, label: 'Left' },
  ]);
  for (const h of hands) {
    assert.equal(h.tracked, true, `side ${h.side} was left untracked`);
    assert.equal(
      Math.sign(h.center.x),
      h.side,
      `side ${h.side} hand is drawn at x=${h.center.x.toFixed(3)}: the arm reaches across the body`,
    );
  }
});

test('two detections labelled the same hand still land one per arm', () => {
  const hands = drive([
    { u: 0.3, label: 'Left' },
    { u: 0.7, label: 'Left' },
  ]);
  for (const h of hands) {
    assert.equal(h.tracked, true, `side ${h.side} was left untracked`);
    assert.equal(Math.sign(h.center.x), h.side);
  }
});
