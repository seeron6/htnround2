import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FaceImpactRig } from '../src/impact-rig.js';
import { FaceDynamics } from '../src/physics.js';
import {
  PAIN_CONTROLS,
  PainRig,
  headFlinch,
  headFlinchCurve,
  limitControls,
  limitHeadPose,
  painControls,
  painDuration,
  painGasp,
  painTimeline,
} from '../src/pain-rig.js';
import { TissueField } from '../src/tissue-field.js';

const anchors = {
  13: [0, -0.04, 0.07],
  14: [0, -0.042, 0.07],
  152: [0, -0.1, 0.06],
  50: [-0.05, -0.005, 0.07],
  280: [0.05, -0.005, 0.07],
  61: [-0.03, -0.04, 0.07],
  291: [0.03, -0.04, 0.07],
  159: [-0.035, 0.038, 0.07],
  145: [-0.035, 0.029, 0.07],
  386: [0.035, 0.038, 0.07],
  374: [0.035, 0.029, 0.07],
};
function plane() {
  const g = new THREE.PlaneGeometry(0.19, 0.26, 38, 52);
  g.translate(0, 0, 0.07);
  g.computeVertexNormals();
  return g;
}
function rig(g = plane()) {
  return new FaceImpactRig(g.attributes.position.array, anchors, {
    indices: g.index.array,
    normals: g.attributes.normal.array,
  });
}
const peak = (a) => {
  let max = 0;
  for (let i = 0; i < a.length; i += 3)
    max = Math.max(max, Math.hypot(a[i], a[i + 1], a[i + 2]));
  return max;
};
const nearest = (tissue, point) => tissue.nearest(point).index;

test('controls are summed and then clamped once, like limit_expression', () => {
  assert.deepEqual(
    limitControls({ eyeClose_L: 1.7, browLower_R: -0.2, jawOpen: 0.4, bogus: 1 }),
    { eyeClose_L: 1, browLower_R: 0, jawOpen: 0.4 },
  );
  for (const pose of ['flinch', 'grimace', 'ache'])
    for (const side of [-1, 0, 1])
      for (const [name, value] of Object.entries(painControls(pose, side, 1))) {
        assert.ok(PAIN_CONTROLS[name.replace(/_[LR]$/, '')], name);
        assert.ok(value >= 0 && value <= 1, `${pose} ${name} ${value}`);
      }
  // The struck side reacts more, and a centred blow is symmetric.
  const left = painControls('ache', -1, 1),
    centre = painControls('ache', 0, 1);
  assert.ok(left.eyeClose_L > left.eyeClose_R + 0.3);
  assert.equal(centre.eyeClose_L, centre.eyeClose_R);
  // A blink is a reflex: a light hit still shuts the eyes, but barely grimaces.
  assert.ok(painControls('flinch', 0, 0.2).eyeClose_L > 0.75);
  assert.ok(painControls('grimace', 0, 0.2).browLower_L < 0.25);
});

test('the timeline is a partition: reflex, then grimace, then ache, then nothing', () => {
  for (const [magnitude, fractured] of [
    [0.2, false],
    [0.85, false],
    [1, true],
  ]) {
    const end = painDuration(magnitude, fractured);
    let last = null;
    for (let age = 0; age <= end + 0.5; age += 0.01) {
      const w = painTimeline(age, magnitude, fractured),
        sum = w.flinch + w.grimace + w.ache;
      for (const v of Object.values(w)) assert.ok(v >= 0 && v <= 1);
      assert.ok(sum <= 1 + 1e-9, `${age}: ${sum}`);
      if (last)
        for (const key of Object.keys(w))
          assert.ok(Math.abs(w[key] - last[key]) < 0.2, `${key} jumps at ${age}`);
      last = w;
    }
    assert.deepEqual(painTimeline(0, magnitude, fractured), {
      flinch: 0,
      grimace: 0,
      ache: 0,
    });
    assert.deepEqual(painTimeline(end, magnitude, fractured), {
      flinch: 0,
      grimace: 0,
      ache: 0,
    });
    assert.ok(painTimeline(0.1, magnitude, fractured).flinch > 0.6);
    assert.ok(painTimeline(0.4, magnitude, fractured).grimace > 0.95);
    // A light tap is over before it can ache; a real blow lingers.
    if (magnitude >= 0.8)
      assert.ok(painTimeline(end - 1, magnitude, fractured).ache > 0.5);
  }
  assert.ok(
    painDuration(1, true) > painDuration(1) && painDuration(1) > painDuration(0.2),
  );
});

