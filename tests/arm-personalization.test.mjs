import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  sampleArmFrame,
  ArmScanAccumulator,
  normalizeArmProfile,
  restoreArmSample,
  storeArmSample,
} from '../src/arm-personalization.js';
import { ArmDynamics } from '../src/physics.js';
import { PresetArm } from '../src/preset-arm.js';
import { syntheticArms, appearanceArms } from './helpers/synthetic-arms.mjs';

test('samples each anatomical arm, keeps tattoo pixels and detects sleeve coverage', () => {
  const fixture = syntheticArms();
  const samples = sampleArmFrame(fixture.image, fixture.landmarks, fixture.pose);
  assert.equal(samples.left.skin, '#c28d68');
  assert.equal(samples.right.skin, '#704b38');
  assert.equal(samples.left.style, 'bare', 'a tattoo band is not a long sleeve');
  assert.equal(samples.right.style, 'long');
  assert.equal(samples.right.clothing, '#20305a');
  const rgb = samples.left.strip;
  assert.ok(
    Array.from({ length: rgb.length / 4 }, (_, i) => rgb[i * 4]).includes(32),
    'photographed marking survives',
  );
  assert.ok(
    !Array.from({ length: rgb.length / 4 }, (_, i) => rgb[i * 4 + 1]).includes(170),
    'room green stays out of arm texture',
  );
});

test('rejects missing elbows, small/foreshortened arms and duplicate frames', () => {
  const f = syntheticArms();
  assert.deepEqual(sampleArmFrame(f.image, f.landmarks, null), {});
  f.pose[13].visibility = 0.1;
  assert.equal(sampleArmFrame(f.image, f.landmarks, f.pose).left, undefined);
  f.pose[14].y = 0.38;
  assert.deepEqual(sampleArmFrame(f.image, f.landmarks, f.pose), {});
  const good = syntheticArms(),
    samples = sampleArmFrame(good.image, good.landmarks, good.pose);
  const scan = new ArmScanAccumulator();
  scan.add(samples, 1);
  scan.add(samples, 1);
  assert.deepEqual(scan.frames, { left: 1, right: 1 });
  assert.throws(() => scan.finish(), /forearm/);
  scan.add(samples, 2);
  scan.add(samples, 3);
  assert.equal(scan.finish().left.skin, '#c28d68');
});

test('arm motor follows tracked motion, absorbs contact recoil and settles at different frame rates', () => {
  for (const fps of [15, 30, 60, 144]) {
    const motor = new ArmDynamics(),
      target = new THREE.Vector3(-0.12, -0.1, -0.4);
    motor.step(target, 1 / fps);
    motor.recoil(4);
    motor.step(target, 1 / fps);
    assert.ok(motor.position.z > target.z, 'contact pushes the fist toward the viewer');
    for (let i = 0; i < fps * 2; i++) motor.step(target, 1 / fps);
    assert.ok(
      motor.position.distanceTo(target) < 0.0001,
      `${fps} fps returns to guard`,
    );
  }
});

test('bare and sleeved rigs have separate accessories, finite geometry and move in first person', () => {
  for (const style of ['bare', 'short', 'long', 'hoodie']) {
    const arm = new PresetArm(-1, { style, watch: true, ring: true });
    assert.equal(arm.sleeve.visible, style !== 'bare');
    assert.equal(arm.watch.visible, true);
    assert.equal(arm.ring.visible, true);
    const before = arm.palm.position.clone();
    for (let i = 0; i < 30; i++)
      arm.update(
        { visible: true, closed: 1, center: new THREE.Vector3(-0.08, 0, -0.55) },
        1 / 60,
      );
    assert.ok(arm.palm.position.z < before.z - 0.1, 'punch reaches into the scene');
    arm.traverse((o) => {
      if (o.geometry)
        assert.ok(o.geometry.attributes.position.array.every(Number.isFinite));
    });
    arm.dispose();
  }
  assert.equal(normalizeArmProfile({ skin: 'url(evil)', width: 999 }).width, 1.3);
});

test('scan fits asymmetric sleeves, fabric colors, a left watch and a right middle-finger ring', () => {
  const f = appearanceArms();
  const samples = sampleArmFrame(f.image, f.landmarks, f.pose);
  const scan = new ArmScanAccumulator();
  for (let i = 1; i <= 5; i++) scan.add(samples, i);
  const fitted = scan.finish();
  assert.equal(fitted.left.skin, '#583c30');
  assert.equal(fitted.right.skin, '#704b38');
  assert.equal(fitted.left.style, 'long');
  assert.equal(fitted.left.clothing, '#d8cfb5');
  assert.equal(fitted.right.style, 'short');
  assert.equal(fitted.right.clothing, '#20305a');
  assert.equal(fitted.left.watch, true);
  assert.equal(fitted.right.watch, false);
  assert.equal(fitted.left.ring, false);
  assert.equal(fitted.right.ring, true);
  assert.equal(fitted.right.ringFinger, 3);
  assert.equal(fitted.right.ringColor, '#ccc8bf');
  assert.equal(fitted.left.watchColor, '#171c22');
  for (const side of ['left', 'right']) {
    const restored = restoreArmSample(
      JSON.parse(JSON.stringify(storeArmSample(fitted[side].sample))),
    );
    assert.deepEqual(restored.strip, fitted[side].sample.strip);
    assert.deepEqual(restored.upperStrip, fitted[side].sample.upperStrip);
    const arm = new PresetArm(side === 'left' ? -1 : 1, fitted[side], restored);
    assert.equal(arm.watch.visible, fitted[side].watch);
    assert.equal(arm.ring.visible, fitted[side].ring);
    assert.equal(arm.surface.material.color.getHexString(), fitted[side].skin.slice(1));
    assert.equal(
      arm.sleeve.material.color.getHexString(),
      fitted[side].clothing.slice(1),
    );
    assert.ok(arm.upperPhotoMap, 'the upper sleeve photograph reaches the material');
    if (arm.ring.visible) {
      const bone = arm.byName.get('finger3-1');
      assert.ok(arm.ring.position.distanceTo(bone.position) < 0.02);
    }
    arm.dispose();
  }
});

