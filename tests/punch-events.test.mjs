import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PunchExtractor,
  firstContact,
  classifyMode,
  resolveHand,
  toHead,
} from '../src/punch-events.js';
import { makeRandom } from './helpers/synthetic-hand.mjs';

// Camera-frame observations straight into the core: x right, y up, z = metres in front of the
// lens. 60 deg FOV at 4:3, matching the shell's defaults.
const KX = Math.tan(Math.PI / 6) * (4 / 3),
  KY = Math.tan(Math.PI / 6);
const project = (p) => ({
  u: 0.5 + p[0] / (2 * p[2] * KX),
  v: 0.5 - p[1] / (2 * p[2] * KY),
});

/**
 * Drive an extractor over a camera-frame trajectory. `traj(tSec)` returns [x,y,z] or null while
 * the hand is out of play; `visible` can kill landmark samples (blur, frame exit) while `blob`
 * keeps the motion stream alive.
 */
function run(
  extractor,
  traj,
  {
    duration = 900,
    step = 1000 / 60,
    noise = 0.0015,
    seed = 7,
    label = 'Right',
    score = 0.9,
    closure = 1,
    kn = null,
    wristDx = null,
    chirality = null,
    visible = null,
    blob = null,
    detour = null,
  } = {},
) {
  const random = makeRandom(seed),
    events = [];
  const at = (option, t) => (typeof option === 'function' ? option(t) : option);
  for (let ms = 0; ms <= duration; ms += step) {
    const t = ms / 1000;
    let p = traj ? traj(t) : null;
    if (detour) p = detour(t, p) ?? p;
    if (p && (!visible || visible(t, p))) {
      const { u, v } = project(p);
      if (u > -0.5 && u < 1.5 && v > -0.5 && v < 1.5) {
        const jitter = [
          p[0] + random.normal() * noise,
          p[1] + random.normal() * noise,
          p[2] + random.normal() * noise * 5,
        ];
        const det = { u, v, span: 0.084 / Math.max(p[2], 0.05) };
        const slot = extractor.assign([det], ms).get(det);
        extractor.push(slot, {
          t: ms,
          u,
          v,
          p: jitter,
          closure,
          kn: at(kn, t),
          label: at(label, t),
          score,
          wristDx: at(wristDx, t),
          chirality: at(chirality, t),
        });
      }
    }
    if (blob) {
      const b = blob(t);
      if (b) extractor.pushBlob({ t: ms, kx: KX, ky: KY, ...b });
    }
    const event = extractor.tick(ms + 8, { gain: 1, headRadii: [0.15, 0.14, 0.09] });
    if (event) events.push(event);
  }
  return events;
}

// The standard shadow punch: fast out, brief hold at full reach, retraction — the same shape the
// target-camera tests use.
const sCurve = (t, { out, hold, back }) =>
  t < 0
    ? 0
    : t < out
      ? (t / out) ** 0.7
      : t < out + hold
        ? 1
        : Math.max(0, 1 - (t - out - hold) / back);
const straight =
  ({
    x = 0,
    y = 0,
    from = 0.7,
    to = 0.34,
    out = 0.13,
    hold = 0.08,
    back = 0.22,
    at = 0,
  } = {}) =>
  (t) => {
    const s = sCurve(t - at, { out, hold, back });
    return [x, y, from + (to - from) * s];
  };
const lerpPath =
  (from, to, { out = 0.16, hold = 0.07, back = 0.24, at = 0 } = {}) =>
  (t) => {
    const s = sCurve(t - at, { out, hold, back });
    return [0, 1, 2].map((k) => from[k] + (to[k] - from[k]) * s);
  };

test('one punch, one event; the retraction that follows never fires a second one', () => {
  const x = new PunchExtractor();
  const events = run(x, straight(), { duration: 1400 });
  assert.equal(events.length, 1, `expected exactly one event, got ${events.length}`);
  assert.ok(
    events[0].closing > 1.5,
    `peak closing carried (${events[0].closing?.toFixed(2)} m/s)`,
  );
  assert.equal(events[0].mode, 'jab');
});

test('a settle-dip when the fist re-enters guard is not a punch', () => {
  const x = new PunchExtractor();
  // full punch, then a slow 4 cm overshoot-and-settle around guard depth
  const traj = (t) => {
    if (t < 0.6) return straight()(t);
    const wobble = Math.sin((t - 0.6) * 2 * Math.PI) * 0.02;
    return [0, 0, 0.7 - Math.max(0, 0.04 - (t - 0.6) * 0.08) + wobble * 0];
  };
  const events = run(x, traj, { duration: 1600 });
  assert.equal(events.length, 1, 'the guard settle after retraction must not re-fire');
});

