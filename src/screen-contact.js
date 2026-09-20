import * as THREE from 'three';
import { coverRect } from './arm-composite.js';
import { fistScore } from './physics.js';

const clamp = THREE.MathUtils.clamp;
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const knuckles = [5, 6, 9, 10, 13, 14, 17, 18];
// A camera move smaller than this in any matrix element shifts the projected head by
// well under a pixel, which is settling, not orbiting. Punches keep tracking through it.
const VIEW_TOLERANCE = 4e-4;

export function cameraPointOnScreen(point, source, viewport, mirrored) {
  const rect = coverRect(source.width, source.height, viewport.width, viewport.height);
  const x = rect.x + point.x * rect.width;
  return { x: mirrored ? viewport.width - x : x, y: rect.y + point.y * rect.height };
}

function footprint(points, hand, closed, timestamp) {
  if (!points || knuckles.some((i) => !Number.isFinite(points[i]?.x + points[i]?.y)))
    return null;
  const x = (points[5].x + points[17].x) * 0.4 + points[9].x * 0.2;
  const y = (points[5].y + points[17].y) * 0.4 + points[9].y * 0.2;
  // The knuckle pad, including the bent PIP joints; never the wrist/forearm.
  const radius = Math.max(
    3,
    ...knuckles.map((i) => Math.hypot(points[i].x - x, points[i].y - y)),
  );
  return { hand, x, y, radius, closed, timestamp };
}

// One vocabulary for "which hand threw this", shared by both fist sources and by everything
// downstream: lowercase, in the puncher's own frame. MediaPipe spells its handedness 'Left' /
// 'Right' and the rendered hands copied that spelling, but the demo HUD and the recoiling arm
// both test `side === 'left'` -- so a capitalised label quietly read as the RIGHT hand no matter
// which hand actually threw the punch. Unlabelled fists keep a per-slot identity instead.
export function punchingHand(label) {
  const side = String(label ?? '').toLowerCase();
  return side === 'left' || side === 'right' ? side : null;
}

export function cameraFists(results, source, viewport, mirrored = true) {
  return (results?.landmarks ?? []).flatMap((lm, i) => {
    if (lm.length !== 21) return [];
    const hand =
      punchingHand(results.handedness?.[i]?.[0]?.categoryName) ?? `hand-${i}`;
    const sample = footprint(
      lm.map((p) => cameraPointOnScreen(p, source, viewport, mirrored)),
      hand,
      fistScore(lm),
      results.timestamp,
    );
    return sample ? [sample] : [];
  });
}

// Associate the whole pair, rather than treating a flickering/duplicate label or
// detector array order as identity. Short gaps retain the same strike lifecycle.
export function assignScreenHands(samples, states, timestamp) {
  const candidates = [...states].filter(([, s]) => timestamp - s.timestamp <= 180);
  let best = null;
  function visit(index, used, assigned, cost) {
    if (index === samples.length) {
      if (!best || cost < best.cost) best = { cost, assigned: [...assigned] };
      return;
    }
    const sample = samples[index];
    for (const [id, state] of candidates) {
      if (used.has(id)) continue;
      const separation =
        Math.hypot(sample.x - state.x, sample.y - state.y) /
        Math.max(sample.radius, state.radius, 8);
      const penalty = sample.hand === state.hand ? 0 : 4;
      used.add(id);
      assigned.push(id);
      visit(index + 1, used, assigned, cost + Math.min(10, separation) + penalty);
      assigned.pop();
      used.delete(id);
    }
    assigned.push(null);
    visit(index + 1, used, assigned, cost + 15);
    assigned.pop();
  }
  visit(0, new Set(), [], 0);
  return best?.assigned ?? [];
}

