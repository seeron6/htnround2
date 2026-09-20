import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cutLips,
  extendVertexField,
  lipField,
  lipSeamFromRing,
  lipTopologyFits,
} from '../src/lip-topology.js';

// A curved lower-face patch with Meshy-sized triangles (~6 mm) and no edge
// anywhere near the lip line: the case the old triangle-deleting aperture left
// shards on. Units are metres on a head normalised like the app's.
const MOUTH_Y = -0.04,
  HALF_WIDTH = 0.025;
const surfaceZ = (x, y) => 0.07 - 4 * x * x - 1.5 * (y - MOUTH_Y) ** 2;
const lipLine = (x) => MOUTH_Y + 0.0025 * Math.cos((Math.PI * x) / (2 * HALF_WIDTH));

function patch({ step = 0.006, jitter = 0.0012 } = {}) {
  const positions = [],
    indices = [],
    columns = Math.round(0.12 / step),
    rows = Math.round(0.09 / step);
  // A fixed pseudo-random jitter, so no grid line can coincide with the lip line.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const border = i === 0 || j === 0 || i === columns || j === rows;
      const x = -0.06 + i * step + (border ? 0 : random() * jitter),
        y = -0.09 + j * step + (border ? 0 : random() * jitter);
      positions.push(x, y, surfaceZ(x, y));
    }
  const at = (i, j) => j * (columns + 1) + i;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      // Counter-clockwise seen from +z, alternating diagonals.
      if ((i + j) % 2)
        indices.push(
          at(i, j),
          at(i + 1, j),
          at(i + 1, j + 1),
          at(i, j),
          at(i + 1, j + 1),
          at(i, j + 1),
        );
      else
        indices.push(
          at(i, j),
          at(i + 1, j),
          at(i, j + 1),
          at(i + 1, j),
          at(i + 1, j + 1),
          at(i, j + 1),
        );
    }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// The detector's view: square-on, isotropic, y up. The scale is arbitrary.
const project = (x, y) => ({ x: x * 7, y: y * 7 });
const seam = Array.from({ length: 11 }, (_, i) => {
  const x = -HALF_WIDTH + (i / 10) * 2 * HALF_WIDTH;
  return project(x, lipLine(x));
});
const mouth = {
  project,
  seam,
  centre: [0, lipLine(0), surfaceZ(0, lipLine(0))],
  width: 2 * HALF_WIDTH,
};

const area = (p, a, b, c) => {
  const u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]),
    v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
  return (
    Math.hypot(
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ) / 2
  );
};
const faces = (indices) =>
  Array.from({ length: indices.length / 3 }, (_, f) => [
    indices[f * 3],
    indices[f * 3 + 1],
    indices[f * 3 + 2],
  ]);
const surfaceFaces = (result) => {
  const inner = new Set([...result.topology.innerUpper, ...result.topology.innerLower]);
  return faces(result.indices).filter((f) => !f.some((v) => inner.has(v)));
};
const key = (p, v) =>
  `${Math.round(p[v * 3] * 1e7)},${Math.round(p[v * 3 + 1] * 1e7)},${Math.round(p[v * 3 + 2] * 1e7)}`;

test('the detector ring becomes one lip line, corner to corner', () => {
  // Upper contour left to right, then the lower contour back again.
  const ring = [
    ...Array.from({ length: 11 }, (_, i) => ({ x: i / 10, y: 0.02 })),
    ...Array.from({ length: 9 }, (_, i) => ({ x: (9 - i) / 10, y: -0.02 })),
  ];
  const line = lipSeamFromRing(ring);
  assert.equal(line.length, 11);
  assert.deepEqual(line[0], { x: 0, y: 0.02 }, 'a corner belongs to both contours');
  for (const p of line.slice(1, -1))
    assert.ok(Math.abs(p.y) < 1e-12, 'midway between the lips');
  assert.ok(
    line.every((p, i) => !i || p.x > line[i - 1].x),
    'ordered left to right',
  );
  assert.equal(lipSeamFromRing(ring.slice(1)), null);
});