test('two punches with a withdrawal between them are two events', () => {
  const x = new PunchExtractor();
  const first = straight({ at: 0 }),
    second = straight({ at: 0.55 });
  const events = run(x, (t) => (t < 0.55 ? first(t) : second(t)), { duration: 1400 });
  assert.equal(events.length, 2, `two swings, two impacts (got ${events.length})`);
});

test('a slow reach toward the camera is not a punch', () => {
  const x = new PunchExtractor();
  const events = run(
    x,
    (t) => [0, 0, Math.max(0.25, 0.7 - 0.45 * Math.min(1, t / 3))],
    { duration: 2600 },
  );
  assert.equal(events.length, 0);
});

test('a fast twitch that goes nowhere is not a punch', () => {
  const x = new PunchExtractor();
  const events = run(
    x,
    straight({ from: 0.5, to: 0.465, out: 0.05, hold: 0.04, back: 0.1 }),
    { duration: 700 },
  );
  assert.equal(events.length, 0, '3.5 cm of travel is under the reach gate');
});

test('a hand sweeping laterally past at constant range is not a punch', () => {
  const x = new PunchExtractor();
  const events = run(
    x,
    (t) => {
      const angle = -0.9 + 1.8 * Math.min(1, t / 0.45),
        radius = 0.42;
      return [radius * Math.sin(angle), 0.02, radius * Math.cos(angle)];
    },
    { duration: 900 },
  );
  assert.equal(events.length, 0, 'moving across the target is not moving into it');
});

test('landmarks that die at full extension still land the punch, once', () => {
  const x = new PunchExtractor();
  const events = run(x, straight({ from: 0.75, to: 0.3 }), {
    duration: 1000,
    visible: (t, p) => p[2] >= 0.4,
  });
  assert.equal(
    events.length,
    1,
    'losing the hand mid-extension is evidence of a punch, not absence of one',
  );
  assert.equal(events[0].stale, true);
});

test('the motion stream carries a landmark-dead punch to a confirmed apex', () => {
  const x = new PunchExtractor();
  const traj = straight({ from: 0.72, to: 0.32, out: 0.14, hold: 0.06, back: 0.2 });
  let lastZ = null,
    lastT = null;
  const events = run(x, traj, {
    duration: 1100,
    visible: (t, p) => p[2] >= 0.52, // landmarks die early in the approach
    blob: (t) => {
      const p = traj(t);
      if (p[2] >= 0.55) return null; // blob picks up as the fist blurs in
      const { u, v } = project(p);
      const expand =
        lastZ !== null && t > lastT ? Math.log(lastZ / p[2]) / (t - lastT) : 0;
      lastZ = p[2];
      lastT = t;
      return { u, v, mass: 0.4, spread: 0.1, expand };
    },
  });
  assert.equal(
    events.length,
    1,
    `blob bridge must land the punch exactly once (got ${events.length})`,
  );
  assert.ok(events[0].bridged, 'and record that the motion stream carried it');
});

test('an instant-fire deep punch does not fire again at its own apex', () => {
  const x = new PunchExtractor();
  const events = run(
    x,
    straight({ from: 0.7, to: 0.06, out: 0.16, hold: 0.1, back: 0.26 }),
    { duration: 1400 },
  );
  assert.equal(events.length, 1, `deep punch: one event (got ${events.length})`);
  assert.equal(
    events[0].instant,
    true,
    'and it fired on the contact-depth crossing, not the apex',
  );
});

test('after an instant fire the fist must withdraw before the next punch registers', () => {
  const x = new PunchExtractor();
  const first = straight({ from: 0.7, to: 0.08, out: 0.13, hold: 0.06, back: 0.2 }),
    second = straight({ from: 0.68, to: 0.3, at: 0.65 });
  const events = run(x, (t) => (t < 0.65 ? first(t) : second(t)), { duration: 1600 });
  assert.equal(
    events.length,
    2,
    `instant fire then a fresh punch after withdrawal (got ${events.length})`,
  );
});

test('a committed jab is not an instant fire — it reports its landing, not its flight', () => {
  // The live symptom: jabs "landed" mid-flight (logged low and lateral, as shoulder hits) and the
  // actual face contact never registered. A 20 cm instant-fire line crossed ~80 ms before full
  // extension; at the 12 cm default the crossing IS the landing, so a jab stopping at 22 cm goes
  // through the apex path and reports its extension point.
  const x = new PunchExtractor();
  const events = run(
    x,
    straight({ from: 0.7, to: 0.22, out: 0.14, hold: 0.07, back: 0.22 }),
    { duration: 1100 },
  );
  assert.equal(events.length, 1);
  assert.ok(!events[0].instant, 'apex path, not instant');
  assert.ok(
    events[0].depth < 0.26,
    `reported at full extension (${(events[0].depth * 100).toFixed(0)} cm), not along the flight`,
  );
});

