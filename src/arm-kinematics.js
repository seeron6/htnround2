import * as THREE from 'three';

// A two-link IK solve. Bone lengths remain constant; the pole controls the
// elbow's bend plane. Reach limits avoid an inverted elbow at full extension.
export function solveArmAnchors(shoulder, target, upperLength, forearmLength, pole) {
  const axis = target.clone().sub(shoulder);
  const requested = axis.length();
  if (requested < 1e-8) axis.set(0, 0, -1);
  else axis.divideScalar(requested);
  const distance = THREE.MathUtils.clamp(
    requested,
    Math.abs(upperLength - forearmLength) + 0.015,
    upperLength + forearmLength - 0.004,
  );
  const wrist = shoulder.clone().addScaledVector(axis, distance);
  const along =
    (upperLength ** 2 - forearmLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const bend = pole.clone().sub(shoulder);
  bend.addScaledVector(axis, -bend.dot(axis));
  if (bend.lengthSq() < 1e-8) {
    bend.set(Math.abs(axis.x) < 0.8 ? 1 : 0, Math.abs(axis.x) < 0.8 ? 0 : 1, 0);
    bend.addScaledVector(axis, -bend.dot(axis));
  }
  const elbow = shoulder
    .clone()
    .addScaledVector(axis, along)
    .addScaledVector(bend.normalize(), height);
  return {
    shoulder: shoulder.clone(),
    elbow,
    wrist,
    reachLimited: requested > distance + 1e-5,
  };
}

export function armFrame(direction, dorsal) {
  const y = direction.clone().normalize();
  const z = dorsal.clone().addScaledVector(y, -dorsal.dot(y));
  if (z.lengthSq() < 1e-8) {
    z.set(0, 1, 0).addScaledVector(y, -y.y);
    if (z.lengthSq() < 1e-8) z.set(1, 0, 0);
  }
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(x, y, z),
  );
}