test('unadorned wrists/fingers do not add accessories, and one bad frame cannot set colors or jewelry', () => {
  const plain = appearanceArms({ accessories: false });
  const clean = sampleArmFrame(plain.image, plain.landmarks, plain.pose);
  const decorated = appearanceArms();
  const noisy = sampleArmFrame(decorated.image, decorated.landmarks, decorated.pose);
  const scan = new ArmScanAccumulator();
  scan.add(
    { left: { ...noisy.left, skin: '#ffffff', quality: 999 }, right: noisy.right },
    1,
  );
  for (let i = 2; i <= 7; i++) scan.add(clean, i);
  const result = scan.finish();
  assert.equal(result.left.skin, '#583c30');
  for (const side of ['left', 'right']) {
    assert.equal(result[side].watch, false);
    assert.equal(result[side].ring, false);
  }
});

test('saved legacy strips remain readable and oversized/malformed samples are rejected', () => {
  assert.ok(
    restoreArmSample({
      stripWidth: 32,
      stripHeight: 128,
      strip: Array(16384).fill(64),
    }),
  );
  assert.equal(
    restoreArmSample({ stripWidth: 5000, stripHeight: 5000, strip: [] }),
    null,
  );
  assert.equal(
    restoreArmSample({ stripWidth: 64, stripHeight: 192, strip: [1] }),
    null,
  );
});

test('lighter palms and darker forearms remain skin, rather than becoming dark sleeves', () => {
  const f = syntheticArms();
  for (let y = Math.floor(f.image.height * 0.4); y < f.image.height * 0.87; y++)
    for (let x = Math.floor(f.image.width * 0.66); x < f.image.width * 0.74; x++)
      f.image.data.set([88, 60, 48, 255], (y * f.image.width + x) * 4);
  const samples = sampleArmFrame(f.image, f.landmarks, f.pose);
  assert.equal(samples.left.style, 'bare');
  assert.equal(samples.left.skin, '#583c30');
});

test('hand detection order does not swap anatomical accessories or colors', () => {
  const f = appearanceArms();
  const normal = sampleArmFrame(f.image, f.landmarks, f.pose);
  const reversed = sampleArmFrame(f.image, [...f.landmarks].reverse(), f.pose);
  for (const side of ['left', 'right']) {
    assert.equal(reversed[side].skin, normal[side].skin);
    assert.deepEqual(reversed[side].accessories, normal[side].accessories);
  }
});

test('a clear hand confirms a low-confidence body wrist and anchors the crop precisely', () => {
  const f = syntheticArms();
  const baseline = sampleArmFrame(f.image, f.landmarks, f.pose);
  f.pose[15].visibility = 0.2;
  f.pose[15].x += 0.045;
  f.pose[16].visibility = 0.35;
  const feedback = {};
  const samples = sampleArmFrame(f.image, f.landmarks, f.pose, feedback);
  assert.deepEqual(feedback, { left: 'ready', right: 'ready' });
  assert.deepEqual(
    samples.left.strip,
    baseline.left.strip,
    'body wrist drift cannot crop the room',
  );
  assert.equal(samples.right.skin, baseline.right.skin);
  f.pose[15].x = 0.4;
  assert.equal(
    sampleArmFrame(f.image, f.landmarks, f.pose, feedback).left,
    undefined,
    'a low-confidence wrist still needs a matching detected hand',
  );
  assert.equal(feedback.left, 'match');
});

test('scan feedback distinguishes missing body, hands, elbows and camera pixels', () => {
  const f = syntheticArms();
  const feedback = {};
  sampleArmFrame(f.image, f.landmarks, null, feedback);
  assert.deepEqual(feedback, { left: 'body', right: 'body' });
  sampleArmFrame(f.image, [], f.pose, feedback);
  assert.deepEqual(feedback, { left: 'hand', right: 'hand' });
  f.pose[13].visibility = 0.1;
  const samples = sampleArmFrame(f.image, f.landmarks, f.pose, feedback);
  assert.equal(samples.left, undefined);
  assert.ok(samples.right);
  assert.deepEqual(feedback, { left: 'elbow', right: 'ready' });
  assert.throws(
    () => new ArmScanAccumulator().finish(feedback),
    /Left forearm: 0\/3 clear views.*elbow/,
  );
  assert.deepEqual(sampleArmFrame(undefined, f.landmarks, f.pose, feedback), {});
  assert.deepEqual(feedback, { left: 'camera', right: 'camera' });
});