test('a two-frame depth stutter mid-flight does not fire the punch early', () => {
  // Near the camera the depth estimate gets noisy exactly as the fist blurs in; one or two fitted
  // samples bouncing above the confirm line used to read as "the retreat", firing the event at a
  // point along the punch's travel and consuming the real apex.
  const x = new PunchExtractor();
  const events = run(
    x,
    straight({ from: 0.7, to: 0.34, out: 0.13, hold: 0.08, back: 0.22 }),
    {
      duration: 1100,
      detour: (t, p) => (p && t >= 0.09 && t < 0.14 ? [p[0], p[1], p[2] + 0.06] : null),
    },
  );
  assert.equal(events.length, 1, `one punch, one event (got ${events.length})`);
  assert.ok(
    events[0].depth < 0.4,
    `fired at the real apex (${(events[0].depth * 100).toFixed(0)} cm), not at the stutter`,
  );
});

test('a jab converging from a low guard lands where it stopped, not down its flight path', () => {
  // A guard-anchored jab sweeps ~20 cm laterally on its way in, but closes 30+ cm of depth doing
  // it: its lateral motion is en route, not through the face. The entry may only walk sideways
  // when the sweep dominates the depth closed — otherwise a centred jab reported at the chin.
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([0.1, -0.22, 0.62], [-0.02, -0.05, 0.3], {
      out: 0.15,
      hold: 0.08,
      back: 0.24,
    }),
    { duration: 1100, label: 'Right' },
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.missed, false);
  assert.ok(
    Math.abs(e.point[0] - 0.02) < 0.05 && e.point[1] > -0.115,
    `lands near the extension point (got [${e.point.map((v) => v.toFixed(3))}])`,
  );
  assert.ok(
    e.point[2] > 0.05,
    'on the front of the face, not walked to a silhouette edge',
  );
});

test('a jab-cross combo from the two sides is two events', () => {
  const x = new PunchExtractor();
  // right jab from the puncher's right (image left, camera -x), then left cross from the other
  // side. Labels follow MediaPipe's real convention on an unmirrored feed (a right hand reads
  // 'Left'), and each arm trails its wrist toward its own shoulder.
  const jab = straight({ x: -0.12, at: 0 }),
    cross = straight({ x: 0.12, at: 0.34 });
  const events = run(x, (t) => (t < 0.34 ? jab(t) : cross(t)), {
    duration: 1200,
    label: (t) => (t < 0.34 ? 'Left' : 'Right'),
    wristDx: (t) => (t < 0.34 ? -0.04 : 0.04),
  });
  assert.equal(
    events.length,
    2,
    `a 340 ms one-two is two punches (got ${events.length})`,
  );
  assert.equal(events[0].hand, 'right');
  assert.equal(events[1].hand, 'left');
});

test('one punch fragmented across identities is still one event', () => {
  for (const teleportAt of [0.12, 0.19, 0.26]) {
    const x = new PunchExtractor();
    const hook = lerpPath([-0.42, 0.02, 0.38], [-0.06, 0.02, 0.3], {
      out: 0.16,
      hold: 0.07,
      back: 0.26,
    });
    const events = run(x, hook, {
      duration: 1400,
      detour: (t, p) => {
        if (p && Math.abs(t - teleportAt) < 1 / 120)
          return [p[0] + 0.28, p[1] + 0.18, p[2]];
        return null;
      },
    });
    assert.ok(
      events.length <= 1,
      `fragment at ${teleportAt}s produced ${events.length} events`,
    );
    assert.equal(
      events.length,
      1,
      `fragment at ${teleportAt}s must still land the punch`,
    );
  }
});

test('a hook reports its terminal tangent, not the mid-arc chord', () => {
  const x = new PunchExtractor();
  // Genuine arc: the fist swings on a circle, so its travel direction rotates continuously. A
  // right hook seen from the target: enters wide on the image left, curls in across the face.
  const centre = [-0.06, 0.02, 0.62],
    R = 0.3;
  const arc = (t) => {
    const s = sCurve(t, { out: 0.2, hold: 0.06, back: 0.2 });
    const theta = ((-65 + 60 * s) * Math.PI) / 180;
    return [
      centre[0] + R * Math.sin(theta),
      centre[1],
      centre[2] - R * Math.cos(theta),
    ];
  };
  const events = run(x, arc, { duration: 1100 });
  assert.equal(events.length, 1);
  const d = events[0].direction;
  // Terminal tangent is almost pure lateral (head -x for a right hook); the chord from entry to
  // apex would carry |dz| ~ 0.5. The solver must read the end of the arc, not its average.
  assert.ok(d[0] < -0.85, `drives across the face (dx ${d[0].toFixed(2)})`);
  assert.ok(
    Math.abs(d[2]) < 0.4,
    `terminal tangent, not the chord (dz ${d[2].toFixed(2)})`,
  );
  assert.equal(events[0].mode, 'hook');
  assert.equal(events[0].hand, 'right');
  assert.ok(
    events[0].curvature > 0.4,
    `the arc itself is measured (${events[0].curvature?.toFixed(2)} rad)`,
  );
});