test('cutting only refines: no original vertex moves and no untouched face changes', () => {
  const source = patch();
  const before = {
    positions: source.positions.slice(),
    indices: source.indices.slice(),
  };
  const result = cutLips({ ...source, ...mouth });
  assert.ok(result, 'a plain curved patch must cut');
  assert.deepEqual(source.positions, before.positions, 'the input is never modified');
  assert.deepEqual(source.indices, before.indices);
  assert.deepEqual(
    result.positions.slice(0, before.positions.length),
    before.positions,
    'vertices are only ever appended',
  );
  // A face far from the mouth keeps both its place in the list and its corners,
  // which is what keeps anything addressed by face or vertex index valid.
  let untouched = 0;
  for (let f = 0; f < before.indices.length / 3; f++) {
    const same = [0, 1, 2].every(
      (k) => result.indices[f * 3 + k] === before.indices[f * 3 + k],
    );
    const y = before.positions[before.indices[f * 3] * 3 + 1];
    if (Math.abs(y - MOUTH_Y) > 0.03)
      assert.ok(same, 'a face away from the lips was rewritten');
    untouched += same;
  }
  assert.ok(untouched > 100);
  assert.ok(result.topology.addedTriangles > 200, 'the lips must gain real resolution');
});

test('the surface is unchanged: same area, and every new vertex lies on an old edge', () => {
  const source = patch();
  const result = cutLips({ ...source, ...mouth });
  const total = (p, list) => list.reduce((sum, f) => sum + area(p, ...f), 0);
  const was = total(source.positions, faces(source.indices)),
    now = total(result.positions, surfaceFaces(result));
  assert.ok(Math.abs(now - was) / was < 1e-5, `area drifted ${was} -> ${now}`);
  // Refinement never re-projects: a split vertex is a blend of two earlier ones.
  const rebuilt = extendVertexField(source.positions, 3, result.parents, {
    offset: true,
  });
  assert.equal(rebuilt.length, result.positions.length);
  for (let i = 0; i < rebuilt.length; i++)
    assert.ok(
      Math.abs(rebuilt[i] - result.positions[i]) < 1e-7,
      'parents must rebuild vertex ' + i / 3,
    );
});

test('the lips part along one seam and share nothing but their corners', () => {
  const result = cutLips({ ...patch(), ...mouth });
  const { upper, lower, corners, seam: chain } = result.topology,
    p = result.positions;
  assert.equal(upper.length, lower.length);
  assert.ok(
    upper.length >= 16,
    'an open mouth needs a smooth outline, got ' + upper.length,
  );
  assert.equal(chain.length, upper.length + 2);
  assert.deepEqual([chain[0], chain[chain.length - 1]], corners);
  upper.forEach((v, i) =>
    assert.equal(key(p, v), key(p, lower[i]), 'closed lips coincide exactly'),
  );
  for (let i = 1; i < chain.length; i++)
    assert.ok(p[chain[i] * 3] > p[chain[i - 1] * 3], 'the seam runs left to right');
  const reach = p[corners[1] * 3] - p[corners[0] * 3];
  assert.ok(
    reach > 2 * HALF_WIDTH * 0.85 && reach < 2 * HALF_WIDTH * 1.02,
    'corner to corner: ' + reach,
  );
  for (const v of chain)
    assert.ok(
      Math.abs(p[v * 3 + 1] - lipLine(p[v * 3])) < 0.0004,
      'the seam must follow the lip line to a fraction of a millimetre',
    );
  // The actual separation: no face may hold the upper lip and the lower lip.
  const up = new Set(upper),
    down = new Set(lower);
  for (const f of faces(result.indices))
    assert.ok(
      !(f.some((v) => up.has(v)) && f.some((v) => down.has(v))),
      'a face still bridges the lips',
    );
  // ...and every face that touches the seam is wholly on its own side of it.
  for (const f of surfaceFaces(result)) {
    const sign =
      up.has(f[0]) || up.has(f[1]) || up.has(f[2])
        ? 1
        : down.has(f[0]) || down.has(f[1]) || down.has(f[2])
          ? -1
          : 0;
    if (!sign) continue;
    const y = (p[f[0] * 3 + 1] + p[f[1] * 3 + 1] + p[f[2] * 3 + 1]) / 3,
      x = (p[f[0] * 3] + p[f[1] * 3] + p[f[2] * 3]) / 3;
    assert.ok(
      (y - lipLine(x)) * sign > -1e-6,
      'a lip face sits on the wrong side of the seam',
    );
  }
});

