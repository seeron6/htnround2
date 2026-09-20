import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function validatePhotoCurves(guides, count) {
  const segments = guides?.segments;
  if (!Number.isInteger(segments) || segments < 4 || segments > 32)
    throw new Error('Invalid photographic hair segments.');
  const size = count * (segments + 1) * 3;
  if (
    guides.curveOffsets?.length !== size ||
    guides.curveNormals?.length !== size ||
    !guides.curveOffsets.every((v) => Number.isFinite(v) && Math.abs(v) < 0.5) ||
    !guides.curveNormals.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.001)
  )
    throw new Error('Invalid photographic hair curves.');
  if (
    guides.curveColors &&
    (guides.curveColors.length !== size ||
      !guides.curveColors.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
  )
    throw new Error('Invalid photographic hair colors.');
}

// Three fine fibers share each observed lock's shape, with coherent clumping
// and small independent flyaways. No camera-facing cards or random grass tufts.
export function photoStrandGeometry(source, spec, p) {
  p = { ...p };
  for (const [name, fallback] of Object.entries({
    density: 0.8,
    frizz: 0.15,
    curlTightness: 0.3,
    lengthMm: 75,
    clumpSizeMm: 8,
    rootLiftMm: 3,
    curlRadiusMm: 8,
  }))
    if (!Number.isFinite(p[name])) p[name] = fallback;
  const guides = spec.photoGuides,
    segments = guides.segments,
    sides = 3,
    children = 3;
  const src = source.attributes.position.array,
    sn = source.attributes.normal.array;
  const count = Math.floor(
    (spec.rootTriangles.length / 3) * clamp(p.density ?? 0.8, 0, 1),
  );
  const max = count * children * (segments + 1) * sides;
  const positions = new Float32Array(max * 3),
    normals = new Float32Array(max * 3),
    colors = new Float32Array(max * 3),
    uv = new Float32Array(max * 2);
  const indices = new Uint32Array(count * children * segments * sides * 6),
    roots = [];
  const rand = random(spec.seed ?? 42),
    root = new THREE.Vector3(),
    normal = new THREE.Vector3();
  const axis = new THREE.Vector3(),
    across = new THREE.Vector3(),
    up = new THREE.Vector3(),
    point = new THREE.Vector3(),
    radial = new THREE.Vector3();
  const color = new THREE.Color(),
    curve = Array.from({ length: segments + 1 }, () => new THREE.Vector3());
  const cn = curve.map(() => new THREE.Vector3());
  const frizz = clamp(p.frizz ?? 0.15, 0, 1),
    curl = clamp(p.curlTightness ?? 0.3, 0, 1);
  const reference = guides.referenceLengthMm ?? p.lengthMm;
  const lengthScale = clamp((p.lengthMm ?? 75) / Math.max(reference, 1), 0.35, 1.6);
  let vertex = 0,
    index = 0;
  for (let i = 0; i < count; i++) {
    root.set(0, 0, 0);
    normal.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const id = spec.rootTriangles[i * 3 + k] * 3,
        w = spec.rootWeights[i * 3 + k];
      point.fromArray(src, id);
      root.addScaledVector(point, w);
      point.fromArray(sn, id);
      normal.addScaledVector(point, w);
    }
    normal.normalize();
    // The rear video views carry reliable roots but several tracked locks end
    // after only a few millimetres. Leaving those guide curves at their
    // observed length exposes a bald posterior slab in neutral and profile
    // views. Extend only those short, rear-facing locks along their recorded
    // direction; the bound root still follows the deformable head.
    let guideLength = 0;
    for (let j = 1; j <= segments; j++) {
      const a = (i * (segments + 1) + j - 1) * 3,
        b = (i * (segments + 1) + j) * 3;
      guideLength += Math.hypot(
        guides.curveOffsets[b] - guides.curveOffsets[a],
        guides.curveOffsets[b + 1] - guides.curveOffsets[a + 1],
        guides.curveOffsets[b + 2] - guides.curveOffsets[a + 2],
      );
    }
    const posteriorCompletion =
      root.z < -0.12 && guideLength < 0.014
        ? clamp(1.9 + (0.014 - guideLength) * 40, 1.9, 2.45)
        : 1;
    const posteriorDrop = posteriorCompletion > 1 ? 0.012 : 0;
    const top = clamp((root.y - spec.hairlineY + 0.025) / 0.065, 0, 1);
    // Continuous spatial phase keeps neighboring fibers in locks, avoiding
    // checkerboard-sized chunks and synchronized identical sine waves.
    const clump = clamp(p.clumpSizeMm ?? 8, 1, 14) * 0.001;
    const phase =
      Math.sin((root.x / clump) * 1.4 + (root.z / clump) * 0.8) * 2.3 +
      (root.z / clump) * 1.2;
    const observedOnly = guides.observedOnly;
    const conformed = guides.surfaceConformed === true;
    const relief =
      (conformed ? 0.00024 : observedOnly ? 0.00012 : 0.00035) +
      clamp(p.rootLiftMm ?? 3, 0, 12) *
        (conformed ? 0.00014 : observedOnly ? 0.000035 : 0.00022) *
        (0.35 + 0.65 * top);
    const start = vertex;
    for (let child = 0; child < children; child++) {
      const fly = rand() < frizz * (observedOnly ? 0.035 : 0.22),
        phaseJitter = (rand() - 0.5) * 0.35,
        spacing =
          (child - 1) *
          (conformed ? 0.0001 + rand() * 0.00007 : 0.00007 + rand() * 0.00004);
      const radius = observedOnly
        ? // The old 24–42 µm fibers were visible only as texture at the
          // rear review scale. The source locks are thick enough to support
          // a slightly fuller strand radius while remaining hair-like.
          0.00004 + rand() * 0.000028
        : 0.000045 + rand() * 0.000035;
      const variation = observedOnly ? 0.96 + rand() * 0.08 : 0.72 + rand() * 0.44;
      color.setRGB(
        ...guides.colors.slice(i * 3, i * 3 + 3).map((v) => clamp(v * variation, 0, 1)),
        THREE.SRGBColorSpace,
      );
      for (let j = 0; j <= segments; j++) {
        const at = (i * (segments + 1) + j) * 3,
          t = j / segments,
          envelope = Math.sin(Math.PI * t);
        const q = curve[j]
          .fromArray(guides.curveOffsets, at)
          .multiplyScalar(lengthScale * posteriorCompletion)
          .add(root);
        cn[j].fromArray(guides.curveNormals, at).normalize();
        const prev = Math.max(0, j - 1),
          next = Math.min(segments, j + 1);
        axis.fromArray(guides.curveOffsets, (i * (segments + 1) + next) * 3);
        point.fromArray(guides.curveOffsets, (i * (segments + 1) + prev) * 3);
        axis.sub(point);
        if (axis.lengthSq() < 1e-12) axis.fromArray(guides.directions, i * 3);
        axis.normalize();
        across.crossVectors(axis, cn[j]).normalize();
        // Offsets already follow the recorded broad S waves. Only unresolved
        // fiber-scale variation is synthesized here, never the whole haircut.
        const wave = Math.sin(t * Math.PI * 2 + phase + phaseJitter);
        const lateral = observedOnly
          ? 0
          : wave * clamp(p.curlRadiusMm ?? 8, 0.3, 25) * 0.00009 * curl * envelope;
        const fuzz =
          Math.sin(t * 26 + phase + child) *
          (observedOnly ? 0.000045 : 0.00022) *
          frizz *
          envelope;
        q.addScaledVector(across, spacing + lateral + fuzz);
        if (posteriorCompletion > 1) {
          // Short tapered back hair falls toward the nape instead of pointing
          // straight out from the occiput. Keep the drop bounded so it cannot
          // cross the neck or the independent temple arms.
          q.y -= posteriorDrop * t * t;
          q.addScaledVector(normal, 0.00018 * envelope);
        }
        q.addScaledVector(
          cn[j],
          0.00007 +
            envelope *
              (relief * (observedOnly ? 1 : 0.65 + 0.35 * wave) + (fly ? 0.0007 : 0)),
        );
      }
      const first = vertex;
      for (let j = 0; j <= segments; j++) {
        axis.copy(curve[Math.min(segments, j + 1)]).sub(curve[Math.max(0, j - 1)]);
        if (axis.lengthSq() < 1e-12) axis.fromArray(guides.directions, i * 3);
        axis.normalize();
        across.crossVectors(axis, cn[j]).normalize();
        up.crossVectors(across, axis).normalize();
        const t = j / segments,
          taper = Math.pow(Math.sin(Math.PI * t), 0.25) * 0.8 + 0.08;
        // Very slight root darkening gives depth without baking hard stripes.
        const shade = observedOnly ? 1 : 0.8 + 0.2 * Math.sin(Math.PI * t);
        if (guides.curveColors)
          color.setRGB(
            ...guides.curveColors
              .slice((i * (segments + 1) + j) * 3, (i * (segments + 1) + j) * 3 + 3)
              .map((v) => clamp(v * variation, 0, 1)),
            THREE.SRGBColorSpace,
          );
        for (let s = 0; s < sides; s++) {
          const theta = (s / sides) * Math.PI * 2;
          radial
            .copy(across)
            .multiplyScalar(Math.cos(theta))
            .addScaledVector(up, Math.sin(theta));
          point
            .copy(curve[j])
            .addScaledVector(radial, radius * taper)
            .toArray(positions, vertex * 3);
          radial.toArray(normals, vertex * 3);
          colors.set([color.r * shade, color.g * shade, color.b * shade], vertex * 3);
          uv.set([s / sides, t], vertex * 2);
          if (j < segments) {
            const a = first + j * sides + s,
              b = first + j * sides + ((s + 1) % sides);
            indices.set([a, b, a + sides, b, b + sides, a + sides], index);
            index += 6;
          }
          vertex++;
        }
      }
    }
    roots.push({
      root: root.clone(),
      normal: normal.clone(),
      sourceIndex: i,
      start,
      count: vertex - start,
    });
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, array, size] of [
    ['position', positions, 3],
    ['normal', normals, 3],
    ['color', colors, 3],
    ['uv', uv, 2],
  ])
    geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return { geometry, roots, strandCount: count * children };
}

