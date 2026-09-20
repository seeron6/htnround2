import * as THREE from 'three';
import { armFrame } from './arm-kinematics.js';

const PALM = [0, 5, 9, 17];
const finite = (p) => p && [p.x, p.y, p.z].every(Number.isFinite);

// Match the anatomical mesh: +y wrist to middle knuckle, +z out of the
// back of the hand. Side changes which edge of the palm contains the thumb.
export function palmFrame(points, side) {
  if (!PALM.every((i) => finite(points?.[i]))) return null;
  const y = new THREE.Vector3().subVectors(points[9], points[0]);
  const x = new THREE.Vector3().subVectors(points[5], points[17]).multiplyScalar(-side);
  if (y.lengthSq() < 1e-10 || x.lengthSq() < 1e-10) return null;
  y.normalize();
  x.normalize();
  const dorsal = new THREE.Vector3().crossVectors(x, y);
  if (dorsal.lengthSq() < 0.01) return null;
  return armFrame(y, dorsal);
}

export function trackedPalmFrame(world, image, side, aspect = 1) {
  // The front camera looks toward the player. Use the same first-person
  // axes as hand position: camera +x/+y become player -x/-y; z keeps its sign.
  const convert = (points, yScale) =>
    points?.map((p) =>
      finite(p) ? new THREE.Vector3(-p.x, -p.y * yScale, p.z) : null,
    );
  // Metric landmarks retain depth when the palm turns edge-on. Image y is
  // height-normalized, while x and z are width-normalized, so correct aspect
  // before using the image-only fallback.
  return (
    palmFrame(convert(world, 1), side) ??
    palmFrame(convert(image, 1 / (aspect > 0 ? aspect : 1)), side)
  );
}

export function limitWristBend(palm, forearm, maxBend = Math.PI * (75 / 180)) {
  const relative = forearm.clone().invert().multiply(palm);
  // Separate axial roll from bend so pronation is never clamped to the
  // preview slider's range, even when the inferred elbow differs from reality.
  const twist = new THREE.Quaternion(0, relative.y, 0, relative.w);
  if (twist.lengthSq() < 1e-10) twist.identity();
  else twist.normalize();
  const swing = relative.clone().multiply(twist.clone().invert());
  const angle = new THREE.Quaternion().angleTo(swing);
  if (angle > maxBend) swing.copy(new THREE.Quaternion().slerp(swing, maxBend / angle));
  return forearm.clone().multiply(swing).multiply(twist);
}

export function forearmRoll(palm, forearm, previous = 0) {
  const relative = forearm.clone().invert().multiply(palm);
  const angle = 2 * Math.atan2(relative.y, relative.w);
  // Keep the twist continuous when a tracked palm crosses +/-180 degrees.
  return previous + Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous));
}