test('the cut surface is still one conforming sheet', () => {
  const source = patch();
  const result = cutLips({ ...source, ...mouth });
  // Closed, the two lips coincide, so welded by position the skin must again be
  // a sheet where every edge has two faces, except around the patch border.
  const count = (positions, list) => {
    const seen = new Map();
    for (const f of list)
      for (let k = 0; k < 3; k++) {
        const a = key(positions, f[k]),
          b = key(positions, f[(k + 1) % 3]);
        assert.notEqual(a, b, 'a face has collapsed to a line');
        const edge = a < b ? a + '|' + b : b + '|' + a;
        seen.set(edge, (seen.get(edge) || 0) + 1);
      }
    return seen;
  };
  const edges = count(result.positions, surfaceFaces(result));
  assert.ok(
    [...edges.values()].every((n) => n === 1 || n === 2),
    'an edge has more than two faces',
  );
  // A T-junction would show up as extra boundary: the border is all there is.
  const border = (p, list) => {
    let length = 0;
    const seen = count(p, list);
    for (const f of list)
      for (let k = 0; k < 3; k++) {
        const a = key(p, f[k]),
          b = key(p, f[(k + 1) % 3]);
        if (seen.get(a < b ? a + '|' + b : b + '|' + a) === 1)
          length += Math.hypot(
            ...[0, 1, 2].map((n) => p[f[k] * 3 + n] - p[f[(k + 1) % 3] * 3 + n]),
          );
      }
    return length;
  };
  const was = border(source.positions, faces(source.indices)),
    now = border(result.positions, surfaceFaces(result));
  assert.ok(Math.abs(now - was) < 1e-6, `open boundary grew from ${was} to ${now}`);
});

test('the inside of the mouth is a closed pouch behind the lips, darker with depth', () => {
  const source = patch(),
    result = cutLips({ ...source, ...mouth });
  const { innerUpper, innerLower, upper, lower, corners, shade } = result.topology,
    p = result.positions;
  assert.ok(innerUpper.length && innerUpper.length === innerLower.length);
  let deepest = 0;
  for (const v of [...innerUpper, ...innerLower]) {
    const front = surfaceZ(p[v * 3], p[v * 3 + 1]);
    assert.ok(
      p[v * 3 + 2] <= front + 1e-6,
      'the inside of the mouth pokes out of the face',
    );
    // It never reaches past the corners: there it has closed to nothing.
    assert.ok(Math.abs(p[v * 3]) <= HALF_WIDTH + 1e-6);
    deepest = Math.max(deepest, front - p[v * 3 + 2]);
  }
  assert.ok(
    deepest > 0.022 && deepest < 0.04,
    'a mouth is about 3 cm deep, got ' + deepest,
  );
  // The sheets are their own surfaces, so the visible lip keeps the normals it had.
  const rim = new Set([...upper, ...lower, ...corners]),
    top = new Set(innerUpper),
    bottom = new Set(innerLower);
  let wall = 0;
  for (const f of faces(result.indices)) {
    const inside = f.some((v) => top.has(v) || bottom.has(v));
    assert.ok(!(inside && f.some((v) => rim.has(v))), 'the pouch shares the lip edge');
    if (f.some((v) => top.has(v)) && f.some((v) => bottom.has(v))) wall++;
  }
  assert.ok(
    wall >= upper.length,
    'the two sheets must be joined at the back, or you see into the skull',
  );
  // Depth shading lists only what is darkened, and only the inside ever is.
  assert.equal(shade.vertices.length, shade.values.length);
  assert.ok(shade.values.every((v) => v > 0 && v < 1));
  const dark = new Map(shade.vertices.map((v, i) => [v, shade.values[i]])),
    inside = new Set([...innerUpper, ...innerLower]);
  for (const v of shade.vertices) assert.ok(inside.has(v), 'skin was darkened');
  for (const v of inside) {
    const depth = surfaceZ(p[v * 3], p[v * 3 + 1]) - p[v * 3 + 2];
    if (depth > 0.02)
      assert.ok(dark.get(v) < 0.2, 'the back of the mouth must be dark');
  }
});

