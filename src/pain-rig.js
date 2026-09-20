// The face's reaction to being hit: a control rig, three poses, a timeline, a
// head flinch and a gasp. See docs/PAIN_RIG.md.
//
// The rigging conventions are the ones FaceFusion's face editor and expression
// restorer are built on (github.com/facefusion/facefusion, which drives
// LivePortrait; read for the method, it is OpenRAIL-AS and nothing is copied).
// It is a 2D tool, so what transfers is how it rigs a face, not code or weights:
//
// - A face is posed as `scale * (points @ rotation.T + expression) + translation`.
//   The head's rigid turn and the expression are separate channels, and the
//   expression is authored in the head's own frame. Here: the poses below live in
//   head space, and the flinch is a separate head rotation (`headFlinch`).
// - Every control is one signed scalar that moves a few named points by a small,
//   fixed amount (`edit_mouth_grim`, `edit_eyebrow_direction`, ...). The controls
//   are summed into one expression, and that sum is clamped once to a calibrated
//   box (`limit_expression`); head angles get the same treatment (`limit_angle`).
//   Here: `PAIN_CONTROLS`, `limitControls`, `limitHeadPose`.
// - Eyes and lips are driven as an opening *ratio* of this face's own lid gap or
//   mouth width, so every face closes alike. Here: `eyeClose` closes a fraction
//   of this head's measured lid gap, and the gasp is a fraction of the speech
//   rig's open shape, which is itself sized as a lip-open ratio.
// - The expression restorer treats the upper face and the lower face as separate
//   groups of points. Here: each control names its `area`, and the timeline lets
//   the upper face (a reflex) lead and outlast the lower face.
//
// An authored animation of a reaction, not a measurement of anyone's pain.
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// Peak travel of each control at 1, in metres on a head whose mouth-to-chin is
// 60 mm (everything scales with the head). Sided controls exist once per side.
export const PAIN_CONTROLS = {
  eyeClose: { area: 'upper', sided: true, max: 1 },
  browLower: { area: 'upper', sided: true, max: 1 },
  cheekRaise: { area: 'upper', sided: true, max: 1 },
  noseWrinkle: { area: 'upper', sided: false, max: 1 },
  upperLipRaise: { area: 'lower', sided: true, max: 1 },
  cornerPull: { area: 'lower', sided: true, max: 1 },
  jawOpen: { area: 'lower', sided: false, max: 1 },
};
// Share of the lid gap that a full `eyeClose` takes away. Short of 1 so the lids
// never meet, whatever the contact layer adds on top.
const LID_CLOSE = 0.78;

// [far side, struck side] for sided controls. The flinch is the reflex: eyes
// shut and the jaw knocked slack. The grimace is the pain face (brow lowering,
// orbital tightening, nose wrinkle and upper-lip raise, lips stretched). The ache
// is what is left: the struck eye still guarded, the brow still drawn.
const POSES = {
  flinch: {
    eyeClose: [1, 1],
    browLower: [0.15, 0.3],
    cheekRaise: [0.1, 0.3],
    noseWrinkle: 0.2,
    upperLipRaise: [0.1, 0.25],
    cornerPull: [0.2, 0.35],
    jawOpen: 0.55,
  },
  grimace: {
    eyeClose: [0.86, 1],
    browLower: [0.8, 1],
    cheekRaise: [0.65, 1],
    noseWrinkle: 0.85,
    upperLipRaise: [0.55, 1],
    cornerPull: [0.75, 1],
    jawOpen: 0.3,
  },
  ache: {
    eyeClose: [0.12, 0.52],
    browLower: [0.4, 0.62],
    cheekRaise: [0.1, 0.45],
    noseWrinkle: 0.25,
    upperLipRaise: [0.1, 0.35],
    cornerPull: [0.3, 0.45],
    jawOpen: 0.22,
  },
};
export const PAIN_POSES = Object.keys(POSES);

