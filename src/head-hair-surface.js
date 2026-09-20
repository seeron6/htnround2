import * as THREE from 'three';

// Build a separate hair shell from the independent head surface. The shell is
// deliberately a copy of selected scalp triangles offset along their measured
// normals; it never changes the face mesh and remains a disposable accessory.
function surfaceHairGeometry(source, spec = {}) {
  const position = source?.attributes?.position,
    normal = source?.attributes?.normal;
  if (!position || !normal) return null;
  const index =
      source.index?.array ?? Uint32Array.from({ length: position.count }, (_, i) => i),
    component = (attribute, id, axis) =>
      axis === 0
        ? attribute.getX(id)
        : axis === 1
          ? attribute.getY(id)
          : attribute.getZ(id),
    hairline = Number.isFinite(spec.hairlineY) ? spec.hairlineY : 0.1,
    faces = [],
    include = new Set();
  for (let f = 0; f < index.length; f += 3) {
    const ids = [index[f], index[f + 1], index[f + 2]],
      c = [0, 0, 0],
      n = [0, 0, 0];
    for (const id of ids) {
      for (let a = 0; a < 3; a++) {
        c[a] += component(position, id, a) / 3;
        n[a] += component(normal, id, a) / 3;
      }
    }
    const top = c[1] > hairline - 0.016 && n[1] > -0.12 && c[1] < hairline + 0.11,
      rear = c[2] < -0.095 && c[1] > -0.055 && c[1] < hairline + 0.04 && n[2] < -0.04;
    if (!top && !rear) continue;
    faces.push(ids);
    ids.forEach((id) => include.add(id));
  }
  if (faces.length < 32) return null;
  const vertexMap = new Map(),
    positions = [],
    normals = [],
    colors = [],
    uv = [],
    indices = [],
    color = new THREE.Color();
  const addVertex = (id) => {
    if (vertexMap.has(id)) return vertexMap.get(id);
    const x = component(position, id, 0),
      y = component(position, id, 1),
      z = component(position, id, 2),
      nx = component(normal, id, 0),
      ny = component(normal, id, 1),
      nz = component(normal, id, 2),
      topLift = THREE.MathUtils.clamp((y - (hairline - 0.016)) / 0.092, 0, 1),
      rearLift = THREE.MathUtils.clamp((-z - 0.095) / 0.16, 0, 1),
      // A few millimetres of independent volume are necessary because the
      // photographed scalp is the inner surface of the hairstyle. Keep the
      // lift smooth so the shell follows the measured cranium instead of
      // producing the three hard blobs seen in the old ellipsoid cap.
      lift = 0.0025 + 0.008 * topLift + 0.006 * rearLift,
      radialX = x / 0.112,
      radialZ = (z + 0.13) / 0.15,
      radialLength = Math.hypot(radialX, radialZ) || 1,
      radialLift = 0.003 + 0.007 * Math.max(topLift, rearLift);
    positions.push(
      x + nx * lift + (radialX / radialLength) * radialLift,
      y + ny * lift,
      z + nz * lift + (radialZ / radialLength) * radialLift,
    );
    normals.push(nx, ny, nz);
    // A subdued, warm-black variation keeps the shell from reading as a flat
    // black card before the photographic hair texture is applied.
    const variation = 0.82 + 0.12 * Math.sin(x * 81 + z * 57 + y * 41);
    color.setRGB(variation, variation * 0.95, variation * 0.9);
    colors.push(color.r, color.g, color.b);
    uv.push(
      THREE.MathUtils.clamp(0.5 + x / 0.23, 0.02, 0.98),
      THREE.MathUtils.clamp(0.5 + (z + 0.12) / 0.28, 0.02, 0.98),
    );
    const next = positions.length / 3 - 1;
    vertexMap.set(id, next);
    return next;
  };
  for (const face of faces) {
    const a = addVertex(face[0]),
      b = addVertex(face[1]),
      c = addVertex(face[2]);
    indices.push(a, b, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export class HeadHairSurface extends THREE.Mesh {
  constructor(source, spec = {}) {
    const geometry = surfaceHairGeometry(source, spec);
    if (!geometry) throw new Error('Independent head has no usable scalp surface.');
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x6f6259,
      vertexColors: true,
      roughness: 0.58,
      metalness: 0,
      specularIntensity: 0.35,
      anisotropy: 0.45,
      clearcoat: 0.18,
      clearcoatRoughness: 0.22,
      side: THREE.DoubleSide,
    });
    if (typeof document !== 'undefined') {
      const texture = new THREE.TextureLoader().load(
        '/textures/crown-hair-generated.png',
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      material.map = texture;
    }
    super(geometry, material);
    this.name = 'Independent surface-bound hair shell';
    this.userData = { accessory: 'hair', estimated: true, structure: 'surface-shell' };
    this.frustumCulled = false;
    this.renderOrder = 1;
  }

  dispose() {
    this.removeFromParent();
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}
