// Fit the lip seam (src/lip-topology.js) to a head that is already in the scene.
//
// This is the one post-build step every head goes through, whichever engine
// made it: a Meshy GLB, a local-pipeline scan, an uploaded bust or a restored
// session all reach `fitMouth()` in src/main.js, and that calls in here. Nothing
// in this file touches the scene; it plans the new geometry and hands it back,
// so the caller can refuse it or swap it in as one step.

import * as THREE from 'three';
import {
  cutLips,
  extendVertexField,
  lastLipCutFailure,
  lipField,
  lipSeamFromRing,
  lipTopologyFits,
  NATIVE_MOUTH_SHADE_VERSION,
} from './lip-topology.js';

// How each cut geometry's appended vertices derive from the ones before them.
// Kept off `userData` on purpose: that is serialised into every saved session.
const lineage = new WeakMap();

/**
 * Work out a head's lip cut without changing anything.
 *
 * @param {object} input
 * @param {THREE.BufferGeometry} input.geometry  the simulated surface
 * @param {Float32Array} [input.rest]  its undeformed positions, if it is posed
 * @param {object|null} [input.atlas]  SurfaceAppearance atlas, when it has one
 * @param {object} input.detection  result of detectFaceOnMesh (src/lip-detect.js)
 * @returns {{geometry:THREE.BufferGeometry,atlas:object|null,parents:Float32Array,
 *   topology:object}|{refused:string}}
 */
export function planLipCut({ geometry, rest, atlas = null, detection }) {
  const anchors = detection?.anchors,
    seam = lipSeamFromRing(detection?.lipPolygon);
  if (!seam || !anchors?.[13] || !anchors?.[14] || !geometry?.index)
    return { refused: 'the detector found no lip line' };
  // A geometry that was cut before and then altered must not be cut again: the
  // new lip line would run a millimetre beside the old one.
  if (geometry.userData?.lipTopology) return { refused: 'already cut' };
  const corners = mouthCorners(anchors);
  if (!corners) return { refused: 'the mouth corners missed the surface' };
  const [left, right] = corners,
    width = Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]),
    centre = mouthCentre(anchors, width);
  const point = new THREE.Vector3();
  const attributes = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (name === 'position' || name === 'normal') continue;
    if (attribute.isInterleavedBufferAttribute)
      return { refused: 'interleaved attributes' };
    attributes[name] = { itemSize: attribute.itemSize, array: attribute.array };
  }
  const result = cutLips({
    positions: rest ?? geometry.attributes.position.array,
    indices: geometry.index.array,
    atlas,
    attributes,
    project: (x, y, z) => detection.project(point.set(x, y, z)),
    seam,
    centre,
    width,
  });
  if (!result) return { refused: lastLipCutFailure() || 'no clean seam' };
  // Lips the mesh already had: nothing to swap in, only things to know. The one
  // change it can carry is a shorter face list, where skin bridged the two lips.
  if (result.topology.native)
    return {
      native: true,
      topology: result.topology,
      indices: result.topology.removedTriangles ? result.indices : null,
      atlas: result.topology.removedTriangles ? result.atlas : null,
    };

  const next = new THREE.BufferGeometry();
  next.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
  for (const [name, attribute] of Object.entries(result.attributes))
    next.setAttribute(
      name,
      new THREE.BufferAttribute(attribute.array, attribute.itemSize),
    );
  shadeMouth(next, result.topology.shade);
  next.setIndex(new THREE.BufferAttribute(result.indices, 1));
  next.computeVertexNormals();
  next.userData = { ...geometry.userData, lipTopology: result.topology };
  delete next.userData.mouthAperture;
  lineage.set(next, result.parents);
  return {
    geometry: next,
    // SurfaceAppearance builds its own render geometry and shades it from this.
    atlas: result.atlas && { ...result.atlas, shade: result.topology.shade },
    parents: result.parents,
    topology: result.topology,
  };
}

