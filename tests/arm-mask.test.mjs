// Mask fixtures ported from jace/cv at d0c1763.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcCoverage,
  ArmAnchor,
  armCutout,
  MaskSmoother,
  refineArmEdges,
} from '../src/arm-mask.js';

test('strict front-camera mask stops at the elbow even when connected shirt fills the frame', () => {
  const width = 100,
    height = 100;
  const labels = new Uint8Array(width * height).fill(4);
  const landmarks = hand(0.3, 0.25, 0.09);
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  pose[15] = { ...landmarks[0], visibility: 1 };
  pose[13] = { x: 0.25, y: 0.62, visibility: 1 };
  const { alpha } = armCutout(labels, width, height, [landmarks], null, null, {
    strict: true,
    pose,
  });
  assert.ok(alpha[48 * width + 28], 'forearm corridor retained');
  assert.equal(alpha[90 * width + 30], 0, 'shirt below elbow rejected');
  assert.equal(alpha[50 * width + 50], 0, 'middle of torso rejected');
  const missing = armCutout(labels, width, height, [landmarks], null, null, {
    strict: true,
  }).alpha;
  assert.equal(
    missing[48 * width + 30],
    0,
    'missing elbow does not invent a corridor into the body',
  );
});

test('dropout support cannot grow across connected clothing into the body', () => {
  const width = 64,
    height = 64,
    labels = new Uint8Array(width * height).fill(4);
  let support = armCutout(labels, width, height, [hand(0.25, 0.3, 0.09)]).alpha;
  const initial = support.slice();
  for (let i = 0; i < 40; i++)
    support = armCutout(labels, width, height, [], support).alpha;
  assert.deepEqual(
    support,
    initial,
    'forty dropped frames never dilate into the torso',
  );
});

function hand(cx = 0.5, palmY = 0.32, size = 0.12) {
  const points = Array.from({ length: 21 }, () => ({ x: cx, y: palmY, z: 0 }));
  points[0] = { x: cx, y: palmY + size * 1.3, z: 0 };
  for (let finger = 0; finger < 5; finger++)
    for (let joint = 0; joint < 4; joint++) {
      const index = 1 + finger * 4 + joint;
      points[index] = {
        x: cx + (finger - 2) * size * 0.22,
        y: palmY - joint * size * 0.22,
        z: -joint * 0.005,
      };
    }
  return points;
}

test('arm mask keeps skin and sleeve on the landmark-seeded arm but rejects another person blob', () => {
  const width = 32,
    height = 32,
    labels = new Uint8Array(width * height),
    landmarks = hand(0.5, 0.28, 0.12);
  for (let y = 5; y < height; y++)
    for (let x = 13; x <= 18; x++) labels[y * width + x] = y < 17 ? 2 : 4;
  for (let y = 20; y < 30; y++) for (let x = 2; x < 6; x++) labels[y * width + x] = 2;
  const { alpha } = armCutout(labels, width, height, [landmarks]);
  assert.equal(alpha[9 * width + 16], 255, 'hand skin retained');
  assert.equal(alpha[27 * width + 16], 255, 'sleeve corridor retained to frame edge');
  assert.equal(alpha[25 * width + 3], 0, 'unseeded person blob rejected');
});

test('landmarks cannot reveal background when the segmenter misses a fist', () => {
  const width = 32,
    height = 32,
    landmarks = hand(0.5, 0.28, 0.12);
  const { alpha } = armCutout(new Uint8Array(width * height), width, height, [
    landmarks,
  ]);
  assert.ok(
    alpha.every((value) => value === 0),
    'no translucent disc around the hand',
  );
});

test('the crop never extends past skin or sleeve pixels, including with dropout support', () => {
  const width = 64,
    height = 48,
    labels = new Uint8Array(width * height);
  for (let y = 8; y < height; y++)
    for (let x = 28; x < 36; x++) labels[y * width + x] = y < 24 ? 2 : 4;
  const seeded = armCutout(labels, width, height, [hand(0.5, 0.28, 0.12)]).alpha;
  const sustained = armCutout(labels, width, height, [], seeded).alpha;
  for (const alpha of [seeded, sustained]) {
    assert.ok(
      alpha.some((value) => value === 255),
      'arm stays visible',
    );
    for (let i = 0; i < alpha.length; i++)
      if (!labels[i]) assert.equal(alpha[i], 0, `background at ${i} stays transparent`);
  }
});

test('confidence trims uncertain fringe while retaining skin and sleeve seams', () => {
  const alpha = new Uint8ClampedArray([255, 255, 255, 255, 0]);
  refineArmEdges(
    alpha,
    new Float32Array([0.4, 0.65, 0.98, 0.48, 1]),
    new Float32Array([0.1, 0.05, 0, 0.48, 0]),
  );
  assert.equal(alpha[0], 0, 'uncertain fringe disappears');
  assert.ok(alpha[1] > 100 && alpha[1] < 155, 'narrow inner boundary is feathered');
  assert.equal(alpha[2], 255, 'confident skin stays opaque');
  assert.equal(alpha[3], 255, 'skin/clothing seam stays opaque');
  assert.equal(alpha[4], 0, 'confidence cannot add pixels outside the selected arm');
});

