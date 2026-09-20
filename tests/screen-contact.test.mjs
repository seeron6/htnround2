import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  cameraFists,
  cameraPointOnScreen,
  renderedFists,
  ScreenMeshCollider,
  ScreenPunching,
} from '../src/screen-contact.js';
import { VirtualHand, Tracking } from '../src/hands.js';
import { FaceDynamics } from '../src/physics.js';
import { WebcamPunching } from '../src/punch-mapping.js';
import { TRUTH_FIST } from './helpers/synthetic-hand.mjs';

function fixture() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 32, 24),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.position.z = -0.6;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
  const viewport = { width: 800, height: 800 };
  const collider = new ScreenMeshCollider();
  collider.prepare(mesh, camera, viewport);
  return { mesh, camera, viewport, collider };
}
const fist = (x, y = 400, radius = 22, hand = 'Left') => ({
  x,
  y,
  radius,
  hand,
  closed: 1,
});

test('camera fists follow the displayed cover crop and reflection in wide and tall viewports', () => {
  assert.deepEqual(
    cameraPointOnScreen(
      { x: 0.25, y: 0.5 },
      { width: 1600, height: 900 },
      { width: 800, height: 800 },
      true,
    ),
    { x: 755.5555555555555, y: 400 },
  );
  assert.deepEqual(
    cameraPointOnScreen(
      { x: 0.25, y: 0.5 },
      { width: 1600, height: 900 },
      { width: 800, height: 800 },
      false,
    ),
    { x: 44.44444444444446, y: 400 },
  );
  assert.deepEqual(
    cameraPointOnScreen(
      { x: 0.25, y: 0.25 },
      { width: 400, height: 800 },
      { width: 800, height: 800 },
      true,
    ),
    { x: 600, y: 0 },
  );
});

test('a fast fist crossing between two outside samples hits the actual visible surface', () => {
  const { mesh, camera, collider } = fixture();
  const { hit, overlapping } = collider.sweep(fist(120), fist(680));
  assert.ok(hit && hit.t > 0 && hit.t < 1);
  assert.equal(overlapping, false);
  const screen = mesh.localToWorld(new THREE.Vector3(...hit.point)).project(camera);
  assert.ok(Math.abs((screen.x + 1) * 400 - hit.x) < 0.02);
  assert.ok(Math.abs((1 - screen.y) * 400 - hit.y) < 0.02);
  assert.ok(new THREE.Vector3(...hit.point).length() > 0.098);
  assert.equal(
    collider.sweep(fist(120, 150), fist(680, 150)).hit,
    null,
    'nearby empty background stays a miss',
  );
});

test('knuckle edge contact counts even when the fist center misses', () => {
  const { collider } = fixture();
  assert.equal(collider.sweep(fist(300, 235, 1), fist(500, 235, 1)).hit, null);
  assert.ok(collider.sweep(fist(300, 235, 30), fist(500, 235, 30)).hit);
});

test('triangle interiors work on coarse meshes and the visible front wins over the back', () => {
  const { mesh, camera, viewport, collider } = fixture();
  mesh.geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  collider.prepare(mesh, camera, viewport);
  const { hit } = collider.sweep(fist(400), fist(405));
  assert.ok(hit.point[2] > 0.099);
  assert.ok(Math.abs(hit.point[0]) < 0.001);
});

test('contacts follow model rotation, scale, translation, deformation and viewport resizing', () => {
  const { mesh, camera, viewport, collider } = fixture();
  mesh.rotation.set(0.2, 0.5, 0.3);
  mesh.scale.set(1.3, 0.8, 1);
  mesh.position.x = 0.1;
  const positions = mesh.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getY(i) + 0.05);
  positions.needsUpdate = true;
  collider.prepare(mesh, camera, viewport);
  const projected = mesh.localToWorld(new THREE.Vector3(0, 0.05, 0)).project(camera);
  const sample = fist((projected.x + 1) * 400, (1 - projected.y) * 400);
  assert.ok(collider.sweep(sample, sample).hit);
  const wider = { width: 1200, height: 600 };
  camera.aspect = 2;
  camera.updateProjectionMatrix();
  collider.prepare(mesh, camera, wider);
  const p = mesh.localToWorld(new THREE.Vector3(0, 0.05, 0)).project(camera);
  assert.ok(
    collider.sweep(
      fist((p.x + 1) * 600, (1 - p.y) * 300),
      fist((p.x + 1) * 600, (1 - p.y) * 300),
    ).hit,
  );
});

