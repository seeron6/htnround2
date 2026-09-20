import * as THREE from 'three';
import {
  FilesetResolver,
  HandLandmarker,
  FaceLandmarker,
} from '@mediapipe/tasks-vision';
import { clamp, fistScore } from './physics.js';
import { palmFrame, trackedPalmFrame } from './hand-orientation.js';
import {
  calibrateBodyFrame,
  matchHandsToBody,
  retargetCapturedArm,
} from './arm-pose.js';

// MediaPipe hand skeleton links: 21 landmarks connected by 21 bones. Plus one virtual forearm
// segment (wrist → elbow) makes 22 segments = 44 endpoints = 132 floats per hand.
const LINKS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
const EMPTY_ARM_PROFILES = new Map();
const SEGMENT_COUNT = LINKS.length + 1; // + forearm
const HAND_POSITION_BUFFER_SIZE = SEGMENT_COUNT * 2 * 3;

// Open vs fist landmark offsets (relative to a hand-center in local space).
// Demo hands default to fists through guard, strike, and recovery.
const HAND_POSE_OPEN = {
  y: [-0.012, 0.022, 0.016, -0.004],
  z: [0.015, 0.004, -0.022, -0.026],
};
const HAND_POSE_FIST = {
  y: [-0.008, 0.008, -0.008, -0.02],
  z: [0.02, 0.024, 0.012, 0.0],
};
// Shared neon-violet material — one instance for both hands cuts uniform uploads in half.
// Normal blending (not additive) so the line reads as saturated purple on light skin *and*
// on the dark studio background; additive purple washes out to white against skin tones.
const NEON_HAND_MATERIAL = new THREE.LineBasicMaterial({
  color: 0xb14dff,
  transparent: true,
  opacity: 1,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NormalBlending,
  toneMapped: false,
});

// Bare neon-cyan hand skeleton. Rigged GLB + per-frame bone/material updates were the source
// of both the blinking (opacity crossfade at near-camera thresholds) and the latency (skinned
// mesh matrix updates for 25 bones × 2 hands × every result frame). One LineSegments per hand,
// one buffer write per frame, additive blending for the neon glow.
export class VirtualHand extends THREE.Group {
  constructor(side) {
    super();
    this.side = side;
    this.center = new THREE.Vector3();
    this.previous = new THREE.Vector3();
    this.lastHit = -10;
    this.closed = 1;
    this.tracked = false;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(HAND_POSITION_BUFFER_SIZE), 3),
    );
    this.line = new THREE.LineSegments(geometry, NEON_HAND_MATERIAL);
    this.line.frustumCulled = false;
    this.line.renderOrder = 20;
    this.add(this.line);
    this.demoPose(new THREE.Vector3(side * 0.19, -0.17, -0.25));
  }

  apply(points, closed, armPose = null, palmOrientation = null) {
    this.points = points;
    this.armPose = armPose;
    this.palmOrientation = palmOrientation;
    this.previous.copy(this.center);
    this.closed = closed;
    this.center
      .addVectors(points[5], points[17])
      .multiplyScalar(0.5)
      .lerp(points[9], 0.2);
    const arr = this.line.geometry.attributes.position.array;
    let k = 0;
    for (const [a, b] of LINKS) {
      const pa = points[a],
        pb = points[b];
      arr[k++] = pa.x;
      arr[k++] = pa.y;
      arr[k++] = pa.z;
      arr[k++] = pb.x;
      arr[k++] = pb.y;
      arr[k++] = pb.z;
    }
    // Forearm segment: wrist → tracked elbow (or a rest guard when no arm pose available).
    const elbow =
      armPose?.joints[1] ?? new THREE.Vector3(this.side * 0.17, -0.25, -0.04);
    const w = points[0];
    arr[k++] = w.x;
    arr[k++] = w.y;
    arr[k++] = w.z;
    arr[k++] = elbow.x;
    arr[k++] = elbow.y;
    arr[k++] = elbow.z;
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  demoPose(center, closed = 1) {
    // Explicit closure remains available for pose inspection.
    const t = clamp(closed, 0, 1);
    const yOff = HAND_POSE_OPEN.y.map((v, i) => v * (1 - t) + HAND_POSE_FIST.y[i] * t);
    const zOff = HAND_POSE_OPEN.z.map((v, i) => v * (1 - t) + HAND_POSE_FIST.z[i] * t);
    const points = [new THREE.Vector3(center.x, center.y - 0.07, center.z + 0.025)];
    for (let f = 0; f < 5; f++)
      for (let j = 0; j < 4; j++) {
        const x = center.x + (f - 2) * 0.015 * this.side;
        const thumbDown = f === 0 ? 0.024 * (1 - t * 0.7) : 0;
        points.push(
          new THREE.Vector3(x, center.y + yOff[j] - thumbDown, center.z + zOff[j]),
        );
      }
    this.apply(points, t);
  }
}

