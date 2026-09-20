import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FaceDynamics } from '../src/physics.js';
import {
  FRACTURE_BONE,
  FRACTURE_LABELS,
  FRACTURE_LIMIT,
  FRACTURE_MAGNITUDE,
  SWELL_SECONDS,
  boneAt,
  fractureSeverity,
  wouldFracture,
} from '../src/bone-fracture.js';

function fixture(options = { asyncImpacts: false }) {
  const g = new THREE.SphereGeometry(1, 64, 48);
  g.scale(0.085, 0.135, 0.095);
  g.computeVertexNormals();
  return new FaceDynamics(g, options);
}
function settle(d, seconds) {
  for (let i = 0; i < seconds * 120; i++) d.step(1 / 120);
}
function hit(d, location, direction, magnitude) {
  const p = d.impactRig.tissue.nearest(location, d.geometry.attributes.position.array);
  return d.applyImpact({
    location: Array.from(
      d.geometry.attributes.position.array.slice(p.index * 3, p.index * 3 + 3),
    ),
    direction,
    magnitude,
  });
}
const peak = (a) => {
  let max = 0;
  for (let i = 0; i < a.length; i += 3)
    max = Math.max(max, Math.hypot(a[i], a[i + 1], a[i + 2]));
  return max;
};
const FOREHEAD = [0, 0.09, 0.065],
  CHEEK = [-0.07, 0, 0.05],
  CHIN = [0, -0.105, 0.045];

test('the rule: 0.70 or more, on skin firmly backed by bone, and nothing else', () => {
  assert.equal(FRACTURE_MAGNITUDE, 0.7);
  const bone = (weights, firm) => ({ bone: firm, bones: weights });
  const skull = bone({ nasal: 0.1, frontal: 0.9 }, 0.9),
    cheek = bone({ zygoma: 0.3, frontal: 0 }, 0.3);
  assert.equal(boneAt(skull), 'frontal');
  assert.equal(boneAt(cheek), null);
  assert.equal(boneAt(bone({ zygoma: FRACTURE_BONE }, FRACTURE_BONE)), 'zygoma');
  assert.equal(boneAt(undefined), null);
  assert.equal(wouldFracture(skull, 0.7), true);
  assert.equal(wouldFracture(skull, 0.6999), false);
  assert.equal(wouldFracture(cheek, 1), false);
  // Bone breaks or it does not: never an invisible break at the threshold.
  assert.ok(fractureSeverity(0.7) > 0.5);
  assert.equal(fractureSeverity(1), 1);
  assert.ok(fractureSeverity(0.85) > fractureSeverity(0.7));
  for (const name of Object.keys(skull.bones)) assert.ok(FRACTURE_LABELS[name]);
});

test('each bone is recognised where it is hit, and soft tissue never breaks', () => {
  const d = fixture(),
    t = d.impactRig.tissue,
    materials = t.prepareAnatomy(d.impactRig.anchors);
  const at = (point) => materials[t.nearest(point).node];
  assert.equal(boneAt(at(FOREHEAD)), 'frontal');
  assert.equal(boneAt(at(CHIN)), 'mandible');
  assert.equal(boneAt(at([0, 0.015, 0.095])), 'nasal');
  assert.equal(boneAt(at([-0.055, 0.02, 0.07])), 'zygoma');
  assert.equal(boneAt(at([0, 0, -0.095])), 'occipital');
  assert.equal(boneAt(at(CHEEK)), null);
  assert.equal(boneAt(at([0, -0.041, 0.085])), null, 'lips');
});

test('a break sets with the blow, swells afterwards, and is all that remains', () => {
  const d = fixture();
  hit(d, FOREHEAD, [0, 0, -1], 0.9);
  const event = d.impactRig.events[0];
  assert.deepEqual(d.impactRig.lastImpact.fracture, {
    bone: 'frontal',
    side: d.impactRig.lastImpact.fracture.side,
    severity: fractureSeverity(0.9),
  });
  assert.ok(peak(event.plastic) > 0.003);
  assert.ok(peak(event.swelling) > 0.0003);
  settle(d, 0.2);
  const set = d.impactRig.permanent.slice();
  assert.ok(peak(set) > peak(event.plastic) * 0.95, 'the plate has given way');
  settle(d, SWELL_SECONDS + 1);
  assert.equal(d.impactRig.events.length, 0);
  const kept = d.impactRig.permanent,
    index = d.impactRig.tissue.nearest(FOREHEAD).index;
  assert.ok(kept[index * 3 + 2] < -0.003, 'driven in, along the blow');
  let risen = 0;
  for (let i = 0; i < kept.length; i++)
    risen = Math.max(risen, Math.abs(kept[i] - set[i]));
  assert.ok(risen > 0.0003, 'the swelling came up after the break had set');
  assert.ok(peak(kept) <= FRACTURE_LIMIT + 1e-6);
  assert.ok(
    Math.abs(d.maxDisplacement - peak(kept)) < 1e-4,
    'the face has recovered around it',
  );
  const q = d.impactRig.tissue.measure(d.geometry.attributes.position.array, d.rest);
  assert.equal(q.reversedTriangles, 0);
  d.reset();
  assert.equal(peak(d.impactRig.permanent), 0);
  assert.deepEqual(d.geometry.attributes.position.array, d.original);
});

