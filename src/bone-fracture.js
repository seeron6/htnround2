// A hard blow on bone leaves the face slightly, lastingly out of shape. The
// rule is a product rule, not a fracture predictor: see docs/PAIN_RIG.md.
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// At or above this magnitude...
export const FRACTURE_MAGNITUDE = 0.7;
// ...on skin this firmly backed by bone (`TissueField.anatomy().bone`, 0..1).
export const FRACTURE_BONE = 0.5;
// The most a live head's skin may stay displaced, however often it is hit, in
// metres. "Slightly deformed" is the brief; clay mode keeps its own 65 mm.
export const FRACTURE_LIMIT = 0.012;
// Swelling comes up over this long after the blow.
export const SWELL_SECONDS = 3;

export const FRACTURE_LABELS = {
  nasal: 'nose',
  zygoma: 'cheekbone',
  mandible: 'jaw',
  temple: 'temple',
  frontal: 'skull',
  occipital: 'skull',
};

// Metres on a head whose mouth-to-chin is 60 mm, at full severity.
// `radius` is the broken plate, `sink` how far it is driven in, `shift` how far
// it slides along the skin with the blow; `puff` is how wide the skin swells
// around the contact afterwards and `swell` how far it rises.
const SHAPES = {
  // The commonest break: the nose is knocked sideways and its bridge flattens.
  nasal: {
    radius: 0.03,
    sink: 0.004,
    shift: 0.0075,
    puff: 0.024,
    swell: 0.0034,
    eyes: 0.6,
  },
  // A flattened cheekbone, and a swollen lower lid on that side.
  zygoma: {
    radius: 0.024,
    sink: 0.009,
    shift: 0.0025,
    puff: 0.024,
    swell: 0.0045,
    eyes: 1,
  },
  // The whole chin sits off to one side, a little back, and hangs.
  mandible: {
    radius: 0.06,
    sink: 0.005,
    shift: 0.0075,
    puff: 0.026,
    swell: 0.0036,
    drop: 0.0025,
  },
  temple: { radius: 0.026, sink: 0.0075, shift: 0.001, puff: 0.026, swell: 0.005 },
  frontal: { radius: 0.026, sink: 0.0075, shift: 0.001, puff: 0.026, swell: 0.005 },
  occipital: { radius: 0.026, sink: 0.0075, shift: 0.001, puff: 0.026, swell: 0.005 },
};

/** The bone under this skin, or null where it is not firmly backed. */
export function boneAt(material) {
  if (!material?.bones || material.bone < FRACTURE_BONE) return null;
  let best = null,
    weight = 0;
  for (const [name, value] of Object.entries(material.bones))
    if (value > weight) {
      weight = value;
      best = name;
    }
  return best;
}

export function wouldFracture(material, magnitude) {
  return magnitude >= FRACTURE_MAGNITUDE && boneAt(material) !== null;
}

/** 0.55 at the threshold, 1 at full magnitude: bone breaks or it does not. */
export function fractureSeverity(magnitude) {
  return (
    0.55 + 0.45 * clamp((magnitude - FRACTURE_MAGNITUDE) / (1 - FRACTURE_MAGNITUDE))
  );
}

// A few passes of each node towards the mean of its neighbours, on `nodes` only.
function relax(tissue, values, nodes, passes) {
  const next = new Float32Array(nodes.length * 3);
  for (let pass = 0; pass < passes; pass++) {
    nodes.forEach((i, k) => {
      const links = tissue.vertices[i].links;
      for (let j = 0; j < 3; j++) {
        let sum = 0;
        for (const [other] of links) sum += values[other * 3 + j];
        next[k * 3 + j] = links.length
          ? values[i * 3 + j] * 0.5 + (sum / links.length) * 0.5
          : values[i * 3 + j];
      }
    });
    nodes.forEach((i, k) => {
      for (let j = 0; j < 3; j++) values[i * 3 + j] = next[k * 3 + j];
    });
  }
}

/**
 * The lasting displacement for one contact, per welded node, or null.
 * `normal` opposes the blow and `incidence` is how squarely it landed, as
 * `TissueField.build` measures them.
 */
