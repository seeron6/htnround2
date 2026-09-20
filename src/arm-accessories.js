// Accessory evidence is local to the matched anatomical hand. A band must have
// visible skin on either end, span the finger/wrist, and recur across frames.
// These are appearance estimates; an occluded accessory cannot be recovered.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const color = (pixels) => [0, 1, 2].map((i) => median(pixels.map((p) => p[i])));
const hex = (rgb) =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function band(pixel, a, b, halfWidth, aspect, skin, { from, to, rows, threshold }) {
  const dx = (b.x - a.x) * aspect,
    dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-5) return null;
  const colors = [],
    evidence = [];
  for (let row = 0; row < rows; row++) {
    const t = from + ((to - from) * row) / (rows - 1);
    const pixels = [];
    for (let col = -4; col <= 4; col++) {
      const across = (col / 4) * halfWidth;
      pixels.push(
        pixel(
          a.x + (b.x - a.x) * t - (dy / length / aspect) * across,
          a.y + (b.y - a.y) * t + (dx / length) * across,
        ),
      );
    }
    colors.push(pixels);
    evidence.push(
      pixels.filter((p) => distance(p, skin) > threshold).length / pixels.length,
    );
  }
  let best = null;
  for (let first = 1; first < rows - 2; first++) {
    if (evidence[first] < 0.7 || evidence[first - 1] >= 0.7) continue;
    let end = first;
    while (end < rows && evidence[end] >= 0.7) end++;
    const fraction = (end - first) / rows;
    if (end >= rows - 1 || fraction < 0.055 || fraction > 0.48) continue;
    const pixels = colors.slice(first, end).flat();
    const rgb = color(pixels);
    const before = color(colors.slice(Math.max(0, first - 3), first).flat());
    const after = color(colors.slice(end, Math.min(rows, end + 3)).flat());
    if (distance(rgb, before) < threshold || distance(rgb, after) < threshold) continue;
    const score = Math.min(
      1,
      Math.min(distance(rgb, before), distance(rgb, after)) / 80,
    );
    if (!best || score > best.score)
      best = {
        score,
        color: hex(rgb),
        centerColor: hex(
          color(colors.slice(first, end).flatMap((row) => row.slice(3, 6))),
        ),
        edgeColor: hex(
          color(colors.slice(first, end).flatMap((row) => [row[0], row[8]])),
        ),
        position: from + ((to - from) * (first + end)) / 2 / (rows - 1),
        fraction,
      };
  }
  return best;
}

export function sampleAccessories(
  pixel,
  hand,
  elbow,
  aspect,
  skin,
  span,
  imageHeight,
  wristSkin = skin,
) {
  const watch = band(pixel, hand[0], elbow, span * 0.28, aspect, wristSkin, {
    from: -0.015,
    to: 0.34,
    rows: 48,
    threshold: 38,
  });
  const rings = [];
  for (const [finger, mcp, pip] of [
    [1, 2, 3],
    [2, 5, 6],
    [3, 9, 10],
    [4, 13, 14],
    [5, 17, 18],
  ]) {
    const a = hand[mcp],
      b = hand[pip];
    if (
      !a ||
      !b ||
      [a.x, a.y, b.x, b.y].some((v) => !Number.isFinite(v) || v < 0.02 || v > 0.98)
    )
      continue;
    const length = Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    if (length * imageHeight < 9 || length < span * 0.13 || length > span * 0.9)
      continue;
    const match = band(pixel, a, b, span * 0.055, aspect, skin, {
      from: 0,
      to: 0.88,
      rows: 32,
      threshold: 32,
    });
    if (match && match.position < 0.62) rings.push({ ...match, finger });
  }
  rings.sort((a, b) => b.score - a.score);
  return {
    watch: watch && watch.position > 0.01 && watch.score >= 0.65 ? watch : null,
    ring: rings[0]?.score >= 0.55 ? rings[0] : null,
  };
}

export function fitAccessories(history) {
  const result = { watch: false, ring: false };
  for (const kind of ['watch', 'ring']) {
    const candidates = history.map((s) => s.accessories?.[kind]).filter(Boolean);
    const finger =
      kind === 'ring' && candidates.length
        ? [1, 2, 3, 4, 5].sort(
            (a, b) =>
              candidates.filter((c) => c.finger === b).length -
              candidates.filter((c) => c.finger === a).length,
          )[0]
        : null;
    const matching = candidates.filter((c) => kind !== 'ring' || c.finger === finger);
    // Require repeated evidence, without treating the hidden side of a turning
    // wrist as proof that an accessory is absent.
    if (matching.length < Math.max(3, Math.ceil(history.length * 0.16))) continue;
    const best = matching.reduce((a, b) => (a.score >= b.score ? a : b));
    result[kind] = true;
    if (kind === 'ring')
      Object.assign(result, {
        ringColor: best.color,
        ringFinger: finger,
        ringPosition: median(matching.map((c) => c.position)),
      });
    else
      Object.assign(result, {
        watchColor: best.edgeColor,
        watchFaceColor: best.centerColor,
        watchPosition: clamp(median(matching.map((c) => c.position)), 0.025, 0.24),
      });
  }
  return result;
}
