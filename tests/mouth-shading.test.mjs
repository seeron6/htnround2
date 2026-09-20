import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clearLegacyMouthShading, shadeMouth } from '../src/lip-fit.js';
import { NATIVE_MOUTH_SHADE_VERSION } from '../src/lip-topology.js';
import { SurfaceAppearance } from '../src/surface-appearance.js';

function savedMouth() {
  const geometry = new THREE.BufferGeometry().copy(
    new THREE.PlaneGeometry(0.1, 0.1, 4, 4),
  );
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([0.6, 0.4, 0.2, 0.7], i * 4);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const originalColors = colors.slice();
  const shade = { vertices: [6, 7, 11, 12], values: [0.06, 0.08, 0.1, 0.5] };
  shadeMouth(geometry, shade);
  geometry.userData.lipTopology = {
    version: 1,
    native: true,
    vertices: count,
    seam: [],
    seamPoints: Array.from({ length: 15 }, (_, i) => [i * 0.003, 0, 0]).flat(),
    upper: [6, 7, 8],
    lower: [11, 12, 13],
    corners: [],
    innerUpper: [],
    innerLower: [],
    shade,
  };
  // Serialise like an editable session: there is no in-memory undo history.
  const saved = new THREE.BufferGeometryLoader().parse(
    JSON.parse(JSON.stringify(geometry.toJSON())),
  );
  const atlas = {
    mapping: Array.from({ length: count }, (_, i) => i),
    indices: Array.from(saved.index.array),
    uv: Array.from(saved.attributes.uv.array),
    shade: structuredClone(shade),
  };
  const appearance = new SurfaceAppearance(saved, atlas, new THREE.Texture());
  return { geometry: saved, appearance, originalColors };
}

test('an old saved mouth loses the dark skin patch on both render paths without changing its face', () => {
  const { geometry, appearance, originalColors } = savedMouth();
  const before = Object.fromEntries(
    ['position', 'normal', 'uv'].map((name) => [
      name,
      geometry.attributes[name].array.slice(),
    ]),
  );
  const indices = geometry.index.array.slice();
  assert.ok(appearance.geometry.attributes.color.getX(6) < 0.1);
  assert.equal(clearLegacyMouthShading(geometry, appearance), true);
  const color = geometry.attributes.color.array;
  for (let i = 0; i < color.length; i++)
    assert.ok(
      Math.abs(color[i] - originalColors[i]) < 1e-6,
      'preserve original colour and alpha at ' + i,
    );
  for (const name of Object.keys(before))
    assert.deepEqual(geometry.attributes[name].array, before[name]);
  assert.deepEqual(geometry.index.array, indices);
  assert.equal(appearance.geometry.attributes.color, undefined);
  assert.equal(appearance.material.vertexColors, false);
  assert.equal(appearance.atlas.shade, undefined);
  assert.equal(geometry.userData.lipTopology, undefined);
  // A later fit may safely install a fresh mask; the previous one never compounds.
  const fresh = { vertices: [12], values: [0.2] };
  appearance.shadeMouth(fresh);
  appearance.shadeMouth(fresh);
  assert.equal(appearance.geometry.attributes.color.getX(6), 1);
  assert.ok(Math.abs(appearance.geometry.attributes.color.getX(12) - 0.2) < 1e-6);
  const repaired = color.slice();
  assert.equal(clearLegacyMouthShading(geometry, appearance), false);
  assert.deepEqual(color, repaired, 'repeated fits must not brighten the skin again');
  appearance.dispose();
  geometry.dispose();
});

test('current native labels and cut lip seams are retained', () => {
  for (const properties of [
    { shadeVersion: NATIVE_MOUTH_SHADE_VERSION },
    { native: false, seam: [0, 1, 2, 3, 4] },
  ]) {
    const { geometry, appearance } = savedMouth();
    Object.assign(geometry.userData.lipTopology, properties);
    const before = geometry.attributes.color.array.slice();
    assert.equal(clearLegacyMouthShading(geometry, appearance), false);
    assert.deepEqual(geometry.attributes.color.array, before);
    assert.ok(appearance.atlas.shade);
    assert.ok(geometry.userData.lipTopology);
    appearance.dispose();
    geometry.dispose();
  }
});