// Preserved API: main.js imports { segment } for other scaffolding (arm segments elsewhere).
// A no-op-style tiny helper still positioned by cylinder is cheaper than churning callers.
const _up = new THREE.Vector3(0, 1, 0);

export function segment(mesh, a, b, radius) {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  const d = new THREE.Vector3().subVectors(b, a);
  mesh.quaternion.setFromUnitVectors(_up, d.clone().normalize());
  mesh.scale.set(radius, d.length(), radius);
}

export class Tracking {
  constructor(video, onStatus) {
    this.video = video;
    this.onStatus = onStatus;
    this.active = false;
    this.calibration = null;
    this.bodyFrame = null;
    this.armProfiles = new Map();
    this.guardWidths = [];
    this.results = null;
    this.resultQueue = [];
    this.stream = null;
    this.worker = null;
    this.busy = false;
    this.pipelineLatency = 0;
    this.frameCallback = null;
  }

  get currentArmProfiles() {
    return this.useCapturedArms === false ? EMPTY_ARM_PROFILES : this.armProfiles;
  }

  setArmProfile(profile) {
    this.armProfiles.set(profile.side, profile);
    this.calibration = null;
    this.bodyFrame = null;
    this.onStatus(
      'Personal arm loaded. Show your face, shoulders, elbows and wrists, then calibrate guard.',
    );
    this.enableBody().catch(() => {});
  }

