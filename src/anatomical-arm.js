import * as THREE from 'three';
import template from '../public/models/arms/anatomical-arms.json' with { type: 'json' };
import { ArmDynamics } from './physics.js';
import { normalizeArmProfile } from './arm-personalization.js';
import { solveArmAnchors, armFrame } from './arm-kinematics.js';
import { makeArmMaterials } from './arm-materials.js';
import { forearmRoll, limitWristBend } from './hand-orientation.js';

const v3 = (a) => new THREE.Vector3(...a);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);
const clamp = THREE.MathUtils.clamp;

function sleeveGeometry() {
  const positions = [],
    uv = [],
    indices = [];
  for (let r = 0; r <= 72; r++)
    for (let a = 0; a <= 48; a++) {
      positions.push(0, 0, 0);
      uv.push(a / 48, r / 72);
      if (r < 72 && a < 48) {
        const i = r * 49 + a;
        indices.push(i, i + 49, i + 1, i + 1, i + 49, i + 50);
      }
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  return geometry;
}

export class AnatomicalArm extends THREE.Group {
  constructor(side, input = {}, sample = null) {
    super();
    this.side = side;
    this.name = `${side < 0 ? 'Left' : 'Right'} anatomical arm`;
    this.profile = normalizeArmProfile(input);
    this.motor = new ArmDynamics();
    this.sample = sample;
    const data = template.arms[side < 0 ? 'left' : 'right'];
    this.rest = new Map(
      data.bones.map((b) => [b.name, { head: v3(b.head), tail: v3(b.tail) }]),
    );
    this.shoulderRest = this.rest.get('upperarm01').head;
    this.elbowRest = this.rest.get('lowerarm01').head;
    this.wristRest = this.rest.get('wrist').head;
    this.upperLength = this.shoulderRest.distanceTo(this.elbowRest);
    this.forearmLength = this.elbowRest.distanceTo(this.wristRest);
    const palmY = this.rest
      .get('finger3-1')
      .head.clone()
      .sub(this.wristRest)
      .normalize();
    const palmX = this.rest
      .get('finger2-1')
      .head.clone()
      .sub(this.rest.get('finger5-1').head)
      .multiplyScalar(-side);
    palmX.addScaledVector(palmY, -palmX.dot(palmY)).normalize();
    this.restDorsal = new THREE.Vector3().crossVectors(palmX, palmY).normalize();
    this.palmRestFrame = armFrame(palmY, this.restDorsal);
    this.upperRestFrame = armFrame(
      this.elbowRest.clone().sub(this.shoulderRest),
      this.restDorsal,
    );
    this.lowerRestFrame = armFrame(
      this.wristRest.clone().sub(this.elbowRest),
      this.restDorsal,
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(data.positions, 3),
    );
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    geometry.setAttribute(
      'skinIndex',
      new THREE.Uint16BufferAttribute(data.skinIndex, 4),
    );
    geometry.setAttribute(
      'skinWeight',
      new THREE.Float32BufferAttribute(data.skinWeight, 4),
    );
    geometry.setIndex(data.indices);
    // Width changes girth around each vertex's controlling bone, not bone length.
    const points = geometry.attributes.position;
    for (let i = 0; i < points.count; i++) {
      const b = data.bones[data.skinIndex[i * 4]],
        a = v3(b.head),
        axis = v3(b.tail).sub(a).normalize();
      const p = new THREE.Vector3().fromBufferAttribute(points, i).sub(a);
      const along = axis.clone().multiplyScalar(p.dot(axis));
      p.sub(along).multiplyScalar(this.profile.width).add(along).add(a);
      points.setXYZ(i, p.x, p.y, p.z);
    }
    if (this.profile.width !== 1) geometry.computeVertexNormals();
    const photoUv = new Float32Array(points.count * 3);
    const armAlong = new Float32Array(points.count);
    const upperAxis = this.elbowRest.clone().sub(this.shoulderRest).normalize();
    const split = this.upperLength / (this.upperLength + this.forearmLength);
    const forearmAxis = this.wristRest.clone().sub(this.elbowRest).normalize();
    const forearmX = X.clone().applyQuaternion(this.lowerRestFrame);
    const forearmZ = Z.clone().applyQuaternion(this.lowerRestFrame);
    for (let i = 0; i < points.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(points, i).sub(this.elbowRest);
      const t = p.dot(forearmAxis) / this.forearmLength;
      const controlling = data.bones[data.skinIndex[i * 4]].name;
      armAlong[i] = controlling.startsWith('upperarm')
        ? (new THREE.Vector3()
            .fromBufferAttribute(points, i)
            .sub(this.shoulderRest)
            .dot(upperAxis) /
            this.upperLength) *
          split
        : controlling.startsWith('lowerarm')
          ? split + t * (1 - split)
          : 1.1;
      const x = p.dot(forearmX) / (0.045 * this.profile.width);
      const front = p.dot(forearmZ) > 0.008;
      const inSkin =
        this.profile.style === 'bare' ||
        this.profile.style === 'short' ||
        t > this.profile.sleeveCoverage;
      const mask =
        front && t > 0.05 && t < 0.97 && inSkin
          ? THREE.MathUtils.smoothstep(1 - Math.abs(x), 0, 0.35)
          : 0;
      photoUv.set([clamp(x * 0.5 + 0.5, 0, 1), clamp(1 - t, 0, 1), mask], i * 3);
      if (controlling.startsWith('upperarm') && sample?.upperStrip) {
        const upper = new THREE.Vector3()
          .fromBufferAttribute(points, i)
          .sub(this.shoulderRest);
        const along = upper.dot(upperAxis) / this.upperLength;
        const upperX = X.clone().applyQuaternion(this.upperRestFrame);
        const upperZ = Z.clone().applyQuaternion(this.upperRestFrame);
        const across = upper.dot(upperX) / (0.06 * this.profile.width);
        photoUv.set(
          [
            clamp(across * 0.5 + 0.5, 0, 1),
            1.001 + clamp(1 - along, 0, 0.999),
            upper.dot(upperZ) > 0.01 && along > 0.1 && along < 0.96
              ? THREE.MathUtils.smoothstep(1 - Math.abs(across), 0, 0.35)
              : 0,
          ],
          i * 3,
        );
      }
    }
    geometry.setAttribute('armPhotoUv', new THREE.BufferAttribute(photoUv, 3));
    geometry.setAttribute('armAlong', new THREE.BufferAttribute(armAlong, 1));
    const { skin, cloth, photoMap, upperPhotoMap } = makeArmMaterials(
      this.profile,
      sample,
    );
    if (this.profile.style !== 'bare') {
      const end =
        this.profile.style === 'short'
          ? split * this.profile.upperSleeveCoverage
          : split + (1 - split) * this.profile.sleeveCoverage;
      const applyPhoto = skin.onBeforeCompile;
      skin.onBeforeCompile = (shader, renderer) => {
        applyPhoto(shader, renderer);
        shader.uniforms.sleeveEnd = { value: end - 0.006 };
        shader.vertexShader =
          'attribute float armAlong; varying float vArmAlong;\n' +
          shader.vertexShader.replace(
            '#include <uv_vertex>',
            '#include <uv_vertex>\nvArmAlong = armAlong;',
          );
        shader.fragmentShader =
          'uniform float sleeveEnd; varying float vArmAlong;\n' +
          shader.fragmentShader.replace(
            '#include <clipping_planes_fragment>',
            '#include <clipping_planes_fragment>\nif (vArmAlong < sleeveEnd) discard;',
          );
      };
      skin.customProgramCacheKey = () => `arm-clothed-v2-${!!sample}-${!!photoMap}`;
    }
    this.photoMap = photoMap;
    this.upperPhotoMap = upperPhotoMap;
    this.surface = new THREE.SkinnedMesh(geometry, skin);
    this.surface.name = 'Continuous shoulder elbow wrist hand skin';
    this.surface.frustumCulled = false;
    this.surface.castShadow = true;
    this.surface.receiveShadow = true;
    this.add(this.surface);
    this.bones = data.bones.map((data) => {
      const b = new THREE.Bone();
      b.name = data.name;
      b.position.fromArray(data.head);
      this.surface.add(b);
      return b;
    });
    this.byName = new Map(this.bones.map((b) => [b.name, b]));
    this.surface.bind(new THREE.Skeleton(this.bones));
    this.sleeve = new THREE.Mesh(sleeveGeometry(), cloth);
    this.sleeve.geometry.setAttribute(
      'armPhotoUv',
      new THREE.Float32BufferAttribute(new Float32Array(73 * 49 * 3), 3),
    );
    this.sleeve.name = 'Articulated cloth sleeve with folds and hem';
    this.sleeve.visible = this.profile.style !== 'bare';
    this.sleeve.frustumCulled = false;
    this.sleeve.castShadow = this.sleeve.receiveShadow = true;
    this.add(this.sleeve);
    // Public attachment frames also support watches/rings and review markers.
    this.palm = new THREE.Group();
    this.forearm = new THREE.Group();
    this.add(this.palm, this.forearm);
    const metal = new THREE.MeshStandardMaterial({
      color: this.profile.ringColor,
      metalness: 0.8,
      roughness: 0.26,
    });
    // Fit the band outside this finger's actual cross-section. The former
    // fixed radius put rings inside the skin, especially on the middle finger.
    const ringName = `finger${this.profile.ringFinger}-1`;
    const ringRest = this.rest.get(ringName);
    const ringAxis = ringRest.tail.clone().sub(ringRest.head);
    const ringLength = ringAxis.length();
    ringAxis.normalize();
    const radii = [];
    for (let i = 0; i < points.count; i++) {
      if (data.bones[data.skinIndex[i * 4]].name !== ringName) continue;
      const p = new THREE.Vector3().fromBufferAttribute(points, i).sub(ringRest.head);
      const along = p.dot(ringAxis);
      if (Math.abs(along / ringLength - this.profile.ringPosition) > 0.14) continue;
      radii.push(p.addScaledVector(ringAxis, -along).length());
    }
    radii.sort((a, b) => a - b);
    const ringRadius =
      (radii[Math.floor(radii.length * 0.95)] || 0.012 * this.profile.width) + 0.0008;
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(ringRadius, 0.0015, 12, 48),
      metal,
    );
    this.ring.visible = this.profile.ring;
    this.add(this.ring);
    this.watch = new THREE.Group();
    this.watch.visible = this.profile.watch;
    this.add(this.watch);
    const strap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.029, 0.029, 0.024, 48, 1, true),
      new THREE.MeshStandardMaterial({
        color: this.profile.watchColor,
        roughness: 0.86,
        side: THREE.DoubleSide,
      }),
    );
    strap.scale.z = 0.73;
    this.watch.add(strap);
    const dial = new THREE.Mesh(
      new THREE.CylinderGeometry(0.019, 0.019, 0.007, 48),
      new THREE.MeshStandardMaterial({
        color: '#a8adb3',
        metalness: 0.8,
        roughness: 0.28,
      }),
    );
    dial.rotation.x = Math.PI / 2;
    dial.position.z = 0.024;
    this.watch.add(dial);
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(0.016, 48),
      new THREE.MeshStandardMaterial({
        color: this.profile.watchFaceColor,
        roughness: 0.3,
      }),
    );
    face.position.z = 0.028;
    this.watch.add(face);
    this.anchorMarkers = new THREE.Group();
    this.anchorMarkers.visible = false;
    this.add(this.anchorMarkers);
    for (let i = 0; i < 3; i++)
      this.anchorMarkers.add(
        new THREE.Mesh(
          new THREE.SphereGeometry(0.007, 12, 8),
          new THREE.MeshBasicMaterial({
            color: ['#efbe70', '#6fe3b8', '#77bcff'][i],
            depthTest: false,
          }),
        ),
      );
    this.update(null, 1 / 60);
  }

  update(hand, dt) {
    const side = this.side;
    const center = hand?.visible
      ? hand.center.clone()
      : new THREE.Vector3(side * 0.15, -0.105, -0.34);
    center.x = clamp(center.x, -0.42, 0.42);
    center.y = clamp(center.y, -0.4, 0.25);
    center.z = clamp(center.z, -0.85, -0.18);
    const target = this.motor
      .step(center.add(new THREE.Vector3(0, -0.052, 0.025)), dt)
      .clone();
    const shoulder = new THREE.Vector3(side * 0.21, -0.24, 0.055);
    // A small shoulder reach follows punches beyond the neutral arm span.
    const reach = target.clone().sub(shoulder);
    const excess = Math.max(
      0,
      reach.length() - this.upperLength - this.forearmLength + 0.02,
    );
    shoulder.addScaledVector(reach.normalize(), Math.min(excess, 0.16));
    this.anchors = solveArmAnchors(
      shoulder,
      target,
      this.upperLength,
      this.forearmLength,
      new THREE.Vector3(side * 0.42, -0.61, -0.04),
    );
    const { elbow, wrist } = this.anchors;
    const upperDirection = elbow.clone().sub(shoulder).normalize();
    const lowerDirection = wrist.clone().sub(elbow).normalize();
    const upperQ = armFrame(upperDirection, Z).multiply(
      this.upperRestFrame.clone().invert(),
    );
    const lowerFrame = armFrame(lowerDirection, Z);
    const closed = clamp(hand?.closed ?? 1, 0, 1);
    // The wrist bends in its own plane: a little flexion as the fist closes, plus a
    // slight tilt toward the thumb. Tilting the hand toward world up instead drove the
    // joint into extension whenever the forearm rose, bending it the wrong way.
    const wristBend = new THREE.Quaternion()
      .setFromAxisAngle(X, -(0.06 + closed * 0.08))
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(Z, side * (0.04 + closed * 0.04)),
      );
    const palmTarget = lowerFrame.clone().multiply(wristBend);
    if (Number.isFinite(hand?.wristRoll))
      palmTarget.multiply(
        new THREE.Quaternion().setFromAxisAngle(Y, clamp(hand.wristRoll, -1.2, 1.2)),
      );
    const observed = hand?.visible && hand.palmOrientation;
    if (observed) palmTarget.copy(limitWristBend(observed, lowerFrame));
    // Smooth sensor jitter in quaternion space, including across the +/-180
    // degree roll boundary. Preview/demo poses keep their existing response.
    if (observed || this.followingPalm)
      this.palm.quaternion.slerp(palmTarget, 1 - Math.exp(-28 * Math.max(0, dt)));
    else this.palm.quaternion.copy(palmTarget);
    this.followingPalm = !!observed;
    this.roll = forearmRoll(
      this.palm.quaternion,
      lowerFrame,
      observed ? (this.roll ?? 0) : 0,
    );
    const handDirection = Y.clone().applyQuaternion(this.palm.quaternion);
    const palmQ = this.palm.quaternion
      .clone()
      .multiply(this.palmRestFrame.clone().invert());
    this.palm.position.copy(wrist);
    this.forearm.position.copy(elbow);
    this.forearm.quaternion.copy(lowerFrame);
    for (const b of this.bones) {
      const rest = this.rest.get(b.name);
      if (b.name.startsWith('upperarm')) {
        b.position
          .copy(rest.head)
          .sub(this.shoulderRest)
          .applyQuaternion(upperQ)
          .add(shoulder);
        b.quaternion.copy(upperQ);
      } else if (b.name.startsWith('lowerarm')) {
        const t = rest.head.distanceTo(this.elbowRest) / this.forearmLength;
        // Distribute pronation through the forearm to avoid a wrist twist seam.
        const q = lowerFrame
          .clone()
          .multiply(new THREE.Quaternion().setFromAxisAngle(Y, this.roll * t))
          .multiply(this.lowerRestFrame.clone().invert());
        b.position.copy(elbow).lerp(wrist, t);
        b.quaternion.copy(q);
      } else {
        b.position
          .copy(rest.head)
          .sub(this.wristRest)
          .applyQuaternion(palmQ)
          .add(wrist);
        b.quaternion.copy(palmQ);
      }
    }
    const bendAxis = X.clone().applyQuaternion(this.palm.quaternion);
    for (let finger = 1; finger <= 5; finger++) {
      let q = palmQ.clone(),
        previous;
      if (finger > 1) {
        const root = this.rest.get(`finger${finger}-1`);
        const from = root.tail
          .clone()
          .sub(root.head)
          .applyQuaternion(palmQ)
          .normalize();
        const adduct = new THREE.Quaternion().setFromUnitVectors(from, handDirection);
        q.premultiply(new THREE.Quaternion().slerp(adduct, closed * 0.92));
      }
      for (let j = 1; j <= 3; j++) {
        const name = `finger${finger}-${j}`,
          bone = this.byName.get(name),
          rest = this.rest.get(name);
        if (previous)
          bone.position
            .copy(previous.tail)
            .sub(previous.head)
            .applyQuaternion(q)
            .add(previous.position);
        const angle =
          closed *
          (finger === 1 ? [0.38, 0.58, 0.56][j - 1] : [1.42, 1.4, 0.45][j - 1]);
        if (finger === 1) {
          // Opposition brings the thumb across the curled fingers. Using the
          // finger flexion axis alone leaves it sticking out of the fist.
          const directions = [
            [-side * 0.006, 0.03, -0.015],
            [side * 0.025, 0.031, -0.019],
            [side * 0.027, 0.008, 0.004],
          ];
          const desired = v3(directions[j - 1])
            .normalize()
            .applyQuaternion(this.palm.quaternion);
          const from = rest.tail
            .clone()
            .sub(rest.head)
            .normalize()
            .applyQuaternion(palmQ);
          const targetQ = new THREE.Quaternion()
            .setFromUnitVectors(from, desired)
            .multiply(palmQ);
          q.copy(palmQ).slerp(targetQ, closed);
        } else q.premultiply(new THREE.Quaternion().setFromAxisAngle(bendAxis, -angle));
        bone.quaternion.copy(q);
        previous = { ...rest, position: bone.position };
      }
    }
    const ringName = `finger${this.profile.ringFinger}-1`;
    const ringBone = this.byName.get(ringName),
      ringRest = this.rest.get(ringName);
    const ringDirection = ringRest.tail
      .clone()
      .sub(ringRest.head)
      .applyQuaternion(ringBone.quaternion);
    this.ring.position
      .copy(ringBone.position)
      .addScaledVector(ringDirection, this.profile.ringPosition);
    this.ring.quaternion.setFromUnitVectors(Z, ringDirection.normalize());
    this.watch.position
      .copy(wrist)
      .addScaledVector(
        lowerDirection,
        -this.forearmLength * this.profile.watchPosition,
      );
    this.watch.quaternion.copy(lowerFrame);
    this.watch.scale.setScalar(this.profile.width);
    this.anchorMarkers.children.forEach((m, i) =>
      m.position.copy([shoulder, elbow, wrist][i]),
    );
    if (this.sleeve.visible) this.updateSleeve();
    this.updateMatrixWorld(true);
    this.surface.skeleton.update();
  }

  updateSleeve() {
    const { shoulder, elbow, wrist } = this.anchors;
    const hoodie = this.profile.style === 'hoodie',
      short = this.profile.style === 'short';
    const split = this.upperLength / (this.upperLength + this.forearmLength);
    const end = short
      ? split * this.profile.upperSleeveCoverage
      : split + (1 - split) * this.profile.sleeveCoverage;
    const upperDir = elbow.clone().sub(shoulder).normalize(),
      lowerDir = wrist.clone().sub(elbow).normalize();
    const bend = Math.acos(clamp(upperDir.dot(lowerDir), -1, 1));
    const position = this.sleeve.geometry.attributes.position;
    const photoUv = this.sleeve.geometry.attributes.armPhotoUv;
    for (let r = 0; r <= 72; r++) {
      const u = r / 72,
        t = u * end;
      const above = t < split;
      const segment = above ? t / split : (t - split) / (1 - split);
      const center = above
        ? shoulder.clone().lerp(elbow, segment)
        : elbow.clone().lerp(wrist, segment);
      const blend = THREE.MathUtils.smoothstep(t, split - 0.09, split + 0.09);
      const dir = upperDir.clone().lerp(lowerDir, blend).normalize();
      const frame = armFrame(dir, Z);
      // Natural taper: deltoid/biceps, elbow, proximal forearm, narrow wrist.
      let radius = above
        ? THREE.MathUtils.lerp(0.062, 0.044, segment) +
          Math.sin(segment * Math.PI) * 0.006
        : THREE.MathUtils.lerp(0.055, 0.037, segment) +
          Math.sin(segment * Math.PI) * 0.005;
      radius += hoodie ? 0.016 : 0.006;
      const cuff = !short
        ? THREE.MathUtils.smoothstep(u, 0.93, 0.96)
        : THREE.MathUtils.smoothstep(u, 0.965, 0.985);
      radius = THREE.MathUtils.lerp(radius, short ? radius - 0.0015 : 0.039, cuff);
      for (let a = 0; a <= 48; a++) {
        const theta = (a / 48) * Math.PI * 2;
        const folds =
          (hoodie ? 0.0038 : 0.0018) *
          Math.sin(t * 74 + Math.sin(theta * 2) * 2.6) *
          (0.08 +
            Math.exp(-(((t - split) / 0.12) ** 2)) *
              bend *
              (0.25 + 0.75 * Math.max(0, Math.cos(theta - 0.8))) +
            Math.exp(-(((u - 0.88) / 0.07) ** 2)) * 0.5) *
          (1 - cuff);
        const rib = cuff * 0.00065 * Math.cos(theta * 36);
        const hem = Math.exp(-(((u - 0.989) / 0.009) ** 2)) * 0.0012;
        const rad = (radius + folds + rib + hem) * this.profile.width;
        const p = new THREE.Vector3(
          Math.sin(theta) * rad,
          0,
          Math.cos(theta) * rad * 0.88,
        )
          .applyQuaternion(frame)
          .add(center);
        position.setXYZ(r * 49 + a, p.x, p.y, p.z);
        const across = (Math.sin(theta) * rad) / 0.0225;
        const front = Math.cos(theta) > 0.5;
        const mask =
          (t > split || this.sample?.upperStrip) && front
            ? THREE.MathUtils.smoothstep(1 - Math.abs(across), 0, 0.35)
            : 0;
        photoUv.setXYZ(
          r * 49 + a,
          clamp(across * 0.5 + 0.5, 0, 1),
          t < split && this.sample?.upperStrip
            ? 1.001 + clamp(1 - t / split, 0, 0.999)
            : clamp((1 - t) / (1 - split), 0, 1),
          mask,
        );
      }
    }
    position.needsUpdate = true;
    photoUv.needsUpdate = true;
    this.sleeve.geometry.computeVertexNormals();
  }

  dispose() {
    const geometry = new Set(),
      materials = new Set();
    this.traverse((o) => {
      if (o.geometry) geometry.add(o.geometry);
      if (o.material) materials.add(o.material);
    });
    this.surface.skeleton.dispose();
    this.photoMap?.dispose();
    this.upperPhotoMap?.dispose();
    geometry.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    // Atlas and weave textures are shared across all arms and preview instances.
    this.removeFromParent();
  }
}
