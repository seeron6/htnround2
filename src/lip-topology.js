// Give a head lips that can part: the lip "wireframe".
//
// `src/mouth-aperture.js` opens a mouth by deleting the triangles that seal it.
// That is exact on the MediaPipe canonical face, whose lips already have their
// own edge rings, and wrong everywhere else. A Meshy head has ~6 mm triangles at
// the lips, so deleting whole triangles leaves black shards while the mouth is
// shut, and the triangles that survive still bridge the two lips, so they
// stretch across the opening as soon as the jaw moves. No choice of triangles
// fixes that. The mesh has no edge where the lips meet, so it needs one.
//
// The conventions are the ones FaceFusion's lip syncer and face editor are built
// on (github.com/facefusion/facefusion; read for the method, nothing is copied):
//
//   * The mouth is addressed by lip contours, never by a box. Its `mouth` area is
//     the outer ring (68-point landmarks 48-59) plus the inner ring (60-67), and
//     its face parser keeps `upper-lip`, `lower-lip` and `mouth` apart as three
//     regions. The two lips share their corners and nothing else. Here that is
//     the cut: one seam along the inner-lip line, upper and lower lip on their
//     own vertices, joined only at the two corner vertices.
//   * Lip opening is a ratio: inner-lip gap over mouth width
//     (`calculate_distance_ratio(landmarks, 62, 66, 54, 48)`), which is what
//     LivePortrait's lip retargeting is driven by. `lipField` and the speech rig
//     size the opening off this head's own mouth width the same way.
//   * Every edit is pasted back through a feathered mask, hard inside and soft at
//     the border. In 3D that is the weight field in `lipField`: discontinuous
//     only across the real cut, smooth everywhere else, and tapering to nothing
//     at the corners so they stay closed.
//
// THE INVARIANT: this only ever REFINES. Each new surface vertex lies on an
// original edge and each new triangle lies inside one original triangle, so the
// shape is unchanged and the texture is exactly preserved however fragmented the
// UV atlas is (Meshy tears its atlas into ~3 copies of every vertex). Nothing is
// re-projected, re-parameterised or re-baked. A closed mouth renders as it did
// before; the difference only shows when the lips part.
//
// Vertices are only ever appended and an untouched triangle keeps its place, so
// anything addressed by vertex index (hair roots, the Newton binding, saved
// sculpts) survives, and `extendVertexField` carries per-vertex data across.
//
// Steps: pick the front surface around the mouth, bisect long edges until the
// lips have enough vertices to bend, split every edge the lip line crosses (the
// line is the zero set of a per-vertex height-above-seam, so the splits chain
// into one edge path), give the lower lip its own copy of that path, then hang a
// short inner-lip surface from each lip so an open mouth has thickness.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export const LIP_TOPOLOGY_VERSION = 1;
// Stored native-mouth labels from before visibility-based skin classification
// can include the cheeks and chin. Keep shading revisions separate from cuts:
// native labels can be rebuilt without changing a single triangle.
export const NATIVE_MOUTH_SHADE_VERSION = 2;

// The sheet behind each lip, as rows of [rise, depth, shade]: how far a row sits
// above (below, for the lower lip) and behind the lip edge in mouth widths, and
// how dark it is drawn. Lip edge, the turn inside it, up the back of the lip, the
// roof of the mouth, the back of it. Every row closes onto the corners, where the
// pouch has no depth at all. The sheet climbs the back of the lip before it heads
// for the throat so that the mouth has a front room: that is where the teeth of
// src/mouth-interior.js stand, and a sheet running straight back would wall them
// off. `hang` keeps every row behind the skin whatever the lips are shaped like.
const POUCH = [
  [0, 0, 0.8],
  [0.06, 0.035, 0.55],
  [0.2, 0.07, 0.3],
  [0.24, 0.3, 0.12],
  [0.22, 0.62, 0.06],
];

// MediaPipe's inner-lip ring as `src/lip-detect.js` hands it over: the upper
// contour corner to corner, then the lower contour back again.
const RING_LENGTH = 20,
  RING_UPPER = 11;

// All in units of the mouth width, measured in the detector's image.
const REFINE_X = 0.2, // how far past each corner the lips are refined
  REFINE_Y = 0.36, // and how far above and below the lip line
  REGION_X = 0.34, // the surface patch that is considered at all
  REGION_Y = 0.62,
  FINE_EDGE = 1 / 24, // target edge length beside the seam...
  COARSE_EDGE = 1 / 9, // ...relaxing to this at the edge of the refined band
  SNAP = 0.004, // a vertex this close to the lip line is taken to be on it
  CANDIDATE_RADIUS = 1.05, // 3D search radius around the mouth centre
  BEHIND_LIMIT = 0.6, // depth guard: never reach a mouth bag or the skull
  AHEAD_LIMIT = 0.35,
  MAX_PASSES = 8,
  MAX_NEW_TRIANGLES = 16000;

/**
 * The lip line, corner to corner, from the detector's inner-lip ring.
 *
 * On a closed mouth the upper and lower inner contours coincide and this is the
 * line where the lips meet. On a mouth captured open (teeth in the texture) it
 * runs between them, so the upper teeth stay with the skull and the lower teeth
 * travel with the jaw.
 */
export function lipSeamFromRing(ring) {
  if (!Array.isArray(ring) || ring.length !== RING_LENGTH) return null;
  const upper = ring.slice(0, RING_UPPER);
  const lower = [ring[0], ...ring.slice(RING_UPPER).reverse(), ring[RING_UPPER - 1]];
  const seam = upper.map((p, i) => ({
    x: (p.x + lower[i].x) / 2,
    y: (p.y + lower[i].y) / 2,
  }));
  if (seam.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  if (seam[0].x > seam[seam.length - 1].x) seam.reverse();
  return seam;
}

/**
 * Seam coordinates: x runs 0..1 from corner to corner, y is height above the
 * corner-to-corner line, both in mouth widths. `height(x)` is the lip line.
 */
function seamFrame(points, shift = 0) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const first = points[0],
    last = points[points.length - 1];
  const dx = last.x - first.x,
    dy = last.y - first.y,
    width = Math.hypot(dx, dy);
  if (!(width > 1e-6)) return null;
  const ex = [dx / width, dy / width],
    ey = [-ex[1], ex[0]];
  const to = (p) => {
    const px = p.x - first.x,
      py = p.y - first.y;
    return [(px * ex[0] + py * ex[1]) / width, (px * ey[0] + py * ey[1]) / width];
  };
  // Keep the knots strictly increasing; a landmark that doubles back is noise.
  const xs = [],
    ys = [];
  for (const p of points) {
    const [x, y] = to(p);
    if (xs.length && x <= xs[xs.length - 1] + 1e-4) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 3) return null;
  xs[0] = 0;
  ys[0] = 0;
  xs[xs.length - 1] = 1;
  ys[ys.length - 1] = 0;
  // Finite-difference tangents: a smooth curve through the landmarks, because
  // ten straight segments would show as kinks in the outline of an open mouth.
  const slopes = xs.map((_, i) => {
    const before = i > 0 ? (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]) : null,
      after = i < xs.length - 1 ? (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) : null;
    return before === null ? after : after === null ? before : (before + after) / 2;
  });
  const height = (x) => {
    if (x <= 0 || x >= 1) return shift;
    let i = 0;
    while (i < xs.length - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i],
      t = (x - xs[i]) / h,
      t2 = t * t,
      t3 = t2 * t;
    return (
      shift +
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * slopes[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * slopes[i + 1]
    );
  };
  return { to, height, width };
}

const edgeKey = (a, b) => (a < b ? a * 16777216 + b : b * 16777216 + a);

/**
 * Cut the lip seam into a mesh.
 *
 * Two layouts are accepted, matching the two ways a head reaches the scene:
 *
 *   atlas  `positions` + `indices` are the welded simulation surface and `atlas`
 *          ({mapping, indices, uv}) holds its render copies, face for face. This
 *          is a local-pipeline head, or any GLB this app exported.
 *   raw    one indexed geometry whose `attributes` (uv, color, ...) sit on the
 *          same vertices, torn wherever the UV atlas is. This is a Meshy GLB.
 *          Coincident vertices are treated as one for topology and kept apart
 *          for texture.
 *
 * @param {object} input
 * @param {ArrayLike<number>} input.positions
 * @param {ArrayLike<number>} input.indices
 * @param {{mapping:ArrayLike<number>,indices:ArrayLike<number>,uv:ArrayLike<number>}} [input.atlas]
 * @param {Record<string,{itemSize:number,array:ArrayLike<number>}>} [input.attributes]
 *        every other per-vertex attribute of the `positions` geometry
 * @param {(x:number,y:number,z:number)=>{x:number,y:number}} input.project
 *        the view the lip line was found in; isotropic, y up
 * @param {{x:number,y:number}[]} input.seam  lip line in that view, corner to corner
 * @param {number[]} input.centre  mouth centre on the surface, in mesh space
 * @param {number} input.width     mouth width in mesh space
 * @param {number[]} [input.forward] the way the face looks, in mesh space
 * @param {number[]} [input.up]
 * @returns {null|{positions:Float32Array,indices:Uint32Array,attributes:object,
 *   atlas:object|null,parents:Float32Array,topology:object}}
 *   null when no clean seam could be cut; the input is never modified.
 */