/**
 * The two mouth corners, on the surface. An anchor is a landmark raycast onto the
 * mesh, and a ray aimed at the very corner of a mouth can slip past it: on the
 * reference head one lands 8 cm behind the face, which doubles the measured width
 * of the mouth and mis-sizes everything cut from it. A corner cannot be further
 * behind the middle of the lips than it is to the side of it, so one that is gets
 * replaced: by the outer-lip corner beside it, else by its mirror image.
 */
function mouthCorners(anchors) {
  const upper = anchors[13],
    lower = anchors[14],
    middle = upper[2] > lower[2] ? upper : lower;
  const sound = (corner) =>
    corner &&
    Math.abs(corner[2] - middle[2]) <
      1.2 * Math.hypot(corner[0] - middle[0], corner[1] - middle[1]);
  let left = [anchors[78], anchors[61]].find(sound),
    right = [anchors[308], anchors[291]].find(sound);
  const mirror = (corner) => [2 * middle[0] - corner[0], corner[1], corner[2]];
  if (!left && right) left = mirror(right);
  if (!right && left) right = mirror(left);
  return left && right ? [left, right] : null;
}

/**
 * The middle of the lip line, on the surface. Anchors are landmarks raycast onto
 * the mesh, and on a head whose lips are already parted the ray through a lip
 * landmark can pass between them and land on the back of the skull, 12 cm away.
 * The nearer of the two lip anchors is then the only one that is on the lips.
 */
function mouthCentre(anchors, width) {
  const upper = anchors[13],
    lower = anchors[14];
  if (Math.abs(upper[2] - lower[2]) < width * 0.3)
    return upper.map((v, i) => (v + lower[i]) / 2);
  return [...(upper[2] > lower[2] ? upper : lower)];
}

/**
 * Anchors with that fault repaired, for the rigs: the lip anchor that fell through
 * the mouth is put back beside the one that did not.
 */
export function soundAnchors(anchors) {
  const upper = anchors?.[13],
    lower = anchors?.[14];
  if (!upper || !lower || Math.abs(upper[2] - lower[2]) < 0.02) return anchors;
  const front = upper[2] > lower[2] ? upper : lower,
    gap = 0.001;
  return {
    ...anchors,
    13: [front[0], front[1] + (front === lower ? gap : 0), front[2]],
    14: [front[0], front[1] - (front === upper ? gap : 0), front[2]],
  };
}

/**
 * Whether a detection is a face, or the landmarker seeing one in a blob.
 *
 * The landmarker answers with a complete, well-proportioned face whenever it
 * answers at all, so nothing about the landmarks themselves gives a false one
 * away. Two things do. A real face is found again when the camera moves in on it
 * (`framing: 'face'`, the detector's second pass); and on a real face the nose tip
 * stands well in front of the eyes once the landmarks are dropped onto the mesh.
 * Measured on three Meshy heads: 0.50 and 0.32 interocular distances on the two
 * real faces, -0.24 on the neck stump of a head Meshy delivered lying on its back,
 * which the first pass took for a face and the second did not confirm.
 */
export function trustedDetection(detection) {
  const a = detection?.anchors;
  if (!a?.[1] || !a[159] || !a[386]) return false;
  if (detection.framing !== 'face' && detection.framing !== 'cage') return false;
  const interocular = Math.hypot(
    a[159][0] - a[386][0],
    a[159][1] - a[386][1],
    a[159][2] - a[386][2],
  );
  // Mesh space looks down +z: that is the axis the detector's camera sits on.
  return a[1][2] - (a[159][2] + a[386][2]) / 2 > interocular * 0.12;
}

// MediaPipe's inner-lip ring in the order src/lip-detect.js reports it, and the
// landmarks it raycasts into anchors.
const INNER_LIP = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88,
  95,
];
const CAGE_ANCHORS = [1, 13, 14, 50, 61, 78, 152, 159, 280, 291, 308, 386];

/**
 * A stand-in for the detector on a head that carries its own landmarks. A
 * local-pipeline scan's physics cage is the 468 MediaPipe landmarks triangulated
 * from the real photographs, and they are the head's first 468 vertices, so its
 * lip line is known even when a render of it shows the landmarker no face.
 */
