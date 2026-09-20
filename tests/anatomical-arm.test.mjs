import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import template from '../public/models/arms/anatomical-arms.json' with { type: 'json' };
import { PresetArm } from '../src/preset-arm.js';
import { armFrame, solveArmAnchors } from '../src/arm-kinematics.js';

test('arm IK keeps bone lengths at extension, across the body, and at a degenerate target', () => {
  const shoulder = new THREE.Vector3(-0.21, -0.24, 0.05);
  for (const target of [
    shoulder,
    new THREE.Vector3(0.4, 0.2, -1.5),
    new THREE.Vector3(-0.2, -0.15, -0.3),
  ]) {
    for (const pole of [shoulder, new THREE.Vector3(-0.4, -0.6, 0)]) {
      const pose = solveArmAnchors(shoulder, target, 0.29, 0.288, pole);
      assert.ok(Math.abs(pose.shoulder.distanceTo(pose.elbow) - 0.29) < 1e-7);
      assert.ok(Math.abs(pose.elbow.distanceTo(pose.wrist) - 0.288) < 1e-7);
      assert.ok(pose.elbow.toArray().every(Number.isFinite));
    }
  }
});

test('prepared anatomical meshes retain normalized weights and bridge the wrist', () => {
  for (const data of Object.values(template.arms)) {
    assert.equal(data.bones.length, 24);
    assert.ok(data.positions.length / 3 > 8000);
    // Positive volume catches inward-facing skin (which can look plausible
    // from one view while revealing the inside of the arm from another).
    let signedVolume = 0;
    for (let i = 0; i < data.indices.length; i += 3) {
      const a = new THREE.Vector3().fromArray(data.positions, data.indices[i] * 3);
      const b = new THREE.Vector3().fromArray(data.positions, data.indices[i + 1] * 3);
      const c = new THREE.Vector3().fromArray(data.positions, data.indices[i + 2] * 3);
      signedVolume += a.dot(b.cross(c)) / 6;
    }
    assert.ok(signedVolume > 0 && signedVolume < 0.01, 'skin faces outward');
    for (let i = 0; i < data.skinWeight.length; i += 4) {
      assert.ok(
        Math.abs(data.skinWeight.slice(i, i + 4).reduce((a, b) => a + b) - 1) < 1e-5,
      );
    }
    const wrist = data.bones.findIndex((b) => b.name === 'wrist');
    const forearm = data.bones.findIndex((b) => b.name === 'lowerarm02');
    let bridges = 0;
    for (let i = 0; i < data.skinIndex.length; i += 4) {
      const influences = data.skinIndex
        .slice(i, i + 4)
        .filter((_, j) => data.skinWeight[i + j] > 0.01);
      if (influences.includes(wrist) && influences.includes(forearm)) bridges++;
    }
    assert.ok(
      bridges > 10,
      'a weighted skin transition connects the forearm to the hand',
    );
  }
});

test('articulated skin stays finite, fingers retain lengths, and sleeves follow moving anchors', () => {
  for (const side of [-1, 1]) {
    const arm = new PresetArm(side, { style: 'hoodie', width: 1.3 });
    for (const closed of [0, 0.5, 1])
      for (const roll of [-1.2, 0, 1.2]) {
        arm.update(
          {
            visible: true,
            closed,
            wristRoll: roll,
            center: new THREE.Vector3(side * 0.1, 0.02, -0.57),
          },
          0.03,
        );
        assert.ok(
          Math.abs(
            arm.anchors.shoulder.distanceTo(arm.anchors.elbow) - arm.upperLength,
          ) < 1e-6,
        );
        assert.ok(
          Math.abs(
            arm.anchors.elbow.distanceTo(arm.anchors.wrist) - arm.forearmLength,
          ) < 1e-6,
        );
        for (let finger = 1; finger <= 5; finger++)
          for (let joint = 1; joint <= 2; joint++) {
            const name = `finger${finger}-${joint}`,
              next = `finger${finger}-${joint + 1}`;
            const expected = arm.rest
              .get(name)
              .head.distanceTo(arm.rest.get(name).tail);
            assert.ok(
              Math.abs(
                arm.byName
                  .get(name)
                  .position.distanceTo(arm.byName.get(next).position) - expected,
              ) < 1e-6,
            );
          }
        const point = new THREE.Vector3();
        for (let i = 0; i < arm.surface.geometry.attributes.position.count; i += 17) {
          arm.surface.getVertexPosition(i, point);
          assert.ok(point.toArray().every(Number.isFinite));
          assert.ok(point.distanceTo(arm.anchors.shoulder) < 0.9);
        }
        if (closed === 1) {
          for (let finger = 2; finger <= 5; finger++) {
            const bone = arm.byName.get(`finger${finger}-3`);
            const rest = arm.rest.get(bone.name);
            const tip = rest.tail
              .clone()
              .sub(rest.head)
              .applyQuaternion(bone.quaternion)
              .add(bone.position)
              .sub(arm.palm.position)
              .applyQuaternion(arm.palm.quaternion.clone().invert());
            assert.ok(tip.z < -0.015, 'closed fingertips stay on the palm side');
          }
        }
        assert.ok(arm.sleeve.geometry.attributes.position.array.every(Number.isFinite));
      }
    arm.dispose();
  }
});

test('the wrist bends in its own plane, toward the palm and the thumb, at any arm angle', () => {
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  for (const side of [-1, 1]) {
    const arm = new PresetArm(side, { style: 'bare' });
    for (const center of [
      new THREE.Vector3(side * 0.15, -0.105, -0.34), // neutral guard
      new THREE.Vector3(side * 0.1, 0.22, -0.3), // hands high
      new THREE.Vector3(side * 0.3, -0.38, -0.25), // hands low
      new THREE.Vector3(-side * 0.12, -0.05, -0.55), // across the body
    ])
      for (const closed of [0, 1])
        for (const wristRoll of [0, 1.2]) {
          for (let i = 0; i < 40; i++)
            arm.update({ visible: true, closed, wristRoll, center }, 1 / 60);
          const { elbow, wrist } = arm.anchors;
          // Forearm frame: y along the bone, z out of the back of the hand,
          // x = y cross z, which is the thumb side of the left arm.
          const frame = armFrame(wrist.clone().sub(elbow), Z);
          const hand = Y.clone()
            .applyQuaternion(arm.palm.quaternion)
            .applyQuaternion(frame.clone().invert());
          const where = `side ${side} centre ${center.toArray()} closed ${closed}`;
          assert.ok(
            hand.z < -0.02,
            `wrist flexes toward the palm, never back: ${where}`,
          );
          assert.ok(
            hand.x * -side > 0.01,
            `wrist tilts toward the thumb, never the little finger: ${where}`,
          );
          assert.ok(
            hand.y > Math.cos(0.35),
            `the bend stays a wrist angle, not a fold: ${where}`,
          );
        }
    arm.dispose();
  }
});
