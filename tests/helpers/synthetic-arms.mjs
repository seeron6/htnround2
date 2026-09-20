// Deliberately synthetic RGB + landmarks, shared by unit and browser scan tests.
export function syntheticArms() {
  const width = 640,
    height = 480;
  const data = new Uint8ClampedArray(width * height * 4);
  const landmarks = [],
    pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / width,
        v = y / height;
      let rgb = [30, 170, 75];
      for (const [cx, skin] of [
        [0.7, [194, 141, 104]],
        [0.3, [112, 75, 56]],
      ]) {
        if (Math.abs(u - cx) < 0.047 && v > 0.18 && v < 0.88) {
          rgb = skin;
          if (cx === 0.3 && v > 0.48) rgb = [32, 48, 90];
          if (cx === 0.7 && v > 0.62 && v < 0.65) rgb = [32, 39, 46];
        }
      }
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  for (const [cx, e, w] of [
    [0.7, 13, 15],
    [0.3, 14, 16],
  ]) {
    const hand = Array.from({ length: 21 }, () => ({ x: cx, y: 0.27, z: 0 }));
    hand[0] = { x: cx, y: 0.36, z: 0 };
    hand[5] = { x: cx - 0.045, y: 0.27, z: 0 };
    hand[17] = { x: cx + 0.045, y: 0.27, z: 0 };
    landmarks.push(hand);
    pose[e] = { x: cx, y: 0.84, z: 0, visibility: 1 };
    pose[w] = { x: cx, y: 0.36, z: 0, visibility: 1 };
  }
  return { image: { data, width, height }, landmarks, pose };
}

// Asymmetric wardrobe/accessories, with actual separated finger joints. Colors
// and pixel boundaries are fixture ground truth, not generated from scan output.
export function appearanceArms({ accessories = true } = {}) {
  const width = 1280,
    height = 960;
  const data = new Uint8ClampedArray(width * height * 4);
  const pose = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const landmarks = [];
  const paint = (left, top, right, bottom, rgb, inside = () => true) => {
    for (
      let y = Math.max(0, Math.floor(top * height));
      y < Math.min(height, Math.ceil(bottom * height));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(left * width));
        x < Math.min(width, Math.ceil(right * width));
        x++
      )
        if (inside(x / width, y / height)) data.set([...rgb, 255], (y * width + x) * 4);
  };
  paint(0, 0, 1, 1, [52, 135, 96]);
  const tones = { left: [88, 60, 48], right: [112, 75, 56] };
  for (const [side, cx, shoulder, elbow, wrist] of [
    ['left', 0.7, 11, 13, 15],
    ['right', 0.3, 12, 14, 16],
  ]) {
    const skin = tones[side];
    const hand = Array.from({ length: 21 }, () => ({ x: cx, y: 0.3, z: 0 }));
    hand[0] = { x: cx, y: 0.38, z: 0 };
    paint(cx - 0.037, 0.28, cx + 0.037, 0.93, skin);
    for (const [finger, dx] of [
      [1, -0.055],
      [2, -0.033],
      [3, -0.011],
      [4, 0.011],
      [5, 0.033],
    ]) {
      const first = finger === 1 ? 1 : 5 + (finger - 2) * 4;
      const base = finger === 1 ? 0.34 : 0.28;
      for (let joint = 0; joint < 4; joint++)
        hand[first + joint] = { x: cx + dx, y: base - joint * 0.06, z: 0 };
      paint(cx + dx - 0.008, base - 0.18, cx + dx + 0.008, base + 0.02, skin);
    }
    pose[shoulder] = { x: cx, y: 0.94, visibility: 1 };
    pose[elbow] = { x: cx, y: 0.74, visibility: 1 };
    pose[wrist] = { ...hand[0], visibility: 1 };
    landmarks.push(hand);
    if (side === 'left') {
      paint(cx - 0.037, 0.52, cx + 0.037, 0.93, [216, 207, 181]);
      // Thin seams must remain texture detail, without breaking the sleeve run.
      for (const y of [0.58, 0.66, 0.79, 0.88])
        paint(cx - 0.037, y, cx + 0.037, y + 0.003, [135, 114, 86]);
      if (accessories) {
        paint(cx - 0.035, 0.4, cx + 0.035, 0.431, [23, 28, 34]);
        paint(cx - 0.012, 0.398, cx + 0.012, 0.434, [8, 12, 18]);
      }
    } else {
      paint(cx - 0.037, 0.83, cx + 0.037, 0.93, [32, 48, 90]);
      if (accessories) paint(cx - 0.019, 0.25, cx - 0.003, 0.261, [204, 200, 191]);
    }
  }
  return { image: { data, width, height }, landmarks, pose };
}