// Why the last head was refused, for browser QA and for the tests.
let failure = '';
export const lastLipCutFailure = () => failure;
const refuse = (reason) => {
  failure = reason;
  return null;
};

// The lip line is moved up and down by these fractions of the mouth's width.
// Parted lips are looked for first and over a few millimetres, because the gap
// between them is about a millimetre tall and a landmarker is not that good; a
// probe changes nothing, so they all share one workspace. A cut is only nudged by
// a hair: a line that runs straight through a sliver can leave a branched seam,
// and a fraction of a millimetre clears it.
const PARTED_SHIFTS = [0, 0.012, -0.012, 0.025, -0.025, 0.04, -0.04, 0.055, -0.055],
  CUT_SHIFTS = [0, 0.003, -0.003, 0.006, -0.006];

export function cutLips(input) {
  failure = '';
  // What every attempt can share: where the vertices project, what is in front
  // of what, and which way the mesh is wound. None of it depends on the shift.
  const shared = { sx: [], sy: [] };
  for (const shift of PARTED_SHIFTS) {
    const result = cutOnce(input, shift, shared, true);
    if (result) return result;
    if (!shared.work) return null;
  }
  for (const shift of CUT_SHIFTS) {
    const result = cutOnce(input, shift, shared, false);
    if (result) return result;
  }
  return null;
}