test('mask smoothing clears vacated pixels immediately as a fist moves', () => {
  const smoother = new MaskSmoother();
  const on = new Uint8ClampedArray([255]),
    off = new Uint8ClampedArray([0]);
  assert.equal(smoother.apply(on)[0], 255, 'first frame seeds directly');
  assert.equal(smoother.apply(off)[0], 0, 'no old silhouette over current background');
  assert.ok(smoother.apply(on)[0] > 150, 'reappearing pixel recovers fast');
  assert.equal(
    smoother.apply(new Uint8ClampedArray([40]))[0],
    40,
    'edge never exceeds current confidence',
  );
});

test('arc coverage counts only the on-frame slice of a corner arc', () => {
  const width = 32,
    height = 32,
    alpha = new Uint8ClampedArray(width * height);
  const target = { x: 0.14, y: 0.78 },
    radius = 0.32;
  assert.equal(
    arcCoverage(alpha, width, height, target, radius),
    0,
    'empty mask covers nothing',
  );
  // Light the whole bottom-left corner: full coverage despite most of the circle being off-frame.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (y >= height * 0.4 && x <= width * 0.5) alpha[y * width + x] = 255;
  assert.equal(
    arcCoverage(alpha, width, height, target, radius),
    1,
    'fully lit arc reads 100%',
  );
  // Half-dim it: coverage tracks the lit fraction.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if ((x + y) % 2) alpha[y * width + x] = 0;
  const half = arcCoverage(alpha, width, height, target, radius);
  assert.ok(half > 0.3 && half < 0.7, 'checkerboard reads near half: ' + half);
});

test('an established arm survives on segmentation alone when hand detection drops', () => {
  const width = 32,
    height = 32,
    labels = new Uint8Array(width * height),
    landmarks = hand(0.5, 0.28, 0.12);
  for (let y = 5; y < height; y++)
    for (let x = 13; x <= 18; x++) labels[y * width + x] = y < 17 ? 2 : 4;
  const seeded = armCutout(labels, width, height, [landmarks]).alpha;
  assert.equal(seeded[9 * width + 16], 255, 'landmarks bootstrap the arm');
  // Detection drops for a frame: no hands at all, but the segmenter still sees the arm.
  const sustained = armCutout(labels, width, height, [], seeded).alpha;
  assert.equal(sustained[9 * width + 16], 255, 'hand region persists');
  assert.equal(sustained[27 * width + 16], 255, 'sleeve corridor persists');
  // No support and no hands: nothing appears from segmentation alone.
  const cold = armCutout(labels, width, height, []).alpha;
  assert.ok(
    cold.every((value) => value === 0),
    'person pixels never bootstrap themselves',
  );
  // Support without person pixels: the arm left the frame, the mask follows it out.
  const gone = armCutout(
    new Uint8Array(width * height),
    width,
    height,
    [],
    seeded,
  ).alpha;
  assert.ok(
    gone.every((value) => value === 0),
    'sustain requires live segmentation',
  );
});

// Corner-anchored anti-loop: the below-chin camera sees the laptop screen, so the app's own
// rendered arms reappear mid-frame. Real arms are corner-connected; ghosts are floating islands.
test('corner anchoring keeps the real arm and rejects the on-screen ghost', () => {
  const width = 32,
    height = 32,
    labels = new Uint8Array(width * height);
  // Real arm: skin column rising from the bottom-left corner strip.
  for (let y = 8; y < height; y++)
    for (let x = 2; x <= 7; x++) labels[y * width + x] = 2;
  // Ghost: a skin patch floating mid-frame — the laptop screen's copy of a fist.
  for (let y = 10; y < 16; y++)
    for (let x = 17; x <= 22; x++) labels[y * width + x] = 2;
  const realHand = hand(0.15, 0.35, 0.12),
    ghostHand = hand(0.62, 0.38, 0.1);
  const anchor = new ArmAnchor();
  const { alpha, anchored } = armCutout(
    labels,
    width,
    height,
    [realHand, ghostHand],
    null,
    anchor,
  );
  assert.deepEqual(anchored, [true, false], 'only the corner-connected hand is real');
  assert.equal(alpha[12 * width + 4], 255, 'real arm rendered');
  assert.ok(
    alpha.slice(12 * width + 17, 12 * width + 23).every((value) => value === 0),
    'ghost patch contributes nothing',
  );
});

test('temporal credit carries a corner-connected arm through a segmentation gap, then expires', () => {
  const width = 32,
    height = 32,
    anchor = new ArmAnchor({ maxCredit: 3 });
  const full = new Uint8Array(width * height),
    cut = new Uint8Array(width * height);
  for (let y = 8; y < height; y++) for (let x = 2; x <= 7; x++) full[y * width + x] = 2;
  // Same arm with its neck severed: rows 24-27 lost by the segmenter.
  for (let y = 8; y < height; y++)
    for (let x = 2; x <= 7; x++) if (y < 24 || y > 27) cut[y * width + x] = 2;
  const arm = [hand(0.15, 0.35, 0.12)];
  assert.equal(
    armCutout(full, width, height, arm, null, anchor).anchored[0],
    true,
    'established while whole',
  );
  for (let i = 0; i < 3; i++)
    assert.equal(
      armCutout(cut, width, height, arm, null, anchor).anchored[0],
      true,
      'credit bridges the gap: frame ' + i,
    );
  assert.equal(
    armCutout(cut, width, height, arm, null, anchor).anchored[0],
    false,
    'credit exhausted, upper blob no longer trusted',
  );
});
