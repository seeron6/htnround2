import test from 'node:test';
import assert from 'node:assert/strict';
import { cutLips } from '../src/lip-topology.js';
import { FaceSpeechRig } from '../src/speech-rig.js';

// The same Meshy-sized lower-face patch the topology tests cut.
const MOUTH_Y = -0.04,
  HALF_WIDTH = 0.025;
const surfaceZ = (x, y) => 0.07 - 4 * x * x - 1.5 * (y - MOUTH_Y) ** 2;
const lipLine = (x) => MOUTH_Y + 0.0025 * Math.cos((Math.PI * x) / (2 * HALF_WIDTH));

function cutPatch() {
  const step = 0.006,
    positions = [],
    indices = [],
    columns = 20,
    rows = 15;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const border = i === 0 || j === 0 || i === columns || j === rows;
      const x = -0.06 + i * step + (border ? 0 : random() * 0.0012),
        y = -0.09 + j * step + (border ? 0 : random() * 0.0012);
      positions.push(x, y, surfaceZ(x, y));
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
  return cutLips({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    project,
    seam: Array.from({ length: 11 }, (_, i) => {
      const x = -HALF_WIDTH + (i / 10) * 2 * HALF_WIDTH;
      return project(x, lipLine(x));
    }),
    centre: [0, lipLine(0), surfaceZ(0, lipLine(0))],
    width: 2 * HALF_WIDTH,
  });
}

const anchors = {
  13: [0, lipLine(0) + 0.001, surfaceZ(0, lipLine(0))],
  14: [0, lipLine(0) - 0.001, surfaceZ(0, lipLine(0))],
  152: [0, -0.1, 0.045],
  61: [-HALF_WIDTH, MOUTH_Y, surfaceZ(-HALF_WIDTH, MOUTH_Y)],
  291: [HALF_WIDTH, MOUTH_Y, surfaceZ(HALF_WIDTH, MOUTH_Y)],
};
const settle = (rig, signal) => {
  rig.set(signal);
  for (let i = 0; i < 40; i++) rig.step(1 / 60);
};
const rigged = () => {
  const cut = cutPatch();
  const rig = new FaceSpeechRig(cut.positions, anchors);
  rig.setLipTopology(cut.topology);
  return { cut, rig };
};
const area = (p, o, [a, b, c]) => {
  const at = (v, k) => p[v * 3 + k] + o[v * 3 + k];
  const u = [0, 1, 2].map((k) => at(b, k) - at(a, k)),
    v = [0, 1, 2].map((k) => at(c, k) - at(a, k));
  return (
    Math.hypot(
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ) / 2
  );
};

test('an open mouth parts along the seam into an almond, closed at the corners', () => {
  const { cut, rig } = rigged();
  assert.ok(rig.lips, 'the rig must pick the seam up');
  settle(rig, { open: 1 });
  const { upper, lower, corners } = cut.topology,
    o = rig.offset;
  const gap = upper.map((v, i) => o[v * 3 + 1] - o[lower[i] * 3 + 1]);
  assert.ok(
    gap.every((g) => g > -1e-7),
    'the lips must never pass through each other',
  );
  const widest = Math.max(...gap),
    at = gap.indexOf(widest);
  assert.ok(
    widest > 0.009,
    'a full "ah" should part the lips about a centimetre, got ' + widest,
  );
  assert.ok(Math.abs(at / gap.length - 0.5) < 0.15, 'the opening is widest mid-mouth');
  assert.ok(
    gap[0] < widest * 0.25 && gap[gap.length - 1] < widest * 0.25,
    'and tapers to the corners',
  );
  // One smooth arch: up to the middle, down again. A gap that jitters is the
  // shard look in motion.
  for (let i = 1; i < gap.length; i++) {
    const rising = i <= at;
    assert.ok(
      (gap[i] - gap[i - 1]) * (rising ? 1 : -1) > -widest * 0.02,
      'the outline is ragged at ' + i,
    );
  }
  // Sized the way FaceFusion's lip-open ratio is: gap over this mouth's width.
  assert.ok(
    Math.abs(rig.lipOpenRatio - 0.3) < 0.02,
    'lip-open ratio ' + rig.lipOpenRatio,
  );
  // The corners are one vertex shared by both lips: they travel, but stay shut.
  for (const v of corners)
    assert.ok(o[v * 3 + 1] < 0, 'a corner rides half the jaw swing');
  // Upper lip with the skull, lower lip with the jaw.
  const middle = upper.length >> 1;
  assert.ok(
    o[upper[middle] * 3 + 1] >= 0,
    'the upper lip must not be dragged down by the jaw',
  );
  assert.ok(o[lower[middle] * 3 + 1] < -0.008, 'the lower lip goes with the jaw');
});

