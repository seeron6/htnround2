import * as THREE from 'three';
import { TargetTracking } from './target-camera.js';
import { ScreenPunching } from './screen-contact.js';

const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

// The extractor's origin is the middle of the face, which is not necessarily
// the GLB origin. Use fitted landmarks so a neck or large crown cannot move aim.
export function punchTargetFrame(mesh, dynamics) {
  // The reference impact rig retains its historical anchors; the speech rig
  // carries the measured facial landmarks, including the nose.
  const impactAnchors = dynamics?.impactRig?.anchors;
  const a = finite3(impactAnchors?.[1])
    ? impactAnchors
    : (dynamics?.speechRig?.anchors ?? impactAnchors ?? {});
  const cage = dynamics?.cage?.positions;
  const at = (i) => {
    const value =
      cage?.length > i * 3 + 2 ? Array.from(cage.slice(i * 3, i * 3 + 3)) : a[i];
    return finite3(value) ? value : null;
  };
  const left = at(234) ?? at(50),
    right = at(454) ?? at(280);
  const chin = at(152),
    eyeL = at(159),
    eyeR = at(386),
    nose = at(1);
  if (left && right && chin && eyeL && eyeR && nose) {
    const eyeY = (eyeL[1] + eyeR[1]) / 2;
    const height = Math.max(0.06, eyeY - chin[1]);
    const bottom = chin[1] - height * 0.06;
    const top = eyeY + height * 0.48;
    const rx = Math.max(
      0.025,
      Math.abs(right[0] - left[0]) * (at(234) && at(454) ? 0.56 : 0.9),
    );
    // 234/454 measure width at the temples and can sit far behind the cheeks.
    // They must not move hooks or uppercuts onto the back half of a full head.
    const cheekL = at(50) ?? left,
      cheekR = at(280) ?? right;
    const centerZ = (cheekL[2] + cheekR[2]) / 2 - rx * 0.1;
    const rz = Math.max(0.02, nose[2] - centerZ);
    return {
      center: [(left[0] + right[0]) / 2, (top + bottom) / 2, centerZ],
      radii: [rx, (top - bottom) / 2, rz],
    };
  }
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  const center = box.getCenter(new THREE.Vector3()).toArray();
  const radii = box
    .getSize(new THREE.Vector3())
    .multiplyScalar(0.5)
    .toArray()
    .map((v) => Math.max(v, 0.01));
  return { center, radii };
}