export function renderedFists(hands, camera, viewport, timestamp, presets = []) {
  camera.updateWorldMatrix(true, false);
  return hands.flatMap((hand) => {
    if (!hand.tracked || !hand.visible || !hand.points) return [];
    hand.updateWorldMatrix(true, false);
    const preset = presets.find((arm) => arm.side === hand.side);
    preset?.palm.updateWorldMatrix(true, true);
    const points = hand.points.map((p) => p.clone().applyMatrix4(hand.matrixWorld));
    let center = hand.center.clone().applyMatrix4(hand.matrixWorld);
    if (preset) {
      // Preset arms have a smoothed wrist. Follow the actual drawn palm, not its input target.
      const drawnCenter = preset.palm.localToWorld(new THREE.Vector3(0, 0.045, 0));
      const offset = drawnCenter.clone().sub(center);
      center = drawnCenter;
      points.forEach((p) => p.add(offset));
    }
    const projected = points.map((p) => {
      p.project(camera);
      return {
        x: ((p.x + 1) * viewport.width) / 2,
        y: ((1 - p.y) * viewport.height) / 2,
      };
    });
    const sample = footprint(
      projected,
      hand.side < 0 ? 'left' : 'right',
      hand.closed,
      timestamp,
    );
    // Rendered 3D fists shrink as they extend into the scene. Their displayed
    // depth supplies motion/strength only; overlap is still exclusively in 2D.
    if (sample) sample.depth = -center.applyMatrix4(camera.matrixWorldInverse).z;
    return sample ? [sample] : [];
  });
}

// Continuous moving-circle / triangle intersection in CSS pixels. Test edge strips
// and vertex circles analytically, so even a whole-face crossing between frames lands.
function sweepTriangle(from, to, radius, a, b, c) {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  let best = null;
  const offer = (t, x, y) => {
    if (t >= 0 && t <= 1 && (!best || t < best.t)) best = { t, x, y };
  };
  const area = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
  if (Math.abs(area) < 1e-8) return null;
  const inside = [
    [a, b],
    [b, c],
    [c, a],
  ].every(
    ([p, q]) => cross(q.x - p.x, q.y - p.y, from.x - p.x, from.y - p.y) * area >= -1e-7,
  );
  if (inside) return { t: 0, x: from.x, y: from.y };
  for (const [p, q] of [
    [a, b],
    [b, c],
    [c, a],
  ]) {
    const ex = q.x - p.x,
      ey = q.y - p.y,
      len = Math.hypot(ex, ey);
    if (len < 1e-8) continue;
    const ux = ex / len,
      uy = ey / len;
    const along = clamp((from.x - p.x) * ux + (from.y - p.y) * uy, 0, len);
    const nearX = p.x + along * ux,
      nearY = p.y + along * uy;
    if (Math.hypot(from.x - nearX, from.y - nearY) <= radius) offer(0, nearX, nearY);
    const d0 = cross(ux, uy, from.x - p.x, from.y - p.y);
    const dd = cross(ux, uy, dx, dy);
    if (Math.abs(dd) > 1e-9)
      for (const sign of [-1, 1]) {
        const t = (sign * radius - d0) / dd;
        const s = (from.x + dx * t - p.x) * ux + (from.y + dy * t - p.y) * uy;
        if (s >= 0 && s <= len) offer(t, p.x + s * ux, p.y + s * uy);
      }
    const ox = from.x - p.x,
      oy = from.y - p.y;
    const aa = dx * dx + dy * dy,
      bb = 2 * (ox * dx + oy * dy);
    const cc = ox * ox + oy * oy - radius * radius;
    const disc = bb * bb - 4 * aa * cc;
    if (aa > 1e-9 && disc >= 0) offer((-bb - Math.sqrt(disc)) / (2 * aa), p.x, p.y);
  }
  return best;
}

