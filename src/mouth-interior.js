// Teeth and a tongue, for a mouth that can open.
//
// Built for every head whose lips have a seam (src/lip-topology.js), whichever
// engine made it: a Meshy head that was cut and a local-pipeline head whose own
// lips were adopted get the same mouth. It is sized and placed from the lip line
// of that head, so there is nothing to author per head and nothing to save: it is
// rebuilt whenever the head is loaded.
//
// They are separate meshes rather than more of the head's surface, for two
// reasons. A head draws its skin with a photograph, and no texel of a photograph
// of a closed mouth is the colour of a tooth. And an adopted head must not change
// its vertex count, or its Newton binding no longer fits.
//
// What keeps separate meshes honest is how they move:
//
//   the jaw     The lower teeth and the tongue swing on the speech rig's own hinge
//               by its own angle (`FaceDynamics.jawSwing`), using the same small-
//               angle form the rig's open shape is built from, so they stay put
//               behind the lower lip at any opening. The upper teeth belong to the
//               skull and do not move with speech at all.
//   a punch     Rigid teeth behind lips that a fist has just pushed in a centimetre
//               would burst through them. Each tooth rides the contact displacement
//               of the lip skin in front of it (the solver's and the impact rig's,
//               never the pose or speech), so it gives way with the lip.
//   the light   A mouth is dark until it opens. The enamel and the tongue are dimmed
//               by how far the lips are parted, which also keeps an adopted head's
//               millimetre of resting lip gap from showing a white line.

import * as THREE from 'three';
import { lipField } from './lip-topology.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Everything below is in mouth widths, so every mouth gets teeth that fit it.
// One side of each arch from the midline out: width along the arch, crown height,
// thickness front to back, and how chisel-edged the crown is (1 an incisor, 0 a
// molar). Proportions are ordinary adult dentition over a 50 mm mouth.
const UPPER = [
  [0.172, 0.21, 0.12, 1],
  [0.132, 0.18, 0.11, 0.9],
  [0.152, 0.2, 0.14, 0.45],
  [0.14, 0.16, 0.16, 0.1],
  [0.136, 0.15, 0.16, 0],
  [0.2, 0.14, 0.2, 0],
];
const LOWER = [
  [0.108, 0.17, 0.1, 1],
  [0.118, 0.17, 0.1, 0.9],
  [0.138, 0.19, 0.13, 0.45],
  [0.14, 0.15, 0.15, 0.1],
  [0.14, 0.14, 0.16, 0],
  [0.2, 0.13, 0.2, 0],
];
const GAP = 0.004, // between neighbouring teeth
  ARCH_CURVE = 0.3, // how far back the arch is at the width of the mouth corners
  UPPER_FRONT = 0.095, // incisors' front face behind the lip surface
  LOWER_FRONT = 0.125, // the lower arch sits inside the upper one
  LOWER_SCALE = 0.94,
  UPPER_TIP = -0.04, // upper incisors end just below the lip line...
  LOWER_TIP = -0.03, // ...and overlap the lower ones, which end just above that
  CLEARANCE = 0.012, // teeth stay this far behind whatever is in front of them
  TONGUE = { width: 0.6, height: 0.2, length: 0.5, top: -0.06, front: 0.27 };

// Linear-light albedos, chosen against this app's studio lighting (a 2.7
// hemisphere light and three directional lights through ACES): an ordinary
// "tooth white" comes out of that as a flat, clipped white with no form left in
// it, and a mid pink as salmon. A mouth is also lit only through its opening.
const ENAMEL = new THREE.Color().setRGB(0.6, 0.57, 0.5),
  TONGUE_PINK = new THREE.Color().setRGB(0.27, 0.06, 0.075);