function replay() {
  const scene = fixture();
  const contacts = [];
  let key = 'live',
    activeMesh = scene.mesh;
  const punching = new ScreenPunching({
    getMesh: () => activeMesh,
    getDynamics: () => null,
    getView: (frame) => ({
      ...scene,
      samples: frame?.samples ?? [],
      timestamp: frame?.timestamp,
      key,
    }),
    contact: (...args) => {
      contacts.push(args);
      return true;
    },
  });
  const send = (timestamp, samples, enabled = true, now = timestamp + 5) =>
    punching.tick({ timestamp, samples }, now, enabled);
  return {
    ...scene,
    punching,
    contacts,
    send,
    setKey: (value) => (key = value),
    setMesh: (value) => (activeMesh = value),
  };
}

test('rapid alternating and simultaneous punches all land without a shared cooldown', () => {
  const { send, contacts } = replay();
  send(0, [fist(120), fist(680, 400, 22, 'Right')]);
  assert.equal(send(33, [fist(380), fist(420, 400, 22, 'Right')]).length, 2);
  send(66, [fist(120), fist(680, 400, 22, 'Right')]);
  assert.equal(send(99, [fist(380), fist(420, 400, 22, 'Right')]).length, 2);
  assert.equal(contacts.length, 4);
  assert.ok(contacts.every((c) => c[3] === 'webcam' && c[5].cv.source === 'screen'));
});

test('a hook through the whole face does not punch the opposite cheek on its return', () => {
  for (const side of [-1, 1]) {
    const { send, contacts } = replay();
    const guard = 400 + side * 280;
    const followThrough = 400 - side * 280;
    const hand = side < 0 ? 'left' : 'right';
    send(0, [fist(guard, 400, 22, hand)]);
    assert.equal(send(33, [fist(followThrough, 400, 22, hand)]).length, 1);
    assert.ok(contacts[0][0].x * side > 0, 'the incoming cheek receives the hit');
    assert.equal(send(66, [fist(guard, 400, 22, hand)]).length, 0);
    assert.equal(
      contacts.length,
      1,
      'bringing the fist back must not damage the far cheek',
    );
    assert.equal(send(99, [fist(followThrough, 400, 22, hand)]).length, 1);
    assert.ok(contacts[1][0].x * side > 0, 'the next hook lands on the same cheek');
  }
});

test('follow-through outside the face stays latched across multiple return samples', () => {
  const { send, contacts } = replay();
  send(0, [fist(680, 400, 22, 'right')]);
  send(33, [fist(440, 400, 22, 'right')]);
  send(66, [fist(120, 400, 22, 'right')]);
  send(99, [fist(340, 400, 22, 'right')]);
  send(132, [fist(460, 400, 22, 'right')]);
  send(165, [fist(680, 400, 22, 'right')]);
  assert.equal(contacts.length, 1, 'the return crossing is not a left-side punch');
  send(198, [fist(440, 400, 22, 'right')]);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((c) => c[0].x > 0));
});

test('an uppercut does not strike the forehead on withdrawal and can repeat immediately', () => {
  const { send, contacts } = replay();
  send(0, [fist(400, 680, 22, 'right')]);
  send(33, [fist(400, 120, 22, 'right')]);
  send(66, [fist(400, 680, 22, 'right')]);
  assert.equal(contacts.length, 1);
  send(99, [fist(400, 120, 22, 'right')]);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((c) => c[0].y < 0 && c[4] === 'uppercut'));
});