export class ScreenMeshCollider {
  prepare(mesh, camera, viewport) {
    mesh.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    const matrix = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(mesh.matrixWorld);
    const positions = mesh.geometry.attributes.position;
    const key = `${positions.version}:${viewport.width}:${viewport.height}:${matrix.elements.join(',')}`;
    if (this.mesh === mesh && this.positions === positions && this.key === key) return;
    Object.assign(this, { mesh, positions, key, camera, viewport });
    this.projected =
      this.projected?.length === positions.count * 4
        ? this.projected
        : new Float32Array(positions.count * 4);
    const p = new THREE.Vector4();
    for (let i = 0; i < positions.count; i++) {
      p.set(positions.getX(i), positions.getY(i), positions.getZ(i), 1).applyMatrix4(
        matrix,
      );
      this.projected.set(
        [
          ((p.x / p.w + 1) * viewport.width) / 2,
          ((1 - p.y / p.w) * viewport.height) / 2,
          p.z / p.w,
          1 / p.w,
        ],
        i * 4,
      );
    }
  }
  sweep(from, to) {
    const radius = Math.max(from.radius, to.radius);
    const loX = Math.min(from.x, to.x) - radius,
      hiX = Math.max(from.x, to.x) + radius;
    const loY = Math.min(from.y, to.y) - radius,
      hiY = Math.max(from.y, to.y) + radius;
    const { geometry } = this.mesh,
      index = geometry.index;
    const count = index?.count ?? this.positions.count;
    const start = geometry.drawRange.start;
    const end = Math.min(count, start + geometry.drawRange.count);
    const p = this.projected;
    const a = {},
      b = {},
      c = {};
    let best = null,
      overlapping = false;
    for (let i = start; i + 2 < end; i += 3) {
      const ia = index ? index.getX(i) : i,
        ib = index ? index.getX(i + 1) : i + 1,
        ic = index ? index.getX(i + 2) : i + 2;
      a.x = p[ia * 4];
      a.y = p[ia * 4 + 1];
      b.x = p[ib * 4];
      b.y = p[ib * 4 + 1];
      c.x = p[ic * 4];
      c.y = p[ic * 4 + 1];
      if (
        Math.min(a.x, b.x, c.x) > hiX ||
        Math.max(a.x, b.x, c.x) < loX ||
        Math.min(a.y, b.y, c.y) > hiY ||
        Math.max(a.y, b.y, c.y) < loY
      )
        continue;
      if (
        [ia, ib, ic].some(
          (v) => p[v * 4 + 3] <= 0 || p[v * 4 + 2] < -1 || p[v * 4 + 2] > 1,
        )
      )
        continue;
      const area = cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
      const material = Array.isArray(this.mesh.material)
        ? this.mesh.material[
            geometry.groups.find((g) => i >= g.start && i < g.start + g.count)
              ?.materialIndex ?? 0
          ]
        : this.mesh.material;
      if (
        !material?.visible ||
        (material.side === THREE.FrontSide && area >= 0) ||
        (material.side === THREE.BackSide && area <= 0)
      )
        continue;
      if (!overlapping && sweepTriangle(to, to, to.radius, a, b, c)) overlapping = true;
      const hit = sweepTriangle(from, to, radius, a, b, c);
      if (!hit || (best && hit.t > best.t + 1e-6)) continue;
      if (
        hit.x < 0 ||
        hit.y < 0 ||
        hit.x > this.viewport.width ||
        hit.y > this.viewport.height
      )
        continue;
      const wb = cross(hit.x - a.x, hit.y - a.y, c.x - a.x, c.y - a.y) / area;
      const wc = cross(b.x - a.x, b.y - a.y, hit.x - a.x, hit.y - a.y) / area;
      const weights = [1 - wb - wc, wb, wc],
        ids = [ia, ib, ic];
      const z = weights.reduce((sum, w, k) => sum + w * p[ids[k] * 4 + 2], 0);
      if (best && Math.abs(hit.t - best.t) <= 1e-6 && z >= best.z) continue;
      const invW = weights.reduce((sum, w, k) => sum + w * p[ids[k] * 4 + 3], 0);
      const point = new THREE.Vector3();
      ids.forEach((v, k) =>
        point.addScaledVector(
          new THREE.Vector3().fromBufferAttribute(this.positions, v),
          (weights[k] * p[v * 4 + 3]) / invW,
        ),
      );
      const va = new THREE.Vector3().fromBufferAttribute(this.positions, ia),
        vb = new THREE.Vector3().fromBufferAttribute(this.positions, ib),
        vc = new THREE.Vector3().fromBufferAttribute(this.positions, ic);
      const normal = vb.sub(va).cross(vc.sub(va)).normalize();
      best = { ...hit, z, point: point.toArray(), normal: normal.toArray() };
    }
    return { hit: best, overlapping };
  }
}