test('the head turns away the way the blow travelled, tucks, stays in its box and returns', () => {
  const fromLeft = headFlinch([0, 0.01, 0.01], [0.78, -0.05, -0.62], 0.85),
    fromRight = headFlinch([0, -0.01, -0.01], [-0.78, -0.05, -0.62], 0.85);
  assert.ok(fromLeft.y > 0.1 && fromRight.y < -0.1);
  assert.ok(
    Math.abs(fromLeft.y + fromRight.y) < 1e-12,
    'mirrored blows mirror the turn',
  );
  assert.ok(fromLeft.x > 0, 'the chin tucks');
  assert.ok(headFlinch([0, 0, 0], [0, 0.85, -0.5], 0.85).x < 0, 'an uppercut lifts it');
  assert.ok(
    headFlinch([0, 0, 0], [0, 0, -1], 1, true).x >
      headFlinch([0, 0, 0], [0, 0, -1], 1).x,
  );
  assert.deepEqual(limitHeadPose({ x: 9, y: -9, z: 9 }), { x: 0.3, y: -0.4, z: 0.22 });
  assert.equal(headFlinchCurve(0, 0.85), 0);
  assert.ok(headFlinchCurve(0.6, 0.85) > 0.95);
  assert.equal(headFlinchCurve(painDuration(0.85), 0.85), 0);
  for (let age = 0; age < 4; age += 0.05) {
    const gasp = painGasp(age, 1, true);
    assert.ok(gasp >= 0 && gasp <= 1);
  }
  assert.equal(painGasp(0, 0.85), 0);
  assert.equal(painGasp(painDuration(0.85), 0.85), 0);
  assert.ok(painGasp(0.4, 0.85) > 0.5);
});

test('the rig reports a head pose and a gasp while it hurts, summed and bounded over blows', () => {
  const r = rig();
  const blow = (id, direction) =>
    r.impact(
      r.tissue.rest,
      {
        location: r.tissue.vertices[r.tissue.nearest(r.anchors[id]).node].p,
        direction,
        magnitude: 1,
      },
      0.75,
    );
  assert.deepEqual(r.headPose, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 6; i++) blow(50, [0.78, -0.05, -0.62]);
  r.step(0.6);
  assert.ok(
    r.headPose.y > 0.2 && r.headPose.y <= 0.4,
    `six hooks, one box: ${r.headPose.y}`,
  );
  assert.ok(r.headPose.x > 0 && r.headPose.x <= 0.3);
  assert.ok(r.gasp > 0.3 && r.gasp <= 1);
  r.step(4);
  assert.deepEqual(r.headPose, { x: 0, y: 0, z: 0 });
  assert.equal(r.gasp, 0);
  blow(50, [0.78, -0.05, -0.62]);
  r.step(0.6);
  r.reset();
  assert.deepEqual(r.headPose, { x: 0, y: 0, z: 0 });
  assert.equal(r.gasp, 0);
  const clay = rig();
  clay.setMode('clay');
  clay.impact(
    clay.tissue.rest,
    { location: clay.anchors[50], direction: [0.78, 0, -0.62], magnitude: 1 },
    0.75,
  );
  clay.step(0.1);
  assert.deepEqual(clay.headPose, { x: 0, y: 0, z: 0 });
  assert.equal(clay.gasp, 0);
});

test('eyes shut before the brows come down, the struck eye stays guarded, and it all goes', () => {
  const r = rig(),
    t = r.tissue;
  const lidL = nearest(t, anchors[159]),
    lidR = nearest(t, anchors[386]),
    browL = nearest(t, [-0.023, 0.062, 0.07]);
  const hit = t.nearest(anchors[50]);
  r.impact(
    t.rest,
    {
      location: t.vertices[hit.node].p,
      direction: [0.75, -0.05, -0.6],
      magnitude: 0.85,
    },
    0.75,
  );
  const drop = (index) => -r.offset[index * 3 + 1];
  r.step(0.12);
  const blink = drop(lidL),
    earlyBrow = drop(browL);
  assert.ok(blink > 0.0025, `the upper lid is coming down: ${blink}`);
  r.step(0.33);
  // Shutting the eyes already draws the brow skin down; the grimace lowers it further.
  assert.ok(drop(browL) > earlyBrow + 0.002, 'then the brow lowers');
  const squeezed = drop(lidR);
  r.step(1.15); // 1.6 s: the ache
  assert.ok(drop(lidL) > drop(lidR) * 1.6, 'the struck eye is still guarded');
  assert.ok(drop(lidR) < squeezed * 0.5, 'the far eye has opened');
  r.step(painDuration(0.85));
  assert.ok(r.offset.every((v) => v === 0));
  assert.equal(r.events.length, 0);
});

