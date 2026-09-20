import test from 'node:test';
import assert from 'node:assert/strict';
import { cutLips, lipField, lipTopologyFits } from '../src/lip-topology.js';
import { FaceSpeechRig } from '../src/speech-rig.js';

// A head the way the local pipeline builds one: a hollow shell whose template
// already has parted lips. The skin is two sheets that meet only beyond the mouth
// corners; each rolls inwards into a shallow mouth; and because the shell is
// hollow, what shows between the lips is its far inside wall, a hand's width back,
// with the outside of the skull behind that. All of it untextured, which is why a
// real one shows a pale line between closed lips.
const MOUTH_Y = -0.04,
  HALF = 0.025,
  GAP = 0.0012;
const surfaceZ = (x, y) => 0.07 - 4 * x * x - 1.5 * (y - MOUTH_Y) ** 2;
const lipLine = (x) => MOUTH_Y + 0.002 * Math.cos((Math.PI * x) / (2 * HALF));
const parting = (x) => (Math.abs(x) < HALF ? GAP * (1 - (x / HALF) ** 2) : 0);
// `bridge` lays a strip of skin across the parted lips over a short stretch
// mid-mouth: a few faces that hold the edge of both lips.
let bridge = 0;

function hollowHead() {
  const positions = [],
    indices = [],
    welded = new Map(),
    tags = [];
  const vertex = (x, y, z, tag) => {
    const key = [x, y, z].map((v) => Math.round(v * 1e7)).join(',');
    if (!welded.has(key)) {
      welded.set(key, positions.length / 3);
      positions.push(x, y, z);
      tags.push(tag);
    }
    return welded.get(key);
  };
  // `at(i, j)` gives a grid's vertex; faces wind counter-clockwise seen from +z
  // unless `flip`, which is how a surface comes to face the other way.
  const sheet = (columns, rows, at, flip = false) => {
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const a = at(i, j),
          b = at(i + 1, j),
          c = at(i + 1, j + 1),
          d = at(i, j + 1);
        for (const t of [
          [a, b, c],
          [a, c, d],
        ]) {
          if (new Set(t).size < 3) continue;
          indices.push(...(flip ? [t[0], t[2], t[1]] : t));
        }
      }
  };
  const COLUMNS = 48,
    xAt = (i) => -0.06 + (i / COLUMNS) * 0.12;
  // Skin above and below the lip line. Row 0 of each is its lip edge; beyond the
  // corners the two edges are the same points, so the skin is one sheet there.
  for (const side of [1, -1]) {
    const border = side > 0 ? 0 : -0.09,
      ROWS = 16;
    sheet(
      COLUMNS,
      ROWS,
      (i, j) => {
        const x = xAt(i),
          edge = lipLine(x) + (side * parting(x)) / 2,
          y = edge + (border - edge) * (j / ROWS) ** 1.4;
        return vertex(x, y, surfaceZ(x, y), side > 0 ? 'upper-skin' : 'lower-skin');
      },
      side < 0,
    );
    // The inside of the mouth: back from the lip edge, a little up (or down).
    const DEPTHS = [0, 0.003, 0.008, 0.014];
    sheet(
      COLUMNS,
      DEPTHS.length - 1,
      (i, j) => {
        const x = xAt(i),
          reach = Math.max(0, 1 - (x / HALF) ** 2),
          edge = lipLine(x) + (side * parting(x)) / 2,
          y = edge + side * 0.35 * DEPTHS[j] * reach;
        const z = surfaceZ(x, edge) - DEPTHS[j] * reach;
        return vertex(
          x,
          y,
          z,
          j ? (side > 0 ? 'roof' : 'floor') : side > 0 ? 'upper-skin' : 'lower-skin',
        );
      },
      side > 0,
    );
  }
  for (let i = 0; i < COLUMNS; i++) {
    if (Math.abs(xAt(i)) >= bridge || Math.abs(xAt(i + 1)) >= bridge) continue;
    const edge = (k, side) => {
      const x = xAt(k),
        y = lipLine(x) + (side * parting(x)) / 2;
      return vertex(x, y, surfaceZ(x, y));
    };
    indices.push(edge(i, 1), edge(i, -1), edge(i + 1, -1));
    indices.push(edge(i, 1), edge(i + 1, -1), edge(i + 1, 1));
  }
  // The shell's far inside wall faces the mouth; the back of the skull faces away.
  for (const [z, tag, flip] of [
    [-0.11, 'far-wall', false],
    [-0.2, 'skull', true],
  ])
    sheet(20, 20, (i, j) => vertex(-0.08 + i * 0.008, -0.12 + j * 0.008, z, tag), flip);
  // As the pipeline delivers it: a welded surface plus a texture atlas of render
  // copies. (One copy each here; what matters is that the whole head is known, not
  // just the part near the mouth, because the far wall is 18 cm from the lips.)
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    atlas: {
      mapping: Array.from({ length: count }, (_, i) => i),
      indices: indices.slice(),
      uv: new Array(count * 2).fill(0.5),
    },
    tags,
  };
}