// Contact authority for the game: displayed motion plus real mesh overlap. No
// target-camera depth threshold, inferred head ellipsoid, or global cooldown.
export class ScreenPunching {
  constructor({ getMesh, getDynamics, getView, contact, onEvent = () => {} }) {
    Object.assign(this, { getMesh, getDynamics, getView, contact, onEvent });
    this.collider = new ScreenMeshCollider();
    this.stats = { frames: 0, detected: 0, emitted: 0 };
    this.reset();
  }
  reset() {
    this.hands = new Map();
    this.nextHand = 0;
    this.lastTimestamp = -Infinity;
    this.lastEvent = null;
    this.debug = { phase: 'idle', closing: 0, travel: 0, span: 0 };
  }
  tick(results, now, enabled) {
    if (!enabled) {
      this.reset();
      return [];
    }
    const view = this.getView(results);
    const mesh = this.getMesh(),
      dynamics = this.getDynamics();
    if (!mesh || !view) {
      this.reset();
      return [];
    }
    const { camera, viewport, samples, timestamp, key } = view;
    // Resizing, changing sources, orbiting or loading a head must not sweep a
    // stationary hand across the newly moved image.
    camera.updateWorldMatrix(true, false);
    const viewKey = `${key}:${viewport.width}:${viewport.height}`;
    // Compared against the last ACCEPTED view, not the previous frame, and with a
    // tolerance: orbiting still accumulates past it and resets, but the settling
    // does not. OrbitControls runs with damping, so releasing a drag leaves the
    // camera easing for thousands of frames by ever smaller amounts. Exact float
    // equality here called every one of those frames a fresh orbit and reset the
    // hands, so the first punch thrown after rotating the head could not land for
    // ~11 s -- each fist looked brand new and no closing segment was ever measured.
    const pose = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
    const moved =
      !this.pose || pose.some((v, i) => Math.abs(v - this.pose[i]) > VIEW_TOLERANCE);
    if (
      mesh !== this.mesh ||
      dynamics !== this.dynamics ||
      viewKey !== this.viewKey ||
      moved
    )
      this.reset();
    if (moved) this.pose = pose;
    Object.assign(this, { mesh, dynamics, viewKey });
    if (!Number.isFinite(timestamp) || now - timestamp > 250 || now < timestamp) {
      this.hands.clear();
      return [];
    }
    if (timestamp <= this.lastTimestamp) return [];
    this.lastTimestamp = timestamp;
    this.stats.frames++;
    const events = [];
    let prepared = false;
    const valid = samples
      .filter(
        (s) => [s.x, s.y, s.radius, s.closed].every(Number.isFinite) && s.radius > 0,
      )
      .slice(0, 2);
    const assignments = assignScreenHands(valid, this.hands, timestamp);
    for (const [index, sample] of valid.entries()) {
      const { hand, x, y, radius, closed } = sample;
      const id = assignments[index] ?? ++this.nextHand;
      this.stats.detected++;
      const old = this.hands.get(id);
      if (!old || timestamp - old.timestamp > 180) {
        this.hands.set(id, { ...sample, timestamp, phase: 'ready', origin: sample });
        continue;
      }
      const dx = x - old.x,
        dy = y - old.y,
        dr =
          Number.isFinite(sample.depth) && Number.isFinite(old.depth)
            ? ((sample.depth - old.depth) * radius) / 0.08
            : radius - old.radius;
      const dt = (timestamp - old.timestamp) / 1000;
      const travel = Math.hypot(dx, dy),
        growth = Math.max(0, dr);
      const movement = Math.hypot(travel, growth * 2);
      const state = { ...old, ...sample, timestamp };
      this.hands.set(id, state);
      this.debug = {
        phase: state.phase,
        closing: movement / dt,
        travel,
        span: (radius * 2) / viewport.width,
        hand,
      };
      if (closed < 0.18) {
        state.phase = 'ready';
        state.origin = sample;
        continue;
      }
      // Jitter/holding do not punch. Accumulated movement still admits slow crossings.
      if (Math.hypot(travel, dr * 2) < 0.5) continue;
      if (!prepared) {
        this.collider.prepare(mesh, camera, viewport);
        prepared = true;
      }
      const { hit, overlapping } = this.collider.sweep(old, sample);
      if (state.phase === 'contact' || state.phase === 'retract') {
        const entry = state.entry;
        const depth =
          Number.isFinite(sample.depth) && Number.isFinite(entry.depth)
            ? ((sample.depth - entry.depth) * radius) / 0.08
            : radius - entry.radius;
        const fromEntry =
          (x - entry.x) * state.attack[0] +
          (y - entry.y) * state.attack[1] +
          depth * 2 * state.attack[2];
        // Leaving beyond the far cheek is follow-through, not a fresh guard.
        // Only separation on the entry side re-arms an arbitrary new strike.
        // The segment returning there has already spent this punch's contact.
        if (!overlapping && fromEntry < -Math.max(3, radius * 0.12)) {
          state.phase = 'outside';
          state.origin = sample;
          continue;
        }
      }
      if (state.phase === 'contact') {
        const reverse =
          dx * state.attack[0] + dy * state.attack[1] + dr * 2 * state.attack[2];
        state.pullback = Math.max(0, (state.pullback ?? 0) - reverse);
        if (state.pullback > Math.max(4, radius * 0.3)) {
          state.phase = 'retract';
          state.origin = sample;
        }
        continue;
      }
      if (state.phase === 'retract') {
        const forward =
          dx * state.attack[0] + dy * state.attack[1] + dr * 2 * state.attack[2];
        if (forward < Math.max(1, radius * 0.04)) {
          state.origin = sample;
          continue;
        }
        state.phase = 'ready';
      }
      if (state.phase === 'outside') {
        // A crossing can start and end outside; it is still a new contact.
        state.phase = 'ready';
      }
      const reach = Math.hypot(
        x - state.origin.x,
        y - state.origin.y,
        Math.max(
          0,
          Number.isFinite(sample.depth) && Number.isFinite(state.origin.depth)
            ? ((sample.depth - state.origin.depth) * radius) / 0.08
            : radius - state.origin.radius,
        ) * 2,
      );
      // A real punch is short and fast at the knuckles but the camera only samples it
      // ~30 times a second, so the measured chord under-reports both. Keep the gates
      // loose enough that an ordinary swing registers, tight enough that a drifting
      // guard does not: guarding moves the fist a few pixels per frame at most.
      if (!hit || reach < Math.max(2, radius * 0.08) || movement / dt < radius * 0.45)
        continue;
      // Shrinking in place is a withdrawal, never another jab.
      if (dr < 0 && travel < Math.abs(dr) * 1.5) continue;
      const point = new THREE.Vector3(...hit.point);
      const worldPoint = mesh.localToWorld(point.clone());
      const ndc = worldPoint.clone().project(camera);
      const pixel = ndc.clone();
      pixel.x += 2 / viewport.width;
      const metresPerPixel = pixel.unproject(camera).distanceTo(worldPoint);
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const direction = new THREE.Vector3(dx, -dy, 0).applyQuaternion(
        camera.getWorldQuaternion(new THREE.Quaternion()),
      );
      direction
        .addScaledVector(forward, Math.max(growth * 2, travel * 0.45, 1))
        .normalize();
      direction.transformDirection(mesh.matrixWorld.clone().invert());
      const normal = new THREE.Vector3(...hit.normal);
      if (normal.dot(direction) > 0) normal.negate();
      // Same sampling gap: the peak closing speed falls between two frames, so the
      // chord reads slow. Lift it, and raise the floor, so a light-but-real contact
      // still asks the tissue rig for a dent you can see rather than the minimum.
      const speed = clamp((movement / dt) * metresPerPixel * 1.35, 0.4, 4);
      const mode =
        travel < growth * 3
          ? 'jab'
          : Math.abs(dy) > Math.abs(dx) * 1.2
            ? dy < 0
              ? 'uppercut'
              : 'overhand'
            : 'hook';
      const event = {
        type: 'impact',
        hand,
        point: hit.point,
        direction: direction.toArray(),
        normal: normal.toArray(),
        speed,
        mode,
        timestamp,
        contactTime: old.timestamp + (timestamp - old.timestamp) * hit.t,
        region: 'face',
        screen: { x: hit.x, y: hit.y, radius },
        normalSpeed: Math.abs(normal.dot(direction)) * speed,
        tangentSpeed: Math.sqrt(Math.max(0, 1 - normal.dot(direction) ** 2)) * speed,
        source: 'screen',
      };
      event.landed = this.contact(point, direction, speed, 'webcam', mode, {
        side: hand,
        cv: event,
      });
      // A fast hook may enter and exit between two frames. Its return still
      // belongs to this strike even though the ending fist is outside the head.
      state.phase = 'contact';
      state.attack = [dx, dy, dr * 2].map((v) => v / (Math.hypot(dx, dy, dr * 2) || 1));
      state.entry = {
        x: old.x + dx * hit.t,
        y: old.y + dy * hit.t,
        radius: old.radius + (radius - old.radius) * hit.t,
        depth:
          Number.isFinite(old.depth) && Number.isFinite(sample.depth)
            ? old.depth + (sample.depth - old.depth) * hit.t
            : undefined,
      };
      state.pullback = 0;
      state.origin = sample;
      this.lastEvent = event;
      this.stats.emitted++;
      this.onEvent(event);
      events.push(event);
    }
    // A short dropout can be bridged by the next observed segment. Never invent
    // a blind punch after the fist disappears.
    for (const [hand, state] of this.hands)
      if (timestamp - state.timestamp > 180) this.hands.delete(hand);
    return events;
  }
}