test('a texture atlas is carried across exactly, UV seam and all', () => {
  const source = patch();
  // Two charts that disagree, split down the middle of the mouth, the way a real
  // atlas is torn: render copies on the right use their own UV mapping.
  const chart = (x, y, right) =>
    right ? [0.5 + x * 3, 0.9 + y * 4] : [0.4 + x * 2, 0.2 - y * 5];
  const mapping = [],
    uv = [],
    atlasIndices = [],
    copies = new Map();
  const renderVertex = (v, right) => {
    const id = v + (right ? ':r' : ':l');
    if (!copies.has(id)) {
      copies.set(id, mapping.length);
      mapping.push(v);
      uv.push(...chart(source.positions[v * 3], source.positions[v * 3 + 1], right));
    }
    return copies.get(id);
  };
  for (const f of faces(source.indices)) {
    const right =
      (source.positions[f[0] * 3] +
        source.positions[f[1] * 3] +
        source.positions[f[2] * 3]) /
        3 >
      0;
    atlasIndices.push(...f.map((v) => renderVertex(v, right)));
  }
  const result = cutLips({
    ...source,
    ...mouth,
    atlas: { mapping, indices: atlasIndices, uv, texture: 'kept' },
  });
  assert.ok(result?.atlas);
  assert.equal(result.atlas.texture, 'kept', 'other atlas fields pass through');
  assert.equal(result.atlas.indices.length, result.indices.length);
  assert.equal(result.atlas.uv.length, result.atlas.mapping.length * 2);
  const inner = new Set([...result.topology.innerUpper, ...result.topology.innerLower]);
  let checked = 0;
  for (let f = 0; f < result.indices.length / 3; f++) {
    const sim = [0, 1, 2].map((k) => result.indices[f * 3 + k]),
      render = [0, 1, 2].map((k) => result.atlas.indices[f * 3 + k]);
    render.forEach((r, k) =>
      assert.equal(result.atlas.mapping[r], sim[k], 'face lists fell out of step'),
    );
    if (sim.some((v) => inner.has(v))) continue;
    const p = result.positions;
    // All three corners of a face must carry ONE chart's UV for where they now
    // are: that is what "the texture did not move" means. A piece of a split
    // face keeps its parent's chart, whichever side of the tear it lies on.
    const fits = (right) =>
      sim.every((v, k) => {
        const want = chart(p[v * 3], p[v * 3 + 1], right);
        return (
          Math.abs(result.atlas.uv[render[k] * 2] - want[0]) < 1e-5 &&
          Math.abs(result.atlas.uv[render[k] * 2 + 1] - want[1]) < 1e-5
        );
      });
    const left = fits(false),
      right = fits(true);
    assert.ok(left || right, 'the texture moved on face ' + f);
    checked += left ? 1 : 1000;
  }
  assert.ok(
    checked % 1000 > 300 && checked > 300000,
    'both charts must be exercised: ' + checked,
  );
});

test('a torn geometry (Meshy: every UV island has its own vertices) cuts the same', () => {
  const source = patch();
  // Tear it completely: each face gets private vertices and a private UV.
  const positions = [],
    uv = [],
    indices = [];
  faces(source.indices).forEach((f, n) => {
    for (const v of f) {
      indices.push(positions.length / 3);
      positions.push(
        source.positions[v * 3],
        source.positions[v * 3 + 1],
        source.positions[v * 3 + 2],
      );
      uv.push((n % 40) / 40 + source.positions[v * 3], source.positions[v * 3 + 1]);
    }
  });
  const result = cutLips({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    attributes: { uv: { itemSize: 2, array: new Float32Array(uv) } },
    ...mouth,
  });
  assert.ok(result, 'a fully torn mesh must still be walked as one sheet');
  assert.equal(result.atlas, null);
  assert.equal(result.attributes.uv.array.length / 2, result.positions.length / 3);
  const { upper, lower, seam: chain } = result.topology,
    up = new Set(upper),
    down = new Set(lower);
  assert.ok(
    upper.length > chain.length,
    'every render copy of a lip vertex is labelled',
  );
  for (const f of faces(result.indices))
    assert.ok(
      !(f.some((v) => up.has(v)) && f.some((v) => down.has(v))),
      'a face still bridges the lips',
    );
  // Still watertight when welded: no cracks between the torn islands.
  const seen = new Map();
  for (const f of surfaceFaces(result))
    for (let k = 0; k < 3; k++) {
      const a = key(result.positions, f[k]),
        b = key(result.positions, f[(k + 1) % 3]),
        edge = a < b ? a + '|' + b : b + '|' + a;
      seen.set(edge, (seen.get(edge) || 0) + 1);
    }
  assert.ok([...seen.values()].every((n) => n <= 2));
  const rebuilt = extendVertexField(new Float32Array(positions), 3, result.parents, {
    offset: true,
  });
  for (let i = 0; i < rebuilt.length; i++)
    assert.ok(Math.abs(rebuilt[i] - result.positions[i]) < 1e-7);
});