/** One attempt: look for parted lips to adopt (`probe`), or cut a seam. */
function cutOnce(input, shift, shared, probe) {
  const frame = seamFrame(input?.seam, shift);
  const width = Number(input?.width);
  if (!frame || !(width > 0) || !input.centre?.every?.(Number.isFinite))
    return refuse('no usable lip line');
  if (typeof input.project !== 'function') return refuse('no projection');
  const forward = normalise(input.forward ?? [0, 0, 1]),
    up = normalise(input.up ?? [0, 1, 0]);
  // A probe changes nothing, so probes share one workspace. A cut builds on its
  // own, and starts from a copy of what the probes already projected.
  const build = () =>
    input.atlas ? atlasWorkspace(input) : rawWorkspace(input, width);
  const work = probe ? (shared.work ??= build()) : build();
  if (!work) return refuse('mesh and atlas do not describe the same faces');
  const { centre } = input;

  // ---- Seam coordinates of a simulation vertex, cached -------------------
  const sx = probe ? shared.sx : shared.sx.slice(),
    sy = probe ? shared.sy : shared.sy.slice(),
    phi = [];
  const locate = (s) => {
    if (phi[s] !== undefined) return;
    if (sx[s] === undefined) {
      const p = work.simP,
        q = input.project(p[s * 3], p[s * 3 + 1], p[s * 3 + 2]);
      [sx[s], sy[s]] = frame.to(q);
    }
    phi[s] = sy[s] - frame.height(sx[s]);
  };
  // Fills the shared projection for a face's vertices (`lineOfSight` reads it).
  work.project = (vertices, xs, ys) => {
    for (const v of vertices) {
      if (xs[v] !== undefined) continue;
      const p = work.simP;
      [xs[v], ys[v]] = frame.to(input.project(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]));
    }
  };
  const phiAt = (x, y, z) => {
    const [px, py] = frame.to(input.project(x, y, z));
    return py - frame.height(px);
  };

  // ---- Candidate faces: everything near the mouth in 3D ------------------
  const radius = width * CANDIDATE_RADIUS,
    radius2 = radius * radius;
  const near = (s) => {
    const p = work.simP,
      dx = p[s * 3] - centre[0],
      dy = p[s * 3 + 1] - centre[1],
      dz = p[s * 3 + 2] - centre[2];
    return dx * dx + dy * dy + dz * dz < radius2;
  };
  const candidates = [];
  for (let f = 0; f < work.faceCount(); f++) {
    const s = work.simFace(f);
    if (s && (near(s[0]) || near(s[1]) || near(s[2]))) candidates.push(f);
  }
  if (candidates.length < 4) return refuse('no surface near the mouth');

  const signedArea = (s) => {
    locate(s[0]);
    locate(s[1]);
    locate(s[2]);
    return (
      (sx[s[1]] - sx[s[0]]) * (sy[s[2]] - sy[s[0]]) -
      (sx[s[2]] - sx[s[0]]) * (sy[s[1]] - sy[s[0]])
    );
  };
  const centroid = (s) => {
    const p = work.simP;
    return [0, 1, 2].map(
      (k) => (p[s[0] * 3 + k] + p[s[1] * 3 + k] + p[s[2] * 3 + k]) / 3,
    );
  };
  // Depth guard, so neither a mouth bag behind the lips nor anything in front
  // of them is ever mistaken for the lips themselves.
  const depthOk = (c) => {
    const behind =
      (centre[0] - c[0]) * forward[0] +
      (centre[1] - c[1]) * forward[1] +
      (centre[2] - c[2]) * forward[2];
    return behind < width * BEHIND_LIMIT && behind > -width * AHEAD_LIMIT;
  };
  const inWindow = (s, marginX, marginY) => {
    const x = (sx[s[0]] + sx[s[1]] + sx[s[2]]) / 3,
      y = (sy[s[0]] + sy[s[1]] + sy[s[2]]) / 3;
    return x > -marginX && x < 1 + marginX && Math.abs(y - frame.height(x)) < marginY;
  };
  // Where a face sits: along the mouth, above the lip line, behind the lips.
  const seat = (f) => {
    const s = work.simFace(f);
    for (const v of s) locate(v);
    const c = centroid(s);
    return {
      x: (sx[s[0]] + sx[s[1]] + sx[s[2]]) / 3,
      y: (phi[s[0]] + phi[s[1]] + phi[s[2]]) / 3,
      c,
      depth:
        (centre[0] - c[0]) * forward[0] +
        (centre[1] - c[1]) * forward[1] +
        (centre[2] - c[2]) * forward[2],
    };
  };

  const sight = (shared.sight ??= lineOfSight({
    work,
    sx,
    sy,
    width,
    centre,
    forward,
  }));

  // Which winding faces the viewer? Standard is counter-clockwise, but a GLB
  // that arrived through a mirroring transform is inside out, so vote. Only what
  // can be SEEN votes: a hollow template head has whole layers behind its face
  // that point the other way, and with them in the count the answer flips.
  if (shared.facing === undefined) {
    let front = 0,
      back = 0;
    for (const f of candidates) {
      const s = work.simFace(f),
        area = signedArea(s),
        c = centroid(s);
      if (!inWindow(s, 0.1, 0.35) || !depthOk(c) || sight.blocked(c, forward, f))
        continue;
      if (area > 0) front += area;
      else back -= area;
    }
    if (!(front + back > 0)) return refuse('no surface under the lip line');
    shared.facing = front >= back ? 1 : -1;
  }
  const facing = shared.facing;

  // ---- The lip surface: flood outward from the mouth centre --------------
  const facesFront = (f) => {
    const s = work.simFace(f);
    return (
      signedArea(s) * facing > 0 &&
      inWindow(s, REGION_X, REGION_Y) &&
      depthOk(centroid(s))
    );
  };
  // The crease between closed lips can fold away from the viewer, so right at
  // the lip line a face is taken whichever way it points.
  const eligible = (f) => {
    const s = work.simFace(f);
    return (
      (signedArea(s) * facing > 0 || inWindow(s, 0.05, 0.12)) &&
      inWindow(s, REGION_X, REGION_Y) &&
      depthOk(centroid(s))
    );
  };
  const grow = (test) => {
    let seed = -1,
      best = Infinity;
    const byEdge = new Map();
    for (const f of candidates) {
      if (!test(f)) continue;
      const s = work.simFace(f),
        c = centroid(s),
        d = (c[0] - centre[0]) ** 2 + (c[1] - centre[1]) ** 2 + (c[2] - centre[2]) ** 2;
      if (d < best) {
        best = d;
        seed = f;
      }
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(s[k], s[(k + 1) % 3]);
        const list = byEdge.get(key);
        if (list) list.push(f);
        else byEdge.set(key, [f]);
      }
    }
    if (seed < 0) return null;
    const grown = new Set([seed]),
      queue = [seed];
    while (queue.length) {
      const s = work.simFace(queue.pop());
      for (let k = 0; k < 3; k++)
        for (const g of byEdge.get(edgeKey(s[k], s[(k + 1) % 3])) ?? [])
          if (!grown.has(g)) {
            grown.add(g);
            queue.push(g);
          }
    }
    return grown;
  };
  const region = grow(eligible);
  if (!region) return refuse('no front surface at the mouth');

  // ---- A mouth that is already open --------------------------------------
  // A head fitted from a full template (the local pipeline's) arrives with real
  // lips: two separate surfaces that roll inwards. The lip line then runs through
  // the gap between them and crosses almost nothing. Such a mouth is adopted as it
  // is rather than cut: see `adoptMouth`.
  if (probe) {
    // Skin is what can be seen: front-facing, at the depth of the face, with
    // nothing in front of it. Not "what is connected to the lips": a template
    // mesh is not one sheet, and on one scan a walk from the lips reaches a
    // fraction of the face. What shows THROUGH the gap is not skin either.
    const skin = new Set();
    for (const f of candidates) {
      if (!facesFront(f)) continue;
      const { x, y, c, depth } = seat(f);
      if (Math.abs(y) < 0.12 && x > 0 && x < 1 && depth > width * 0.12) continue;
      if (!sight.blocked(c, forward, f)) skin.add(f);
    }
    // Along the mouth, where does skin run unbroken across the lip line, and where
    // is there lip above and lip below with nothing joining them? Counted per face
    // over the whole stretch the face covers: on a Meshy head a lip triangle is
    // three bins wide, and counted by its edges alone it leaves bins that look
    // empty between them, which reads as parted lips.
    const bins = 24,
      crossed = new Uint8Array(bins),
      above = new Uint8Array(bins),
      below = new Uint8Array(bins);
    for (const f of skin) {
      const s = work.simFace(f),
        heights = s.map((v) => phi[v]),
        low = Math.min(...heights),
        high = Math.max(...heights);
      const from = Math.max(0, Math.floor(Math.min(...s.map((v) => sx[v])) * bins)),
        to = Math.min(bins - 1, Math.floor(Math.max(...s.map((v) => sx[v])) * bins));
      const mark =
        low < 0 && high > 0 ? crossed : low >= 0 && low < 0.25 ? above : null;
      for (let bin = from; bin <= to; bin++) {
        if (mark) mark[bin] = 1;
        else if (high <= 0 && high > -0.25) below[bin] = 1;
      }
    }
    // The corners of any mouth are closed, so they say nothing: judge the middle.
    const edge = 2,
      judged = bins - 2 * edge;
    let sealed = 0,
      parted = 0;
    for (let i = edge; i < bins - edge; i++) {
      sealed += crossed[i];
      parted += !crossed[i] && above[i] && below[i];
    }
    if (sealed < judged * 0.4 && parted >= judged * 0.5)
      return adoptMouth({ work, skin, sight, seat, sx, phi, centre, width, forward });
  }
  if (probe) return refuse('the lips are not parted');

  // ---- Split every face that owns a marked edge --------------------------
  // `marks` maps an edge to where it is cut. A face with one marked edge becomes
  // two, with two becomes three and with three becomes four; because a mark
  // belongs to the edge, both of its faces split at the same point and the
  // surface stays conforming. The first child takes its parent's place.
  const live = new Set(candidates);
  const longestEdge = (s) => {
    let longest = -1,
      at = 0;
    for (let k = 0; k < 3; k++) {
      const length = work.distance(s[k], s[(k + 1) % 3]);
      if (length > longest) {
        longest = length;
        at = k;
      }
    }
    return { at, length: longest };
  };
  const applyMarks = (marks, bisecting = false) => {
    for (const f of [...live]) {
      const s = work.simFace(f),
        r = work.renderFace(f);
      const cut = [0, 1, 2].map(
        (k) => marks.get(edgeKey(s[k], s[(k + 1) % 3])) ?? null,
      );
      const count = cut.filter(Boolean).length;
      if (!count) continue;
      const mid = cut.map((mark, k) =>
        mark ? work.splitEdge(mark, s[k], s[(k + 1) % 3], r[k], r[(k + 1) % 3]) : null,
      );
      const corner = (k) => ({ s: s[k], r: r[k] });
      let children;
      const long = bisecting ? longestEdge(s).at : -1;
      if (long >= 0 && cut[long]) {
        // Longest-edge bisection (Rivara's 4T-LE): halve the longest edge, then
        // join any other midpoint to that one. Angles stay bounded however many
        // times a face is refined, where splitting a short edge again and again
        // fans a big neighbour into needles.
        const a = corner(long),
          b = corner((long + 1) % 3),
          c = corner((long + 2) % 3),
          m = mid[long],
          n = mid[(long + 1) % 3],
          o = mid[(long + 2) % 3];
        children = [
          ...(o
            ? [
                [a, m, o],
                [o, m, c],
              ]
            : [[a, m, c]]),
          ...(n
            ? [
                [m, b, n],
                [m, n, c],
              ]
            : [[m, b, c]]),
        ];
      } else if (count === 3)
        children = [
          [corner(0), mid[0], mid[2]],
          [mid[0], corner(1), mid[1]],
          [mid[2], mid[1], corner(2)],
          [mid[0], mid[1], mid[2]],
        ];
      else if (count === 1) {
        const k = cut.findIndex(Boolean),
          a = corner(k),
          b = corner((k + 1) % 3),
          c = corner((k + 2) % 3);
        children = [
          [a, mid[k], c],
          [mid[k], b, c],
        ];
      } else {
        // Two marks: the unmarked edge is opposite the vertex the marks share.
        const free = cut.findIndex((mark) => !mark),
          a = corner(free),
          b = corner((free + 1) % 3),
          c = corner((free + 2) % 3),
          bc = mid[(free + 1) % 3],
          ca = mid[(free + 2) % 3];
        // The corner triangle always carries the edge bc-ca, so a lip line that
        // crosses this face becomes a mesh edge. Split the rest on its shorter
        // diagonal to keep the pieces well shaped.
        const viaB = work.distance(b.s, ca.s) <= work.distance(a.s, bc.s);
        children = viaB
          ? [
              [ca, bc, c],
              [a, b, ca],
              [b, bc, ca],
            ]
          : [
              [ca, bc, c],
              [a, b, bc],
              [a, bc, ca],
            ];
      }
      const inRegion = region.has(f);
      children.forEach((child, n) => {
        const id = work.writeFace(n === 0 ? f : -1, child);
        live.add(id);
        if (inRegion) region.add(id);
      });
    }
  };

  // ---- 1. Refine: give the lips enough vertices to bend ------------------
  const trianglesBefore = work.faceCount();
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const marks = new Map(),
      around = new Map(),
      queue = [];
    for (const f of live) {
      const s = work.simFace(f);
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(s[k], s[(k + 1) % 3]),
          list = around.get(key);
        if (list) list.push(f);
        else around.set(key, [f]);
      }
    }
    // Only an edge with both ends inside the search sphere may be split: every
    // face around such an edge is a candidate, so none is left with a crack.
    const bisect = (f) => {
      const s = work.simFace(f),
        { at } = longestEdge(s),
        a = s[at],
        b = s[(at + 1) % 3],
        key = edgeKey(a, b);
      if (marks.has(key) || !near(a) || !near(b)) return;
      marks.set(key, { t: 0.5, low: Math.min(a, b) });
      queue.push(...around.get(key));
    };
    for (const f of region) {
      const s = work.simFace(f);
      locate(s[0]);
      locate(s[1]);
      locate(s[2]);
      if (!inWindow(s, REFINE_X, REFINE_Y)) continue;
      const x = (sx[s[0]] + sx[s[1]] + sx[s[2]]) / 3,
        y = (sy[s[0]] + sy[s[1]] + sy[s[2]]) / 3,
        distance = Math.abs(y - frame.height(x));
      const target =
        width *
        (FINE_EDGE + (COARSE_EDGE - FINE_EDGE) * smooth(0.06, REFINE_Y, distance));
      if (longestEdge(s).length > target) bisect(f);
    }
    // Closure: a face that owns a marked edge must have its own longest edge
    // marked too. It runs uphill, towards ever longer edges, so it is short.
    while (queue.length) {
      const f = queue.pop(),
        s = work.simFace(f);
      if ([0, 1, 2].some((k) => marks.has(edgeKey(s[k], s[(k + 1) % 3])))) bisect(f);
    }
    if (!marks.size) break;
    applyMarks(marks, true);
    if (work.faceCount() - trianglesBefore > MAX_NEW_TRIANGLES)
      return refuse('refinement ran away');
  }

  // ---- 2. Cut: split every edge the lip line crosses ---------------------
  const onSeam = new Set();
  {
    const marks = new Map();
    for (const f of region) for (const s of work.simFace(f)) locate(s);
    for (const f of region)
      for (const s of work.simFace(f))
        if (Math.abs(phi[s]) < SNAP) {
          phi[s] = 0;
          if (sx[s] >= 0 && sx[s] <= 1) onSeam.add(s);
        }
    const p = work.simP;
    for (const f of region) {
      const s = work.simFace(f);
      for (let k = 0; k < 3; k++) {
        const a = Math.min(s[k], s[(k + 1) % 3]),
          b = Math.max(s[k], s[(k + 1) % 3]);
        if (!(phi[a] * phi[b] < 0)) continue;
        const key = edgeKey(a, b);
        if (marks.has(key)) continue;
        // Linear in the image is exact for a parallel view; under perspective
        // it is a first guess, tightened against the real projection.
        let lo = 0,
          hi = 1,
          flo = phi[a],
          fhi = phi[b],
          t = flo / (flo - fhi);
        for (let i = 0; i < 5; i++) {
          const value = phiAt(
            p[a * 3] + (p[b * 3] - p[a * 3]) * t,
            p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * t,
            p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * t,
          );
          if (Math.abs(value) < 1e-5) break;
          if (value * flo > 0) {
            lo = t;
            flo = value;
          } else {
            hi = t;
            fhi = value;
          }
          t = lo + ((hi - lo) * flo) / (flo - fhi);
        }
        t = clamp(t, 0.02, 0.98);
        const x = sx[a] + (sx[b] - sx[a]) * t;
        // The cut stops at the corners; past them the lips stay one surface.
        if (x < 0 || x > 1) continue;
        marks.set(key, { t, low: a, seam: true });
      }
    }
    if (!marks.size && onSeam.size < 3) return refuse('the lip line crosses nothing');
    work.onSplit = (id, mark, a, b) => {
      if (!mark.seam) return;
      onSeam.add(id);
      phi[id] = 0;
      sx[id] = sx[a] + (sx[b] - sx[a]) * mark.t;
      sy[id] = frame.height(sx[id]);
    };
    applyMarks(marks);
    work.onSplit = null;
  }

  // ---- 3. Which lip does each face belong to? ----------------------------
  const sideOf = (f) => {
    const s = work.simFace(f);
    let total = 0;
    for (const v of s) {
      locate(v);
      total += phi[v];
    }
    if (Math.abs(total) > 1e-9) return Math.sign(total);
    const c = centroid(s);
    return Math.sign(phiAt(c[0], c[1], c[2]));
  };
  const seamFaces = new Map(); // seam edge -> the faces either side of it
  for (const f of region) {
    const s = work.simFace(f);
    for (let k = 0; k < 3; k++) {
      const a = s[k],
        b = s[(k + 1) % 3];
      if (!onSeam.has(a) || !onSeam.has(b)) continue;
      const key = edgeKey(a, b);
      const entry = seamFaces.get(key) ?? { a, b, faces: [] };
      entry.faces.push({ f, side: sideOf(f), from: a, to: b });
      seamFaces.set(key, entry);
    }
  }
  const links = new Map();
  const seamEdges = [];
  for (const entry of seamFaces.values()) {
    const above = entry.faces.filter((x) => x.side > 0),
      below = entry.faces.filter((x) => x.side < 0);
    // A real seam edge has exactly one lip on each side of it.
    if (above.length !== 1 || below.length !== 1 || entry.faces.length !== 2) continue;
    seamEdges.push({ ...entry, above: above[0], below: below[0] });
    for (const [u, v] of [
      [entry.a, entry.b],
      [entry.b, entry.a],
    ]) {
      if (!links.has(u)) links.set(u, []);
      links.get(u).push(v);
    }
  }
  // The seam has to be one unbranched path. Anything else means the lip line
  // ran over torn or folded geometry, and a half-cut mouth is worse than none.
  const ends = [...links.keys()].filter((v) => links.get(v).length === 1);
  if (ends.length !== 2 || [...links.values()].some((list) => list.length > 2))
    return refuse(
      `the seam is not one path (${ends.length} ends, ${seamEdges.length} edges, ` +
        `${[...links.values()].filter((list) => list.length > 2).length} branches)`,
    );
  ends.sort((a, b) => sx[a] - sx[b]);
  const chain = [ends[0]];
  for (let previous = -1, current = ends[0]; current !== ends[1];) {
    const next = links.get(current).find((v) => v !== previous);
    if (next === undefined || chain.length > links.size)
      return refuse('the seam loops');
    chain.push(next);
    previous = current;
    current = next;
  }
  if (chain.length !== links.size || chain.length < 5)
    return refuse('the seam is in pieces');
  if (sx[chain[chain.length - 1]] - sx[chain[0]] < 0.7)
    return refuse('the seam stops short of the corners');

  // ---- 4. Part the lips: the lower lip gets its own copy of the seam -----
  const interior = new Set(chain.slice(1, -1));
  const lowerOf = new Map();
  for (const v of interior) lowerOf.set(v, work.cloneSim(v));
  const lowerRender = new Map();
  for (const f of [...live]) {
    const s = work.simFace(f);
    if (!s.some((v) => interior.has(v))) continue;
    if (sideOf(f) >= 0) continue;
    const r = work.renderFace(f);
    work.writeFace(
      f,
      s.map((v, k) => {
        if (!interior.has(v)) return { s: v, r: r[k] };
        const copy = lowerOf.get(v);
        if (!lowerRender.has(r[k])) lowerRender.set(r[k], work.cloneRender(r[k], copy));
        return { s: copy, r: lowerRender.get(r[k]) };
      }),
    );
  }
  const upperChain = chain,
    lowerChain = chain.map((v) => lowerOf.get(v) ?? v);

  // ---- 5. The inside of the mouth -----------------------------------------
  // Behind each lip hangs a sheet: the inner lip, then the roof (or floor) of the
  // mouth, then the back of it, where a wall joins the two sheets into one closed
  // pouch. It is part of the head, so it swings with the jaw like everything
  // else, and an open mouth shows a mouth instead of the inside of a skull.
  //
  // Each sheet hangs from its OWN copy of the lip edge, so the normals of the
  // visible lip are exactly what they were.
  const innerUpper = [],
    innerLower = [];
  const span = sx[chain[chain.length - 1]] - sx[chain[0]] || 1;
  const taper = (v) =>
    Math.sin(Math.PI * clamp((sx[v] - sx[chain[0]]) / span, 0, 1)) ** 0.75;
  const edgeLookup = new Map(seamEdges.map((e) => [edgeKey(e.a, e.b), e]));
  // The whole pouch is drawn in one colour: the middle of the largest lower-lip
  // face beside the seam, mid-mouth. A Meshy atlas is hundreds of small islands
  // with black between them, and the pouch's long thin faces are drawn from its
  // coarsest mip levels, so texture taken from the lip EDGE bleeds that black in
  // as streaks. One texel in the middle of a face cannot.
  let swatch = null,
    largest = -1;
  for (const edge of seamEdges) {
    if (taper(edge.a) < 0.8 || taper(edge.b) < 0.8) continue;
    const s = work.simFace(edge.below.f);
    const size =
      work.distance(s[0], s[1]) * work.distance(s[1], s[2]) * work.distance(s[2], s[0]);
    if (size > largest) {
      largest = size;
      swatch = work.renderFace(edge.below.f);
    }
  }
  if (!swatch) return refuse('no lip face to colour the mouth from');
  // A row that climbs the back of a lip is only millimetres under the skin, and
  // under a lower lip the skin dives into the fold above the chin. Wherever a row
  // would come within `margin` of the surface in front of it (or through it), it
  // is pushed straight back until it is not.
  const tuck = (v, offset, margin) => {
    if (!(margin > 0)) return offset;
    const p = work.simP,
      at = [0, 1, 2].map((k) => p[v * 3 + k] + offset[k]);
    for (let tries = 0; tries < 12; tries++) {
      const [x, y] = frame.to(input.project(at[0], at[1], at[2])),
        ahead = sight.ahead(at, forward, x, y);
      if (ahead >= margin && ahead < Infinity) break;
      const step = ahead === Infinity ? width * 0.04 : margin - ahead + width * 0.002;
      for (let k = 0; k < 3; k++) at[k] -= forward[k] * step;
    }
    return [0, 1, 2].map((k) => at[k] - p[v * 3 + k]);
  };
  const hang = (row, sign, record) => {
    const rows = POUCH.map(([rise, depth, shade], j) =>
      row.map((v, i) => {
        const reach = width * taper(chain[i]),
          offset = [0, 1, 2].map(
            (k) => (sign * rise * up[k] - depth * forward[k]) * reach,
          );
        // Row 0 IS the lip edge and stays on it.
        return work.cloneSim(v, j ? tuck(v, offset, reach * 0.05) : offset, shade);
      }),
    );
    for (const list of rows) record.push(...list);
    const back = [],
      painted = new Map();
    for (let i = 0; i + 1 < row.length; i++) {
      const edge = edgeLookup.get(edgeKey(chain[i], chain[i + 1]));
      if (!edge) continue;
      const face = sign > 0 ? edge.above : edge.below,
        s = work.simFace(face.f),
        r = work.renderFace(face.f);
      const a = s.indexOf(row[i]),
        b = s.indexOf(row[i + 1]);
      if (a < 0 || b < 0) continue;
      const corner = (j, n) => {
        const sim = rows[j][i + n];
        if (!painted.has(sim))
          painted.set(sim, work.swatchRender(swatch, sim, r[n ? b : a]));
        return { s: sim, r: painted.get(sim) };
      };
      // Wind against the lip face across the shared edge, so the sheet is the
      // same surface rolling over the lip, not one facing into it.
      const along = (a + 1) % 3 === b;
      for (let j = 0; j + 1 < rows.length; j++) {
        const p = corner(j, 0),
          q = corner(j, 1),
          pp = corner(j + 1, 0),
          qq = corner(j + 1, 1);
        if (along) {
          work.writeFace(-1, [q, p, pp]);
          work.writeFace(-1, [q, pp, qq]);
        } else {
          work.writeFace(-1, [p, q, qq]);
          work.writeFace(-1, [p, qq, pp]);
        }
      }
      back.push({
        i,
        along,
        p: corner(rows.length - 1, 0),
        q: corner(rows.length - 1, 1),
      });
    }
    return back;
  };
  const roof = hang(upperChain, 1, innerUpper),
    floor = new Map(hang(lowerChain, -1, innerLower).map((entry) => [entry.i, entry]));
  // The back wall. Its faces hold vertices of both sheets, so it is the one part
  // of the head that stretches as the jaw drops, which is what a mouth does.
  for (const top of roof) {
    const bottom = floor.get(top.i);
    if (!bottom) continue;
    if (top.along) {
      work.writeFace(-1, [top.p, top.q, bottom.q]);
      work.writeFace(-1, [top.p, bottom.q, bottom.p]);
    } else {
      work.writeFace(-1, [top.q, top.p, bottom.p]);
      work.writeFace(-1, [top.q, bottom.p, bottom.q]);
    }
  }

  return work.finish({
    version: LIP_TOPOLOGY_VERSION,
    seam: upperChain,
    upper: upperChain.slice(1, -1),
    lower: lowerChain.slice(1, -1),
    corners: [chain[0], chain[chain.length - 1]],
    innerUpper,
    innerLower,
    width,
  });
}

