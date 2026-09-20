// Keep the photographed head in its original camera coordinates. Face fitting
// can reject a pose/expression without erasing those pixels from the head mask.
export function headOutline(landmarks, ids) {
  if (!landmarks || landmarks.length < 468) return null;
  const oval = ids.map((id) => landmarks[id]);
  return oval.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? oval : null;
}

const boundsOf = (points) => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1])),
];

function fillPolygon(mask, width, height, points) {
  const bounds = boundsOf(points);
  for (
    let y = Math.max(0, Math.floor(bounds[1]));
    y <= Math.min(height - 1, bounds[3]);
    y++
  ) {
    const hits = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [ax, ay] = points[i],
        [bx, by] = points[j];
      if (ay > y + 0.5 !== by > y + 0.5)
        hits.push(ax + ((y + 0.5 - ay) * (bx - ax)) / (by - ay));
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2)
      for (
        let x = Math.max(0, Math.ceil(hits[i] - 0.5));
        x <= Math.min(width - 1, Math.floor(hits[i + 1] - 0.5));
        x++
      )
        mask[y * width + x] = 1;
  }
}

function components(mask, width, height) {
  const seen = new Uint8Array(mask.length),
    result = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [start];
    seen[start] = 1;
    let x0 = width,
      y0 = height,
      x1 = 0,
      y1 = 0;
    for (let at = 0; at < pixels.length; at++) {
      const index = pixels[at],
        x = index % width,
        y = Math.floor(index / width);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy,
            next = yy * width + xx;
          if (
            xx < 0 ||
            yy < 0 ||
            xx >= width ||
            yy >= height ||
            seen[next] ||
            !mask[next]
          )
            continue;
          seen[next] = 1;
          pixels.push(next);
        }
    }
    result.push({ pixels, bounds: [x0, y0, x1, y1] });
  }
  return result;
}

function fillHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length),
    queue = [];
  const add = (i) => {
    if (mask[i] || outside[i]) return;
    outside[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < width; x++) {
    add(x);
    add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    add(y * width);
    add(y * width + width - 1);
  }
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at],
      x = i % width,
      y = Math.floor(i / width);
    if (x) add(i - 1);
    if (x < width - 1) add(i + 1);
    if (y) add(i - width);
    if (y < height - 1) add(i + width);
  }
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1;
}

export function headCaptureMask({
  labels,
  width,
  height,
  oval = null,
  previous = null,
}) {
  const mask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++)
    mask[i] = +(labels[i] === 1 || labels[i] === 3 || labels[i] === 5);
  const face = oval?.map((p) => [p.x * width, p.y * height]);
  const faceBounds = face && boundsOf(face);
  // The outline protects glasses, eyebrows and closed mouths regardless of the
  // quality gate used for triangulating landmarks. It never changes the RGB.
  if (face) fillPolygon(mask, width, height, face);
  const groups = components(mask, width, height).filter((group) =>
    group.pixels.some((i) => labels[i] === 1 || labels[i] === 3),
  );
  if (!groups.length) return null;
  const anchor = faceBounds || previous;
  const score = (group) => {
    if (!anchor) return group.pixels.length;
    const [x0, y0, x1, y1] = group.bounds;
    const overlap =
      Math.max(0, Math.min(x1, anchor[2]) - Math.max(x0, anchor[0])) *
      Math.max(0, Math.min(y1, anchor[3]) - Math.max(y0, anchor[1]));
    const distance = Math.hypot(
      (x0 + x1 - anchor[0] - anchor[2]) / 2,
      (y0 + y1 - anchor[1] - anchor[3]) / 2,
    );
    return (
      (group.pixels.length + overlap * 3) /
      (1 + distance / Math.max(1, anchor[3] - anchor[1]))
    );
  };
  groups.sort((a, b) => score(b) - score(a));
  const primary = groups[0],
    box = [...primary.bounds];
  const headHeight = Math.max(1, box[3] - box[1]);
  mask.fill(0);
  // Keep disconnected wisps and ears close to the selected head. Unlike the old
  // front-view rectangle, a component is kept whole, including its outer edge.
  for (const group of groups) {
    const b = group.bounds;
    const gap = Math.hypot(
      Math.max(0, box[0] - b[2], b[0] - box[2]),
      Math.max(0, box[1] - b[3], b[1] - box[3]),
    );
    if (group !== primary && gap > headHeight * 0.08) continue;
    for (const i of group.pixels) mask[i] = 1;
  }
  // Body-skin contains ears and neck as well as arms. Restrict only that class,
  // using the current head instead of clipping hair and face at a stale chin.
  const chin = faceBounds ? faceBounds[3] : box[3];
  const neckBottom = Math.max(box[3], chin) + headHeight * 0.18;
  for (let y = Math.max(0, box[1]); y < Math.min(height, neckBottom); y++)
    for (
      let x = Math.max(0, Math.floor(box[0] - headHeight * 0.1));
      x <= Math.min(width - 1, box[2] + headHeight * 0.1);
      x++
    ) {
      const i = y * width + x;
      // Selfie multiclass label 5 contains accessories, including glasses. They
      // must survive in profile views where a face oval cannot be detected.
      if (labels[i] === 2 || (labels[i] === 5 && y <= box[3])) mask[i] = 1;
    }
  // Discard isolated skin (for example, a hand beside the head).
  const connected = components(mask, width, height);
  const head = connected.find((group) => group.pixels.includes(primary.pixels[0]));
  mask.fill(0);
  if (!head) return null;
  for (const i of head.pixels) mask[i] = 1;
  // Preserve near hair components even when they do not touch the main surface.
  for (const group of groups) {
    const b = group.bounds;
    const gap = Math.hypot(
      Math.max(0, box[0] - b[2], b[0] - box[2]),
      Math.max(0, box[1] - b[3], b[1] - box[3]),
    );
    if (gap <= headHeight * 0.08) for (const i of group.pixels) mask[i] = 1;
  }
  fillHoles(mask, width, height);
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  return { mask, bounds: [x0, y0, x1, y1], trackingBounds: box };
}