const project = (x, y) => ({ x: x * 5, y: y * 5 });
// The landmarker is good to a millimetre or two; the gap is 1.2 mm tall. Hand it a
// lip line that is 1.5 mm high, the way a real detection is.
const seamAt = (offset) =>
  Array.from({ length: 11 }, (_, i) => {
    const x = -HALF + (i / 10) * 2 * HALF;
    return project(x, lipLine(x) + offset);
  });
const mouth = (offset = 0) => ({
  project,
  seam: seamAt(offset),
  centre: [0, lipLine(0), surfaceZ(0, lipLine(0))],
  width: 2 * HALF,
});

test('parted lips are adopted, not cut: not one vertex or face changes', () => {
  const head = hollowHead();
  const result = cutLips({ ...head, ...mouth() });
  assert.ok(result?.topology.native, 'a mouth that is already open must be recognised');
  assert.deepEqual(result.positions, head.positions);
  assert.deepEqual(result.indices, head.indices);
  assert.equal(result.parents.length, 0);
  assert.equal(result.topology.addedVertices, 0);
  assert.equal(lipTopologyFits(result.topology, head.positions.length / 3), true);
});

test('the gap is found even when the detected lip line misses it', () => {
  const head = hollowHead();
  for (const offset of [0.0015, -0.0015, 0.0025]) {
    const result = cutLips({ ...head, ...mouth(offset) });
    assert.ok(
      result?.topology.native,
      `a lip line ${offset * 1000} mm off must still find the gap`,
    );
  }
});

test('every lip vertex is given to the right lip, and the mouth behind it too', () => {
  const head = hollowHead();
  const { topology } = cutLips({ ...head, ...mouth(0.0015) });
  const p = head.positions,
    up = new Set(topology.upper),
    down = new Set(topology.lower);
  assert.ok(up.size > 20 && down.size > 20);
  let edges = 0;
  head.tags.forEach((tag, v) => {
    if (Math.abs(p[v * 3]) > HALF * 0.85) return;
    if (tag === 'roof')
      assert.ok(up.has(v), 'the roof of the mouth goes with the upper lip');
    if (tag === 'floor')
      assert.ok(down.has(v), 'the floor of the mouth goes with the jaw');
    // The lip edges are 1.2 mm apart and BOTH lie below the detected line here,
    // which is exactly where judging by height gets the upper lip wrong.
    const onEdge = Math.abs(p[v * 3 + 1] - lipLine(p[v * 3])) < GAP;
    if (onEdge && tag === 'upper-skin')
      assert.ok(up.has(v) && ++edges, 'an upper lip edge vertex was called lower');
    if (onEdge && tag === 'lower-skin')
      assert.ok(down.has(v) && ++edges, 'a lower lip edge vertex was called upper');
  });
  assert.ok(edges > 25, 'too few lip edge vertices were checked: ' + edges);
  for (const v of up) assert.ok(!down.has(v), 'a vertex cannot belong to both lips');
});

