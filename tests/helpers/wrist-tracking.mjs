import * as THREE from 'three';

// A palm with known player-space orientation, supplied as the unmirrored
// front-camera observations consumed by Tracking.tick. Finger joints curl
// inward, but the palm anchors do not change when the fist rolls.
export function wristObservation(side, quaternion, aspect = 16 / 9) {
  const points = [new THREE.Vector3(0, -0.055, 0)];
  for (let finger = 0; finger < 5; finger++) {
    const x = side * (finger - 2.5) * 0.024;
    for (let joint = 0; joint < 4; joint++)
      points.push(
        new THREE.Vector3(
          x,
          [0.02, 0.045, 0.022, 0.002][joint],
          [0, 0, -0.02, -0.03][joint],
        ),
      );
  }
  points[9].set(0, 0.025, 0);
  points.forEach((p) => p.applyQuaternion(quaternion));
  return {
    world: points.map((p) => ({ x: -p.x, y: -p.y, z: p.z })),
    image: points.map((p) => ({
      x: 0.5 - side * 0.18 - p.x * 1.7,
      y: 0.53 - p.y * 1.7 * aspect,
      z: p.z * 1.7,
    })),
  };
}