/** FaceFusion's `limit_expression`: the summed controls are clamped once. */
export function limitControls(controls) {
  const out = {};
  for (const [name, value] of Object.entries(controls)) {
    const max = PAIN_CONTROLS[name.replace(/_[LR]$/, '')]?.max;
    if (max !== undefined && Number.isFinite(value)) out[name] = clamp(value, 0, max);
  }
  return out;
}

/**
 * Control values for one pose. `side` is -1 (struck on the x<0 side) to 1,
 * `strength` 0..1. A blink is a reflex and is nearly complete however light the
 * hit, so eye closure in the flinch does not fall away with strength.
 */
export function painControls(pose, side, strength) {
  const table = POSES[pose],
    controls = {};
  for (const [name, value] of Object.entries(table)) {
    if (!PAIN_CONTROLS[name].sided) {
      controls[name] = value * strength;
      continue;
    }
    for (const [suffix, s] of [
      ['L', -1],
      ['R', 1],
    ]) {
      const near = 0.5 + 0.5 * s * side;
      const amount = mix(value[0], value[1], near);
      controls[`${name}_${suffix}`] =
        name === 'eyeClose' && pose === 'flinch'
          ? amount * (0.72 + 0.28 * strength)
          : amount * strength;
    }
  }
  return limitControls(controls);
}

export function painDuration(magnitude = 0.85, fractured = false) {
  return 1.5 + 1.3 * clamp(magnitude) + (fractured ? 0.7 : 0);
}

/**
 * Weight of each pose at `age` seconds. They never sum past 1, so a blend of
 * them stays inside the poses that were checked.
 */
export function painTimeline(age, magnitude = 0.85, fractured = false) {
  const m = clamp(magnitude),
    end = painDuration(m, fractured),
    hold = 0.45 + 0.35 * m + (fractured ? 0.25 : 0);
  // A blink starts some 30 ms after the blow and is shut by about 130 ms. The
  // brows and mouth follow with the grimace: the reflex leads the expression.
  const onset = smooth(0.03, 0.13, age),
    toGrimace = smooth(0.14, 0.34, age),
    toAche = smooth(hold, hold + 0.5, age),
    release = 1 - smooth(end - 0.9, end, age);
  return {
    flinch: onset * (1 - toGrimace),
    grimace: onset * toGrimace * (1 - toAche),
    ache: onset * toGrimace * toAche * release,
  };
}

/** How much of the reaction is on the face at `age`: 0 before and after. */
export function painEnvelope(age, magnitude = 0.85, fractured = false) {
  const w = painTimeline(age, magnitude, fractured);
  return w.flinch + w.grimace + w.ache;
}

// Head angles are in the units of `FaceDynamics.recoil`, which the app shows at
// 0.55. FaceFusion's `limit_angle` lets an edit reach pitch 20, yaw 60, roll 15
// degrees; a flinch gets a much tighter box (about 9, 12 and 7 degrees shown).
const HEAD_LIMIT = { x: 0.3, y: 0.4, z: 0.22 };

/** FaceFusion's `limit_angle`: clamp the summed head pose, in place. */
export function limitHeadPose(pose) {
  for (const axis of ['x', 'y', 'z'])
    pose[axis] = clamp(pose[axis], -HEAD_LIMIT[axis], HEAD_LIMIT[axis]);
  return pose;
}

/**
 * Where the head wants to be, as amplitudes for `headFlinchCurve`. The face
 * turns the way the blow was travelling, which is away from the fist; `torque`
 * is (contact - pivot) x direction, the vector the recoil impulse uses, so the
 * flinch carries on the way the blow already turned the head. The chin tucks,
 * unless the blow came from below and lifted it.
 */