  async start(deviceId = '') {
    this.onStatus('Starting local hand tracking…');
    try {
      // Lower capture resolution → smaller HandLandmarker input tensor → faster inference.
      // 960×540 is still generous headroom for MediaPipe (which downsamples to 224×224 anyway).
      // frameRate:60 lets a modern webcam feed frames every ~16 ms; the pipeline already gates
      // on busy/frameCallback so we won't process faster than we can, but we get fresher data.
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      // Inference lives in a worker so synchronous MediaPipe calls cannot block
      // rendering and impact integration on the main thread.
      this.worker = new Worker('/tracking-worker.js');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Hand model initialization timed out.')),
          25000,
        );
        this.worker.onmessage = ({ data }) => {
          if (data.type === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
          if (data.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(data.message));
          }
        };
        this.worker.onerror = (e) => {
          clearTimeout(timeout);
          reject(new Error(e.message));
        };
        this.worker.postMessage({ type: 'init', origin: location.origin });
      });
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'poseReady') {
          this.poseReady = true;
          this.poseSegmentation = !!data.segmentation;
          this.onPoseReady?.();
          return;
        }
        this.busy = false;
        if (data.type === 'result') {
          this.results = data;
          this.resultQueue.push(data);
          this.resultQueue = this.resultQueue
            .filter((frame) => data.timestamp - frame.timestamp <= 250)
            .slice(-16);
          this.receivedAt = performance.now();
          this.pipelineLatency = this.receivedAt - data.timestamp;
          if (data.capture) this.onCapture?.(data);
          if (data.armSample) this.onArmSample?.(data);
          this.scheduleFrame();
        } else if (data.type === 'error') {
          this.onStatus(data.message);
          this.stop();
        }
      };
      this.active = true;
      this.calibration = null;
      this.scheduleFrame();
      // Body/pose tracking is lazy — only spun up when the user actually scans or loads an arm.
      // Eager-loading it here used to add ~30-50 ms per pose frame on top of the hand landmark
      // pipeline for a signal that the default punch flow never reads.
      this.onStatus(
        'Webcam connected · show your face and hands, then calibrate guard',
      );
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  stop() {
    this.active = false;
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.results = null;
    this.resultQueue = [];
    this.poseReady = false;
    this.poseSegmentation = false;
    this.appliedTimestamp = 0;
    this.calibration = null;
    this.bodyFrame = null;
    this.captureRequest = null;
    this.scanArms = false;
    this.frameCallback = null;
    this.pipelineLatency = 0;
    this.poseInitReject?.(
      new Error('Camera disconnected while loading body tracking.'),
    );
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
  }

  scheduleFrame() {
    if (!this.active || !this.worker || this.busy || this.frameCallback !== null)
      return;
    // requestVideoFrameCallback fires the instant a decoded camera frame is ready; no
    // display-clock throttling and no polling latency between capture and inference.
    const post = async () => {
      this.frameCallback = null;
      if (!this.active || !this.worker) {
        return;
      }
      if (this.busy) {
        this.scheduleFrame();
        return;
      }
      if (this.video.readyState < 2) {
        this.scheduleFrame();
        return;
      }
      this.busy = true;
      try {
        const posted = performance.now();
        const bitmap = await createImageBitmap(this.video);
        this.worker.postMessage(
          {
            type: 'frame',
            bitmap,
            timestamp: posted,
            capture: this.captureRequest,
            trackBody: this.currentArmProfiles.size > 0 || this.trackArmView,
            scanArms: !!this.scanArms && posted - (this.lastArmScanFrame || 0) >= 150,
          },
          [bitmap],
        );
        this.captureRequest = null;
        if (this.scanArms && posted - (this.lastArmScanFrame || 0) >= 150)
          this.lastArmScanFrame = posted;
      } catch {
        this.busy = false;
        this.scheduleFrame();
      }
    };
    this.frameCallback = this.video.requestVideoFrameCallback
      ? this.video.requestVideoFrameCallback(post)
      : setTimeout(post, 4);
  }

  calibrate() {
    const hands = this.results?.landmarks;
    if (!hands?.length)
      throw new Error('Show an open hand to the camera before calibrating.');
    const pose = this.results.pose;
    this.bodyFrame = calibrateBodyFrame(
      pose?.worldLandmarks?.[0],
      pose?.landmarks?.[0],
      [...this.currentArmProfiles.values()],
    );
    if (
      this.currentArmProfiles.size &&
      (!this.bodyFrame ||
        !Number.isFinite(pose.timestamp) ||
        this.results.timestamp - pose.timestamp > 180)
    )
      throw new Error(
        'Personal arms need a clear view of your face, shoulders, elbows and wrists to calibrate.',
      );
    this.calibration =
      hands
        .map((lm) => Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y))
        .reduce((a, b) => a + b, 0) / hands.length;
    this.onStatus(
      this.currentArmProfiles.size
        ? 'Personal proportions calibrated · body and palm tracking drive the captured meshes'
        : 'Guard calibrated · close your fist and move across the target',
    );
  }

  async enableBody({ wantSegmentation = false } = {}) {
    if (this.poseReady && (!wantSegmentation || this.poseSegmentation)) return;
    if (!this.active) throw new Error('Connect your webcam first.');
    if (this.poseInitPromise) {
      await this.poseInitPromise;
      return this.enableBody({ wantSegmentation });
    }
    this.poseInitPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Body model initialization timed out.')),
        25000,
      );
      this.poseInitReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.onPoseReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.worker.postMessage({ type: 'enablePose', wantSegmentation });
    }).finally(() => {
      this.poseInitPromise = null;
      this.poseInitReject = null;
      this.onPoseReady = null;
    });
    return this.poseInitPromise;
  }

  drainResults(now) {
    const frames = this.resultQueue.filter(
      (frame) =>
        frame.timestamp > (this.appliedTimestamp ?? -Infinity) &&
        now - frame.timestamp <= 250,
    );
    this.resultQueue = [];
    return frames.length
      ? frames.sort((a, b) => a.timestamp - b.timestamp)
      : [this.results];
  }

  tick(now, hands, results = this.results) {
    if (!this.active) return;
    for (const h of hands) h.updated = false;
    // Ingest is driven by requestVideoFrameCallback in scheduleFrame(); tick() only
    // applies the latest inference result to the hand rigs.
    this.scheduleFrame();
    // Only fully hide a hand when tracking has been silent for >1 s. Between-frame gaps of a few
    // hundred ms happen constantly with MediaPipe — flipping visible on/off each of those gaps
    // is what caused the on-screen skeleton to strobe.
    if (!results || now - results.timestamp > 1000) {
      for (const h of hands) {
        h.tracked = false;
        h.visible = false;
        h.armPose = null;
      }
      return;
    }
    // Retaining the last drawing must not retain contact eligibility. After
    // a gap, reset tracking so reacquisition cannot turn the entire jump
    // between old and new samples into a punch.
    if (now - results.timestamp > 350) {
      for (const h of hands) {
        h.tracked = false;
        h.armPose = null;
      }
      return;
    }
    if (this.appliedTimestamp === results.timestamp) return;
    const sampleDt = this.appliedTimestamp
      ? clamp((results.timestamp - this.appliedTimestamp) / 1000, 1 / 60, 0.15)
      : 1 / 30;
    this.appliedTimestamp = results.timestamp;
    const previouslyTracked = new Map(hands.map((h) => [h.side, h.tracked]));
    // Clear tracked but not visible — the skeleton stays where it was until a fresh hand assignment
    // moves it. Old code cleared visible here too, so a single frame with no detection blanked it.
    for (const h of hands) {
      h.tracked = false;
      h.armPose = null;
    }
    const body = results.pose,
      assignments = matchHandsToBody(
        results.landmarks,
        body && results.timestamp - body.timestamp <= 180
          ? body.landmarks?.[0]
          : null,
        this.video.videoWidth / this.video.videoHeight || 1,
      );
    // Which arm each detection belongs to. The body pose is the authority when it ran; otherwise
    // MediaPipe's own label decides. On the unmirrored frames this app sends, tasks-vision 0.10
    // names the ANATOMICAL hand: "Left" is the user's left, side -1. Measured by running the
    // bundled landmarker over rendered arms of known chirality — 39 of 43 confident labels named
    // the anatomy, none of them the legacy selfie convention this used to assume. That assumption
    // sent every hand to the opposite arm: invisible for the skeleton, which draws at the
    // landmarks themselves, but it crossed the first-person 3D arms, whose shoulders are pinned
    // at +-0.21. tests/hand-side.test.mjs holds the coherence check.
    const sides = results.landmarks.map((lm, i) => {
      const matched = assignments.get(i);
      if (matched) return matched === 'left' ? -1 : 1;
      return results.handedness[i]?.[0]?.categoryName === 'Left' ? -1 : 1;
    });
    // Both detections on one arm leaves the other frozen mid-reach. Move the hand the body pose
    // did not place; with neither placed, image order decides, because an unmirrored frame shows
    // the user's right hand on the image's left.
    if (sides.length === 2 && sides[0] === sides[1]) {
      const loose = [0, 1].filter((i) => !assignments.has(i));
      if (loose.length === 1) sides[loose[0]] *= -1;
      else if (loose.length === 2) {
        const centre = (i) =>
          (results.landmarks[i][5].x + results.landmarks[i][17].x) / 2;
        sides[0] = centre(0) < centre(1) ? 1 : -1;
        sides[1] = -sides[0];
      }
    }
    results.landmarks.forEach((lm, i) => {
      // Mirror horizontal motion into the user's body frame. This creates a
      // virtual view, not recovered RGB of unseen hand surfaces.
      const centerX = (lm[5].x + lm[17].x) / 2;
      const matched = assignments.get(i),
        side = sides[i];
      const h = hands.find((h) => h.side === side);
      if (!h) return;
      const profile = this.currentArmProfiles.get(side < 0 ? 'left' : 'right');
      if (this.currentArmProfiles.size && !profile) return;
      if (profile) {
        if (
          !matched ||
          !body ||
          !Number.isFinite(body.timestamp) ||
          results.timestamp - body.timestamp > 180
        )
          return;
        const pose = retargetCapturedArm(
          profile,
          this.bodyFrame,
          body.worldLandmarks?.[0],
          body.landmarks?.[0],
          results.worldLandmarks?.[i],
        );
        if (!pose) return;
        h.visible = true;
        h.tracked = true;
        const points = pose.joints.slice(3);
        h.apply(points, fistScore(lm), pose, palmFrame(points, side));
        h.sampleDt = sampleDt;
        h.updated = previouslyTracked.get(h.side) === true;
        if (!h.updated) h.previous.copy(h.center);
        return;
      }
      const width = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y);
      const ratio = this.calibration ? width / this.calibration : 1;
      // Rest is now ~48 cm from the origin camera so hands hover close to the face at z=-0.55
      // instead of near the lens. A moderate punch (ratio ≈ 1.2) lands past the face; a big
      // reach (ratio ≈ 1.5) drives the mesh through it. Floor 0.38 keeps recovery well inside
      // the near-fade's opaque band so the hand never sits inside the camera's near plane.
      const depth = clamp(0.48 + (ratio - 1) * 0.35, 0.38, 0.85);
      const base = new THREE.Vector3(
        (0.5 - centerX) * 0.85,
        clamp((0.55 - lm[9].y) * 0.65, -0.3, 0.16),
        -depth,
      );
      const unit = 0.075 / Math.max(width, 0.025);
      const points = lm.map(
        (p) =>
          new THREE.Vector3(
            base.x - (p.x - centerX) * unit,
            base.y - (p.y - lm[9].y) * unit,
            base.z + (p.z - lm[9].z) * unit,
          ),
      );
      h.visible = true;
      h.tracked = true;
      h.apply(
        points,
        fistScore(lm),
        null,
        trackedPalmFrame(
          results.worldLandmarks?.[i],
          lm,
          side,
          this.video.videoWidth / this.video.videoHeight || 1,
        ),
      );
      h.sampleDt = sampleDt;
      h.updated = previouslyTracked.get(h.side) === true;
      if (!h.updated) h.previous.copy(h.center);
    });
  }
}