// The saved video guides are strongest around the quiff and temples. Build a
// small, surface-bound completion for the short rear guides so the posterior
// silhouette remains covered when the head is rotated away from the camera.
// This samples only the independent reconstructed head; it never uses Meshy
// geometry or camera-facing cards.
export function posteriorCompletionGeometry(source, spec, p = {}) {
  const position = source.attributes.position.array,
    normal = source.attributes.normal.array,
    index =
      source.index?.array ??
      Uint32Array.from({ length: position.length / 3 }, (_, i) => i),
    candidates = new Map();
  for (let f = 0; f < index.length; f += 3) {
    const ids = [index[f], index[f + 1], index[f + 2]],
      centroid = [0, 0, 0],
      faceNormal = [0, 0, 0];
    for (const id of ids) {
      for (let a = 0; a < 3; a++) centroid[a] += position[id * 3 + a] / 3;
      for (let a = 0; a < 3; a++) faceNormal[a] += normal[id * 3 + a] / 3;
    }
    // Rear scalp only: keep the visible temples and face governed by the
    // observed guides and avoid putting fibers across the ear/neck boundary.
    if (
      centroid[2] > -0.105 ||
      centroid[1] < -0.012 ||
      centroid[1] > 0.125 ||
      faceNormal[2] > -0.08
    )
      continue;
    const key = [
      Math.round((centroid[0] + 0.12) / 0.02),
      Math.round((centroid[1] + 0.012) / 0.018),
      Math.round((centroid[2] + 0.27) / 0.03),
    ].join(':');
    // Prefer the triangle whose normal points most clearly out of the rear
    // surface. This keeps the completion from selecting cheek/ear triangles.
    const score = -faceNormal[2] + Math.max(0, faceNormal[1]) * 0.15;
    if (!candidates.has(key) || candidates.get(key).score < score)
      candidates.set(key, { ids, centroid, faceNormal, score });
  }
  const selected = [...candidates.values()];
  if (!selected.length) return { geometry: null, bindings: [], strandCount: 0 };
  const rand = random((spec.seed ?? 42) ^ 0x9e3779b9),
    density = clamp(p.posteriorDensity ?? 0.88, 0.25, 1),
    keep = selected.filter(() => rand() < density),
    segments = 12,
    sides = 3,
    children = 2,
    positions = [],
    normals = [],
    colors = [],
    uv = [],
    indices = [],
    bindings = [];
  const color = new THREE.Color(),
    root = new THREE.Vector3(),
    surfaceNormal = new THREE.Vector3(),
    tangent = new THREE.Vector3(),
    across = new THREE.Vector3(),
    up = new THREE.Vector3(),
    point = new THREE.Vector3();
  const rgb =
    p.colorSrgb?.length === 3 && p.colorSrgb.every(Number.isFinite)
      ? p.colorSrgb
      : spec.parameters?.colorSrgb?.length === 3
        ? spec.parameters.colorSrgb
        : [0.06, 0.05, 0.04];
  for (const [rootIndex, candidate] of keep.entries()) {
    root.set(...candidate.centroid);
    surfaceNormal.set(...candidate.faceNormal).normalize();
    tangent.set(0, -1, 0);
    tangent.addScaledVector(surfaceNormal, -tangent.dot(surfaceNormal));
    if (tangent.lengthSq() < 1e-6) tangent.set(0, 0, -1);
    tangent.normalize();
    across.crossVectors(tangent, surfaceNormal).normalize();
    const length =
      0.012 + 0.014 * clamp((root.y + 0.012) / 0.137, 0, 1) * (0.86 + rand() * 0.22);
    const start = positions.length / 3;
    bindings.push({
      ids: candidate.ids,
      weights: [1 / 3, 1 / 3, 1 / 3],
      root: root.clone(),
      normal: surfaceNormal.clone(),
      start,
      count: children * (segments + 1) * sides,
    });
    for (let child = 0; child < children; child++) {
      const phase = rand() * Math.PI * 2,
        radius = 0.000085 + rand() * 0.00004,
        childOffset = (child - 0.5) * 0.00016;
      color.setRGB(
        ...rgb.map((v) => clamp(v * (0.82 + rand() * 0.24), 0, 1)),
        THREE.SRGBColorSpace,
      );
      const first = positions.length / 3;
      for (let j = 0; j <= segments; j++) {
        const t = j / segments,
          envelope = Math.sin(Math.PI * t),
          bend = Math.sin(t * Math.PI + phase) * 0.0012 * envelope;
        point
          .copy(root)
          .addScaledVector(tangent, length * t)
          .addScaledVector(surfaceNormal, 0.00018 + 0.00055 * envelope)
          .addScaledVector(across, childOffset + bend);
        const axis = tangent.clone();
        up.crossVectors(across, axis).normalize();
        const radial = new THREE.Vector3();
        for (let side = 0; side < sides; side++) {
          const theta = (side / sides) * Math.PI * 2;
          radial
            .copy(across)
            .multiplyScalar(Math.cos(theta))
            .addScaledVector(up, Math.sin(theta));
          positions.push(
            ...point.clone().addScaledVector(radial, radius * (1 - t * 0.88)),
          );
          normals.push(...radial);
          colors.push(color.r, color.g, color.b);
          uv.push(side / sides, t);
          if (j < segments) {
            const a = first + j * sides + side,
              b = first + j * sides + ((side + 1) % sides);
            indices.push(a, b, a + sides, b, b + sides, a + sides);
          }
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return { geometry, bindings, strandCount: keep.length * children };
}
