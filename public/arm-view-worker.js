/* Arm cutout adapted from jace/cv's pov-worker.js (d0c1763).
   Classic worker: MediaPipe's WASM loader requires importScripts. */
self.exports = {};
importScripts('/vendor/vision_bundle.cjs');
const { FilesetResolver, HandLandmarker, ImageSegmenter } = self.exports;
let armCutout,
  refineArmEdges,
  smoother,
  anchor,
  hands,
  segmenter,
  small,
  context,
  canvas,
  maskContext;
let lastHand = -Infinity,
  lastTimestamp = -1,
  firstPerson = false;

async function create(task, files, options) {
  try {
    return await task.createFromOptions(files, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' },
    });
  } catch {
    return task.createFromOptions(files, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const module = await import(new URL(data.maskURL, data.origin).href);
      armCutout = module.armCutout;
      refineArmEdges = module.refineArmEdges;
      smoother = new module.MaskSmoother();
      // Only the forward-facing body camera needs screen-feedback rejection.
      anchor = data.bodyCamera ? new module.ArmAnchor() : null;
      firstPerson = !!data.bodyCamera;
      const files = await FilesetResolver.forVisionTasks(`${data.origin}/wasm`);
      if (data.bodyCamera) {
        hands = await create(HandLandmarker, files, {
          baseOptions: { modelAssetPath: `${data.origin}/models/hand_landmarker.task` },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.45,
          minHandPresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        });
      }
      segmenter = await create(ImageSegmenter, files, {
        baseOptions: {
          modelAssetPath: `${data.origin}/models/selfie_multiclass_256x256.tflite`,
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: true,
      });
      self.postMessage({ type: 'ready' });
      return;
    }
    if (data.type !== 'frame') return;
    let frameTransferred = false;
    try {
      const timestamp = Math.max(data.timestamp, lastTimestamp + 1);
      lastTimestamp = timestamp;
      // Reuse the punch camera's detections; only a separate camera needs its own landmarker.
      const detection = hands ? hands.detectForVideo(data.bitmap, timestamp) : null;
      const landmarks = detection ? detection.landmarks : data.landmarks;
      if (landmarks?.length) lastHand = timestamp;
      const width = 256,
        height = Math.max(
          64,
          Math.round((width * data.bitmap.height) / data.bitmap.width),
        );
      if (!small || small.height !== height) {
        small = new OffscreenCanvas(width, height);
        context = small.getContext('2d');
        smoother.state = null;
      }
      context.drawImage(data.bitmap, 0, 0, width, height);
      const result = segmenter.segmentForVideo(small, timestamp);
      try {
        const category = result.categoryMask;
        // A brief dropout bridge only: indefinite growth can swallow the torso in a front view.
        const support =
          !landmarks?.length && timestamp - lastHand < 250 ? smoother.state : null;
        const cut = armCutout(
          category.getAsUint8Array(),
          category.width,
          category.height,
          landmarks || [],
          support,
          anchor,
          { strict: true, firstPerson, pose: data.pose },
        );
        refineArmEdges(
          cut.alpha,
          result.confidenceMasks[2].getAsFloat32Array(),
          result.confidenceMasks[4].getAsFloat32Array(),
        );
        const alpha = smoother.apply(cut.alpha);
        if (
          !canvas ||
          canvas.width !== category.width ||
          canvas.height !== category.height
        ) {
          canvas = new OffscreenCanvas(category.width, category.height);
          maskContext = canvas.getContext('2d');
        }
        const pixels = maskContext.createImageData(canvas.width, canvas.height);
        let visiblePixels = 0;
        for (let i = 0; i < alpha.length; i++) {
          pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = 255;
          pixels.data[i * 4 + 3] = alpha[i];
          if (alpha[i] > 80) visiblePixels++;
        }
        maskContext.putImageData(pixels, 0, 0);
        const mask = canvas.transferToImageBitmap();
        self.postMessage(
          {
            type: 'result',
            mask,
            frame: data.bitmap,
            timestamp: data.timestamp,
            visiblePixels,
            landmarks,
            handedness: detection?.handedness,
          },
          [mask, data.bitmap],
        );
        frameTransferred = true;
      } finally {
        result.close();
      }
    } finally {
      if (!frameTransferred) data.bitmap.close();
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