let faceDetector;
export async function ensureFaceDetector() {
  if (!faceDetector) {
    const files = await FilesetResolver.forVisionTasks('/wasm');
    faceDetector = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
  }
  return faceDetector;
}

// Meshy is trained on natural portrait photos. Send a natural, tight, square crop centered on
// the face: enough hair, ear, and neck to look like a normal headshot, but small enough that the
// bust doesn't dominate the silhouette. No matting — hard-edged mattes produce weird seams and
// distorted geometry near the mask boundary in Meshy 6/7 output.
export async function cropFacePortrait(canvas) {
  const detector = await ensureFaceDetector();
  const found = detector.detect(canvas);
  const lm = found.faceLandmarks?.[0];
  if (!lm)
    throw new Error(
      'No face detected. Face the camera with even lighting and no obstructions.',
    );
  const W = canvas.width,
    H = canvas.height;
  const pts = lm.slice(0, 468);
  let minX = 1,
    maxX = 0,
    minY = 1,
    maxY = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minX *= W;
  maxX *= W;
  minY *= H;
  maxY *= H;
  const fw = maxX - minX,
    fh = maxY - minY;
  // Padding: hair above, ear at the sides, chin + a hint of neck below. Non-square (natural portrait);
  // squaring a tall face adds huge horizontal padding that lets shoulders sneak back into frame.
  const padSide = fw * 0.55,
    padTop = fh * 0.85,
    padBot = fh * 0.35;
  let x0 = Math.max(0, Math.floor(minX - padSide));
  let y0 = Math.max(0, Math.floor(minY - padTop));
  let x1 = Math.min(W, Math.ceil(maxX + padSide));
  let y1 = Math.min(H, Math.ceil(maxY + padBot));
  const cw = x1 - x0,
    ch = y1 - y0;
  if (cw < 128 || ch < 128)
    throw new Error(
      'Face is too small in the frame. Move closer to the camera and try again.',
    );
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
  return out;
}