/** A crown: a rounded block, narrower at the root, thinned to an edge if `chisel`. */
function crown(chisel) {
  const geometry = new THREE.SphereGeometry(0.5, 12, 10),
    position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    let x = position.getX(i),
      y = position.getY(i),
      z = position.getZ(i);
    // A sphere pushed out towards the box around it: flat faces, round edges.
    const length = Math.hypot(x, y, z) || 1,
      box = (Math.abs(x) ** 4 + Math.abs(y) ** 4 + Math.abs(z) ** 4) ** 0.25 || 1,
      grow = length / box;
    x *= grow;
    y *= grow;
    z *= grow;
    // The biting edge is at -y, the root at +y.
    const towardsRoot = y + 0.5;
    x *= 1 - 0.16 * towardsRoot;
    z *=
      (1 - 0.1 * towardsRoot) * (1 - chisel * 0.55 * (1 - smooth(0, 0.7, towardsRoot)));
    position.setXYZ(i, x, y, z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function tongueShape() {
  const geometry = new THREE.SphereGeometry(0.5, 24, 16),
    position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    let x = position.getX(i),
      y = position.getY(i);
    const z = position.getZ(i);
    if (y < 0) y *= 0.55; // flat underneath
    if (z > 0) x *= 1 - 0.4 * (z / 0.5) ** 2; // narrowing to the tip
    // The groove down the middle, fading out towards the tip.
    if (y > 0) y -= 0.07 * Math.exp(-((x / 0.13) ** 2)) * (1 - smooth(0.2, 0.5, z));
    position.setXYZ(i, x, y, z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Where the dental arch is, `along` it from the midline: x across, z behind. */
function archPoint(along, curve) {
  // Walk the parabola z = -curve * (x / 0.5)^2 by arc length.
  let x = 0,
    travelled = 0;
  const step = 0.002;
  while (travelled < along && x < 1.2) {
    const slope = (-2 * curve * (x + step / 2)) / 0.25;
    travelled += step * Math.hypot(1, slope);
    x += step;
  }
  return { x, z: -curve * (x / 0.5) ** 2, slope: (-2 * curve * x) / 0.25 };
}

export class MouthInterior extends THREE.Group {
  /**
   * @param {object} input
   * @param {Float32Array} input.rest   the head's undeformed vertices
   * @param {ArrayLike<number>} input.indices  its faces
   * @param {object} input.topology     its lip seam (geometry.userData.lipTopology)
   * @returns {MouthInterior|null} null for a head without a usable lip seam
   */
  static build({ rest, indices, topology }) {
    const lips = lipField(rest, topology);
    return lips ? new MouthInterior(rest, indices, topology, lips) : null;
  }

  constructor(rest, indices, topology, lips) {
    super();
    this.name = 'Teeth and tongue';
    this.userData.accessory = 'mouth-interior';
    this.topology = topology;
    this.width = lips.width;
    this.centre = lips.centre;
    const W = lips.width;
    // The mouth's own frame: x from corner to corner, y up, z out of the face.
    this.position.fromArray(lips.centre);
    const across = lips.axis[0] >= 0 ? lips.axis : lips.axis.map((v) => -v);
    this.rotation.z = Math.atan2(across[1], across[0]);

    this.enamel = new THREE.MeshStandardMaterial({
      color: ENAMEL.clone(),
      roughness: 0.3,
      metalness: 0,
    });
    this.flesh = new THREE.MeshStandardMaterial({
      color: TONGUE_PINK.clone(),
      roughness: 0.55,
      metalness: 0,
    });
    this.shapes = new Map();
    const shape = (chisel) => {
      if (!this.shapes.has(chisel)) this.shapes.set(chisel, crown(chisel));
      return this.shapes.get(chisel);
    };

    // Only what is near the mouth can be in a tooth's way.
    const near = nearbyFaces(rest, indices, lips.centre, W * 1.1);
    const upperSkin = topology.upper,
      lowerSkin = topology.lower;

    this.riders = [];
    const stand = (arch, { lower }) => {
      let along = 0;
      arch.forEach(([width, height, depth, chisel], n) => {
        const scale = lower ? LOWER_SCALE : 1;
        along += (n ? GAP : 0) + (width * scale) / 2;
        const at = archPoint(along, ARCH_CURVE);
        along += (width * scale) / 2;
        for (const side of [-1, 1]) {
          // Its own material, so it can be as dark as its place in the mouth: see
          // `corridor` in _rider.
          const tooth = new THREE.Mesh(shape(chisel), this.enamel.clone());
          tooth.scale.set(width * scale * W, height * W * (lower ? -1 : 1), depth * W);
          const front = lower ? LOWER_FRONT : UPPER_FRONT,
            tip = lower ? LOWER_TIP : UPPER_TIP;
          tooth.position.set(
            side * at.x * scale * W,
            (tip + (lower ? -height / 2 : height / 2)) * W,
            (at.z * scale - front - depth / 2) * W,
          );
          tooth.rotation.y = -side * Math.atan(at.slope);
          this.add(tooth);
          this.riders.push(
            this._rider(tooth, lower, lower ? lowerSkin : upperSkin, rest),
          );
        }
      });
    };
    stand(UPPER, { lower: false });
    stand(LOWER, { lower: true });

    const tongue = new THREE.Mesh(tongueShape(), this.flesh);
    tongue.scale.set(TONGUE.width * W, TONGUE.height * W, TONGUE.length * W);
    tongue.position.set(
      0,
      (TONGUE.top - TONGUE.height / 2) * W,
      -(TONGUE.front + TONGUE.length / 2) * W,
    );
    this.add(tongue);
    this.tongue = tongue;
    this.riders.push(this._rider(tongue, true, lowerSkin, rest));

    this._tuckBehindLips(rest, near);
    for (const rider of this.riders) rider.home.copy(rider.mesh.position);
    // An adopted head's lips rest a little apart; a cut head's rest shut.
    this.restingGap = restingGap(rest, topology, lips);
    this.update({});
  }

  /** How a mesh follows the head: which lip skin it rides, and whether the jaw. */
  _rider(mesh, lower, skin, rest) {
    // The three lip vertices nearest the front of the mesh carry it.
    const front = mesh.position
      .clone()
      .add(new THREE.Vector3(0, 0, Math.abs(mesh.scale.z) / 2));
    const world = front.applyEuler(this.rotation).add(this.position);
    const nearest = [];
    for (const v of skin ?? []) {
      const d = Math.hypot(
        rest[v * 3] - world.x,
        rest[v * 3 + 1] - world.y,
        rest[v * 3 + 2] - world.z,
      );
      if (nearest.length < 3 || d < nearest[nearest.length - 1].d) {
        nearest.push({ v, d });
        nearest.sort((a, b) => a.d - b.d);
        nearest.length = Math.min(nearest.length, 3);
      }
    }
    const total = nearest.reduce((sum, n) => sum + 1 / (n.d + 1e-4), 0) || 1;
    return {
      mesh,
      lower,
      home: new THREE.Vector3(),
      yaw: mesh.rotation.y,
      // Light does not reach the back teeth. Without this the molars at the
      // corners of an open mouth are as bright as the incisors, and the corners
      // read as wedges of white. It has to fall almost to nothing: under this
      // lighting a fifth of the albedo still displays as a light grey.
      corridor: 1 - 0.98 * smooth(0.16, 0.46, Math.abs(mesh.position.x) / this.width),
      carriers: nearest.map((n) => ({ v: n.v, w: 1 / (n.d + 1e-4) / total })),
    };
  }

  /**
   * Stand every tooth behind whatever is in front of it. Lips differ: a Meshy
   * head's mouth pouch starts a few millimetres under the skin, a local head's
   * lips are a centimetre of shell. So each tooth looks forward from just behind
   * itself and backs off until its front face clears the first surface it sees;
   * then the row is evened out, because teeth that step in and out look broken.
   */
  _tuckBehindLips(rest, faces) {
    const W = this.width,
      inverse = new THREE.Matrix4()
        .compose(this.position, this.quaternion, this.scale)
        .invert(),
      forward = new THREE.Vector3(0, 0, 1);
    const p = new THREE.Vector3(),
      q = new THREE.Vector3(),
      r = new THREE.Vector3();
    // The faces, once, in the mouth's own frame.
    const triangles = faces.map((f) =>
      f.map((v) =>
        new THREE.Vector3(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]).applyMatrix4(
          inverse,
        ),
      ),
    );
    const firstAhead = (origin) => {
      let nearest = Infinity;
      for (const [a, b, c] of triangles) {
        // Möller-Trumbore, along +z.
        p.subVectors(b, a);
        q.subVectors(c, a);
        const h = r.crossVectors(forward, q),
          det = p.dot(h);
        if (Math.abs(det) < 1e-14) continue;
        const s = origin.clone().sub(a),
          u = s.dot(h) / det;
        if (u < 0 || u > 1) continue;
        const k = s.cross(p),
          v = forward.dot(k) / det;
        if (v < 0 || u + v > 1) continue;
        const t = q.dot(k) / det;
        if (t > 0 && t < nearest) nearest = t;
      }
      return nearest;
    };
    const retreat = this.riders.map(({ mesh, lower }) => {
      const half = Math.abs(mesh.scale.z) / 2,
        // Look from the part of the crown the lip covers, not from its tip: the
        // tips of the upper teeth stand behind the gap between the lips.
        origin = mesh.position.clone();
      if (mesh !== this.tongue)
        origin.y += (lower ? -0.25 : 0.25) * Math.abs(mesh.scale.y);
      origin.z -= half + W * 0.12;
      const ahead = firstAhead(origin);
      if (ahead === Infinity) return 0;
      // The front face is `2 * half + 0.12 W` ahead of where the look started.
      return Math.max(0, 2 * half + W * 0.12 + W * CLEARANCE - ahead);
    });
    this.riders.forEach(({ mesh, lower }, i) => {
      if (mesh === this.tongue) return;
      // Teeth come in mirrored pairs, two riders per tooth, in arch order: the
      // tooth either side of this one, in the same jaw, is two riders away.
      const neighbours = [i - 2, i, i + 2].filter(
        (n) =>
          this.riders[n] &&
          this.riders[n].lower === lower &&
          this.riders[n].mesh !== this.tongue,
      );
      mesh.position.z -= Math.max(...neighbours.map((n) => retreat[n]));
    });
    // The tongue lies behind the lower teeth, wherever they ended up.
    const lowerFront = Math.min(
      ...this.riders
        .filter((rider) => rider.lower && rider.mesh !== this.tongue)
        .slice(0, 4)
        .map(({ mesh }) => mesh.position.z - Math.abs(mesh.scale.z) / 2),
    );
    this.tongue.position.z = Math.min(
      this.tongue.position.z,
      lowerFront - this.tongue.scale.z / 2 - W * 0.01,
    );
  }

  /**
   * @param {object} state
   * @param {{radians:number,hingeY:number,hingeZ:number,lipArm:number}|null} [state.swing]
   *        `FaceDynamics.jawSwing`: how far the jaw is open and the hinge it is on
   * @param {Float32Array[]} [state.offsets] contact displacement fields of the
   *        head (the solver's and the impact rig's), to give way with the lips
   */
  update({ swing = null, offsets = [] }) {
    const radians = swing?.radians ?? 0,
      hingeY = (swing?.hingeY ?? 0) - this.centre[1],
      hingeZ = (swing?.hingeZ ?? 0) - this.centre[2];
    // Inner-lip gap over mouth width, the same ratio the rig opens by. Colours are
    // linear light, where a tenth displays as a mid grey: a shut mouth has to go
    // far lower than looks necessary, and come up on a curve.
    const parted = (this.restingGap + radians * (swing?.lipArm ?? 0)) / this.width,
      light = 0.004 + 0.996 * smooth(0.02, 0.17, parted) ** 2;
    this.light = light;
    this.flesh.color.copy(TONGUE_PINK).multiplyScalar(light);
    for (const { mesh, lower, home, carriers, yaw, corridor } of this.riders) {
      if (mesh !== this.tongue)
        mesh.material.color.copy(ENAMEL).multiplyScalar(light * corridor);
      let x = home.x,
        y = home.y,
        z = home.z;
      if (lower && radians) {
        // The rig's open shape, exactly: dy = -(z - hz) a, dz = (y - hy) a.
        y -= (home.z - hingeZ) * radians;
        z += (home.y - hingeY) * radians;
      }
      for (const { v, w } of carriers)
        for (const field of offsets) {
          x += field[v * 3] * w;
          y += field[v * 3 + 1] * w;
          z += field[v * 3 + 2] * w;
        }
      mesh.position.set(x, y, z);
      mesh.rotation.set(lower ? radians : 0, yaw, 0);
    }
    // The shared enamel is what a front tooth looks like right now.
    this.enamel.color.copy(ENAMEL).multiplyScalar(light);
  }

  dispose() {
    this.removeFromParent();
    for (const geometry of this.shapes.values()) geometry.dispose();
    for (const { mesh } of this.riders)
      if (mesh !== this.tongue) mesh.material.dispose();
    this.tongue.geometry.dispose();
    this.enamel.dispose();
    this.flesh.dispose();
  }
}

/** Faces with a vertex within `radius` of `centre`. */
function nearbyFaces(rest, indices, centre, radius) {
  const near = (v) =>
    Math.hypot(
      rest[v * 3] - centre[0],
      rest[v * 3 + 1] - centre[1],
      rest[v * 3 + 2] - centre[2],
    ) < radius;
  const faces = [];
  for (let f = 0; f < indices.length; f += 3) {
    const face = [indices[f], indices[f + 1], indices[f + 2]];
    if (near(face[0]) || near(face[1]) || near(face[2])) faces.push(face);
  }
  return faces;
}

/** How far apart the lips are at rest, mid-mouth: zero for a mouth that was cut. */
function restingGap(rest, topology, lips) {
  const off = (v) =>
    Math.abs(lips.along[v] - 0.5) + (2 * Math.abs(lips.height[v])) / lips.width;
  const middle = (list) =>
    list.reduce((best, v) => (off(v) < off(best) ? v : best), list[0]);
  if (!topology.upper.length || !topology.lower.length) return 0;
  const top = middle(topology.upper),
    bottom = middle(topology.lower);
  return Math.max(0, lips.height[top] - lips.height[bottom]);
}