test('returning to guard allows the same hand to change its next punch direction', () => {
  const { send, contacts } = replay();
  send(0, [fist(680, 400, 22, 'right')]);
  send(33, [fist(120, 400, 22, 'right')]);
  send(66, [fist(680, 400, 22, 'right')]);
  send(99, [fist(680, 680, 22, 'right')]);
  send(132, [fist(400, 680, 22, 'right')]);
  send(165, [fist(400, 120, 22, 'right')]);
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0][4], 'hook');
  assert.equal(contacts[1][4], 'uppercut');
});

test('duplicate and flickering hand labels do not drop a fist or rearm a held contact', () => {
  const { send, contacts } = replay();
  send(0, [fist(120), fist(680)]);
  assert.equal(send(33, [fist(340), fist(460)]).length, 2);
  send(66, [fist(450, 400, 22, 'Right'), fist(350)]);
  assert.equal(contacts.length, 2);
});

test('the game adapter accepts lateral screen hits without world landmarks or a depth punch', () => {
  const scene = fixture();
  const contacts = [];
  const punching = new WebcamPunching({
    video: {},
    getMesh: () => scene.mesh,
    getDynamics: () => null,
    getView: (frame) => ({
      ...scene,
      key: 'live',
      timestamp: frame.timestamp,
      samples: cameraFists(frame, scene.viewport, scene.viewport, true),
    }),
    contact: (...args) => {
      contacts.push(args);
      return true;
    },
  });
  punching.tracker.consume = () => {
    throw new Error('camera-depth detector must not gate screen contacts');
  };
  const frame = (x, timestamp) => ({
    timestamp,
    landmarks: [
      TRUTH_FIST.map((p) => ({
        x: 1 - x / 800 + p[0] * 0.7,
        y: 0.5 - p[1] * 0.7,
        z: p[2] * 0.7,
      })),
    ],
  });
  punching.tick(frame(100, 0), 5, true);
  punching.tick(frame(400, 33), 38, true);
  assert.equal(contacts.length, 1);
  assert.equal(punching.lastEvent.source, 'screen');
});

test('a landed punch names the hand the way the HUD and the recoiling arm read it', () => {
  const scene = fixture();
  const contacts = [];
  const punching = new ScreenPunching({
    getMesh: () => scene.mesh,
    getDynamics: () => null,
    getView: (frame) => ({
      ...scene,
      key: 'live',
      timestamp: frame.timestamp,
      samples: cameraFists(frame, scene.viewport, scene.viewport, true),
    }),
    contact: (...args) => {
      contacts.push(args);
      return true;
    },
  });
  const frame = (x, timestamp) => ({
    timestamp,
    landmarks: [
      TRUTH_FIST.map((p) => ({
        x: 1 - x / 800 + p[0] * 0.7,
        y: 0.5 - p[1] * 0.7,
        z: p[2] * 0.7,
      })),
    ],
    handedness: [[{ categoryName: 'Left', score: 0.97 }]],
  });
  punching.tick(frame(100, 0), 5, true);
  punching.tick(frame(400, 33), 38, true);
  assert.equal(contacts.length, 1);
  // Capitalised here and the HUD's `side === 'left'` misses, scoring every punch as a right.
  assert.equal(contacts[0][5].side, 'left');
  assert.equal(punching.lastEvent.hand, 'left');

  // Rendered fists must speak the same vocabulary; they feed the identical contact path.
  const hand = new VirtualHand(-1);
  hand.demoPose(new THREE.Vector3(0, 0, -0.3), 1);
  hand.tracked = true;
  assert.equal(renderedFists([hand], scene.camera, scene.viewport, 10)[0].hand, 'left');
});