export async function makePhotoFace(image) {
  const detector = await ensureFaceDetector();
  const found = detector.detect(image);
  const lm = found.faceLandmarks?.[0];
  if (!lm)
    throw new Error('No face detected. Use a well-lit, frontal neutral portrait.');
  const canonical = await fetch('/models/canonical_face_model.obj').then((r) =>
    r.text(),
  );
  const indices = canonical
    .split('\n')
    .filter((l) => l.startsWith('f '))
    .flatMap((l) =>
      l
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((v) => Number(v.split('/')[0]) - 1),
    );
  const minY = Math.min(...lm.slice(0, 468).map((p) => p.y)),
    maxY = Math.max(...lm.slice(0, 468).map((p) => p.y));
  const scale = 0.24 / (maxY - minY),
    cx = (lm[234].x + lm[454].x) / 2,
    cy = (minY + maxY) / 2;
  const aspect = image.videoWidth
    ? image.videoWidth / image.videoHeight
    : image.width / image.height;
  const pos = [],
    uv = [];
  lm.slice(0, 468).forEach((p) => {
    pos.push(
      (p.x - cx) * scale * aspect,
      -(p.y - cy) * scale,
      -p.z * scale * aspect + 0.025,
    );
    uv.push(p.x, 1 - p.y);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const canvas = document.createElement('canvas');
  canvas.width = image.videoWidth || image.width;
  canvas.height = image.videoHeight || image.height;
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    geometry,
    material: new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.87,
      side: THREE.DoubleSide,
    }),
    photo: canvas.toDataURL('image/jpeg', 0.92),
  };
}