export function headFlinch(torque, direction, magnitude, fractured = false) {
  const m = Math.pow(clamp(magnitude), 1.2) * (fractured ? 1.25 : 1);
  const turn = clamp(direction[0] * 1.3 + (torque[1] / 0.04) * 0.5, -1, 1),
    tilt = clamp(torque[2] / 0.04, -1, 1),
    lifted = clamp(direction[1] / 0.6, 0, 1);
  return limitHeadPose({
    x: mix(0.2, -0.1, lifted) * m,
    y: 0.26 * turn * m,
    z: 0.12 * tilt * m,
  });
}

export function headFlinchCurve(age, magnitude = 0.85, fractured = false) {
  const end = painDuration(magnitude, fractured);
  return (
    smooth(0.1, 0.38, age) *
    (1 - smooth(0.75 + 0.3 * clamp(magnitude), Math.max(end - 0.2, 1.3), age))
  );
}

/**
 * Mouth opening asked of the speech rig, 0..1 of its open shape: knocked open
 * just after the blow, then lips left a little parted while it aches.
 */
export function painGasp(age, magnitude = 0.85, fractured = false) {
  const m = clamp(magnitude),
    end = painDuration(m, fractured);
  const burst =
    smooth(0.1, 0.28, age) * (1 - smooth(0.55, 1.3, age)) * (0.25 + 0.45 * m);
  const parted =
    smooth(0.5, 1.2, age) * (1 - smooth(end - 0.8, end, age)) * (0.06 + 0.1 * m);
  return Math.max(burst, parted) * (fractured ? 1.15 : 1);
}

export class PainRig {
  constructor(tissue) {
    this.tissue = tissue;
    // The head template has separate eyeball surfaces. Move the eyelids over
    // those rigid spheres instead of squashing the eyes with the skin.
    this.skin = new Uint8Array(tissue.vertices.length);
    const visited = new Uint8Array(tissue.vertices.length);
    let largest = [];
    tissue.vertices.forEach((v, seed) => {
      if (visited[seed] || !v.links.length) return;
      const component = [seed];
      visited[seed] = 1;
      for (let k = 0; k < component.length; k++)
        for (const [j] of tissue.vertices[component[k]].links)
          if (!visited[j]) {
            visited[j] = 1;
            component.push(j);
          }
      if (component.length > largest.length) largest = component;
    });
    for (const i of largest) this.skin[i] = 1;
  }

  /** Named points of this head, measured where the head has them. */
  landmarks(anchors) {
    const a = { ...anchors },
      { rest, map, vertices } = this.tissue;
    // Photo heads reserve the first 468 *unrendered* semantic cage landmarks.
    // Use their measured positions only when this layout is present.
    if (
      map.length >= 468 &&
      [145, 374, 107, 336].every((i) => !vertices[map[i]].links.length)
    )
      for (const id of [145, 374, 107, 336, 105, 334, 129, 358, 6])
        a[id] ??= Array.from(rest.slice(id * 3, id * 3 + 3));
    const mouth = a[13].map((x, j) => (x + a[14][j]) * 0.5);
    const scale = clamp((mouth[1] - a[152][1]) / 0.06, 0.65, 1.6);
    const nose = a[1] ?? [mouth[0], mouth[1] + 0.043 * scale, mouth[2] + 0.014 * scale];
    const sides = [-1, 1].map((s) => {
      const upper = a[s < 0 ? 159 : 386],
        lower = a[s < 0 ? 145 : 374] ?? [upper[0], upper[1] - 0.009 * scale, upper[2]];
      const eye = upper.map((v, j) => (v + lower[j]) * 0.5);
      return {
        s,
        upper,
        lower,
        eye,
        // The upper lid does most of the closing.
        closeY: mix(lower[1], upper[1], 0.42),
        brow: a[s < 0 ? 107 : 336] ?? [eye[0] * 0.65, eye[1] + 0.024 * scale, eye[2]],
        midBrow: a[s < 0 ? 105 : 334] ?? [eye[0], eye[1] + 0.027 * scale, eye[2]],
        cheek: [eye[0], eye[1] - 0.024 * scale, eye[2] - 0.004 * scale],
        corner: a[s < 0 ? 61 : 291],
        wing: a[s < 0 ? 129 : 358] ?? [
          nose[0] + s * 0.017 * scale,
          nose[1] - 0.004 * scale,
          nose[2] - 0.012 * scale,
        ],
      };
    });
    const root = a[6] ?? [
      nose[0],
      (sides[0].eye[1] + sides[1].eye[1]) * 0.5,
      nose[2] - 0.012 * scale,
    ];
    return { chin: a[152], mouth, scale, nose, root, sides };
  }