test('an uppercut classifies as an uppercut and lands under the chin', () => {
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([0.03, -0.36, 0.42], [0.03, -0.08, 0.26], {
      out: 0.16,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left', score: 0.9 },
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.mode, 'uppercut');
  assert.ok(e.direction[1] > 0.5, `drives upward (dy ${e.direction[1].toFixed(2)})`);
  assert.ok(e.point[1] < -0.02, `lands low on the head (y ${e.point[1].toFixed(3)})`);
  assert.equal(
    e.hand,
    'right',
    'MediaPipe "Left" on an unmirrored front camera is the puncher\'s right',
  );
});

test('a left hook mirrors: enters image-right, drives head +x, classified left', () => {
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([0.34, 0.02, 0.36], [0.06, 0.02, 0.3], {
      out: 0.16,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Right', score: 0.9 },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'hook');
  assert.equal(events[0].hand, 'left');
  assert.ok(
    events[0].direction[0] > 0.5,
    `travels toward head +x (dx ${events[0].direction[0].toFixed(2)})`,
  );
});

test('impact point sits on the surface the punch came in through', () => {
  const radii = [0.15, 0.14, 0.09];
  const zone = (point) => {
    const n = point.map((v, k) => v / radii[k]),
      biggest = n.map(Math.abs).reduce((b, v, i, a) => (a[b] > v ? b : i), 0);
    return biggest === 0
      ? 'cheek'
      : biggest === 1
        ? point[1] > 0
          ? 'forehead'
          : 'chin'
        : 'front';
  };
  const jab = run(new PunchExtractor(), straight({ from: 0.7, to: 0.3 }), {
    duration: 900,
  })[0];
  assert.equal(zone(jab.point), 'front', `jab on the front (got ${zone(jab.point)})`);
  const hook = run(
    new PunchExtractor(),
    lerpPath([-0.34, 0.02, 0.36], [-0.06, 0.02, 0.3]),
    { duration: 900 },
  )[0];
  assert.equal(
    zone(hook.point),
    'cheek',
    `hook on the cheek (got ${zone(hook.point)})`,
  );
  const upper = run(
    new PunchExtractor(),
    lerpPath([0.03, -0.34, 0.4], [0.03, -0.06, 0.24]),
    { duration: 900 },
  )[0];
  assert.equal(
    zone(upper.point),
    'chin',
    `uppercut on the chin (got ${zone(upper.point)})`,
  );
});

test("punch to the puncher's right lands at head +x, and high lands high", () => {
  const right = run(new PunchExtractor(), straight({ x: -0.09, from: 0.7, to: 0.34 }), {
    duration: 900,
  })[0];
  assert.ok(
    right.point[0] > 0.03,
    `camera -x is the puncher's right, head +x (got ${right.point[0].toFixed(3)})`,
  );
  const high = run(new PunchExtractor(), straight({ y: 0.09, from: 0.7, to: 0.34 }), {
    duration: 900,
  })[0];
  assert.ok(
    high.point[1] > 0.03,
    `the vertical axis never flips (got ${high.point[1].toFixed(3)})`,
  );
});

test('a guard hand parked in frame does not fire while the other punches', () => {
  const x = new PunchExtractor(),
    random = makeRandom(17),
    events = [];
  const swing = straight({ x: 0.1, from: 0.7, to: 0.3 });
  for (let ms = 0; ms <= 1000; ms += 1000 / 60) {
    const t = ms / 1000;
    for (const [p, label] of [
      [[-0.18, -0.02, 0.55], 'Left'],
      [swing(t), 'Right'],
    ]) {
      const { u, v } = project(p);
      const jitter = [
        p[0] + random.normal() * 0.0015,
        p[1] + random.normal() * 0.0015,
        p[2] + random.normal() * 0.008,
      ];
      const det = { u, v, span: 0.084 / p[2] };
      const slot = x.assign([det], ms).get(det);
      x.push(slot, { t: ms, u, v, p: jitter, closure: 1, label, score: 0.9 });
    }
    const event = x.tick(ms + 8, { gain: 1, headRadii: [0.15, 0.14, 0.09] });
    if (event) events.push(event);
  }
  assert.equal(
    events.length,
    1,
    `only the punching hand scores (got ${events.length})`,
  );
  assert.ok(x.slots.size >= 2, 'both hands hold their own slot');
});

test('after an event no nearby slot is left mid-approach to fire its own copy', () => {
  const x = new PunchExtractor();
  const hook = lerpPath([-0.42, 0.02, 0.38], [-0.06, 0.02, 0.3], {
    out: 0.16,
    hold: 0.07,
    back: 0.26,
  });
  run(x, hook, {
    duration: 1400,
    detour: (t, p) => {
      if (p && Math.abs(t - 0.12) < 1 / 120) return [p[0] + 0.28, p[1] + 0.18, p[2]];
      return null;
    },
  });
  assert.ok(x.stats.impacts <= 1);
  for (const slot of x.slots.values())
    assert.ok(
      slot.rearm !== null || slot.consumedUntil > -1e8 || slot.samples.length < 3,
      'an unconsumed mid-approach orphan would fire its own version of the punch later',
    );
});

test('an open hand pushed forward is not a punch', () => {
  const x = new PunchExtractor();
  const events = run(x, straight(), { duration: 900, closure: 0.05 });
  assert.equal(events.length, 0, 'closure evidence is required');
  assert.match(x.stats.rejected, /open hand/);
});

test('a right hook first detected mid-frame still attributes to the right hand', () => {
  // The failure seen live: hooks are often first detected mid-arc near frame centre, where the
  // entry-side vote is meaningless — right hooks were logged as left. The wrist trail, the fitted
  // hand's chirality and the travel azimuth must carry it instead.
  const x = new PunchExtractor();
  // First sample already at u ~ .35 — inside the centre band where the entry-side vote is mute —
  // and still sweeping across as it closes on the head.
  const events = run(
    x,
    lerpPath([-0.09, 0.02, 0.4], [0.11, 0.02, 0.28], {
      out: 0.15,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left', wristDx: -0.05, chirality: 0.16 },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'hook');
  assert.equal(
    events[0].hand,
    'right',
    `wrist trail + chirality + azimuth outvote the useless centre entry (votes ${JSON.stringify(events[0].handVotes)})`,
  );
});

test('a rising hook with upward knuckles stays a hook, not an uppercut', () => {
  // Hooks often carry lift and a rotated fist; the old first-match uppercut branch took any
  // knuckle normal with n.y > .45 at its word.
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([-0.34, -0.06, 0.36], [-0.06, 0.06, 0.3], {
      out: 0.16,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left', kn: [-0.55, 0.55, -0.63] },
  );
  assert.equal(events.length, 1);
  assert.equal(
    events[0].mode,
    'hook',
    `overwhelming lateral travel wins (got ${events[0].mode})`,
  );
});

test('a blur-censored shallow hook still classifies as a hook', () => {
  // Landmarks die mid-arc, so the terminal tangent degrades toward the chord — which for a
  // shallow hook is forward enough to have read as a jab.
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([-0.3, 0.02, 0.55], [-0.04, 0.02, 0.3], {
      out: 0.16,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, visible: (t, p) => p[2] >= 0.4, label: 'Left' },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].stale, true, 'the punch was censored');
  assert.equal(
    events[0].mode,
    'hook',
    `the image sweep keeps it a hook (got ${events[0].mode})`,
  );
});

test('a hook pulled just short grazes the cheek; one stopped a fist-width out misses', () => {
  // First-contact is honest about pulled hooks: a stop within a fist of the silhouette lands on
  // it, a stop clearly wide of the head is a miss, and neither teleports anywhere.
  const near = new PunchExtractor();
  const nearEvents = run(
    near,
    lerpPath([-0.42, 0.02, 0.38], [-0.19, 0.02, 0.31], {
      out: 0.15,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left' },
  );
  assert.equal(nearEvents.length, 1);
  assert.equal(nearEvents[0].missed, false, 'a stop grazing the silhouette lands');
  assert.ok(
    nearEvents[0].point[0] > 0.12,
    `on the cheek it was driving toward (x ${nearEvents[0].point[0].toFixed(3)})`,
  );
  const wide = new PunchExtractor();
  const wideEvents = run(
    wide,
    lerpPath([-0.44, 0.02, 0.38], [-0.27, 0.02, 0.31], {
      out: 0.15,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left' },
  );
  assert.equal(wideEvents.length, 1);
  assert.equal(
    wideEvents[0].missed,
    true,
    'a stop a fist-width wide of the head is a miss',
  );
});

test('a hook with follow-through lands on the cheek it came in through, not past the centreline', () => {
  // The live symptom: hooks landing on the WRONG side of the face. A hook's fist decelerates at
  // or past the centreline (follow-through), and solving the impact from the stopping point put
  // the marker on the far cheek. First-contact takes the earliest touch of the trajectory.
  const x = new PunchExtractor();
  // right hook sweeping THROUGH centre: enters via head +x, stops at head -x
  const events = run(
    x,
    lerpPath([-0.3, 0.02, 0.4], [0.14, 0.02, 0.3], {
      out: 0.17,
      hold: 0.06,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left' },
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.missed, false);
  assert.ok(
    e.point[0] > 0.12,
    `entry-side cheek despite the follow-through (got [${e.point.map((v) => v.toFixed(3))}], apex ${e.apexPoint[0].toFixed(3)})`,
  );
  assert.equal(e.mode, 'hook');
});

test('a shallow hook — more forward drive than sweep — still lands on its entry side', () => {
  // Real hooks at a laptop close 25-40 cm of depth while sweeping 15-25 cm laterally. An earlier
  // gate required the sweep to dominate depth before sideways entry applied, so every real hook
  // fell back to its stopping point — the follow-through side. First-contact has no such branch.
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([-0.28, 0.02, 0.62], [0.02, 0.02, 0.3], {
      out: 0.16,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Left' },
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.missed, false);
  assert.ok(
    e.point[0] > 0.03,
    `first touch on the entry-side half (got ${e.point[0].toFixed(3)}, stop was ${e.apexPoint[0].toFixed(3)})`,
  );
});

test('a hook seen only from the centreline onward still lands on the side the face would have stopped it', () => {
  // The live symptom, stated by the user: "if I swing such that it hits screen-left, my hook
  // ends with my fist on the right of the screen — but in a real scenario it would have been
  // stopped by the face." Blur eats the entry-side flight, so every MEASURED sample sits at or
  // past the centreline; the entry is reconstructed backward along the arrival direction to
  // where the trajectory first crossed the face.
  for (const cut of [0.05, 0.06, 0.07]) {
    const x = new PunchExtractor();
    // left hook with follow-through; landmarks only exist from `cut` seconds in
    const events = run(
      x,
      lerpPath([0.3, 0.02, 0.46], [-0.14, 0.02, 0.23], {
        out: 0.15,
        hold: 0.06,
        back: 0.24,
      }),
      { duration: 1100, label: 'Left', seed: 11, visible: (t) => t >= cut },
    );
    assert.equal(
      events.length,
      1,
      `cut ${cut}: the truncated hook must register (got ${events.length})`,
    );
    const e = events[0];
    assert.equal(e.mode, 'hook');
    assert.equal(e.hand, 'left');
    assert.ok(
      e.point[0] < -0.12,
      `cut ${cut}: lands screen-left where the face would have stopped it (got [${e.point.map((v) => v.toFixed(3))}])`,
    );
  }
});

test('a hook whose retraction re-crosses the closest range still anchors on the punch, not the pull-back', () => {
  // The range profile of a follow-through hook dips twice: the forward crossing and the
  // retraction re-cross, which can dip LOWER. Anchoring the apex on the global minimum hung the
  // terminal window and the direction on the pull-back — the reported travel reversed and the
  // entry flipped sides. The contact is the FIRST arrival into the deepest zone.
  const x = new PunchExtractor();
  // right hook, fully tracked, retraction retracing the arc
  const events = run(
    x,
    lerpPath([-0.3, 0.02, 0.4], [0.14, 0.02, 0.3], {
      out: 0.17,
      hold: 0.06,
      back: 0.24,
    }),
    { duration: 1100, label: 'Right', seed: 7 },
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.ok(
    e.direction[0] < -0.5,
    `the punch's travel, not the retraction's (dx ${e.direction[0].toFixed(2)})`,
  );
  assert.ok(
    e.point[0] > 0.12,
    `entry-side cheek (got [${e.point.map((v) => v.toFixed(3))}])`,
  );
});

test('an uppercut seen only at its top still classifies and lands under the chin', () => {
  // The live symptom: an uppercut's rise is low, fast, blurred and partly below the frame, so
  // the landmarker locks on only at the top where the upward velocity is spent. The measured
  // direction reads near-pure -z ("right jab · [-0.20,-0.08,-0.98]"), every travel-gated
  // uppercut branch fails, and the marker lands high on the skull. The fist's ORIENTATION is
  // measured at the apex where tracking is good — knuckles-up carries the classification, and
  // the classification carries the entry down to the chin.
  const traj = (t) => {
    if (t < 0.1) {
      const s = (t / 0.1) ** 0.7;
      return [0.02, -0.3 + 0.25 * s, 0.46 - 0.08 * s];
    } // the unseen rise
    if (t < 0.17) {
      const s = (t - 0.1) / 0.07;
      return [0.02, -0.05 + 0.005 * s, 0.38 - 0.12 * s];
    } // the seen top: forward drive, no vertical
    if (t < 0.23) return [0.02, -0.045, 0.26];
    const s = Math.min(1, (t - 0.23) / 0.24);
    return [0.02, -0.045 - 0.2 * s, 0.26 + 0.16 * s];
  };
  const x = new PunchExtractor();
  const events = run(x, traj, {
    duration: 1000,
    visible: (t) => t >= 0.1,
    label: 'Left',
    kn: [0.1, 0.85, -0.5],
  });
  assert.equal(
    events.length,
    1,
    `the top-only uppercut must register (got ${events.length})`,
  );
  const e = events[0];
  assert.equal(
    e.mode,
    'uppercut',
    `knuckles-up carries it despite direction dz ${e.direction[2].toFixed(2)} (got ${e.mode})`,
  );
  assert.equal(e.missed, false);
  assert.ok(
    e.point[1] < -0.11,
    `lands under the chin, not where the top was measured (got [${e.point.map((v) => v.toFixed(3))}])`,
  );
});

test('a hook fragment first seen mid-arc, moving fast, still registers', () => {
  // Tracking picks hooks up mid-flight. Born-fast is judged on full 3D speed — a mid-arc hook
  // moves 3-5 m/s while closing range slowly, and judging it on range rate kept the relaxed
  // reach gate away from exactly the punches that needed it.
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([-0.12, 0.02, 0.34], [0.02, 0.02, 0.28], {
      out: 0.1,
      hold: 0.06,
      back: 0.2,
    }),
    { duration: 900, label: 'Left' },
  );
  assert.equal(
    events.length,
    1,
    `the visible tail closes only ~7 cm, but it was born at speed (got ${events.length})`,
  );
});

test('a hook that blurs out in its tangential phase still censors and lands', () => {
  // The censor gate reads the trailing window's PEAK closing: this fragment closed hard early,
  // then swept tangentially just before vanishing — judged on its last sample it read as a hand
  // drifting to a stop and died silently.
  const x = new PunchExtractor();
  const traj = (t) => {
    if (t < 0.12) {
      const s = (t / 0.12) ** 0.7;
      return [0.3 - 0.25 * s, 0.02, 0.55 - 0.22 * s];
    }
    if (t < 0.18) {
      const s = (t - 0.12) / 0.06;
      return [0.05 - 0.12 * s, 0.02, 0.33];
    }
    return [-0.07, 0.02, 0.33];
  };
  const events = run(x, traj, {
    duration: 900,
    visible: (t) => t < 0.18,
    label: 'Right',
  });
  assert.equal(
    events.length,
    1,
    `the fragment was a punch losing its landing to blur (got ${events.length})`,
  );
  assert.equal(events[0].stale, true);
});

test('an uppercut offset from centre lands on the chin, never beside the head', () => {
  // Real uppercuts drift laterally and finish above face height. They were reading as misses or
  // as entry points on the ellipsoid's flank where the real mesh has no surface.
  const x = new PunchExtractor();
  const events = run(
    x,
    lerpPath([0.09, -0.34, 0.42], [0.09, -0.1, 0.26], {
      out: 0.16,
      hold: 0.07,
      back: 0.24,
    }),
    { duration: 1100, label: 'Right' },
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.missed, false, 'a chin-bound trajectory is a hit');
  assert.equal(e.mode, 'uppercut');
  assert.ok(e.point[1] < -0.09, `lands low (y ${e.point[1].toFixed(3)})`);
  const onSilhouette = (e.point[0] / 0.15) ** 2 + (e.point[1] / 0.14) ** 2 <= 1.0001;
  assert.ok(
    onSilhouette,
    `the entry stays on the head silhouette (point [${e.point.map((v) => v.toFixed(3))}])`,
  );
});

test('the extractor holds up at 20 fps inference, where a punch is five samples long', () => {
  const x = new PunchExtractor();
  const events = run(x, straight({ out: 0.15, hold: 0.09, back: 0.24 }), {
    duration: 1200,
    step: 50,
  });
  assert.equal(
    events.length,
    1,
    `one punch, one event at 20 fps (got ${events.length})`,
  );
  assert.equal(events[0].mode, 'jab');
  const hook = new PunchExtractor();
  const hookEvents = run(
    hook,
    lerpPath([-0.34, 0.02, 0.36], [-0.06, 0.02, 0.3], {
      out: 0.18,
      hold: 0.08,
      back: 0.26,
    }),
    { duration: 1200, step: 1000 / 24 },
  );
  assert.equal(
    hookEvents.length,
    1,
    `and a hook still lands at 24 fps (got ${hookEvents.length})`,
  );
  assert.equal(hookEvents[0].mode, 'hook');
});

test('firstContact takes the earliest touch of the path, never the stopping point', () => {
  const radii = [0.15, 0.14, 0.09];
  // a hook path sweeping in from wide: enters through the +x cheek where it first crossed
  const swept = firstContact(
    [
      [0.25, 0.02],
      [0.19, 0.02],
      [0.13, 0.02],
      [0.07, 0.02],
      [0.01, 0.02],
    ],
    radii,
  );
  assert.ok(
    swept && Math.abs(swept[0] - 0.15) < 0.01,
    `entry at the silhouette crossing, not deeper (got ${swept?.[0].toFixed(3)})`,
  );
  // a follow-through path crossing the whole face: still the FIRST touch, not where it stopped
  const through = firstContact(
    [
      [0.2, 0.02],
      [0.08, 0.02],
      [-0.04, 0.02],
      [-0.12, 0.02],
    ],
    radii,
  );
  assert.ok(
    through && through[0] > 0.14,
    'first contact is on the side it came in through',
  );
  // a path already inside: lands at its earliest point
  const inside = firstContact(
    [
      [0.02, -0.01],
      [0.01, -0.02],
      [0, -0.03],
    ],
    radii,
  );
  assert.ok(
    inside && Math.abs(inside[0] - 0.02) < 1e-6 && inside[2] > 0.08,
    'a jab lands where it arrives, on the front',
  );
  // a path skimming just wide grazes on; one clearly wide misses
  const grazed = firstContact(
    [
      [0.2, 0.02],
      [0.185, 0.02],
    ],
    radii,
  );
  assert.ok(
    grazed && grazed[0] > 0.14,
    'a skim within a fist-width snaps onto the silhouette',
  );
  assert.equal(
    firstContact(
      [
        [0.3, 0.02],
        [0.26, 0.02],
      ],
      radii,
    ),
    null,
    'clearly wide of the head misses',
  );
});

test('the same jab lands in the same place, run after run', () => {
  // The live symptom: identical jabs marked on entirely opposite parts of the mesh. Root cause
  // was a single near-apex direction probe that could read the retraction and report the punch
  // travelling OUT of the face (~1 run in 8), which sent the app's raycast through the back of
  // the skull. Directions must always drive into the head and points must cluster.
  const points = [],
    directions = [];
  for (let seed = 1; seed <= 24; seed++) {
    const x = new PunchExtractor();
    const events = run(x, straight({ x: -0.03, y: -0.02, from: 0.68, to: 0.33 }), {
      duration: 900,
      seed: seed * 7919,
      noise: 0.003,
      label: 'Left',
    });
    assert.equal(events.length, 1, `seed ${seed}: one jab, one event`);
    points.push(events[0].point);
    directions.push(events[0].direction);
  }
  for (const d of directions)
    assert.ok(
      d[2] < -0.5,
      `every direction drives into the face (got dz ${d[2].toFixed(2)})`,
    );
  const mean = [0, 1, 2].map(
    (k) => points.reduce((s, p) => s + p[k], 0) / points.length,
  );
  for (const p of points) {
    const spread = Math.hypot(p[0] - mean[0], p[1] - mean[1]);
    assert.ok(
      spread < 0.02,
      `every marker within 2 cm of the cluster centre (got ${(spread * 100).toFixed(1)} cm at [${p.map((v) => v.toFixed(3))}])`,
    );
  }
});

test('classification helpers behave at the boundaries', () => {
  assert.equal(classifyMode({ direction: [0, 0.8, -0.6] }), 'uppercut');
  assert.equal(classifyMode({ direction: [-0.9, 0, -0.3] }), 'hook');
  assert.equal(classifyMode({ direction: [0, 0, -1] }), 'jab');
  assert.equal(
    classifyMode({ direction: [-0.6, 0.1, -0.6], knuckleNormal: [-0.8, 0, -0.4] }),
    'hook',
  );
  assert.equal(resolveHand({ entryU: 0.2, labels: [] }).hand, 'right');
  assert.equal(resolveHand({ entryU: 0.8, labels: [] }).hand, 'left');
  assert.equal(resolveHand({ labels: [{ label: 'Left', score: 0.9 }] }).hand, 'right');
  assert.equal(
    resolveHand({ wristDx: -0.05, labels: [] }).hand,
    'right',
    'wrist trails toward the right shoulder at camera -x',
  );
  assert.equal(
    resolveHand({ chirality: 0.15, labels: [] }).hand,
    'right',
    'a right hand measures positive in the fit frame',
  );
  assert.equal(resolveHand({ chirality: -0.15, labels: [] }).hand, 'left');
  assert.deepEqual(toHead([1, 2, 3]), [-1, 2, 3]);
});