// Adapt jace/cv's registerTargetImpact to the editable mesh and fitted face origin.
// Points and normals are returned in mesh-local coordinates, as FaceDynamics expects.
export function mapTargetImpact(event, mesh, frame = null) {
  if (
    !mesh?.geometry?.attributes?.position ||
    event?.missed ||
    !finite3(event?.point) ||
    !finite3(event?.direction) ||
    !Number.isFinite(event.speed) ||
    event.speed <= 0
  )
    return null;
  frame ??= punchTargetFrame(mesh);
  const travel = new THREE.Vector3(...event.direction);
  if (travel.lengthSq() < 1e-10) return null;
  travel.normalize();
  const entry = new THREE.Vector3(...event.point).add(
    new THREE.Vector3(...frame.center),
  );
  mesh.updateWorldMatrix(true, false);
  // Deformation changes the surface without updating Three's raycast bounds.
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeBoundingBox();
  const reach = Math.max(...frame.radii) * 4;
  const origin = mesh.localToWorld(entry.clone().addScaledVector(travel, -reach));
  const ray = new THREE.Raycaster(
    origin,
    travel.clone().transformDirection(mesh.matrixWorld),
  );
  // Double-sided meshes can report the exit when a ray grazes a seam at entry.
  // Only an inward crossing is a landing; otherwise use the nearby-skin fallback.
  const hit = ray
    .intersectObject(mesh, false)
    .find((hit) => hit.face.normal.dot(travel) < -1e-6);
  let point,
    normal,
    snapped = false;
  if (hit) {
    point = mesh.worldToLocal(hit.point.clone());
    // Three r180's hit.normal is mesh-local (see Mesh.checkGeometryIntersection).
    normal = (hit.normal ?? hit.face.normal).clone().normalize();
  } else {
    // The analytic silhouette can graze past the chin. Snap only a nearby
    // entry to a real vertex; a distant fist remains a miss.
    const positions = mesh.geometry.attributes.position;
    const candidate = new THREE.Vector3();
    let distance = (Math.min(frame.radii[0], frame.radii[1]) * 0.4) ** 2;
    for (let i = 0; i < positions.count; i++) {
      candidate.fromBufferAttribute(positions, i);
      const d = candidate.distanceToSquared(entry);
      if (d >= distance) continue;
      distance = d;
      point = candidate.clone();
      normal = mesh.geometry.attributes.normal
        ? new THREE.Vector3()
            .fromBufferAttribute(mesh.geometry.attributes.normal, i)
            .normalize()
        : travel.clone().negate();
    }
    if (!point) return null;
    snapped = true;
  }
  if (normal.dot(travel) > 0) normal.negate();
  const velocity = travel.clone().multiplyScalar(event.speed);
  const vn = velocity.dot(normal);
  const knuckles = finite3(event.knuckleNormal)
    ? new THREE.Vector3(...event.knuckleNormal).normalize()
    : null;
  return {
    ...event,
    point: point.toArray(),
    direction: travel.toArray(),
    normal: normal.toArray(),
    normalSpeed: Math.abs(vn),
    tangentSpeed: velocity.addScaledVector(normal, -vn).length(),
    obliquity: knuckles
      ? THREE.MathUtils.radToDeg(
          Math.acos(THREE.MathUtils.clamp(-knuckles.dot(normal), -1, 1)),
        )
      : null,
    snapped,
  };
}

export class WebcamPunching {
  constructor({ video, getMesh, getDynamics, getView, contact, onEvent = () => {} }) {
    Object.assign(this, { getMesh, getDynamics, contact, onEvent });
    this.tracker = new TargetTracking(video, () => {});
    this.mesh = null;
    this.lastEvent = null;
    this.enabled = false;
    if (getView)
      this.screen = new ScreenPunching({
        getMesh,
        getDynamics,
        getView,
        contact,
        onEvent: (event) => {
          this.lastEvent = event;
          this.onEvent(event);
        },
      });
  }
  reset() {
    this.tracker.reset();
    this.screen?.reset();
    this.lastEvent = null;
  }
  syncMesh() {
    const mesh = this.getMesh();
    const dynamics = this.getDynamics();
    if (mesh !== this.mesh || dynamics !== this.dynamics) {
      this.mesh = mesh;
      this.dynamics = dynamics;
      this.reset();
    }
    if (!mesh) return null;
    const frame = punchTargetFrame(mesh, dynamics);
    this.tracker.setHeadWidth(frame.radii[0] * 2);
    this.tracker.setHeadRadii(frame.radii);
    return frame;
  }
  apply(event, frame = this.syncMesh()) {
    if (!frame) return false;
    const mapped = mapTargetImpact(event, this.mesh, frame);
    if (!mapped) {
      this.lastEvent = { ...event, landed: false };
      this.onEvent(this.lastEvent);
      return false;
    }
    const landed = this.contact(
      new THREE.Vector3(...mapped.point),
      new THREE.Vector3(...mapped.direction),
      Math.min(4, mapped.speed),
      'webcam',
      mapped.mode,
      { side: mapped.hand, cv: mapped },
    );
    this.lastEvent = { ...mapped, landed };
    this.onEvent(this.lastEvent);
    return landed;
  }
  tick(results, now, enabled) {
    if (this.screen) {
      this.enabled = enabled;
      const events = this.screen.tick(results, now, enabled);
      return events.at(-1) ?? null;
    }
    if (!enabled) {
      if (this.enabled) this.reset();
      this.enabled = false;
      return null;
    }
    this.enabled = true;
    const frame = this.syncMesh();
    if (!frame) return null;
    const event = this.tracker.consume(
      results && now - results.timestamp < 350 ? results : null,
      now,
    );
    if (event) this.apply(event, frame);
    return event;
  }
}