  /** One sparse displacement field per control, at control value 1. */
  prepare(anchors) {
    const key = JSON.stringify(anchors);
    if (this.basis?.key === key) return;
    const marks = this.landmarks(anchors),
      { chin, mouth, scale, root, sides } = marks,
      { vertices } = this.tissue;
    const names = [];
    for (const [name, control] of Object.entries(PAIN_CONTROLS))
      if (control.sided) names.push(`${name}_L`, `${name}_R`);
      else names.push(name);
    const lists = Object.fromEntries(names.map((name) => [name, []]));
    const gaussian = (p, c, rx, ry, rz) =>
      Math.exp(
        -p.reduce(
          (sum, x, j) => sum + ((x - c[j]) / ([rx, ry, rz][j] * scale)) ** 2,
          0,
        ),
      );
    const add = (name, node, weight, dx, dy, dz) => {
      if (Math.hypot(dx, dy, dz) * weight > 2e-6)
        lists[name].push(node, dx * weight, dy * weight, dz * weight);
    };
    for (let i = 0; i < vertices.length; i++) {
      if (!this.skin[i]) continue;
      const p = vertices[i].p,
        [x, y, z] = p;
      // Feather to nothing on the skull and the neck, the way FaceFusion feathers
      // every mask it pastes back: an edit must join what it did not touch.
      const front = smooth(mouth[2] - 0.08 * scale, mouth[2] - 0.025 * scale, z);
      const neck = smooth(chin[1] - 0.025 * scale, chin[1] + 0.008 * scale, y);
      const weight = front * neck;
      if (weight < 1e-6) continue;
      for (const side of sides) {
        const { s } = side,
          suffix = s < 0 ? 'L' : 'R';
        // Close along the lid gap rather than translate the whole socket.
        // A broad support avoids a crease immediately above the upper eyelid.
        add(
          `eyeClose_${suffix}`,
          i,
          weight,
          0,
          -(y - side.closeY) * LID_CLOSE * gaussian(p, side.eye, 0.026, 0.026, 0.024),
          0,
        );
        const inner = gaussian(p, side.brow, 0.031, 0.022, 0.036),
          outer = gaussian(p, side.midBrow, 0.03, 0.02, 0.036);
        add(
          `browLower_${suffix}`,
          i,
          weight,
          -s * 0.0045 * scale * inner,
          -(0.0105 * inner + 0.0035 * outer * (1 - inner)) * scale,
          0.002 * scale * inner,
        );
        const lift = gaussian(p, side.cheek, 0.032, 0.02, 0.03);
        add(
          `cheekRaise_${suffix}`,
          i,
          weight,
          0,
          0.0055 * scale * lift,
          0.0015 * scale * lift,
        );
        const lip = gaussian(
          p,
          [mouth[0] + s * 0.013 * scale, mouth[1] + 0.01 * scale, mouth[2]],
          0.02,
          0.016,
          0.026,
        );
        add(
          `upperLipRaise_${suffix}`,
          i,
          weight,
          0,
          0.0042 * scale * lip,
          0.0016 * scale * lip,
        );
        const corner = gaussian(p, side.corner, 0.023, 0.022, 0.026);
        add(
          `cornerPull_${suffix}`,
          i,
          weight,
          s * 0.0045 * scale * corner,
          -0.008 * scale * corner,
          -0.001 * scale * corner,
        );
      }
      // The wings of the nose lift and flare, and the skin at its root bunches.
      let wx = 0,
        wy = 0,
        wz = 0;
      for (const side of sides) {
        const wing = gaussian(p, side.wing, 0.014, 0.014, 0.018);
        wx += side.s * 0.001 * scale * wing;
        wy += 0.003 * scale * wing;
      }
      const bunch = gaussian(p, root, 0.014, 0.012, 0.02);
      wy -= 0.002 * scale * bunch;
      wz += 0.0012 * scale * bunch;
      add('noseWrinkle', i, weight, wx, wy, wz);
      // Broad lower-face hinge motion makes the response visible in silhouette.
      // This field is a function of position, so both copies of a lip-seam vertex
      // move together: it swings the jaw but cannot part a mouth. `painGasp`
      // does that, through the speech rig, which knows which lip is which.
      const jaw =
        (1 - smooth(mouth[1] - 0.015 * scale, mouth[1] + 0.015 * scale, y)) *
        Math.exp(-(((x - mouth[0]) / (0.085 * scale)) ** 4));
      const angle = 0.19 * jaw,
        hy = mouth[1] + 0.058 * scale,
        hz = mouth[2] - 0.072 * scale;
      add(
        'jawOpen',
        i,
        weight,
        0,
        (y - hy) * (Math.cos(angle) - 1) - (z - hz) * Math.sin(angle),
        (y - hy) * Math.sin(angle) + (z - hz) * (Math.cos(angle) - 1),
      );
    }
    const controls = {};
    for (const name of names) {
      const list = lists[name],
        count = list.length / 4;
      const nodes = new Uint32Array(count),
        delta = new Float32Array(count * 3);
      for (let k = 0; k < count; k++) {
        nodes[k] = list[k * 4];
        for (let j = 0; j < 3; j++) delta[k * 3 + j] = list[k * 4 + 1 + j];
      }
      controls[name] = { nodes, delta };
    }
    this.basis = { key, marks, controls };
  }

