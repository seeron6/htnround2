import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Tracking, VirtualHand } from '../src/hands.js';
import { PresetArm } from '../src/preset-arm.js';
import { armFrame } from '../src/arm-kinematics.js';
import {
  palmFrame,
  trackedPalmFrame,
  limitWristBend,
} from '../src/hand-orientation.js';
import { wristObservation } from './helpers/wrist-tracking.mjs';

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

test('both anatomical palms recover pitch, yaw and full roll from camera landmarks', () => {
  for (const side of [-1, 1])
    for (const roll of [-3.05, -1.6, 0, 1.6, 3.05]) {
      const expected = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-0.7, roll, 0.3),
      );
      const { world, image } = wristObservation(side, expected);
      const metric = trackedPalmFrame(world, image, side, 16 / 9);
      const fallback = trackedPalmFrame([], image, side, 16 / 9);
      assert.ok(metric.angleTo(expected) < 1e-7, `metric orientation, side ${side}`);
      assert.ok(
        fallback.angleTo(expected) < 1e-7,
        `aspect-correct fallback, side ${side}`,
      );
    }
});

test('missing or collapsed palm anchors cannot produce an invalid rotation', () => {
  assert.equal(palmFrame([], -1), null);
  const collapsed = Array.from({ length: 21 }, () => new THREE.Vector3());
  assert.equal(palmFrame(collapsed, 1), null);
  collapsed[9].y = 0.08;
  collapsed[5].y = 0.06;
  assert.equal(palmFrame(collapsed, 1), null, 'collinear palm rejected');
  collapsed[0].x = NaN;
  assert.equal(palmFrame(collapsed, 1), null);
  const good = wristObservation(-1, new THREE.Quaternion());
  assert.ok(
    trackedPalmFrame(collapsed, good.image, -1, 16 / 9).angleTo(
      new THREE.Quaternion(),
    ) < 1e-7,
  );
});

test('wrist bend is bounded without clipping forearm roll', () => {
  const base = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.8, 0, 0.2));
  for (const roll of [-Math.PI, -2, 0, 2, Math.PI]) {
    const target = base
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, roll));
    assert.ok(limitWristBend(target, base).angleTo(target) < 1e-7);
  }
  const bent = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z, 2.5));
  const limited = limitWristBend(bent, base);
  assert.ok(
    Y.clone().applyQuaternion(limited).angleTo(Y.clone().applyQuaternion(base)) <=
      (Math.PI * 75) / 180 + 1e-7,
  );
});

test('camera-only tracking rotates the third-option skin at a stationary hand position', () => {
  for (const side of [-1, 1]) {
    const tracking = new Tracking(
      { videoWidth: 1280, videoHeight: 720, readyState: 0 },
      () => {},
    );
    tracking.active = true;
    const hand = new VirtualHand(side);
    const arm = new PresetArm(side, { style: 'bare', ring: true });
    const base = armFrame(arm.anchors.wrist.clone().sub(arm.anchors.elbow), Z);
    const image = wristObservation(side, base).image;
    let stamp = 1000;
    const drive = (orientation, frames = 60) => {
      const { world } = wristObservation(side, orientation);
      for (let frame = 0; frame < frames; frame++) {
        stamp += 1000 / 60;
        tracking.tick(stamp, [hand], {
          timestamp: stamp,
          landmarks: [image],
          worldLandmarks: [world],
          handedness: [[{ categoryName: side < 0 ? 'Left' : 'Right', score: 0.99 }]],
        });
        arm.update({ ...hand, closed: 1 }, 1 / 60);
      }
    };
    drive(base);
    assert.ok(hand.palmOrientation.angleTo(base) < 1e-7);
    const before = arm.palm.quaternion.clone();
    const anchor = arm.anchors.wrist.clone();
    const finger = arm.byName.get('finger2-1').position.clone();
    const ring = arm.ring.position.clone();
    const rolled = base
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, 1.8));
    drive(rolled, 1);
    assert.ok(
      before.angleTo(arm.palm.quaternion) > 0.1,
      'responds on the first camera frame',
    );
    assert.ok(before.angleTo(arm.palm.quaternion) < 1.8, 'smooths the step');
    drive(rolled);
    assert.ok(
      before.angleTo(arm.palm.quaternion) > 1.7,
      'camera rolls the rendered fist beyond the old slider limit',
    );
    assert.ok(
      arm.anchors.wrist.distanceTo(anchor) < 1e-6,
      'rotation does not move the wrist anchor',
    );
    assert.ok(arm.byName.get('finger2-1').position.distanceTo(finger) > 0.02);
    assert.ok(arm.ring.position.distanceTo(ring) > 0.01);
    const vertex = new THREE.Vector3();
    for (let i = 0; i < arm.surface.geometry.attributes.position.count; i += 17) {
      arm.surface.getVertexPosition(i, vertex);
      assert.ok(vertex.toArray().every(Number.isFinite));
    }
    const wrapA = base
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, 3.05));
    const wrapB = base
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, -3.05));
    drive(wrapA);
    const atBoundary = arm.palm.quaternion.clone();
    const forearmAtBoundary = arm.byName.get('lowerarm02').quaternion.clone();
    drive(wrapB, 1);
    assert.ok(
      atBoundary.angleTo(arm.palm.quaternion) < 0.1,
      'roll crosses 180 degrees along the short arc',
    );
    assert.ok(
      forearmAtBoundary.angleTo(arm.byName.get('lowerarm02').quaternion) < 0.1,
      'forearm skin also crosses 180 degrees without flipping its twist direction',
    );
    hand.demoPose(hand.center.clone());
    assert.equal(
      hand.palmOrientation,
      null,
      'demo does not inherit the last tracked rotation',
    );
    arm.dispose();
  }
});