export function detectionFromCage(cage) {
  const p = cage?.positions;
  if (!p || p.length !== 468 * 3) return null;
  return {
    anchors: Object.fromEntries(
      CAGE_ANCHORS.map((i) => [i, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]]),
    ),
    lipPolygon: INNER_LIP.map((i) => ({ x: p[i * 3], y: p[i * 3 + 1] })),
    // The head's own frame: x across the face, y up, looking down +z.
    project: (point) => ({ x: point.x, y: point.y }),
    framing: 'cage',
  };
}

/**
 * Darken the inside of the mouth. It is drawn with the lips' own texture (or, in
 * a template's mouth bag, with nothing at all) and darkened with depth through
 * vertex colour, which multiplies whatever the material draws. Call once.
 */
export function shadeMouth(geometry, shade) {
  if (!shade?.vertices?.length) return;
  let color = geometry.attributes.color;
  if (!color) {
    const count = geometry.attributes.position.count;
    color = new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3);
    geometry.setAttribute('color', color);
  }
  shade.vertices.forEach((v, i) => {
    for (let k = 0; k < 3; k++) color.array[v * color.itemSize + k] *= shade.values[i];
  });
  color.needsUpdate = true;
}

/** Remove obsolete native-mouth shading before detecting and fitting again.
 * A saved session includes both the multiplied vertex colours and the old
 * labels. Merely updating the classifier otherwise leaves that dark patch in
 * place forever. Native adoption never altered the surface or its UVs.
 */
export function clearLegacyMouthShading(geometry, appearance = null) {
  const topology = lipTopologyOf(geometry);
  if (!topology?.native || topology.shadeVersion === NATIVE_MOUTH_SHADE_VERSION)
    return false;
  const color = geometry.attributes.color;
  if (color && topology.shade) {
    const restored = new Set();
    topology.shade.vertices.forEach((vertex, i) => {
      const multiplier = topology.shade.values[i];
      if (
        !Number.isInteger(vertex) ||
        vertex < 0 ||
        vertex >= color.count ||
        !Number.isFinite(multiplier) ||
        multiplier <= 0 ||
        multiplier > 1 ||
        restored.has(vertex)
      )
        return;
      restored.add(vertex);
      color.setXYZ(
        vertex,
        color.getX(vertex) / multiplier,
        color.getY(vertex) / multiplier,
        color.getZ(vertex) / multiplier,
      );
    });
    color.needsUpdate = true;
  }
  appearance?.shadeMouth(null);
  delete geometry.userData.lipTopology;
  return true;
}

/** The topology a geometry carries, if it still describes that geometry. */
export function lipTopologyOf(geometry) {
  const topology = geometry?.userData?.lipTopology;
  return lipTopologyFits(topology, geometry?.attributes?.position?.count)
    ? topology
    : null;
}

/** Carry a per-vertex xyz field (rest shape, permanent damage) onto a cut head. */
export function growVertexField(field, parents, { offset = false } = {}) {
  return extendVertexField(field, 3, parents, { blend: true, offset });
}

/**
 * A Newton cage binding for a head whose lips were cut after it was built. Each
 * new vertex is bound exactly as the vertex it was split from, which is right
 * for a field as smooth as the cage's, and keeps the two lips bound alike.
 */
export function growBinding(binding, geometry, parents = lineage.get(geometry)) {
  const count = geometry?.attributes?.position?.count;
  if (!binding || !parents || binding.active.length === count) return binding;
  if (binding.active.length + parents.length / 6 !== count) return binding;
  const grow = (field, size) =>
    extendVertexField(field, size, parents, { blend: false });
  return {
    ...binding,
    indices: grow(binding.indices, 3),
    weights: grow(binding.weights, 3),
    active: grow(binding.active, 1),
  };
}

/** Where the mouth is and how big, for whatever sits behind the lips. */
export function lipOpening(rest, topology) {
  const field = lipField(rest, topology);
  if (!field) return null;
  return { centre: field.centre, width: field.width, height: field.width * 0.3 };
}
