// Fast, bounded appearance fitting. No network, training, or face/body texture crops.
import { sampleAccessories, fitAccessories } from './arm-accessories.js';
export const ARM_SCAN_MS = 8000;
export const ARM_BUILD_BUDGET_MS = 15000;
export const ARM_STYLES = ['bare', 'short', 'long', 'hoodie'];
export const DEFAULT_ARM = Object.freeze({
  skin: '#bb8666',
  clothing: '#343a43',
  style: 'bare',
  width: 1,
  sleeveCoverage: 0.87,
  upperSleeveCoverage: 0.62,
  watch: false,
  ring: false,
  watchColor: '#252a2d',
  watchFaceColor: '#102026',
  watchPosition: 0.12,
  ringColor: '#c8b27d',
  ringFinger: 4,
  ringPosition: 0.35,
  photoDetail: true,
});
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dist = (a, b, aspect = 1) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
const valid = (p) =>
  p &&
  Number.isFinite(p.x) &&
  Number.isFinite(p.y) &&
  p.x > 0.02 &&
  p.x < 0.98 &&
  p.y > 0.02 &&
  p.y < 0.98 &&
  (p.visibility ?? 1) > 0.6;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rgbHex = (rgb) =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const colorDistance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
function looksLikeCloth(rgb, skin) {
  if (colorDistance(rgb, skin) < 35) return false;
  const sum = Math.max(1, rgb[0] + rgb[1] + rgb[2]);
  const skinSum = Math.max(1, skin[0] + skin[1] + skin[2]);
  // A darker forearm or shadow must not become a sleeve merely because the
  // palm is lighter. Compare chromaticity as well as absolute color.
  return Math.hypot(...rgb.map((v, i) => v / sum - skin[i] / skinSum)) > 0.07;
}
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const medianColor = (colors) =>
  rgbHex([0, 1, 2].map((i) => median(colors.map((c) => hexRgb(c)[i]))));
const safeColor = (value, fallback) =>
  /^#[a-f\d]{6}$/i.test(value) ? value : fallback;

export const ARM_SCAN_HINTS = Object.freeze({
  waiting: 'Waiting for a camera frame.',
  camera: 'Camera frames are unavailable. Reconnect the webcam.',
  body: 'Move back until your face, shoulders and elbows are in view.',
  elbow: 'Bring your whole forearm and elbow into view, away from your body.',
  wrist: 'Keep your wrist and elbow in view together.',
  hand: 'Show an open hand with your fingers in view.',
  match: 'Separate your arms and hold still so each hand can match its wrist.',
  small: 'Move a little closer while keeping your elbows in view.',
  angle: 'Turn your forearm across the camera view instead of pointing at the lens.',
  lighting: 'Use even lighting on your hands and forearms.',
  ready: 'Arm detected. Slowly turn your forearm and show your open hand.',
});

export function normalizeArmProfile(input = {}) {
  return {
    ...DEFAULT_ARM,
    skin: /^#[a-f\d]{6}$/i.test(input.skin) ? input.skin : DEFAULT_ARM.skin,
    clothing: /^#[a-f\d]{6}$/i.test(input.clothing)
      ? input.clothing
      : DEFAULT_ARM.clothing,
    style: ARM_STYLES.includes(input.style) ? input.style : 'bare',
    width: clamp(Number(input.width) || 1, 0.75, 1.3),
    sleeveCoverage: clamp(Number(input.sleeveCoverage) || 0.87, 0.2, 0.97),
    upperSleeveCoverage: clamp(Number(input.upperSleeveCoverage) || 0.62, 0.15, 1),
    watch: input.watch === true,
    ring: input.ring === true,
    watchColor: safeColor(input.watchColor, DEFAULT_ARM.watchColor),
    watchFaceColor: safeColor(input.watchFaceColor, DEFAULT_ARM.watchFaceColor),
    watchPosition: clamp(Number(input.watchPosition) || 0.12, 0.025, 0.24),
    ringColor: safeColor(input.ringColor, DEFAULT_ARM.ringColor),
    ringFinger: [1, 2, 3, 4, 5].includes(input.ringFinger) ? input.ringFinger : 4,
    ringPosition: clamp(Number(input.ringPosition) || 0.35, 0.12, 0.6),
    photoDetail: input.photoDetail !== false,
  };
}