test('nothing is stretched across the opening', () => {
  const { cut, rig } = rigged();
  settle(rig, { open: 1 });
  const inner = new Set([...cut.topology.innerUpper, ...cut.topology.innerLower]),
    zero = new Float32Array(rig.offset.length);
  let worst = 1,
    where = '';
  for (let f = 0; f < cut.indices.length; f += 3) {
    const face = [cut.indices[f], cut.indices[f + 1], cut.indices[f + 2]];
    if (face.some((v) => inner.has(v))) continue;
    const before = area(cut.positions, zero, face);
    if (before < 1e-9) continue;
    const grew = area(cut.positions, rig.offset, face) / before;
    if (grew > worst) {
      worst = grew;
      where =
        face
          .map(
            (v) =>
              [0, 1].map((k) => (cut.positions[v * 3 + k] * 1000).toFixed(1)) +
              ' side ' +
              rig.lips.side[v] +
              ' dy ' +
              (rig.offset[v * 3 + 1] * 1000).toFixed(1),
          )
          .join(' | ') +
        ' area mm2 ' +
        (before * 1e6).toFixed(4);
    }
  }
  // A face bridging the lips would grow many times over as they part.
  assert.ok(worst < 1.75, 'a face grew ' + worst.toFixed(2) + 'x: ' + where);
});

test('the inner lips travel with the lip they hang from', () => {
  const { cut, rig } = rigged();
  settle(rig, { open: 1, spread: 0.4 });
  const { upper, lower, innerUpper, innerLower, corners } = cut.topology,
    p = cut.positions,
    o = rig.offset;
  for (const [lip, sheet] of [
    [[...upper, ...corners], innerUpper],
    [[...lower, ...corners], innerLower],
  ]) {
    let edges = 0;
    for (const v of sheet) {
      // Pair each sheet vertex with the lip vertex it hangs from: same x.
      const from = lip.reduce((a, b) =>
        Math.abs(p[b * 3] - p[v * 3]) < Math.abs(p[a * 3] - p[v * 3]) ? b : a,
      );
      const apart = Math.hypot(...[0, 1, 2].map((k) => p[v * 3 + k] - p[from * 3 + k]));
      const drift = Math.hypot(...[0, 1, 2].map((k) => o[v * 3 + k] - o[from * 3 + k]));
      if (apart < 1e-7) {
        // The sheet's own copy of the lip edge shares the lip's position and its
        // side, so it must move exactly as the lip does or a crack opens.
        assert.ok(drift < 1e-7, 'the inner lip tore off its lip by ' + drift);
        edges++;
      } else {
        // Deeper in, the pouch swings on the same hinge from a shorter arm, so it
        // travels a little less than its lip: never more, never the other way.
        const travel = Math.hypot(o[from * 3], o[from * 3 + 1], o[from * 3 + 2]);
        assert.ok(
          drift < travel * 0.5 + 5e-4,
          `the pouch drifted ${drift} from a lip moving ${travel}`,
        );
      }
    }
    assert.ok(edges >= lip.length, 'every lip vertex carries the sheet');
  }
});

test('spreading and rounding keep a closed mouth closed', () => {
  for (const signal of [{ spread: 1 }, { round: 1 }, { spread: 0.6, round: 0.6 }]) {
    const { cut, rig } = rigged();
    settle(rig, signal);
    cut.topology.upper.forEach((v, i) => {
      const w = cut.topology.lower[i];
      for (let k = 0; k < 3; k++)
        assert.ok(
          Math.abs(rig.offset[v * 3 + k] - rig.offset[w * 3 + k]) < 1e-7,
          'the seam opened without the jaw',
        );
    });
  }
});

test('a silent face is untouched, and a stale topology falls back to the anchors', () => {
  const { cut, rig } = rigged();
  for (let i = 0; i < 10; i++) rig.step(1 / 60);
  assert.ok(rig.offset.every((v) => v === 0));
  rig.setLipTopology({ ...cut.topology, vertices: 12 });
  assert.equal(rig.lips, null, 'a topology for another vertex buffer must be ignored');
  settle(rig, { open: 1 });
  assert.ok(
    rig.offset.some((v) => v !== 0),
    'the anchor-based shapes still work',
  );
  rig.setLipTopology(null);
  assert.equal(rig.lips, null);
});