test('a jaw breaks sideways with the blow; a straight blow still leaves it crooked', () => {
  for (const [direction, sign] of [
    [[0.85, 0.1, -0.5], 1],
    [[-0.85, 0.1, -0.5], -1],
  ]) {
    const d = fixture();
    hit(d, CHIN, direction, 1);
    settle(d, SWELL_SECONDS + 1);
    assert.equal(d.impactRig.lastImpact.fracture.bone, 'mandible');
    const chin = d.impactRig.tissue.nearest(CHIN).index;
    assert.ok(d.impactRig.permanent[chin * 3] * sign > 0.002, `${direction}`);
  }
  const straight = fixture();
  hit(straight, CHIN, [0, 0.85, -0.5], 1);
  settle(straight, SWELL_SECONDS + 1);
  const chin = straight.impactRig.tissue.nearest(CHIN).index;
  assert.ok(Math.abs(straight.impactRig.permanent[chin * 3]) > 0.0005);
});

test('however often it is hit, a live head stays only slightly out of shape', () => {
  const d = fixture();
  const peaks = [];
  for (let i = 0; i < 6; i++) {
    hit(d, FOREHEAD, [0.2, 0, -1], 1);
    settle(d, SWELL_SECONDS + 1);
    peaks.push(peak(d.impactRig.permanent));
    assert.ok(peaks.at(-1) <= FRACTURE_LIMIT + 1e-6, JSON.stringify(peaks));
    const q = d.impactRig.tissue.measure(d.geometry.attributes.position.array, d.rest);
    assert.ok(q.finite);
    assert.equal(q.reversedTriangles, 0);
  }
  assert.ok(peaks[1] > peaks[0], 'a second break adds to the first');
  assert.ok(Math.abs(peaks[5] - peaks[4]) < 1e-5, 'and then there is no more to give');
  const saved = d.impactRig.snapshot(),
    restored = fixture();
  restored.impactRig.restore(saved);
  restored.step(0);
  assert.deepEqual(restored.impactRig.permanent, d.impactRig.permanent);
  const a = restored.geometry.attributes.position.array,
    b = d.geometry.attributes.position.array;
  // The live head's skin springs are still ringing down by a few nanometres.
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6));
});

test('clay keeps its own rule: whole dents, no breaks, no swelling', () => {
  const d = fixture();
  d.setHeadMode('clay');
  hit(d, FOREHEAD, [0, 0, -1], 1);
  assert.equal(d.impactRig.lastImpact.fracture, null);
  assert.equal(d.impactRig.events[0].swelling, null);
  settle(d, 1);
  assert.ok(peak(d.impactRig.permanent) > FRACTURE_LIMIT);
});

test('a blow that breaks bone is prepared in order; others still go off-thread, over the break', () => {
  const d = fixture({ asyncImpacts: false }),
    rig = d.impactRig,
    asked = [];
  let reply = null;
  rig.preparer = {
    request(input, _softness, _reaction, callback) {
      asked.push(input.magnitude);
      reply = callback;
      return true;
    },
    invalidate() {},
    configure() {},
    dispose() {},
  };
  hit(d, FOREHEAD, [0, 0, -1], 0.9);
  assert.deepEqual(asked, [], 'the break was not handed to the worker');
  assert.equal(rig.lastImpact.fracture.bone, 'frontal');
  settle(d, SWELL_SECONDS + 1);
  const kept = rig.permanent.slice(),
    forehead = rig.tissue.nearest(FOREHEAD).index;
  assert.ok(peak(kept) > 0.003);
  // The same blow below the threshold, and a full-power blow on a soft cheek.
  hit(d, FOREHEAD, [0, 0, -1], 0.65);
  hit(d, CHEEK, [0.9, 0.1, -0.4], 1);
  assert.deepEqual(asked, [0.65, 1]);
  // What a worker would send back: endpoints that never met the break.
  const clean = fixture();
  hit(clean, CHEEK, [0.9, 0.1, -0.4], 1);
  reply({
    stage: 'complete',
    event: { ...clean.impactRig.events[0] },
    affected: 1,
    impact: {},
  });
  assert.equal(rig.events.at(-1).offThread, true);
  rig.step(0.12);
  clean.impactRig.step(0.12);
  assert.ok(peak(clean.impactRig.offset) > 0.02, 'the cheek dents');
  // The broken head shows that same blow, laid over the break it already had:
  // nothing about another punch straightens a broken bone, even at its crest.
  assert.ok(
    rig.offset.every(
      (v, i) => Math.abs(v - clean.impactRig.offset[i] - kept[i]) < 1e-6,
    ),
  );
  assert.ok(Math.abs(rig.offset[forehead * 3 + 2] - kept[forehead * 3 + 2]) < 1e-3);
  settle(d, 4);
  assert.deepEqual(rig.permanent, kept);
  assert.ok(Math.abs(d.maxDisplacement - peak(kept)) < 1e-4);
});
