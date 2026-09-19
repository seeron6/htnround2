import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadGlasses } from '../src/head-accessories.js';
import * as THREE from 'three';

function fixture() {
  const ring = (x) =>
    Array.from({ length: 16 }, (_, i) => [
      x + 0.024 * Math.cos((i * Math.PI) / 8),
      0.04 + 0.016 * Math.sin((i * Math.PI) / 8),
      0.024,
    ]);
  return {
    rims: [ring(-0.037), ring(0.037)],
    bridge: [
      [-0.013, 0.043, 0.025],
      [0, 0.048, 0.03],
      [0.013, 0.043, 0.025],
    ],
    temples: [
      [
        [0.06, 0.046, 0.023],
        [0.08, 0.046, -0.05],
        [0.08, 0.03, -0.1],
      ],
      [
        [-0.06, 0.046, 0.023],
        [-0.08, 0.046, -0.05],
        [-0.08, 0.03, -0.1],
      ],
    ],
    frameColor: [0.05, 0.05, 0.05],
    radius: 0.0015,
    lensTint: 0,
  };
}

test('glasses have independent three-dimensional geometry that round-trips through a saved specification', () => {
  const spec = fixture(),
    g = new HeadGlasses(spec);
  const restored = new HeadGlasses(JSON.parse(JSON.stringify(g.spec)));
  const bounds = new THREE.Box3().setFromObject(g);
  assert.ok(bounds.max.z - bounds.min.z > 0.1);
  assert.equal(g.children.length, 9);
  g.children.forEach((m, i) => {
    assert.ok(m.geometry.attributes.position.array.every(Number.isFinite));
    assert.deepEqual(
      m.geometry.attributes.position.array,
      restored.children[i].geometry.attributes.position.array,
    );
    assert.equal(m.userData.accessory, 'eyeglasses');
    assert.equal(m.geometry.morphAttributes.position, undefined);
  });
  spec.rims[0][0][0] = 0.8;
  assert.notEqual(g.spec.rims[0][0][0], 0.8);
  g.dispose();
  restored.dispose();
});
test('acetate arms are flatter than their height and taper toward the ear; clear lenses preserve the photographed eyes', () => {
  const spec = fixture();
  spec.templeWidth = 0.006;
  spec.temples = [
    [
      [0.07, 0.04, 0],
      [0.07, 0.04, -0.06],
      [0.07, 0.04, -0.12],
    ],
  ];
  const glasses = new HeadGlasses(spec),
    arm = glasses.getObjectByName('Eyeglass temple 1');
  const positions = arm.geometry.attributes.position;
  const section = (i) => {
    const box = new THREE.Box3();
    const sides = (positions.count - 2) / 97;
    for (let j = 0; j < sides; j++)
      box.expandByPoint(
        new THREE.Vector3().fromBufferAttribute(positions, i * sides + j),
      );
    return box.getSize(new THREE.Vector3());
  };
  const start = section(0),
    end = section(96);
  assert.ok(start.y >= 0.006 * 1.15);
  assert.ok(start.y > start.x * 2);
  assert.ok(end.y < start.y * 0.6);
  const lens = glasses.getObjectByName('Eyeglass lens 1');
  assert.ok(lens.material.transparent);
  assert.ok(lens.material.opacity < 0.12);
  assert.equal(lens.material.depthWrite, false);
  assert.equal(lens.material.ior, 1.5);
  assert.ok(lens.geometry.attributes.position.count > 500);
  assert.ok(glasses.getObjectByName('Eyeglass hinge 1'));
  glasses.dispose();
});
test('invalid eyewear cannot install non-finite vertices into the renderer', () => {
  const spec = fixture();
  spec.rims[0][3][2] = Infinity;
  assert.throws(() => new HeadGlasses(spec), /Invalid/);
});
test('noisy profile fits produce straight rigid shafts with only a short ear hook on both sides', () => {
  const spec = fixture();
  spec.temples = [-1, 1].map((sign) =>
    [
      [0.082, 0.06, 0.001],
      [0.082, 0.061, -0.018],
      [0.101, 0.06, -0.056],
      [0.107, 0.068, -0.098],
      [0.114, 0.056, -0.124],
      [0.112, 0.042, -0.136],
    ].map(([x, y, z]) => [sign * x, y, z]),
  );
  const original = structuredClone(spec),
    glasses = new HeadGlasses(spec);
  for (let arm = 0; arm < 2; arm++) {
    const positions = glasses.getObjectByName(`Eyeglass temple ${arm + 1}`).geometry
      .attributes.position;
    const center = (section) => {
      const p = new THREE.Vector3(),
        sides = (positions.count - 2) / 97;
      for (let j = 0; j < sides; j++)
        p.add(new THREE.Vector3().fromBufferAttribute(positions, section * sides + j));
      return p.divideScalar(sides);
    };
    const hinge = center(0),
      shaftEnd = center(64),
      direction = shaftEnd.clone().sub(hinge).normalize();
    for (let section = 1; section < 64; section++) {
      const deviation = center(section).sub(hinge).cross(direction).length();
      assert.ok(deviation < 1e-7, `Arm ${arm + 1} bends along its rigid shaft`);
    }
    assert.ok(hinge.distanceTo(new THREE.Vector3(...spec.temples[arm][0])) < 1e-8);
    assert.ok(
      center(96).distanceTo(new THREE.Vector3(...spec.temples[arm].at(-1))) < 1e-8,
    );
    assert.ok(center(96).y < shaftEnd.y - 0.01, 'Keep the short downward ear hook');
  }
  assert.deepEqual(spec, original, 'Keep the original observations intact');
  glasses.dispose();
});
test('physical eyewear keeps acetate highlights and a visible optical response', () => {
  const glasses = new HeadGlasses(fixture());
  const frames = glasses.children.filter((child) =>
    child.name.startsWith('Eyeglass rim'),
  );
  const lenses = glasses.children.filter((child) =>
    child.name.startsWith('Eyeglass lens '),
  );
  assert.equal(frames.length, 2);
  assert.equal(lenses.length, 2);
  for (const frame of frames) {
    assert.ok(frame.material.specularIntensity >= 0.8);
    assert.ok(frame.material.clearcoat > 0.9);
  }
  for (const lens of lenses) {
    assert.ok(lens.material.opacity > 0.06 && lens.material.opacity < 0.2);
    assert.ok(lens.material.envMapIntensity >= 0.8);
    assert.equal(lens.material.depthWrite, false);
  }
  glasses.dispose();
});
test('GLB round-trip retains acetate frames, clear lenses and separate hinges', async () => {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js'),
    { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const previous = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  };
  const glasses = new HeadGlasses(fixture());
  try {
    const binary = await new GLTFExporter().parseAsync(glasses, { binary: true }),
      restored = (await new GLTFLoader().parseAsync(binary, '')).scene.children[0];
    assert.equal(restored.children.length, 9);
    for (let i = 0; i < 9; i++) {
      assert.deepEqual(
        restored.children[i].geometry.attributes.position.array,
        glasses.children[i].geometry.attributes.position.array,
      );
      assert.equal(restored.children[i].userData.accessory, 'eyeglasses');
    }
    const lens = restored.children.find((m) => m.name.startsWith('Eyeglass_lens'));
    assert.ok(lens.material.transparent);
    assert.ok(lens.material.opacity < 0.12);
  } finally {
    glasses.dispose();
    globalThis.FileReader = previous;
  }
});