/**
 * What lies in front of and behind a surface, along the view. Rays run along the
 * view, so a ray can only meet faces that project onto the same spot: the faces
 * of the column through the mouth are binned by where they project, and a ray is
 * tested against its own bin. Binned on the raw projection, not on height above
 * the lip line, so one table serves every shift of that line.
 */
function lineOfSight({ work, sx, sy, width }) {
  const p = work.simP,
    column = [],
    CELLS = 30,
    grid = new Map(),
    cellOf = (x, y) =>
      Math.floor(((x + 0.4) / 1.8) * CELLS) * 1024 +
      Math.floor(((y + 0.9) / 1.8) * CELLS);
  for (let f = 0; f < work.faceCount(); f++) {
    const s = work.simFace(f);
    if (!s) continue;
    work.project(s, sx, sy);
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const v of s) {
      x0 = Math.min(x0, sx[v]);
      x1 = Math.max(x1, sx[v]);
      y0 = Math.min(y0, sy[v]);
      y1 = Math.max(y1, sy[v]);
    }
    if (x1 < -0.4 || x0 > 1.4 || y1 < -0.9 || y0 > 0.9) continue;
    column.push(f);
    // One cell of slack: under a perspective view a ray drifts across the image.
    const i0 = Math.floor(((x0 + 0.4) / 1.8) * CELLS) - 1,
      i1 = Math.floor(((x1 + 0.4) / 1.8) * CELLS) + 1,
      j0 = Math.floor(((y0 + 0.9) / 1.8) * CELLS) - 1,
      j1 = Math.floor(((y1 + 0.9) / 1.8) * CELLS) + 1;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = i * 1024 + j;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(f);
      }
  }
  // `clearance` is how far away the blocker must be: skin that merely folds over
  // itself (the crease at a mouth corner) is millimetres from what covers it.
  const blocked = (origin, direction, self, clearance = width * 0.01) => {
    const s0 = work.simFace(self),
      x = (sx[s0[0]] + sx[s0[1]] + sx[s0[2]]) / 3,
      y = (sy[s0[0]] + sy[s0[1]] + sy[s0[2]]) / 3;
    for (const f of grid.get(cellOf(x, y)) ?? []) {
      if (f === self) continue;
      const s = work.simFace(f),
        a = s[0] * 3,
        e1 = [0, 1, 2].map((k) => p[s[1] * 3 + k] - p[a + k]),
        e2 = [0, 1, 2].map((k) => p[s[2] * 3 + k] - p[a + k]);
      const h = [
        direction[1] * e2[2] - direction[2] * e2[1],
        direction[2] * e2[0] - direction[0] * e2[2],
        direction[0] * e2[1] - direction[1] * e2[0],
      ];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-14) continue;
      const t0 = [origin[0] - p[a], origin[1] - p[a + 1], origin[2] - p[a + 2]],
        u = (t0[0] * h[0] + t0[1] * h[1] + t0[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [
        t0[1] * e1[2] - t0[2] * e1[1],
        t0[2] * e1[0] - t0[0] * e1[2],
        t0[0] * e1[1] - t0[1] * e1[0],
      ];
      const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > clearance) return true;
    }
    return false;
  };
  // How far to the first surface from any point, given where that point projects.
  const ahead = (origin, direction, x, y) => {
    let nearest = Infinity;
    for (const f of grid.get(cellOf(x, y)) ?? []) {
      const s = work.simFace(f),
        a = s[0] * 3,
        e1 = [0, 1, 2].map((k) => p[s[1] * 3 + k] - p[a + k]),
        e2 = [0, 1, 2].map((k) => p[s[2] * 3 + k] - p[a + k]);
      const h = [
        direction[1] * e2[2] - direction[2] * e2[1],
        direction[2] * e2[0] - direction[0] * e2[2],
        direction[0] * e2[1] - direction[1] * e2[0],
      ];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-14) continue;
      const t0 = [origin[0] - p[a], origin[1] - p[a + 1], origin[2] - p[a + 2]],
        u = (t0[0] * h[0] + t0[1] * h[1] + t0[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [
        t0[1] * e1[2] - t0[2] * e1[1],
        t0[2] * e1[0] - t0[0] * e1[2],
        t0[0] * e1[1] - t0[1] * e1[0],
      ];
      const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (t > -width * 1e-4 && t < nearest) nearest = Math.max(t, 0);
    }
    return nearest;
  };
  return { blocked, column, ahead };
}