test('one extension lands once; holding, duplicate frames, open hands and jitter do not hit', () => {
  const { send, contacts } = replay();
  send(0, [fist(140)]);
  send(33, [fist(340)]);
  send(33, [fist(340)]);
  send(66, [fist(370)]);
  send(99, [fist(400)]);
  for (let t = 132; t < 1000; t += 33) send(t, [fist(400 + Math.sin(t) * 0.2)]);
  assert.equal(contacts.length, 1);
  const idle = replay();
  idle.send(0, [fist(400)]);
  for (let t = 33; t < 600; t += 33) idle.send(t, [fist(400 + Math.sin(t) * 0.2)]);
  idle.send(633, [{ ...fist(600), closed: 0 }]);
  idle.send(666, [{ ...fist(400), closed: 0 }]);
  assert.equal(idle.contacts.length, 0);
});

test('quick repeated jabs while overlapping rearm on pullback, never on shrinking alone', () => {
  const { send, contacts } = replay();
  send(0, [fist(400, 400, 20)]);
  send(33, [fist(400, 400, 28)]);
  send(66, [fist(400, 400, 34)]);
  send(99, [fist(400, 400, 22)]);
  send(132, [fist(400, 400, 20)]);
  send(165, [fist(400, 400, 30)]);
  assert.equal(contacts.length, 2);
});

test('short dropped frames sweep on reacquisition; stale, paused or changed views cannot phantom-hit', () => {
  const { send, contacts, setKey, setMesh } = replay();
  send(0, [fist(120)]);
  send(33, []);
  send(99, [fist(650)]);
  assert.equal(contacts.length, 1);
  send(500, [fist(120)]);
  send(533, [fist(500)], false);
  send(566, [fist(600)]);
  assert.equal(contacts.length, 1);
  setKey('wireframe');
  send(599, [fist(120)]);
  setMesh(fixture().mesh);
  send(632, [fist(600)]);
  send(666, [fist(120)], true, 1000);
  send(1033, [fist(600)]);
  assert.equal(contacts.length, 1);
});

test('a hook lands as soon as an orbit settles, not once the damping underflows', () => {
  const { send, contacts, camera } = replay();
  const target = new THREE.Vector3(0, 0, -0.6);
  // OrbitControls runs with damping, so releasing a drag leaves the camera easing
  // toward rest by delta * dampingFactor every frame for thousands of frames.
  let theta = 0,
    delta = 0.02;
  const settle = () => {
    theta += delta * 0.05;
    delta *= 0.95;
    camera.position.set(0.6 * Math.sin(theta), 0, target.z + 0.6 * Math.cos(theta));
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
  };
  let landed = null;
  for (let frame = 0; frame < 360 && landed === null; frame++) {
    settle();
    send(frame * 33, [fist(frame % 2 ? 400 : 680, 400, 22, 'right')]);
    if (contacts.length) landed = frame;
  }
  // Exact float equality on the camera matrix read every damped frame as a fresh
  // orbit and reset the hands, so no punch could land for ~11 s after a rotation.
  assert.ok(landed !== null && landed < 60, `first landing waited ${landed} frames`);

  // A view that is still genuinely moving must keep swallowing the sweep: otherwise
  // a stationary fist slides across the head the camera moved out from under it.
  const orbiting = replay();
  const step = (frame) => {
    orbiting.camera.position.set(
      0.6 * Math.sin(frame * 0.04),
      0,
      target.z + 0.6 * Math.cos(frame * 0.04),
    );
    orbiting.camera.lookAt(target);
    orbiting.camera.updateMatrixWorld(true);
  };
  for (let frame = 0; frame < 8; frame++) {
    step(frame);
    orbiting.send(frame * 33, [fist(frame % 2 ? 400 : 680, 400, 22, 'right')]);
  }
  assert.equal(orbiting.contacts.length, 0, 'an active orbit cannot phantom-hit');
});