test('a dense mesh is cut without being refined', () => {
  const source = patch({ step: 0.001, jitter: 0.0002 });
  const result = cutLips({ ...source, ...mouth });
  assert.ok(result);
  const strip = result.topology.innerUpper.length + result.topology.innerLower.length;
  // Only the crossings, the lower-lip copies and the inner-lip sheets are new.
  assert.ok(
    result.topology.addedVertices < result.topology.seam.length * 3 + strip,
    'a mesh that is already fine enough must not be subdivided',
  );
});

test('per-vertex data follows the new vertices', () => {
  const source = patch();
  const result = cutLips({ ...source, ...mouth });
  const count = source.positions.length / 3;
  // Newton-style binding: three cage indices and three weights per vertex.
  const binding = Uint32Array.from({ length: count * 3 }, (_, i) => (i * 7) % 468);
  const extended = extendVertexField(binding, 3, result.parents, { blend: false });
  assert.equal(extended.length, result.positions.length);
  assert.deepEqual(extended.slice(0, binding.length), binding);
  for (let v = count; v < extended.length / 3; v++) {
    const parent =
      result.parents[
        (v - count) * 6 + (result.parents[(v - count) * 6 + 2] < 0.5 ? 0 : 1)
      ];
    assert.deepEqual(
      Array.from(extended.slice(v * 3, v * 3 + 3)),
      Array.from(extended.slice(parent * 3, parent * 3 + 3)),
      'a new vertex is bound exactly as the parent it is nearest',
    );
  }
});

test('the rig is told which lip a vertex belongs to, even where positions cannot', () => {
  const result = cutLips({ ...patch(), ...mouth });
  const field = lipField(result.positions, result.topology);
  assert.ok(field);
  assert.ok(Math.abs(field.width - 2 * HALF_WIDTH) < 0.006);
  const { upper, lower, corners, innerUpper, innerLower } = result.topology;
  for (const v of [...upper, ...innerUpper]) assert.equal(field.side[v], 1);
  for (const v of [...lower, ...innerLower]) assert.equal(field.side[v], -1);
  for (const v of corners) {
    assert.equal(field.side[v], 0);
    assert.ok(field.taper[v] < 1e-3, 'the corners stay closed');
  }
  const middle = upper[upper.length >> 1];
  assert.ok(field.taper[middle] > 0.95);
  assert.ok(Math.abs(field.height[middle]) < 1e-6);
  // Away from the seam the side is simply above or below it.
  const p = result.positions;
  for (let v = 0; v < p.length / 3; v++) {
    if (Math.abs(p[v * 3]) > HALF_WIDTH * 0.8) continue;
    const above = p[v * 3 + 1] - lipLine(p[v * 3]);
    if (Math.abs(above) > 0.002) assert.equal(field.side[v], Math.sign(above));
  }
  assert.equal(lipTopologyFits(result.topology, p.length / 3), true);
  assert.equal(
    lipTopologyFits(result.topology, p.length / 3 + 1),
    false,
    'a stale topology is refused',
  );
  assert.equal(lipField(p.slice(0, -3), result.topology), null);
});

test('a head with no mouth where the detector pointed is left alone', () => {
  const source = patch();
  assert.equal(cutLips({ ...source, ...mouth, centre: [0, 0.5, 0.07] }), null);
  assert.equal(cutLips({ ...source, ...mouth, seam: seam.slice(0, 2) }), null);
  assert.equal(cutLips({ ...source, ...mouth, width: 0 }), null);
  // Seen from behind there is no front surface to cut.
  const flipped = { ...source, indices: source.indices.slice().reverse() };
  assert.ok(
    cutLips({ ...flipped, ...mouth }),
    'an inside-out mesh is still cut, by majority winding',
  );
});