// Rectify a narrow, central forearm strip. Palm pixels supply skin colour;
// forearm pixels supply garment colour and actual markings (including tattoos).
// Reject foreshortened/offscreen arms rather than sampling a shirt or the room.
export function sampleArmFrame(image, landmarks, pose, feedback = {}) {
  const samples = {};
  const { data, width, height } = image || {};
  const unavailable =
    !data || !width || !height || data.length !== width * height * 4
      ? 'camera'
      : !pose?.length
        ? 'body'
        : !landmarks?.length
          ? 'hand'
          : null;
  feedback.left = feedback.right = unavailable || 'waiting';
  if (unavailable) return samples;
  const usedHands = new Set();
  const aspect = width / height;
  const pixel = (x, y) => {
    const i =
      (clamp(Math.round(y * height), 0, height - 1) * width +
        clamp(Math.round(x * width), 0, width - 1)) *
      4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  for (const [side, elbowId, wristId] of [
    ['left', 13, 15],
    ['right', 14, 16],
  ]) {
    const elbow = pose[elbowId],
      bodyWrist = pose[wristId];
    if (!valid(elbow)) {
      feedback[side] = 'elbow';
      continue;
    }
    // A detected hand independently confirms the wrist. Body-pose wrist
    // visibility is often low on a bent arm, even when its hand is clear.
    if (!valid(bodyWrist && { ...bodyWrist, visibility: 1 })) {
      feedback[side] = 'wrist';
      continue;
    }
    const hand = landmarks.reduce(
      (best, h) =>
        !usedHands.has(h) &&
        valid(h?.[0]) &&
        (!best || dist(h[0], bodyWrist, aspect) < dist(best[0], bodyWrist, aspect))
          ? h
          : best,
      null,
    );
    if (!hand || ![0, 5, 9, 17].every((i) => valid(hand[i]))) {
      feedback[side] = 'hand';
      continue;
    }
    if (dist(hand[0], bodyWrist, aspect) > 0.1) {
      feedback[side] = 'match';
      continue;
    }
    // Crop from the more precise hand wrist, not the coarser body estimate.
    const wrist = hand[0];
    const span = dist(hand[5], hand[17], aspect);
    const length = dist(wrist, elbow, aspect);
    if (span < 0.045) {
      feedback[side] = 'small';
      continue;
    }
    if (length < span * 1.4 || length > span * 7) {
      feedback[side] = 'angle';
      continue;
    }
    usedHands.add(hand);
    const palm = {
      x: (hand[0].x + hand[9].x + hand[5].x + hand[17].x) / 4,
      y: (hand[0].y + hand[9].y + hand[5].y + hand[17].y) / 4,
    };
    const skinPixels = [];
    for (let y = -2; y <= 2; y++)
      for (let x = -2; x <= 2; x++)
        skinPixels.push(
          pixel(palm.x + (x * span * 0.035) / aspect, palm.y + y * span * 0.035),
        );
    const skin = [0, 1, 2].map((i) => median(skinPixels.map((p) => p[i])));
    if (Math.max(...skin) < 8 || Math.min(...skin) > 250) {
      feedback[side] = 'lighting';
      continue;
    }
    const stripWidth = 64,
      stripHeight = 192;
    const strip = new Uint8ClampedArray(stripWidth * stripHeight * 4);
    const nx = -(elbow.y - wrist.y) / length / aspect;
    const ny = ((elbow.x - wrist.x) * aspect) / length;
    const garmentPixels = [];
    const garmentRows = [];
    let sharpness = 0;
    for (let y = 0; y < stripHeight; y++) {
      const t = y / (stripHeight - 1);
      const cx = wrist.x + (elbow.x - wrist.x) * t;
      const cy = wrist.y + (elbow.y - wrist.y) * t;
      let different = 0;
      for (let x = 0; x < stripWidth; x++) {
        const offset = (x / (stripWidth - 1) - 0.5) * span * (0.66 + t * 0.1);
        const rgb = pixel(cx + nx * offset, cy + ny * offset);
        const i = (y * stripWidth + x) * 4;
        strip.set([...rgb, 255], i);
        if (looksLikeCloth(rgb, skin)) {
          if (y > stripHeight * 0.55) garmentPixels.push(rgb);
          different++;
        }
        if (x) sharpness += Math.abs(rgb[0] - strip[i - 4]);
      }
      garmentRows.push(different > stripWidth * 0.7);
    }
    // Cloth patterns and seams must not break an otherwise continuous sleeve.
    const smoothRows = garmentRows.map((_, row) => {
      const window = garmentRows.slice(Math.max(0, row - 5), row + 6);
      return window.filter(Boolean).length >= window.length * 0.6;
    });
    let run = 0;
    for (let row = stripHeight - 1; row >= 0 && smoothRows[row]; row--) run++;
    const hasSleeve = run > stripHeight * 0.28;
    let clothing = garmentPixels.length
      ? [0, 1, 2].map((i) => median(garmentPixels.map((p) => p[i])))
      : [52, 58, 67];
    // Short sleeves live above the elbow. The old forearm-only scan could
    // never see them. Keep a separate, elbow-to-shoulder crop when available.
    const shoulder = pose[side === 'left' ? 11 : 12];
    let upperStrip = null,
      upperCoverage = 0,
      upperPixels = [];
    const upperLength = valid(shoulder) ? dist(elbow, shoulder, aspect) : 0;
    if (upperLength > span * 1.2) {
      upperStrip = new Uint8ClampedArray(strip.length);
      const ux = -(shoulder.y - elbow.y) / upperLength / aspect;
      const uy = ((shoulder.x - elbow.x) * aspect) / upperLength;
      const rows = [];
      for (let y = 0; y < stripHeight; y++) {
        const t = y / (stripHeight - 1);
        // Avoid the armpit/torso junction at the shoulder itself.
        const along = Math.min(0.85, t);
        let different = 0;
        for (let x = 0; x < stripWidth; x++) {
          const offset = (x / (stripWidth - 1) - 0.5) * span * 0.7;
          const rgb = pixel(
            elbow.x + (shoulder.x - elbow.x) * along + ux * offset,
            elbow.y + (shoulder.y - elbow.y) * along + uy * offset,
          );
          upperStrip.set([...rgb, 255], (y * stripWidth + x) * 4);
          if (looksLikeCloth(rgb, skin)) {
            different++;
            if (t > 0.55) upperPixels.push(rgb);
          }
        }
        rows.push(different > stripWidth * 0.6);
      }
      let upperRun = 0;
      for (let y = stripHeight - 1; y >= 0; y--) {
        const window = rows.slice(Math.max(0, y - 5), y + 6);
        if (window.filter(Boolean).length < window.length * 0.6) break;
        upperRun++;
      }
      upperCoverage = upperRun / stripHeight;
      if (!hasSleeve && upperCoverage > 0.18 && upperPixels.length)
        clothing = [0, 1, 2].map((i) => median(upperPixels.map((p) => p[i])));
    }
    // Exposed forearm skin is a better color reference than the lighter palm.
    // Ignore the wrist/accessory zone and detected cloth when choosing it.
    const exposed = [];
    for (
      let row = Math.ceil(stripHeight * 0.3);
      row < stripHeight * (1 - (hasSleeve ? run / stripHeight : 0));
      row++
    ) {
      if (smoothRows[row]) continue;
      for (let x = (stripWidth * 0.3) | 0; x < stripWidth * 0.7; x++) {
        const i = (row * stripWidth + x) * 4;
        exposed.push(Array.from(strip.subarray(i, i + 3)));
      }
    }
    const fittedSkin =
      exposed.length > 100
        ? [0, 1, 2].map((i) => median(exposed.map((p) => p[i])))
        : skin;
    const accessories = sampleAccessories(
      pixel,
      hand,
      elbow,
      aspect,
      skin,
      span,
      height,
      fittedSkin,
    );
    samples[side] = {
      skin: rgbHex(fittedSkin),
      clothing: rgbHex(clothing),
      style: hasSleeve ? 'long' : upperCoverage > 0.18 ? 'short' : 'bare',
      sleeveCoverage: hasSleeve ? clamp(run / stripHeight, 0.2, 0.97) : 0.87,
      upperSleeveCoverage: clamp(upperCoverage, 0.15, 1),
      width: clamp((3.4 * span) / length, 0.8, 1.25),
      strip,
      stripWidth,
      stripHeight,
      upperStrip,
      accessories,
      quality: length * Math.min(1, span / 0.1) + Math.min(0.03, sharpness / 1000000),
    };
    feedback[side] = 'ready';
  }
  return samples;
}

export class ArmScanAccumulator {
  constructor() {
    this.reset();
  }
  reset() {
    this.frames = { left: 0, right: 0 };
    this.best = {};
    this.history = { left: [], right: [] };
    this.lastTimestamp = -1;
  }
  add(samples, timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= this.lastTimestamp) return;
    this.lastTimestamp = timestamp;
    for (const side of ['left', 'right']) {
      const sample = samples[side];
      if (!sample) continue;
      this.frames[side]++;
      this.history[side].push(sample);
      if (this.history[side].length > 80) this.history[side].shift();
      if (!this.best[side] || sample.quality > this.best[side].quality)
        this.best[side] = sample;
    }
  }
  finish(feedback = {}) {
    const missing = ['left', 'right'].filter((side) => this.frames[side] < 3);
    if (missing.length)
      throw new Error(
        missing
          .map(
            (side) =>
              `${side === 'left' ? 'Left' : 'Right'} forearm: ${this.frames[side]}/3 clear views. ${ARM_SCAN_HINTS[feedback[side]] || ARM_SCAN_HINTS.elbow}`,
          )
          .join(' '),
      );
    return Object.fromEntries(
      ['left', 'right'].map((side) => {
        const history = this.history[side];
        const style = ['bare', 'short', 'long'].sort(
          (a, b) =>
            history.filter((s) => s.style === b).length -
            history.filter((s) => s.style === a).length,
        )[0];
        const matching = history.filter((s) => s.style === style);
        const skin = medianColor(history.map((s) => s.skin));
        const representative = matching.filter(
          (s) => colorDistance(hexRgb(s.skin), hexRgb(skin)) < 50,
        );
        const best = (representative.length ? representative : matching).reduce(
          (a, b) => (a.quality >= b.quality ? a : b),
        );
        const fitted = normalizeArmProfile({
          ...best,
          style,
          skin,
          clothing: medianColor(matching.map((s) => s.clothing)),
          sleeveCoverage: median(matching.map((s) => s.sleeveCoverage)),
          upperSleeveCoverage: median(
            matching.map((s) => s.upperSleeveCoverage || 0.62),
          ),
          width: median(history.map((s) => s.width)),
          ...fitAccessories(history),
        });
        if (fitted.watch && fitted.style === 'long')
          fitted.sleeveCoverage = Math.min(
            fitted.sleeveCoverage,
            1 - fitted.watchPosition - 0.05,
          );
        return [side, { ...fitted, sample: { ...best, ...fitted } }];
      }),
    );
  }
}

// Versioned, bounded crop storage. Older 32x128 forearm-only scans still load.
export function restoreArmSample(sample) {
  if (
    !sample ||
    !Number.isInteger(sample.stripWidth) ||
    !Number.isInteger(sample.stripHeight) ||
    sample.stripWidth < 1 ||
    sample.stripWidth > 128 ||
    sample.stripHeight < 1 ||
    sample.stripHeight > 256
  )
    return null;
  const size = sample.stripWidth * sample.stripHeight * 4;
  if (sample.strip?.length !== size) return null;
  return {
    ...sample,
    strip: new Uint8ClampedArray(sample.strip),
    upperStrip:
      sample.upperStrip?.length === size
        ? new Uint8ClampedArray(sample.upperStrip)
        : null,
  };
}

export function storeArmSample(sample) {
  return {
    ...sample,
    strip: Array.from(sample.strip),
    upperStrip: sample.upperStrip ? Array.from(sample.upperStrip) : null,
  };
}