test('source-fitted frames keep polished lens edges and hardware as independent geometry', () => {
  const spec = fixture();
  spec.version = 3;
  spec.rimWidths = spec.rims.map((r) => r.map(() => 0.003));
  spec.rimDepth = 0.0038;
  spec.lensThickness = 0.0014;
  spec.templeAccent = { length: 0.014, width: 0.0011, offset: 0.004 };
  const glasses = new HeadGlasses(spec);
  assert.equal(glasses.children.length, 17);
  assert.ok(glasses.getObjectByName('Eyeglass inset temple accent 1'));
  assert.ok(glasses.getObjectByName('Eyeglass polished lens edge 2'));
  for (const m of glasses.children)
    assert.ok(m.geometry.attributes.position.array.every(Number.isFinite));
  glasses.dispose();
  spec.rimWidths[0][3] = NaN;
  assert.throws(() => new HeadGlasses(spec), /rim widths/);
});

test('surface-fitted arms keep their clearance path through serialization and the renderer', () => {
  const spec = fixture();
  spec.templePathMode = 'fitted-polyline';
  // This intermediate shoulder is the clearance constraint. The legacy
  // straightening pass would erase it, crossing the obstacle behind the arm.
  spec.temples = [
    [
      [0.06, 0.05, 0.02],
      [0.1, 0.05, -0.06],
      [0.101, 0.033, -0.09],
    ],
  ];
  const original = structuredClone(spec),
    glasses = new HeadGlasses(spec),
    restored = new HeadGlasses(JSON.parse(JSON.stringify(glasses.spec))),
    p = glasses.getObjectByName('Eyeglass temple 1').geometry.attributes.position,
    a = new THREE.Vector3(...spec.temples[0][0]),
    b = new THREE.Vector3(...spec.temples[0][1]),
    c = new THREE.Vector3(...spec.temples[0][2]),
    line1 = new THREE.Line3(a, b),
    line2 = new THREE.Line3(b, c);
  const sides = (p.count - 2) / 97;
  for (let section = 0; section <= 96; section++) {
    const center = new THREE.Vector3();
    for (let j = 0; j < sides; j++)
      center.add(new THREE.Vector3().fromBufferAttribute(p, section * sides + j));
    center.divideScalar(sides);
    const distance = Math.min(
      center.distanceTo(line1.closestPointToPoint(center, true, new THREE.Vector3())),
      center.distanceTo(line2.closestPointToPoint(center, true, new THREE.Vector3())),
    );
    assert.ok(distance < 1e-8, 'Keep every swept section on its fitted segment');
  }
  assert.deepEqual(
    p.array,
    restored.getObjectByName('Eyeglass temple 1').geometry.attributes.position.array,
  );
  assert.deepEqual(spec, original);
  glasses.dispose();
  restored.dispose();
  spec.templePathMode = 'unknown';
  assert.throws(() => new HeadGlasses(spec), /arm mode/);
  spec.templePathMode = 'fitted-polyline';
  spec.temples[0][1] = spec.temples[0][0];
  assert.throws(() => new HeadGlasses(spec), /arm segment/);
});
