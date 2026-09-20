import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FaceDynamics } from '../src/physics.js';
import {
  mapTargetImpact,
  punchTargetFrame,
  WebcamPunching,
} from '../src/punch-mapping.js';
import { PinholeCamera } from '../src/fist-pose.js';
import { observe, makeRandom } from './helpers/synthetic-hand.mjs';
import { punchReplay } from './helpers/punch-replay.mjs';

test('complete landmark trajectories map each punch variation onto its own surface region', () => {
  const { mesh } = fixture();
  for (const kind of ['jab', 'left-hook', 'right-hook', 'uppercut', 'overhand']) {
    const events = [];
    const punching = new WebcamPunching({
      video: { videoWidth: 640, videoHeight: 480 },
      getMesh: () => mesh,
      getDynamics: () => null,
      contact: () => true,
      onEvent: (event) => events.push(event),
    });
    for (const frame of punchReplay(kind))
      punching.tick(frame, frame.timestamp + 8, true);
    assert.equal(events.length, 1, kind);
    const event = events[0];
    assert.equal(event.landed, true, kind);
    assert.equal(event.mode, kind.includes('hook') ? 'hook' : kind);
    if (kind === 'left-hook') assert.ok(event.point[0] < -0.07);
    if (kind === 'right-hook') assert.ok(event.point[0] > 0.07);
    if (kind === 'uppercut') assert.ok(event.point[1] < -0.11);
    if (kind === 'overhand') assert.ok(event.point[1] > 0.11);
  }
});

function fixture(center = [0, 0, 0]) {
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  geometry.scale(0.085, 0.135, 0.095);
  geometry.translate(...center);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  return { mesh, frame: { center, radii: [0.085, 0.135, 0.095] } };
}
const strikes = [
  { mode: 'jab', hand: 'left', point: [0, 0, 0.095], direction: [0, 0, -1] },
  { mode: 'hook', hand: 'left', point: [-0.085, 0, 0], direction: [1, 0, -0.3] },
  { mode: 'hook', hand: 'right', point: [0.085, 0, 0], direction: [-1, 0, -0.3] },
  { mode: 'uppercut', hand: 'right', point: [0, -0.135, 0], direction: [0, 1, -0.3] },
  { mode: 'overhand', hand: 'right', point: [0, 0.135, 0], direction: [0, -1, -0.3] },
].map((event) => ({ ...event, speed: 2, confidence: 0.9 }));

test('strike trajectories enter the actual front, cheek, chin and brow triangles', () => {
  const { mesh, frame } = fixture();
  const mapped = strikes.map((event) => mapTargetImpact(event, mesh, frame));
  assert.ok(mapped.every(Boolean));
  assert.ok(mapped[0].point[2] > 0.09);
  assert.ok(mapped[1].point[0] < -0.07);
  assert.ok(mapped[2].point[0] > 0.07);
  assert.ok(mapped[3].point[1] < -0.12);
  assert.ok(mapped[4].point[1] > 0.12);
  for (const event of mapped) {
    assert.ok(event.normalSpeed > 0);
    assert.ok(
      Math.abs(Math.hypot(event.normalSpeed, event.tangentSpeed) - event.speed) < 1e-6,
    );
  }
});

test('translation, rotation and scene scaling do not alter local contact or normal', () => {
  const { mesh, frame } = fixture([0.025, -0.04, 0.01]);
  const before = strikes.map((event) => mapTargetImpact(event, mesh, frame));
  const root = new THREE.Group();
  root.add(mesh);
  root.position.set(0.2, -0.1, -0.7);
  root.rotation.set(0.3, 0.8, -0.2);
  root.scale.set(1.3, 0.9, 1.1);
  for (let i = 0; i < strikes.length; i++) {
    const after = mapTargetImpact(strikes[i], mesh, frame);
    assert.ok(
      new THREE.Vector3(...after.point).distanceTo(
        new THREE.Vector3(...before[i].point),
      ) < 1e-6,
    );
    assert.ok(Math.abs(after.normalSpeed - before[i].normalSpeed) < 1e-5);
  }
});

test('misses and malformed directions never turn into arbitrary facial hits', () => {
  const { mesh, frame } = fixture();
  assert.equal(mapTargetImpact(strikes[0], null), null);
  for (const extra of [
    { missed: true },
    { point: [1, 1, 0] },
    { direction: [0, 0, 0] },
    { direction: [NaN, 0, -1] },
    { speed: Infinity },
  ]) {
    assert.equal(mapTargetImpact({ ...strikes[0], ...extra }, mesh, frame), null);
  }
});

test('raycasts follow the deformed surface, including vertices outside the old bounds', () => {
  const { mesh, frame } = fixture();
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
  const p = mesh.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + 0.045);
  p.needsUpdate = true;
  const hit = mapTargetImpact(strikes[0], mesh, frame);
  assert.ok(hit.point[2] > 0.13);
});