/**
 * Adopt lips the mesh already has. Nothing is moved, split or added; what comes
 * back is the knowledge the rigs and the renderer were missing:
 *
 *   sides   which lip every vertex around the mouth belongs to, found by walking
 *           the surface outwards from skin that is certainly upper or lower lip.
 *           The two lips only meet at the corners and at the back of the mouth,
 *           so the nearer source over the surface is always the right one, even
 *           for an upper lip that hangs below the top of the lower lip, where
 *           height alone gets it wrong and the opening comes out ragged.
 *   seam    the line between the lips, as points midway between their edges.
 *   shade   the inside of the mouth, darkened with depth. A template's mouth bag
 *           has no photograph on it, so it shows as a pale line between closed
 *           lips and a pale hole between open ones.
 */
function adoptMouth({
  work,
  skin: region,
  sight,
  seat,
  sx,
  phi,
  centre,
  width,
  forward,
}) {
  const p = work.simP,
    { blocked, column } = sight;
  const behind = (v) =>
    (centre[0] - p[v * 3]) * forward[0] +
    (centre[1] - p[v * 3 + 1]) * forward[1] +
    (centre[2] - p[v * 3 + 2]) * forward[2];
  const skin = new Set();
  for (const f of region) for (const v of work.simFace(f)) skin.add(v);

  // The inside, part one: the inner lips and any mouth bag, walked from the lip
  // edges over faces that are not skin, and kept close to the mouth.
  const byVertex = new Map();
  for (const f of column) {
    if (region.has(f)) continue;
    for (const v of work.simFace(f)) {
      if (!byVertex.has(v)) byVertex.set(v, []);
      byVertex.get(v).push(f);
    }
  }
  const within = (f) => {
    const { x, y, depth } = seat(f);
    return (
      x > -0.1 &&
      x < 1.1 &&
      Math.abs(y) < 0.6 &&
      depth > -0.1 * width &&
      depth < 0.9 * width
    );
  };
  const inside = new Set(),
    queue = [];
  for (const v of skin) {
    if (!(Math.abs(phi[v]) < 0.2 && sx[v] > 0 && sx[v] < 1)) continue;
    for (const f of byVertex.get(v) ?? [])
      if (!inside.has(f) && within(f)) {
        inside.add(f);
        queue.push(f);
      }
  }
  while (queue.length)
    for (const v of work.simFace(queue.pop()))
      for (const f of byVertex.get(v) ?? [])
        if (!inside.has(f) && within(f)) {
          inside.add(f);
          queue.push(f);
        }
  if (inside.size < 8)
    return refuse('the lips are parted but there is no mouth behind them');
  const mouthFaces = [...inside];

  // Part two: whatever else shows between parted lips. A head built as a hollow
  // shell has no mouth bag; you look straight through the lips at the far inside
  // wall, a hand's width back. Neither connectivity nor normals can be trusted to
  // find that and nothing else, so it is decided by what is in the way: a surface
  // is inside the head if something lies behind it AND either something lies in
  // front of it or it is deep behind the gap between the lips itself. Outer skin
  // fails one or the other everywhere: the face has nothing in front, the back of
  // the skull nothing behind.
  const backward = forward.map((v) => -v);
  for (const f of column) {
    if (region.has(f) || inside.has(f)) continue;
    const { x, y, c, depth } = seat(f);
    // Only behind the mouth itself, as tall as it can open: further down, the
    // skin under the jaw is "behind" the chin too, and that is not the inside.
    if (depth < width * 0.12 || Math.abs(y) > 0.55 || x < -0.15 || x > 1.15) continue;
    const throughTheGap =
      Math.abs(y) < 0.12 && x > 0.05 && x < 0.95 && depth > width * 0.3;
    if (
      blocked(c, backward, f) &&
      (throughTheGap || blocked(c, forward, f, width * 0.08))
    )
      inside.add(f);
  }

  // Walk the surface from certain upper-lip and lower-lip skin.
  const links = new Map();
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    links.get(a).push(b);
  };
  for (const f of [...region, ...mouthFaces]) {
    const s = work.simFace(f);
    for (let k = 0; k < 3; k++) {
      link(s[k], s[(k + 1) % 3]);
      link(s[(k + 1) % 3], s[k]);
    }
  }
  const distance = new Map(),
    label = new Map(),
    heap = [];
  const push = (d, v, side) => {
    heap.push([d, v, side]);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0],
      last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const v of skin) {
    if (sx[v] < 0.1 || sx[v] > 0.9) continue;
    if (phi[v] > 0.12 && phi[v] < 0.3) push(0, v, 1);
    else if (phi[v] < -0.12 && phi[v] > -0.3) push(0, v, -1);
  }
  // Sides only matter where the rigs reach, which is well within two mouth widths.
  while (heap.length) {
    const [d, v, side] = pop();
    if (distance.has(v) || d > width * 2) continue;
    distance.set(v, d);
    label.set(v, side);
    for (const w of links.get(v) ?? [])
      if (!distance.has(w)) push(d + work.distance(v, w), w, side);
  }
  // Lips can look parted and not be: a scan of a closed mouth has a deep crease
  // where they meet, and from the front the crease hides its own floor. Walk from
  // one lip to the other over the surface. Round a real mouth that is a long way
  // (down into it and back, or not connected at all); across a crease it is a few
  // millimetres. A crease is not adopted: its floor would stretch across the
  // opening like a tongue. It gets a seam cut along it instead.
  let across = Infinity;
  for (const [v, neighbours] of links) {
    if (!label.has(v) || sx[v] < 0.15 || sx[v] > 0.85) continue;
    for (const w of neighbours) {
      // Where the two lips meet out of sight. Skin that visibly bridges parted
      // lips is a different fault, and is dealt with below.
      if (skin.has(v) && skin.has(w)) continue;
      if (label.has(w) && label.get(w) !== label.get(v))
        across = Math.min(
          across,
          distance.get(v) + distance.get(w) + work.distance(v, w),
        );
    }
  }
  if (across < width * 0.55) return refuse('the lips meet at the bottom of a crease');
  const innerVertices = new Set();
  for (const f of inside)
    for (const v of work.simFace(f)) if (!skin.has(v)) innerVertices.add(v);
  const upper = [],
    lower = [];
  for (const [v, side] of label) {
    // Away from the lip line, on the skin, height says the same thing.
    if (!innerVertices.has(v) && Math.abs(phi[v]) > 0.12) continue;
    (side > 0 ? upper : lower).push(v);
  }
  if (upper.length < 6 || lower.length < 6)
    return refuse('could not tell the lips apart');

  // Lips parted along most of their length can still be joined by a strip of skin
  // (the reference head's are, mid-mouth), and that strip stretches across the
  // opening like a tongue. Between the corners no skin face may hold both lips:
  // the few that do are dropped. This is the old triangle-deleting aperture, but
  // only ever for faces that really bridge, never for everything near the lips.
  const bridges = [];
  for (const f of region) {
    const { x, y } = seat(f);
    if (x < 0.06 || x > 0.94 || Math.abs(y) > 0.2) continue;
    const sides = work.simFace(f).map((v) => label.get(v) ?? 0);
    if (sides.some((side) => side > 0) && sides.some((side) => side < 0))
      bridges.push(f);
  }
  work.dropFaces(bridges);

  // The seam: midway between the two lip edges, column by column.
  const columns = 24,
    seamPoints = [],
    seamAt = [],
    seamDepth = [];
  for (let k = 0; k <= columns; k++) {
    const x = k / columns;
    let top = -1,
      bottom = -1;
    for (const [v, side] of label) {
      if (Math.abs(sx[v] - x) > 0.035 || behind(v) > width * 0.45) continue;
      if (side > 0 && (top < 0 || phi[v] < phi[top])) top = v;
      if (side < 0 && (bottom < 0 || phi[v] > phi[bottom])) bottom = v;
    }
    if (top < 0 || bottom < 0) continue;
    // The gap has to be where the lip line was found, give or take the few
    // millimetres it was searched over. A messy scan can offer a "gap" elsewhere.
    if (Math.abs(phi[top] + phi[bottom]) / 2 > 0.12) continue;
    for (let i = 0; i < 3; i++)
      seamPoints.push((p[top * 3 + i] + p[bottom * 3 + i]) / 2);
    seamAt.push(x);
    seamDepth.push((behind(top) + behind(bottom)) / 2);
  }
  if (seamPoints.length < 15 * 3)
    return refuse('the gap between the lips could not be traced');
  // And the two lips have to be the two lips: clear of the lip line, skin above it
  // is upper lip and skin below it lower. If the walk says otherwise often, this
  // is not a mouth it understands.
  let agree = 0,
    judged = 0;
  for (const v of skin) {
    if (!label.has(v) || sx[v] < 0.1 || sx[v] > 0.9 || Math.abs(phi[v]) < 0.12)
      continue;
    judged++;
    agree += Math.sign(phi[v]) === label.get(v);
  }
  if (judged < 20 || agree < judged * 0.95)
    return refuse('the lips could not be told apart');

  // Darken the inside with depth behind the lips: behind the lip line where the
  // vertex is, not behind the middle of the mouth. A mouth curves round the teeth,
  // so its corners sit a centimetre further back than its centre, and measured
  // from the centre the skin in the corner creases comes out black.
  const lipDepth = (x) => {
    let i = 0;
    while (i < seamAt.length - 2 && x > seamAt[i + 1]) i++;
    const t = clamp((x - seamAt[i]) / (seamAt[i + 1] - seamAt[i] || 1), 0, 1);
    return seamDepth[i] + (seamDepth[i + 1] - seamDepth[i]) * t;
  };
  const shadeVertices = [],
    shadeValues = [];
  for (const v of innerVertices) {
    const value =
      1 - 0.94 * smooth(width * 0.015, width * 0.2, behind(v) - lipDepth(sx[v] ?? 0.5));
    if (value > 0.995) continue;
    shadeVertices.push(v);
    shadeValues.push(Math.round(value * 1000) / 1000);
  }
  return work.finish({
    version: LIP_TOPOLOGY_VERSION,
    native: true,
    shadeVersion: NATIVE_MOUTH_SHADE_VERSION,
    seam: [],
    seamPoints: seamPoints.map((v) => Math.round(v * 1e6) / 1e6),
    upper,
    lower,
    corners: [],
    innerUpper: [],
    innerLower: [],
    width,
    shade: { vertices: shadeVertices, values: shadeValues },
    removedTriangles: bridges.length,
  });
}

