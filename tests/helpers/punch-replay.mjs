import { PinholeCamera } from '../../src/fist-pose.js';
import { observe, makeRandom } from './synthetic-hand.mjs';

// Full MediaPipe-shaped worker results: repeatable input for Node and browser QA.
export function punchReplay(kind = 'jab', { mirrored = false, start = 1 } = {}) {
  const paths = {
    jab: [
      [0, 0, 0.7],
      [0, 0, 0.34],
    ],
    'left-hook': [
      [0.34, 0.02, 0.36],
      [0.06, 0.02, 0.3],
    ],
    'right-hook': [
      [-0.34, 0.02, 0.36],
      [-0.06, 0.02, 0.3],
    ],
    uppercut: [
      [0.04, -0.34, 0.4],
      [0.04, -0.09, 0.26],
    ],
    overhand: [
      [0.04, 0.34, 0.4],
      [0.04, 0.09, 0.26],
    ],
  };
  const [from, to] = paths[kind];
  const camera = new PinholeCamera({
    fovDegrees: 60,
    sourceAspect: 4 / 3,
    viewAspect: 4 / 3,
  });
  const random = makeRandom(5),
    frames = [];
  for (let ms = 0; ms < 850; ms += 1000 / 60) {
    const t = ms / 1000;
    const s =
      t < 0.16 ? (t / 0.16) ** 0.7 : t < 0.23 ? 1 : Math.max(0, 1 - (t - 0.23) / 0.24);
    const p = from.map((v, i) => v + (to[i] - v) * s);
    const o = observe(
      {
        position: [p[0], p[1], -p[2]],
        rotation: { pitch: kind === 'overhand' ? Math.PI : Math.PI / 2 },
        closure: 1,
      },
      camera,
      random,
    );
    if (mirrored) {
      o.landmarks = o.landmarks.map((p) => ({ ...p, x: 1 - p.x }));
      o.worldLandmarks = o.worldLandmarks.map((p) => ({ ...p, x: -p.x }));
    }
    frames.push({
      timestamp: start + ms,
      landmarks: [o.landmarks],
      worldLandmarks: [o.worldLandmarks],
      handedness: [
        [{ categoryName: kind === 'left-hook' ? 'Right' : 'Left', score: 0.95 }],
      ],
    });
  }
  return frames;
}
