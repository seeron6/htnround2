import * as THREE from 'three';

// A smooth independent dome avoids inheriting the Object Capture cut plane.
// Photo-guided fibers are layered over it for strand-scale detail.
export class HeadHairCap extends THREE.Mesh {
  constructor(source, spec = {}) {
    const segments = 72,
      rings = 15,
      // The photographed side silhouette reaches slightly beyond the old
      // shell at the temple and rear crown. Keep the cap inside the source
      // head, but carry it far enough laterally that skin cannot peek through
      // the hair at three-quarter and back angles.
      rx = 0.114,
      rz = 0.174,
      // Put the open rim inside the photographed scalp. The shell should
      // emerge through the hairline instead of leaving a floating dark band.
      centerY = 0.005,
      centerZ = -0.105,
      height = (spec.capHeightMm ?? 18) * 0.001;
    const positions = [],
      uvs = [],
      colors = [],
      indices = [];
    const color = new THREE.Color();
    for (let r = 0; r <= rings; r++) {
      const phi = (r / rings) * Math.PI * 0.5,
        sinPhi = Math.sin(phi),
        cosPhi = Math.cos(phi);
      for (let j = 0; j <= segments; j++) {
        const theta = (j / segments) * Math.PI * 2,
          // Give the broad shell the same low-frequency grouping visible in
          // the captured quiff. The photographic map supplies the fine
          // strands; this relief keeps the silhouette from reading as a
          // smooth helmet at profile and rear angles.
          clump = 1 + 0.05 * Math.sin(theta * 7.0 + r * 0.85),
          // Keep the crown full while retaining a gentle nape taper. The
          // former 0.52 rim collapsed the side shell and exposed a skin
          // wedge behind the ear in the rear review.
          taper = 0.68 + 0.32 * cosPhi,
          ridge =
            (0.00065 + 0.0027 * (0.5 + 0.5 * Math.sin(theta * 10.0 + r * 1.35))) *
            sinPhi ** 1.35,
          x = rx * sinPhi * taper * Math.cos(theta) * clump + Math.cos(theta) * ridge,
          z =
            centerZ +
            rz * sinPhi * taper * Math.sin(theta) * clump +
            Math.sin(theta) * ridge,
          posterior = THREE.MathUtils.smoothstep(-z, 0.03, 0.18),
          y =
            centerY +
            (0.15 + height * 0.2) * cosPhi +
            height * 0.8 * cosPhi ** 2 +
            ridge * 0.18 * cosPhi -
            // Carry the posterior shell down over the photographed cut
            // plane; the front fades out before this drop is visible.
            0.032 * posterior * sinPhi ** 1.4 +
            // Lift the center of the rear nape into a shallow arch. This
            // removes the horizontal lower edge that made the back read as
            // a cut rectangular cap while keeping the sideburn transition
            // anchored to the photographed scalp.
            0.009 * posterior * Math.max(0, -Math.sin(theta)) * sinPhi ** 1.8;
        positions.push(x, y, z);
        uvs.push(
          THREE.MathUtils.clamp(0.5 + x / 0.23, 0.02, 0.98),
          THREE.MathUtils.clamp(0.5 + (z + 0.12) / 0.28, 0.02, 0.98),
        );
        const variation = 0.78 + 0.16 * Math.sin(x * 83 + z * 57 + y * 41),
          // Fade the shell into the observed front quiff so the posterior
          // lift does not leave a hard synthetic hairline band.
          // Let the photographed nape carry the lower edge. A continuous
          // vertical fade prevents a single posterior cap triangle from
          // reading as a detached dark patch behind the ear in profile.
          alpha =
            (1 - THREE.MathUtils.smoothstep(z, -0.1, -0.035)) *
            THREE.MathUtils.smoothstep(y, 0.0, 0.03) *
            THREE.MathUtils.smoothstep(rings - r, 0, 3);
        color.setRGB(variation, variation * 0.96, variation * 0.92);
        colors.push(color.r, color.g, color.b, alpha);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let j = 0; j < segments; j++) {
        const a = r * (segments + 1) + j,
          b = a + 1,
          c = a + segments + 1,
          d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshPhysicalMaterial({
      // A slightly lifted brown lets the photographed swirl texture catch
      // broad highlights instead of collapsing the posterior into a black
      // helmet under the neutral studio light.
      color: 0xb0a39a,
      vertexColors: true,
      transparent: true,
      // The shell sits just above the photographed scalp. Writing its depth
      // keeps the lower rear rim from blending through the skin at profile
      // angles, while the explicit render order preserves the faded hairline.
      depthWrite: true,
      roughness: 0.52,
      metalness: 0,
      specularIntensity: 0.42,
      anisotropy: 0.5,
      anisotropyRotation: Math.PI * 0.12,
      clearcoat: 0.2,
      clearcoatRoughness: 0.2,
      side: THREE.DoubleSide,
    });
    const texture = new THREE.TextureLoader().load(
      '/textures/crown-hair-generated.png',
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    material.map = texture;
    super(geometry, material);
    this.name = 'Independent photographic hair cap';
    this.userData = { accessory: 'hair', estimated: true, structure: 'separate-shell' };
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