test('physics chases the flinch with the recoil spring and parts the lips through the speech rig', () => {
  const g = new THREE.SphereGeometry(1, 48, 36);
  g.scale(0.085, 0.135, 0.095);
  g.computeVertexNormals();
  const d = new FaceDynamics(g, { asyncImpacts: false });
  const at = d.impactRig.tissue.nearest([-0.07, 0, 0.05]);
  d.applyImpact({
    location: Array.from(d.rest.slice(at.index * 3, at.index * 3 + 3)),
    direction: [0.9, 0, -0.4],
    magnitude: 0.6,
  });
  let turned = 0,
    opened = 0;
  for (let i = 0; i < 120; i++) {
    d.step(1 / 120);
    turned = Math.max(turned, d.recoil.y);
    opened = Math.max(opened, d.speechRig.openNow);
  }
  assert.ok(turned > 0.05, `the face turns with the blow: ${turned}`);
  assert.ok(opened > 0.2, `the mouth is knocked open: ${opened}`);
  for (let i = 0; i < 480; i++) d.step(1 / 120);
  assert.ok(d.recoil.length() < 0.001);
  assert.equal(d.speechRig.openNow, 0);
  assert.ok(d.maxDisplacement < 0.0001);
});

test('a speaking voice keeps the jaw it asked for; the gasp is only a floor', () => {
  const g = new THREE.SphereGeometry(1, 32, 24);
  g.scale(0.085, 0.135, 0.095);
  g.computeVertexNormals();
  const d = new FaceDynamics(g, { asyncImpacts: false });
  d.speechRig.set({ open: 0.9 });
  for (let i = 0; i < 60; i++) d.speechRig.step(1 / 120, 1, 0.4);
  assert.ok(Math.abs(d.speechRig.openNow - 0.9) < 0.01);
  d.speechRig.set({ open: 0 });
  for (let i = 0; i < 60; i++) d.speechRig.step(1 / 120, 1, 0.4);
  assert.ok(Math.abs(d.speechRig.openNow - 0.4) < 0.01);
  for (let i = 0; i < 60; i++) d.speechRig.step(1 / 120, 1, 0);
  assert.equal(d.speechRig.openNow < 1e-4, true);
});

test('poses only move connected face skin, and every control has a sparse basis', () => {
  const g = plane(),
    tissue = new TissueField(
      g.attributes.position.array,
      g.index.array,
      g.attributes.normal.array,
    ),
    pain = new PainRig(tissue);
  pain.prepare(anchors);
  const names = Object.keys(pain.basis.controls);
  assert.equal(names.length, 12);
  for (const name of names) {
    const { nodes, delta } = pain.basis.controls[name];
    assert.ok(nodes.length > 0 && nodes.length < tissue.vertices.length, name);
    assert.equal(delta.length, nodes.length * 3);
    assert.ok(delta.every(Number.isFinite));
  }
  // Closing is a share of THIS head's lid gap: the lids approach and never meet.
  const field = pain.field(anchors, { eyeClose_L: 1 });
  const up = nearest(tissue, anchors[159]),
    low = nearest(tissue, anchors[145]);
  const rest = tissue.rest,
    gap = rest[up * 3 + 1] - rest[low * 3 + 1],
    closed = gap + field[up * 3 + 1] - field[low * 3 + 1];
  assert.ok(closed > 0 && closed < gap * 0.45, `${closed} of ${gap}`);
  assert.ok(-field[up * 3 + 1] > field[low * 3 + 1], 'the upper lid does most of it');
  assert.equal(peak(pain.field(anchors, {})), 0);
});