test('a mapped strike deforms the existing tissue rig and preserves its direction', () => {
  for (const event of strikes) {
    const { mesh, frame } = fixture();
    const dynamics = new FaceDynamics(mesh.geometry);
    const mapped = mapTargetImpact(event, mesh, frame);
    const affected = dynamics.impulse(
      new THREE.Vector3(...mapped.point),
      new THREE.Vector3(...mapped.direction),
      1,
      mapped.mode,
    );
    assert.ok(affected > 0, event.mode);
    for (let step = 0; step < 30; step++) dynamics.step(1 / 120);
    assert.ok(
      dynamics.maxDisplacement > 0.001,
      `${event.mode} must visibly move the mesh`,
    );
    assert.ok(mesh.geometry.attributes.position.array.every(Number.isFinite));
    dynamics.dispose();
  }
});

test('shared webcam results produce one applied strike; pause and model changes discard pending approaches', () => {
  const { mesh } = fixture();
  const camera = new PinholeCamera({
    fovDegrees: 60,
    viewAspect: 4 / 3,
    sourceAspect: 4 / 3,
  });
  const random = makeRandom(5);
  const contacts = [];
  let activeMesh = mesh;
  const punching = new WebcamPunching({
    video: { videoWidth: 640, videoHeight: 480 },
    getMesh: () => activeMesh,
    getDynamics: () => null,
    contact: (...args) => {
      contacts.push(args);
      return true;
    },
  });
  const results = (ms) => {
    const t = ms / 1000;
    const depth =
      t < 0.13
        ? 0.7 - 0.36 * (t / 0.13) ** 0.7
        : t < 0.21
          ? 0.34
          : 0.34 + 0.36 * Math.min(1, (t - 0.21) / 0.22);
    const o = observe(
      { position: [0, 0, -depth], rotation: { pitch: Math.PI / 2 }, closure: 1 },
      camera,
      random,
    );
    return {
      landmarks: [o.landmarks],
      worldLandmarks: [o.worldLandmarks],
      handedness: [[{ categoryName: 'Right', score: 0.95 }]],
      timestamp: ms,
    };
  };
  for (let ms = 1; ms < 900; ms += 1000 / 60) {
    const frame = results(ms);
    punching.tick(frame, ms + 8, true);
    punching.tick(frame, ms + 10, true);
  }
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0][4], 'jab');
  assert.equal(contacts[0][3], 'webcam');
  assert.ok(contacts[0][5].cv.normalSpeed > 0);
  punching.reset();
  for (let ms = 1001; ms < 1100; ms += 1000 / 60)
    punching.tick({ ...results(ms - 1000), timestamp: ms }, ms + 8, true);
  punching.tick(null, 1105, false);
  punching.tick(null, 1600, true);
  assert.equal(contacts.length, 1, 'pausing must not land a censored punch on resume');
  activeMesh = fixture().mesh;
  punching.tick(null, 1800, true);
  assert.equal(punching.tracker.slots.size, 0);
});

test('fitted face landmarks keep the target stable when a model includes a neck', () => {
  const { mesh } = fixture();
  const a = {
    234: [-0.08, 0, 0.02],
    454: [0.08, 0, 0.02],
    152: [0, -0.1, 0.04],
    159: [-0.035, 0.04, 0.07],
    386: [0.035, 0.04, 0.07],
    1: [0, 0.015, 0.095],
  };
  const first = punchTargetFrame(mesh, { impactRig: { anchors: a } });
  mesh.geometry.attributes.position.setY(0, -1);
  assert.deepEqual(punchTargetFrame(mesh, { impactRig: { anchors: a } }), first);
  assert.deepEqual(
    punchTargetFrame(mesh, {
      impactRig: { anchors: { 50: [-0.05, 0, 0.06] } },
      speechRig: { anchors: a },
    }),
    first,
    'reference mapping uses measured speech landmarks when the historical impact rig has no nose',
  );
});

test('deep temple landmarks set width without pulling cheek contacts behind the face', () => {
  const { mesh } = fixture();
  const anchors = {
    1: [0, 0, 0.034],
    50: [-0.061, 0, -0.015],
    280: [0.061, 0, -0.015],
    234: [-0.104, 0.02, -0.094],
    454: [0.093, 0.02, -0.101],
    152: [0, -0.1, 0],
    159: [-0.04, 0.044, -0.01],
    386: [0.04, 0.044, -0.01],
  };
  const frame = punchTargetFrame(mesh, { impactRig: { anchors } });
  assert.ok(frame.radii[0] > 0.1, 'temples determine the full face width');
  assert.ok(
    frame.center[2] > -0.04,
    'cheek plane determines where lateral strikes enter',
  );
});