const normalise = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

// ---------------------------------------------------------------------------
// Workspaces. Both present the same surface to `cutLips`: simulation vertices
// for topology, render vertices for texture, one face list shared by the two.
// ---------------------------------------------------------------------------

/** A face list without the dropped faces. */
function keep(faces, dropped) {
  if (!dropped.size) return faces;
  const kept = [];
  for (let f = 0; f < faces.length / 3; f++)
    if (!dropped.has(f)) kept.push(faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]);
  return kept;
}

function growable(attributes) {
  return Object.entries(attributes ?? {})
    .filter(([, a]) => a?.array && a.itemSize > 0)
    .map(([name, a]) => ({ name, itemSize: a.itemSize, values: Array.from(a.array) }));
}

function lerpAppend(attribute, a, b, t) {
  const { itemSize: n, values } = attribute;
  for (let k = 0; k < n; k++)
    values.push(values[a * n + k] + (values[b * n + k] - values[a * n + k]) * t);
}

function validIndices(indices, count) {
  if (!indices || indices.length % 3 || !indices.length) return false;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!Number.isInteger(v) || v < 0 || v >= count) return false;
  }
  return true;
}

/** A welded simulation surface with a texture atlas of render copies. */
function atlasWorkspace(input) {
  const { atlas } = input;
  const simP = Array.from(input.positions),
    count = simP.length / 3;
  if (!validIndices(input.indices, count)) return null;
  if (
    !atlas.mapping?.length ||
    atlas.uv?.length !== atlas.mapping.length * 2 ||
    atlas.indices?.length !== input.indices.length ||
    !validIndices(atlas.indices, atlas.mapping.length)
  )
    return null;
  const T = Array.from(input.indices),
    R = Array.from(atlas.indices),
    M = Array.from(atlas.mapping);
  // The two face lists must describe the same triangles in the same order.
  for (let i = 0; i < T.length; i++) if (M[R[i]] !== T[i]) return null;
  const simAttributes = growable(input.attributes),
    uv = { name: 'uv', itemSize: 2, values: Array.from(atlas.uv) };
  const parents = [],
    renderSplits = new Map(),
    shades = new Map(),
    dropped = new Set();
  const work = {
    simP,
    onSplit: null,
    faceCount: () => T.length / 3,
    simFace: (f) => [T[f * 3], T[f * 3 + 1], T[f * 3 + 2]],
    renderFace: (f) => [R[f * 3], R[f * 3 + 1], R[f * 3 + 2]],
    distance: (a, b) =>
      Math.hypot(
        simP[a * 3] - simP[b * 3],
        simP[a * 3 + 1] - simP[b * 3 + 1],
        simP[a * 3 + 2] - simP[b * 3 + 2],
      ),
    splitEdge(mark, a, b, ra, rb) {
      const t = mark.low === a ? mark.t : 1 - mark.t;
      if (mark.id === undefined) {
        mark.id = simP.length / 3;
        for (let k = 0; k < 3; k++)
          simP.push(simP[a * 3 + k] + (simP[b * 3 + k] - simP[a * 3 + k]) * t);
        for (const attribute of simAttributes) lerpAppend(attribute, a, b, t);
        parents.push(a, b, t, 0, 0, 0);
        work.onSplit?.(mark.id, mark, mark.low, mark.low === a ? b : a);
      }
      const key = edgeKey(ra, rb);
      let r = renderSplits.get(key);
      if (r === undefined) {
        r = M.length;
        M.push(mark.id);
        lerpAppend(uv, ra, rb, t);
        renderSplits.set(key, r);
      }
      return { s: mark.id, r };
    },
    cloneSim(v, offset = [0, 0, 0], shade = 1) {
      const id = simP.length / 3;
      for (let k = 0; k < 3; k++) simP.push(simP[v * 3 + k] + offset[k]);
      for (const attribute of simAttributes) lerpAppend(attribute, v, v, 0);
      parents.push(v, v, 0, offset[0], offset[1], offset[2]);
      if (shade !== 1) shades.set(id, shade);
      return id;
    },
    cloneRender(r, sim) {
      M.push(sim);
      lerpAppend(uv, r, r, 0);
      return M.length - 1;
    },
    // A render vertex textured from the middle of `face`.
    swatchRender(face, sim) {
      M.push(sim);
      for (let k = 0; k < 2; k++)
        uv.values.push(
          (uv.values[face[0] * 2 + k] +
            uv.values[face[1] * 2 + k] +
            uv.values[face[2] * 2 + k]) /
            3,
        );
      return M.length - 1;
    },
    writeFace(f, corners) {
      const at = f < 0 ? T.length : f * 3;
      for (let k = 0; k < 3; k++) {
        T[at + k] = corners[k].s;
        R[at + k] = corners[k].r;
      }
      return at / 3;
    },
    dropFaces(faces) {
      for (const f of faces) dropped.add(f);
    },
    finish: (topology) => ({
      positions: new Float32Array(simP),
      indices: new Uint32Array(keep(T, dropped)),
      attributes: Object.fromEntries(
        simAttributes.map((a) => [
          a.name,
          { itemSize: a.itemSize, array: new Float32Array(a.values) },
        ]),
      ),
      atlas: { ...atlas, mapping: M, indices: keep(R, dropped), uv: uv.values },
      parents: new Float32Array(parents),
      topology: describe(
        {
          ...topology,
          shade:
            topology.shade ?? shadeList(count, simP.length / 3, (v) => shades.get(v)),
        },
        count,
        input.indices.length / 3,
        simP.length / 3,
        keep(T, dropped),
      ),
    }),
  };
  return work;
}

