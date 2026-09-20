import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cutLips } from '../src/lip-topology.js';
import { FaceSpeechRig } from '../src/speech-rig.js';
import { MouthInterior } from '../src/mouth-interior.js';

// The Meshy-sized lower-face patch the lip tests cut, at any size.
const MOUTH_Y = -0.04,
  HALF = 0.025;
const surfaceZ = (x, y, k = 1) =>
  k * (0.07 - 4 * (x / k) ** 2 - 1.5 * (y / k - MOUTH_Y) ** 2);
const lipLine = (x) => MOUTH_Y + 0.0025 * Math.cos((Math.PI * x) / (2 * HALF));

function head(k = 1) {
  const positions = [],
    indices = [],
    columns = 20,
    rows = 15,
    step = 0.006;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const border = i === 0 || j === 0 || i === columns || j === rows;
      const x = -0.06 + i * step + (border ? 0 : random() * 0.0012),
        y = -0.09 + j * step + (border ? 0 : random() * 0.0012);
      positions.push(x * k, y * k, surfaceZ(x * k, y * k, k));
    }
  const at = (i, j) => j * (columns + 1) + i;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++)
      indices.push(
        at(i, j),
        at(i + 1, j),
        at(i + 1, j + 1),
        at(i, j),
        at(i + 1, j + 1),
        at(i, j + 1),
      );
  const project = (x, y) => ({ x: x * 7, y: y * 7 });
  const cut = cutLips({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    project,
    seam: Array.from({ length: 11 }, (_, i) => {
      const x = -HALF + (i / 10) * 2 * HALF;
      return project(x * k, lipLine(x) * k);
    }),
    centre: [0, lipLine(0) * k, surfaceZ(0, lipLine(0) * k, k)],
    width: 2 * HALF * k,
  });
  const rig = new FaceSpeechRig(cut.positions, {
    13: [0, (lipLine(0) + 0.001) * k, surfaceZ(0, lipLine(0) * k, k)],
    14: [0, (lipLine(0) - 0.001) * k, surfaceZ(0, lipLine(0) * k, k)],
    152: [0, -0.1 * k, 0.045 * k],
  });
  rig.setLipTopology(cut.topology);
  const mouth = MouthInterior.build({
    rest: cut.positions,
    indices: cut.indices,
    topology: cut.topology,
  });
  return { cut, rig, mouth, k };
}

const teeth = (mouth) => mouth.riders.filter((r) => r.mesh !== mouth.tongue);
const swing = (rig, open) => ({ ...rig.jaw, radians: rig.jaw.angle * open });
const place = (mouth, mesh) => mesh.getWorldPosition(new THREE.Vector3());

test('every head with a lip seam gets two rows of teeth and a tongue', () => {
  const { mouth, cut } = head();
  assert.ok(mouth, 'a cut head must get a mouth interior');
  assert.equal(teeth(mouth).length, 24, 'six teeth a side, top and bottom');
  assert.equal(teeth(mouth).filter((r) => r.lower).length, 12);
  assert.ok(mouth.tongue);
  // No seam, no teeth: they are placed from the lip line and nothing else.
  assert.equal(
    MouthInterior.build({
      rest: cut.positions,
      indices: cut.indices,
      topology: { ...cut.topology, vertices: 3 },
    }),
    null,
  );
});

test('at rest nothing shows: every tooth and the tongue stand behind the skin', () => {
  const { mouth } = head();
  mouth.updateMatrixWorld(true);
  const corner = new THREE.Vector3();
  for (const { mesh } of mouth.riders) {
    const box = new THREE.Box3().setFromObject(mesh);
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y]) {
        corner.set(x, y, box.max.z);
        assert.ok(
          corner.z < surfaceZ(corner.x, corner.y) - 0.0004,
          `${mesh === mouth.tongue ? 'the tongue' : 'a tooth'} reaches the skin at ${corner.toArray()}`,
        );
      }
  }
  // The teeth are in the front of the mouth, the tongue behind them.
  const front = Math.min(
    ...teeth(mouth)
      .slice(0, 4)
      .map((r) => place(mouth, r.mesh).z),
  );
  assert.ok(
    place(mouth, mouth.tongue).z < front,
    'the tongue lies behind the front teeth',
  );
});