export function fractureField(
  tissue,
  { seed, direction, normal, incidence, magnitude, materials, anchors },
) {
  const material = materials[seed];
  if (!wouldFracture(material, magnitude)) return null;
  const bone = boneAt(material),
    shape = SHAPES[bone],
    severity = fractureSeverity(magnitude),
    s = material.scale,
    { vertices } = tissue;
  const source = vertices[seed].p,
    middle = (anchors[13][0] + anchors[14][0]) * 0.5,
    side = Math.sign(source[0] - middle) || 1;
  // The part of the blow that runs along the skin carries the fragment with it.
  const tangent = direction.map((x, j) => x + normal[j] * incidence);
  // A nose or a jaw breaks sideways. A blow that came straight in still leaves
  // it a little crooked, away from the side it landed on.
  let sideways = clamp(tangent[0] * 1.8, -1, 1);
  if (Math.abs(sideways) < 0.35) sideways = 0.35 * (Math.sign(tangent[0]) || -side);
  const radius = shape.radius * (0.8 + 0.2 * severity) * s,
    puff = shape.puff * s,
    reach = Math.max(radius, puff * 1.9, shape.eyes ? 0.075 * s : 0),
    distance = tissue.distances(seed, reach);
  const damage = new Float32Array(vertices.length * 3),
    swelling = new Float32Array(damage.length);
  const sink = shape.sink * s * severity * (0.55 + 0.45 * incidence),
    shift = shape.shift * s * severity;
  const gaussian = (p, c, radii) =>
    Math.exp(-p.reduce((sum, x, j) => sum + ((x - c[j]) / (radii[j] * s)) ** 2, 0));
  // Swollen lower lids: both for a nose, the struck side for a cheekbone.
  const lids = shape.eyes
    ? (bone === 'nasal' ? [-1, 1] : [side]).map((eye) => {
        const lid = anchors[eye < 0 ? 159 : 386];
        return [lid[0], lid[1] - 0.021 * s, lid[2] - 0.002 * s];
      })
    : [];
  // The lids themselves are left alone. They are the finest skin on the head
  // and they close hard in the pain rig: anything kept there folds them.
  const eyes = [159, 386].map((id) => [
    anchors[id][0],
    anchors[id][1] - 0.0045 * s,
    anchors[id][2],
  ]);
  const touched = [];
  for (let i = 0; i < vertices.length; i++) {
    const d = distance[i];
    if (!Number.isFinite(d)) continue;
    touched.push(i);
    const local = materials[i],
      v = vertices[i],
      spared =
        1 - Math.max(...eyes.map((eye) => gaussian(v.p, eye, [0.026, 0.017, 0.03])));
    // A plate, not a bowl: bone gives way as a piece, with a firm edge.
    const plate = 1 - smooth(radius * 0.4, radius * 1.1, d);
    const held =
      bone === 'nasal'
        ? clamp(local.bones.nasal * 1.4)
        : bone === 'mandible'
          ? Math.pow(local.bones.mandible, 0.8) * (1 - 0.6 * local.lips)
          : 0.3 + 0.7 * local.bone;
    const weight = plate * held * spared;
    if (weight > 1e-5) {
      for (let j = 0; j < 3; j++) damage[i * 3 + j] = -normal[j] * sink * weight;
      if (bone === 'nasal' || bone === 'mandible')
        damage[i * 3] += sideways * shift * weight;
      else for (let j = 0; j < 3; j++) damage[i * 3 + j] += tangent[j] * shift * weight;
      if (shape.drop) damage[i * 3 + 1] -= shape.drop * s * severity * weight;
    }
    // Soft tissue swells, mostly in a ring around the contact. Never the lips:
    // their creases fold over themselves if they are pushed along their normals.
    const ring = Math.exp(-(((d - puff * 0.95) / (puff * 0.5)) ** 2)),
      middle = 1 - smooth(puff * 0.45, puff, d);
    const around = shape.swell * (0.3 * middle + 0.7 * ring);
    let under = 0;
    for (const lid of lids)
      under += 0.002 * shape.eyes * gaussian(v.p, lid, [0.02, 0.011, 0.02]);
    const soft =
      s * severity * (0.8 + 0.2 * local.compliance) * (1 - local.lips) * spared;
    // Rise along the skin's own normal, steadied by the way the surface faces as
    // a whole: a crease has normals every which way and would fold otherwise.
    for (const [rise, axis] of [
      [around * soft, normal],
      [under * soft, [0, 0, 1]],
    ]) {
      if (rise < 1e-6) continue;
      const way = v.n.map((x, j) => x + axis[j]),
        length = Math.hypot(...way),
        // Skin that faces away is not what swells.
        facing = smooth(0.5, 1.3, length);
      if (facing > 0)
        for (let j = 0; j < 3; j++)
          swelling[i * 3 + j] += (way[j] / length) * rise * facing;
    }
  }
  // The weights above meet at edges (the lids, the lips, where bone gives way
  // to cheek). Skin does not: spread each field along the surface before it is
  // bounded, or those edges show as creases.
  for (const field of [damage, swelling]) relax(tissue, field, touched, 6);
  tissue.limitGradient(damage, 0.3, touched);
  tissue.limitGradient(swelling, 0.35, touched);
  return { bone, side, severity, damage, swelling };
}
