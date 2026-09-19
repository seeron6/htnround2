import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document, NodeIO, Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three';
import { packageEyewear } from '../scripts/package_head_eyewear.mjs';
import { weldTexturedSurface } from '../src/surface-appearance.js';

test('packaged GLB keeps head buffers separate from real frame, lens and hinge nodes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eyewear-'));
  try {
    const d = new Document(),
      b = d.createBuffer(),
      ring = (x) =>
        Array.from({ length: 16 }, (_, i) => [
          x + 0.025 * Math.cos((i * Math.PI) / 8),
          0.04 + 0.018 * Math.sin((i * Math.PI) / 8),
          0.03,
        ]);
    const spec = {
      rims: [ring(-0.04), ring(0.04)],
      bridge: [
        [-0.015, 0.04, 0.03],
        [0, 0.045, 0.035],
        [0.015, 0.04, 0.03],
      ],
      temples: [
        [
          [-0.06, 0.05, 0.02],
          [-0.085, 0.05, -0.08],
        ],
        [
          [0.06, 0.05, 0.02],
          [0.085, 0.05, -0.08],
        ],
      ],
      radius: 0.002,
    };
    const positions = new Float32Array([-0.1, 0, 0, 0.1, 0, 0, 0, 0.1, 0]);
    const a = d
      .createAccessor()
      .setBuffer(b)
      .setType(Accessor.Type.VEC3)
      .setArray(positions);
    const primitive = d.createPrimitive().setAttribute('POSITION', a),
      mesh = d
        .createMesh('head')
        .addPrimitive(primitive)
        .setExtras({ accessories: { glasses: spec } });
    d.createScene().addChild(d.createNode('head').setMesh(mesh));
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS),
      file = path.join(dir, 'head.glb');
    await io.write(file, d);
    await packageEyewear(file);
    const out = await io.read(file),
      root = out.getRoot(),
      head = root.listMeshes().find((m) => m.getName() === 'head');
    assert.deepEqual(
      head.listPrimitives()[0].getAttribute('POSITION').getArray(),
      positions,
    );
    const glasses = root
      .listNodes()
      .filter((n) => n.getExtras().accessory === 'eyeglasses' && n.getMesh());
    assert.equal(glasses.length, 9);
    const headAccessor = head.listPrimitives()[0].getAttribute('POSITION');
    for (const node of glasses)
      assert.notEqual(
        node.getMesh().listPrimitives()[0].getAttribute('POSITION'),
        headAccessor,
      );
    const lenses = glasses.filter((n) => n.getName().includes('lens'));
    assert.equal(lenses.length, 2);
    for (const n of lenses) {
      const m = n.getMesh().listPrimitives()[0].getMaterial();
      assert.equal(m.getAlphaMode(), 'BLEND');
      assert.ok(m.getBaseColorFactor()[3] < 0.12);
    }
    await assert.rejects(packageEyewear(file), /already packaged/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('interleaved GLB attributes cannot enter the skin solver as mixed position-normal-UV data', () => {
  const data = new THREE.InterleavedBuffer(
      new Float32Array([
        0, 0, 0, 0, 0, 1, 0.1, 0.2, 1, 0, 0, 0, 0, 1, 0.3, 0.4, 0, 1, 0, 0, 0, 1, 0.5,
        0.6,
      ]),
      8,
    ),
    g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.InterleavedBufferAttribute(data, 3, 0));
  g.setAttribute('uv', new THREE.InterleavedBufferAttribute(data, 2, 6));
  g.setIndex([0, 1, 2]);
  const { geometry, atlas } = weldTexturedSurface(g);
  assert.equal(geometry.attributes.position.count, 3);
  assert.deepEqual(
    Array.from(geometry.attributes.position.array),
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
  );
  assert.equal(atlas.uv.length, 6);
  assert.ok(geometry.attributes.normal.array.every(Number.isFinite));
});
