import * as THREE from 'three';

// Build a separate hair shell from the independent head surface. The shell is
// a continuous duplicate of the measured surface with a bounded scalp volume
// offset; it never changes the face mesh and remains a disposable accessory.
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
    guideVertices = new Set(spec.rootTriangles ?? []),
    positions = [],
    normals = [],
    colors = [],
    uv = [],
    indices = Array.from(index),
    color = new THREE.Color();
  // Offset every source vertex, including the non-hair face vertices. Keeping
  // one continuous topology prevents the isolated scalp islands and z-fighting
  // that appeared when only selected scalp triangles were duplicated.
  for (let id = 0; id < position.count; id++) {
    const x = component(position, id, 0),
      y = component(position, id, 1),
      z = component(position, id, 2),
      nx = component(normal, id, 0),
      ny = component(normal, id, 1),
      nz = component(normal, id, 2),
      topBand = THREE.MathUtils.clamp((y - (hairline - 0.045)) / 0.095, 0, 1),
      frontGate = THREE.MathUtils.clamp((0.026 - z) / 0.052, 0, 1),
      topLift = topBand * frontGate,
      rearBand = THREE.MathUtils.clamp((-z - 0.045) / 0.19, 0, 1),
      rearHeight = THREE.MathUtils.clamp((y + 0.09) / 0.2, 0, 1),
      rearLift = rearBand * rearHeight,
      rootLift = guideVertices.has(id) ? 0.18 : 0,
      scalp = THREE.MathUtils.clamp(Math.max(topLift, rearLift, rootLift), 0, 1),
      // Hair volume is strongest over the crown and occiput and fades smoothly
      // through the photographed hairline, leaving the forehead and face shape
      // on the measured surface.
      lift = 0.0008 + scalp * (0.004 + 0.011 * topLift + 0.009 * rearLift),
      radialX = x / 0.112,
      radialZ = (z + 0.13) / 0.15,
      radialLength = Math.hypot(radialX, radialZ) || 1,
      radialLift = scalp * (0.0025 + 0.009 * Math.max(topLift, rearLift));
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
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  // Recompute normals after the offset so the independent shell shades as one
  // continuous surface instead of inheriting tiny source-face discontinuities.
  geometry.computeVertexNormals();
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
    this.traverse((child) => {
      if (child === this || !child.isMesh) return;
      child.geometry?.dispose();
      child.material?.map?.dispose();
      child.material?.dispose();
    });
  }
}