/**
 * One indexed geometry, torn along its UV seams. Coincident vertices near the
 * mouth are grouped so the surface can be walked as the single sheet it is.
 */
function rawWorkspace(input, width) {
  const count = input.positions.length / 3;
  if (!validIndices(input.indices, count)) return null;
  const position = {
      name: 'position',
      itemSize: 3,
      values: Array.from(input.positions),
    },
    attributes = [position, ...growable(input.attributes)],
    R = Array.from(input.indices),
    P = position.values;
  // Generous, so every face that shares an edge with a split one is known here.
  const reach = (width * (CANDIDATE_RADIUS + 0.6)) ** 2,
    c = input.centre;
  const simP = [],
    simOf = new Map(),
    copies = [],
    classes = new Map();
  for (let v = 0; v < count; v++) {
    const x = P[v * 3],
      y = P[v * 3 + 1],
      z = P[v * 3 + 2];
    if ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 > reach) continue;
    const key = `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;
    let s = classes.get(key);
    if (s === undefined) {
      s = simP.length / 3;
      classes.set(key, s);
      simP.push(x, y, z);
      copies.push([]);
    }
    simOf.set(v, s);
    copies[s].push(v);
  }
  const parents = [],
    renderSplits = new Map(),
    offsets = new Map(),
    shades = new Map(),
    dropped = new Set(),
    zero = [0, 0, 0];
  // `a`-`b` at `t` is where the texture comes from. The position is the
  // simulation vertex's own, which for an inner-lip vertex is `from` plus an
  // offset rather than anywhere on that edge, so its parentage is kept apart.
  const newRender = (sim, a, b, t, from = null) => {
    const id = P.length / 3;
    for (const attribute of attributes) lerpAppend(attribute, a, b, t);
    for (let k = 0; k < 3; k++) P[id * 3 + k] = simP[sim * 3 + k];
    const offset = from === null ? zero : (offsets.get(sim) ?? zero);
    if (from === null) parents.push(a, b, t, 0, 0, 0);
    else parents.push(from, from, 0, offset[0], offset[1], offset[2]);
    simOf.set(id, sim);
    copies[sim].push(id);
    return id;
  };
  const work = {
    simP,
    onSplit: null,
    faceCount: () => R.length / 3,
    simFace(f) {
      const a = simOf.get(R[f * 3]),
        b = simOf.get(R[f * 3 + 1]),
        d = simOf.get(R[f * 3 + 2]);
      return a === undefined || b === undefined || d === undefined ? null : [a, b, d];
    },
    renderFace: (f) => [R[f * 3], R[f * 3 + 1], R[f * 3 + 2]],
    distance: (a, b) =>
      Math.hypot(
        simP[a * 3] - simP[b * 3],
        simP[a * 3 + 1] - simP[b * 3 + 1],
        simP[a * 3 + 2] - simP[b * 3 + 2],
      ),
    splitEdge(mark, a, b, ra, rb) {
      const t = mark.low === a ? mark.t : 1 - mark.t;
      if (mark.id === undefined) {
        mark.id = simP.length / 3;
        for (let k = 0; k < 3; k++)
          simP.push(simP[a * 3 + k] + (simP[b * 3 + k] - simP[a * 3 + k]) * t);
        copies.push([]);
        work.onSplit?.(mark.id, mark, mark.low, mark.low === a ? b : a);
      }
      const key = edgeKey(ra, rb);
      let r = renderSplits.get(key);
      if (r === undefined) {
        r = newRender(mark.id, ra, rb, t);
        renderSplits.set(key, r);
      }
      return { s: mark.id, r };
    },
    cloneSim(v, offset = zero, shade = 1) {
      const id = simP.length / 3;
      for (let k = 0; k < 3; k++) simP.push(simP[v * 3 + k] + offset[k]);
      copies.push([]);
      offsets.set(id, offset);
      if (shade !== 1) shades.set(id, shade);
      return id;
    },
    cloneRender: (r, sim) => newRender(sim, r, r, 0, r),
    // A render vertex textured from the middle of `face`, positioned off `from`.
    swatchRender(face, sim, from) {
      const id = newRender(sim, from, from, 0, from);
      for (const attribute of attributes.slice(1)) {
        const { itemSize: n, values } = attribute;
        for (let k = 0; k < n; k++)
          values[id * n + k] =
            (values[face[0] * n + k] +
              values[face[1] * n + k] +
              values[face[2] * n + k]) /
            3;
      }
      return id;
    },
    writeFace(f, corners) {
      const at = f < 0 ? R.length : f * 3;
      for (let k = 0; k < 3; k++) R[at + k] = corners[k].r;
      return at / 3;
    },
    dropFaces(faces) {
      for (const f of faces) dropped.add(f);
    },
    finish(topology) {
      // Here a lip vertex is every render copy of it, since the rig reads sides
      // per vertex of the geometry it is handed. `seam` keeps one copy per
      // point, in order: it is only ever read for its positions.
      const all = (list) => list.flatMap((s) => copies[s]),
        faces = keep(R, dropped);
      const used = new Set(faces);
      const expanded = {
        ...topology,
        seam: topology.seam.map(
          (s) => copies[s].find((v) => used.has(v)) ?? copies[s][0],
        ),
        upper: all(topology.upper),
        lower: all(topology.lower),
        corners: all(topology.corners),
        innerUpper: all(topology.innerUpper),
        innerLower: all(topology.innerLower),
        // An adopted mouth lists welded vertices; here each is all its copies.
        shade: topology.shade
          ? {
              vertices: topology.shade.vertices.flatMap((s) => copies[s]),
              values: topology.shade.vertices.flatMap((s, i) =>
                copies[s].map(() => topology.shade.values[i]),
              ),
            }
          : shadeList(count, P.length / 3, (v) => shades.get(simOf.get(v))),
      };
      return {
        positions: new Float32Array(P),
        indices: new Uint32Array(faces),
        attributes: Object.fromEntries(
          attributes
            .slice(1)
            .map((a) => [
              a.name,
              { itemSize: a.itemSize, array: new Float32Array(a.values) },
            ]),
        ),
        atlas: null,
        parents: new Float32Array(parents),
        topology: describe(
          expanded,
          count,
          input.indices.length / 3,
          P.length / 3,
          faces,
        ),
      };
    },
  };
  return work;
}

// How dark a vertex is drawn, for the few that are not simply 1: only ever the
// inside of a mouth. Sparse, because it is saved with every session.
function shadeList(start, end, shadeOf) {
  const vertices = [],
    values = [];
  for (let v = start; v < end; v++) {
    const shade = shadeOf(v);
    if (shade === undefined || shade === 1) continue;
    vertices.push(v);
    values.push(shade);
  }
  return { vertices, values };
}

function describe(topology, verticesBefore, trianglesBefore, vertices, faces) {
  return {
    ...topology,
    vertices,
    triangles: faces.length / 3,
    addedVertices: vertices - verticesBefore,
    addedTriangles: faces.length / 3 - trianglesBefore,
    originalVertices: verticesBefore,
  };
}

/**
 * Carry a per-vertex array (rest shape, Newton binding, sculpt history) onto a
 * cut head. `parents` holds, for each appended vertex, the edge it sits on, how
 * far along, and for an inner-lip vertex its offset from the lip edge.
 *
 *   blend   true for quantities that vary over the surface (positions);
 *           false copies from the nearer parent (indices, weights, flags).
 *   offset  true for positions, which an inner-lip vertex holds displaced.
 */
export function extendVertexField(
  field,
  itemSize,
  parents,
  { blend = true, offset = false } = {},
) {
  const before = field.length / itemSize,
    added = parents.length / 6,
    total = field.length + added * itemSize;
  // A binding read from JSON is a plain array; everything else is typed.
  const out = ArrayBuffer.isView(field)
    ? new field.constructor(total)
    : new Array(total);
  for (let i = 0; i < field.length; i++) out[i] = field[i];
  for (let i = 0; i < added; i++) {
    const a = parents[i * 6],
      b = parents[i * 6 + 1],
      t = parents[i * 6 + 2],
      at = (before + i) * itemSize;
    for (let k = 0; k < itemSize; k++) {
      const from = out[a * itemSize + k],
        to = out[b * itemSize + k];
      out[at + k] = blend ? from + (to - from) * t : t < 0.5 ? from : to;
      if (offset && itemSize === 3) out[at + k] += parents[i * 6 + 3 + k];
    }
  }
  return out;
}

/** Whether a stored topology still describes this vertex buffer. */
export function lipTopologyFits(topology, vertexCount) {
  if (topology?.version !== LIP_TOPOLOGY_VERSION || topology.vertices !== vertexCount)
    return false;
  const lists = ['seam', 'upper', 'lower', 'corners', 'innerUpper', 'innerLower'];
  return (
    // A cut mouth has a chain of seam vertices; an adopted one has seam points.
    (topology.seam?.length >= 5 || topology.seamPoints?.length >= 45) &&
    lists.every(
      (name) =>
        Array.isArray(topology[name]) &&
        topology[name].every((v) => Number.isInteger(v) && v >= 0 && v < vertexCount),
    )
  );
}

/**
 * Where every vertex sits relative to the lip seam, for the rigs.
 *
 * `side` is +1 on the upper lip and -1 on the lower. On the seam itself it comes
 * from the cut, which is the whole point: the two copies of a seam vertex share
 * a position, so nothing computed from position can tell them apart. `height` is
 * metres above the seam, `along` runs 0..1 corner to corner, `taper` is 1
 * mid-mouth and 0 at and beyond the corners, which is what keeps them closed.
 */
export function lipField(rest, topology) {
  const count = rest.length / 3;
  if (!lipTopologyFits(topology, count)) return null;
  // The seam as points: a cut mouth's chain of vertices, or an adopted mouth's
  // own record of the line between its lips.
  const line = topology.seamPoints?.length
    ? topology.seamPoints
    : topology.seam.flatMap((v) => [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]]);
  const last = line.length - 3,
    left = line.slice(0, 3),
    right = line.slice(last, last + 3);
  const dx = right[0] - left[0],
    dy = right[1] - left[1],
    width = Math.hypot(dx, dy);
  if (!(width > 1e-6)) return null;
  const ex = [dx / width, dy / width],
    ey = ex[0] >= 0 ? [-ex[1], ex[0]] : [ex[1], -ex[0]];
  const knotX = [],
    knotY = [];
  for (let i = 0; i < line.length; i += 3) {
    const px = line[i] - left[0],
      py = line[i + 1] - left[1];
    knotX.push((px * ex[0] + py * ex[1]) / width);
    knotY.push(px * ey[0] + py * ey[1]);
  }
  const seamHeight = (x) => {
    if (x <= knotX[0] || x >= knotX[knotX.length - 1]) return 0;
    let i = 0;
    while (i < knotX.length - 2 && x > knotX[i + 1]) i++;
    const h = knotX[i + 1] - knotX[i];
    return h > 1e-9
      ? knotY[i] + ((knotY[i + 1] - knotY[i]) * (x - knotX[i])) / h
      : knotY[i];
  };
  const side = new Int8Array(count),
    height = new Float32Array(count),
    along = new Float32Array(count),
    taper = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const px = rest[v * 3] - left[0],
      py = rest[v * 3 + 1] - left[1],
      x = (px * ex[0] + py * ex[1]) / width;
    along[v] = x;
    height[v] = px * ey[0] + py * ey[1] - seamHeight(x);
    side[v] = height[v] > 0 ? 1 : height[v] < 0 ? -1 : 0;
    taper[v] = Math.sin(Math.PI * clamp(x, 0, 1)) ** 0.75;
  }
  for (const v of topology.upper) side[v] = 1;
  for (const v of topology.innerUpper) side[v] = 1;
  for (const v of topology.lower) side[v] = -1;
  for (const v of topology.innerLower) side[v] = -1;
  for (const v of topology.corners) side[v] = 0;
  // An inner-lip vertex sits behind the lip edge, not above or below it: treat
  // it as being on the seam so it travels exactly as its lip edge does.
  for (const v of [...topology.innerUpper, ...topology.innerLower]) height[v] = 0;
  const centre = [0, 1, 2].map((k) => (left[k] + right[k]) / 2);
  const middle = 3 * ((line.length / 3) >> 1);
  centre[1] = line[middle + 1];
  centre[2] = line[middle + 2];
  return {
    side,
    height,
    along,
    taper,
    width,
    centre,
    corners: [left, right],
    axis: ex,
    normal: ey,
  };
}