test('screen hits drive the real tissue rig at the contacted mesh point', () => {
  const scene = fixture();
  const dynamics = new FaceDynamics(scene.mesh.geometry);
  const punching = new ScreenPunching({
    getMesh: () => scene.mesh,
    getDynamics: () => dynamics,
    getView: (frame) => ({ ...scene, ...frame, key: 'test' }),
    contact: (point, direction, speed, source, mode) =>
      dynamics.impulse(point, direction, speed, mode) > 0,
  });
  punching.tick({ timestamp: 0, samples: [fist(150)] }, 5, true);
  const events = punching.tick({ timestamp: 33, samples: [fist(420)] }, 38, true);
  assert.equal(events.length, 1);
  assert.ok(events[0].landed);
  for (let i = 0; i < 15; i++) dynamics.step(1 / 120);
  assert.ok(dynamics.maxDisplacement > 0.001);
  assert.ok(scene.mesh.geometry.attributes.position.array.every(Number.isFinite));
  dynamics.dispose();
});

test('wireframe contacts use the same displayed knuckles, regardless of camera depth', () => {
  const { camera, viewport } = fixture();
  const hand = new VirtualHand(-1);
  hand.demoPose(new THREE.Vector3(0, 0, -0.3), 1);
  hand.tracked = true;
  const [sample] = renderedFists([hand], camera, viewport, 10);
  const center = hand.center.clone().project(camera);
  assert.ok(Math.abs(sample.x - (center.x + 1) * 400) < 3);
  assert.ok(sample.radius > 10);
  assert.equal(sample.closed, 1);
});

test('an overlapping rendered fist can jab into the scene even though it shrinks on screen', () => {
  const { send, contacts } = replay();
  send(0, [{ ...fist(400, 400, 35), depth: 0.35 }]);
  send(33, [{ ...fist(400, 400, 30), depth: 0.45 }]);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0][4], 'jab');
  send(66, [{ ...fist(400, 400, 35), depth: 0.35 }]);
  send(99, [{ ...fist(400, 400, 30), depth: 0.45 }]);
  assert.equal(contacts.length, 2);
});

test('tracking drains intermediate samples in order so a render stall does not erase a punch', () => {
  const tracking = new Tracking({}, () => {});
  tracking.appliedTimestamp = 100;
  tracking.results = { timestamp: 199 };
  tracking.resultQueue = [
    { timestamp: 20 },
    { timestamp: 100 },
    { timestamp: 199 },
    { timestamp: 133 },
    { timestamp: 166 },
  ];
  assert.deepEqual(
    tracking.drainResults(205).map((f) => f.timestamp),
    [133, 166, 199],
  );
  assert.deepEqual(tracking.resultQueue, []);
  assert.equal(tracking.drainResults(205)[0], tracking.results);
  tracking.resultQueue = [{ timestamp: 199 }];
  tracking.results = null;
  assert.deepEqual(tracking.drainResults(800), [null]);
});

test('buffered worker frames drive the displayed skeleton and preserve two rapid strikes', () => {
  const scene = fixture(),
    hands = [new VirtualHand(-1), new VirtualHand(1)];
  const tracking = new Tracking({ videoWidth: 640, videoHeight: 480 }, () => {});
  tracking.active = true;
  tracking.scheduleFrame = () => {};
  const contacts = [];
  const punching = new ScreenPunching({
    getMesh: () => scene.mesh,
    getDynamics: () => null,
    getView: (frame) => ({
      ...scene,
      key: 'wireframe',
      timestamp: frame.timestamp,
      samples: renderedFists(hands, scene.camera, scene.viewport, frame.timestamp),
    }),
    contact: (...args) => {
      contacts.push(args);
      return true;
    },
  });
  const frames = [0.85, 0.5, 0.85, 0.5].map((u, i) => ({
    timestamp: 10 + i * 33,
    landmarks: [
      TRUTH_FIST.map((p) => ({
        x: u + p[0] * 0.7,
        y: 0.5 - p[1] * 0.7,
        z: p[2] * 0.7,
      })),
    ],
    handedness: [[{ categoryName: 'Right', score: 1 }]],
  }));
  tracking.results = frames.at(-1);
  tracking.resultQueue = frames;
  for (const frame of tracking.drainResults(115)) {
    tracking.tick(115, hands, frame);
    punching.tick(frame, 115, true);
  }
  assert.equal(contacts.length, 2);
  assert.equal(tracking.appliedTimestamp, frames.at(-1).timestamp);
});