  /** The mesh field for a set of control values, on every copy of each vertex. */
  field(anchors, controls) {
    this.prepare(anchors);
    const { vertices, rest } = this.tissue,
      nodes = new Float64Array(vertices.length * 3),
      touched = new Set();
    for (const [name, value] of Object.entries(limitControls(controls))) {
      const basis = this.basis.controls[name];
      if (!basis || !value) continue;
      for (let k = 0; k < basis.nodes.length; k++) {
        const node = basis.nodes[k];
        touched.add(node);
        for (let j = 0; j < 3; j++)
          nodes[node * 3 + j] += basis.delta[k * 3 + j] * value;
      }
    }
    const field = new Float32Array(rest.length);
    for (const node of touched)
      for (const copy of vertices[node].copies)
        for (let j = 0; j < 3; j++) field[copy * 3 + j] = nodes[node * 3 + j];
    return field;
  }

  /** How strongly, and on which side, this contact is felt. */
  reading(anchors, point, magnitude, fractured = false) {
    this.prepare(anchors);
    const { mouth, scale } = this.basis.marks;
    const side = clamp((point[0] - mouth[0]) / (0.035 * scale), -1, 1);
    // A blow to the back of the head is not seen coming, but it still hurts.
    const front =
      0.45 +
      0.55 * smooth(mouth[2] - 0.085 * scale, mouth[2] - 0.025 * scale, point[2]);
    const felt = clamp(magnitude + (fractured ? 0.12 : 0));
    return { side, strength: Math.pow(felt, 0.8) * front };
  }

  /** The three poses for one contact: `{ flinch, grimace, ache }`. */
  build(anchors, point, magnitude, fractured = false) {
    const { side, strength } = this.reading(anchors, point, magnitude, fractured);
    const poses = {};
    for (const pose of PAIN_POSES)
      poses[pose] = this.field(anchors, painControls(pose, side, strength));
    return poses;
  }
}