test('only the inside of the head is darkened, never skin and never the skull', () => {
  const head = hollowHead();
  const { topology } = cutLips({ ...head, ...mouth() });
  const dark = new Map(
      topology.shade.vertices.map((v, i) => [v, topology.shade.values[i]]),
    ),
    p = head.positions;
  assert.ok(dark.size > 50);
  let wall = 0;
  head.tags.forEach((tag, v) => {
    const value = dark.get(v) ?? 1;
    // This is the failure that matters: on one real scan a walk from the inner
    // lips reached the scalp, and the whole head would have been drawn black.
    if (tag.endsWith('skin'))
      assert.equal(value, 1, 'skin was darkened at ' + [p[v * 3], p[v * 3 + 1]]);
    if (tag === 'skull')
      assert.equal(value, 1, 'the outside of the skull was darkened');
    const behindTheMouth =
      Math.abs(p[v * 3]) < HALF * 0.8 && Math.abs(p[v * 3 + 1] - MOUTH_Y) < 0.01;
    if (tag === 'far-wall' && behindTheMouth) {
      assert.ok(
        value < 0.2,
        'what shows between parted lips must be dark, got ' + value,
      );
      wall++;
    }
    if (
      (tag === 'roof' || tag === 'floor') &&
      surfaceZ(p[v * 3], p[v * 3 + 1]) - p[v * 3 + 2] > 0.012
    )
      assert.ok(value < 0.3, 'the back of the mouth must be dark');
  });
  assert.ok(wall > 5, 'the far wall behind the mouth was never reached');
});

test('an adopted mouth opens along its own lips', () => {
  const head = hollowHead();
  const { topology } = cutLips({ ...head, ...mouth(0.0015) });
  const field = lipField(head.positions, topology);
  assert.ok(
    field && Math.abs(field.width - 2 * HALF) < 0.006,
    'mouth width ' + field?.width,
  );
  const rig = new FaceSpeechRig(head.positions, {
    13: [0, lipLine(0) + 0.001, surfaceZ(0, lipLine(0))],
    14: [0, lipLine(0) - 0.001, surfaceZ(0, lipLine(0))],
    152: [0, -0.1, 0.045],
  });
  rig.setLipTopology(topology);
  rig.set({ open: 1 });
  for (let i = 0; i < 40; i++) rig.step(1 / 60);
  assert.ok(
    Math.abs(rig.lipOpenRatio - 0.3) < 0.03,
    'lip-open ratio ' + rig.lipOpenRatio,
  );
  const p = head.positions;
  head.tags.forEach((tag, v) => {
    if (
      Math.abs(p[v * 3]) > HALF * 0.5 ||
      Math.abs(p[v * 3 + 1] - lipLine(p[v * 3])) > GAP
    )
      return;
    const dy = rig.offset[v * 3 + 1];
    // Judged by height these would move together and the outline comes out ragged.
    if (tag === 'upper-skin')
      assert.ok(dy > -5e-4, 'the upper lip edge was dragged down ' + dy);
    if (tag === 'lower-skin')
      assert.ok(dy < -0.004, 'the lower lip edge did not follow the jaw ' + dy);
  });
});

test('skin that bridges otherwise parted lips is removed, and nothing else is', () => {
  bridge = 0.006;
  const head = hollowHead();
  bridge = 0;
  const result = cutLips({ ...head, ...mouth() });
  assert.ok(result?.topology.native);
  const { removedTriangles, upper, lower } = result.topology;
  assert.ok(
    removedTriangles > 0 && removedTriangles < 40,
    'dropped ' + removedTriangles,
  );
  assert.equal(result.indices.length, head.indices.length - removedTriangles * 3);
  assert.equal(
    result.atlas.indices.length,
    result.indices.length,
    'the atlas lost the same faces',
  );
  assert.deepEqual(result.positions, head.positions, 'no vertex is touched');
  const up = new Set(upper),
    down = new Set(lower),
    p = head.positions;
  for (let f = 0; f < result.indices.length; f += 3) {
    const face = [result.indices[f], result.indices[f + 1], result.indices[f + 2]];
    if (!face.every((v) => head.tags[v].endsWith('skin'))) continue;
    const x = (p[face[0] * 3] + p[face[1] * 3] + p[face[2] * 3]) / 3;
    if (Math.abs(x) > HALF * 0.85) continue;
    assert.ok(
      !(face.some((v) => up.has(v)) && face.some((v) => down.has(v))),
      'a strip of skin still joins the lips at x=' + x,
    );
  }
});