test('teeth are sized and placed from the mouth they are in', () => {
  const small = head(1),
    large = head(1.3);
  const spanOf = ({ mouth }) => {
    // Canine to canine, upper: the six teeth a smile shows.
    const xs = teeth(mouth)
      .filter((r) => !r.lower)
      .slice(0, 6)
      .map((r) => place(mouth, r.mesh).x);
    return Math.max(...xs) - Math.min(...xs);
  };
  const width = 2 * HALF;
  assert.ok(
    spanOf(small) > width * 0.55 && spanOf(small) < width * 0.95,
    'span ' + spanOf(small),
  );
  assert.ok(
    Math.abs(spanOf(large) / spanOf(small) - 1.3) < 0.03,
    'a bigger mouth gets bigger teeth',
  );
  // Mirror symmetry: teeth come in pairs.
  const upper = teeth(small.mouth).filter((r) => !r.lower);
  for (let i = 0; i < upper.length; i += 2) {
    const a = place(small.mouth, upper[i].mesh),
      b = place(small.mouth, upper[i + 1].mesh);
    assert.ok(
      Math.abs(a.x + b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3,
      'a pair of teeth is lopsided',
    );
  }
});

test('the lower teeth and tongue swing with the jaw; the upper teeth never move', () => {
  const { mouth, rig, cut } = head();
  const before = mouth.riders.map((r) => place(mouth, r.mesh));
  mouth.update({ swing: swing(rig, 1) });
  mouth.updateMatrixWorld(true);
  // What the lower lip itself does at a full "ah", straight from the rig's shape.
  const lower = cut.topology.lower,
    mid = lower[lower.length >> 1],
    lipDrop = rig.openBasis[mid * 3 + 1];
  assert.ok(lipDrop < -0.008);
  mouth.riders.forEach((rider, i) => {
    const moved = place(mouth, rider.mesh).sub(before[i]);
    if (!rider.lower)
      return assert.ok(moved.length() < 1e-9, 'an upper tooth moved with the jaw');
    assert.ok(moved.y < 0, 'a lower tooth must go down with the jaw');
  });
  // The lower incisors keep their place behind the lower lip: same hinge, same
  // angle, a slightly shorter arm. If they lagged, they would rise out of the lip.
  const incisor = teeth(mouth).find((r) => r.lower),
    drop = place(mouth, incisor.mesh).y - before[mouth.riders.indexOf(incisor)].y;
  assert.ok(
    Math.abs(drop - lipDrop) < Math.abs(lipDrop) * 0.3,
    `teeth ${drop} vs lip ${lipDrop}`,
  );
  assert.ok(
    Math.abs(incisor.mesh.rotation.x - rig.jaw.angle) < 1e-9,
    'and tilt with it',
  );
  mouth.update({});
  mouth.riders.forEach((rider, i) =>
    assert.ok(
      place(mouth, rider.mesh).distanceTo(before[i]) < 1e-9,
      'a shut mouth is back where it was',
    ),
  );
});

test('teeth give way with the lip in front of them when it is punched in', () => {
  const { mouth, cut } = head();
  const before = mouth.riders.map((r) => place(mouth, r.mesh));
  // A fist drives the lower lip a centimetre into the face. Only contact fields
  // are handed over: a tooth must never follow speech or the pose.
  const contact = new Float32Array(cut.positions.length);
  for (const v of cut.topology.lower) contact[v * 3 + 2] = -0.01;
  mouth.update({ offsets: [contact, new Float32Array(cut.positions.length)] });
  mouth.updateMatrixWorld(true);
  mouth.riders.forEach((rider, i) => {
    const moved = place(mouth, rider.mesh).sub(before[i]);
    if (rider.lower && rider.mesh !== mouth.tongue)
      assert.ok(
        Math.abs(moved.z + 0.01) < 1e-6,
        'a lower tooth stayed put and would burst through the lip',
      );
    if (!rider.lower) assert.ok(moved.length() < 1e-9, 'the upper teeth were not hit');
  });
});

test('a closed mouth is dark inside and an open one is lit', () => {
  const { mouth, rig } = head();
  mouth.update({ swing: swing(rig, 0) });
  assert.ok(mouth.light < 0.01, 'a shut mouth must not glow: ' + mouth.light);
  const shut = mouth.enamel.color.getHSL({}).l;
  mouth.update({ swing: swing(rig, 1) });
  assert.ok(mouth.light > 0.9, 'a full "ah" shows its teeth: ' + mouth.light);
  assert.ok(mouth.enamel.color.getHSL({}).l > shut * 5);
  assert.ok(mouth.flesh.color.r > mouth.flesh.color.g * 1.5, 'the tongue is pink');
  // Light does not reach the back of the mouth: the molars are darker than the
  // incisors, or the corners of an open mouth are wedges of white.
  const row = teeth(mouth).filter((r) => !r.lower),
    lightness = (r) => r.mesh.material.color.getHSL({}).l;
  assert.ok(lightness(row[row.length - 1]) < lightness(row[0]) * 0.1);
});

test('it cleans up after itself', () => {
  const { mouth } = head();
  const parent = new THREE.Group();
  parent.add(mouth);
  mouth.dispose();
  assert.equal(mouth.parent, null);
});
