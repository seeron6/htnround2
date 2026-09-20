/* MediaPipe's WASM loader uses importScripts; keep this a classic worker. */
self.exports = {};
importScripts('/vendor/vision_bundle.cjs');
importScripts('/target-motion.js');
const { FilesetResolver, HandLandmarker, PoseLandmarker } = self.exports;
let detector,
  poseDetector,
  poseSegmentation = false,
  origin,
  lastPose,
  lastStamp = 0;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      origin = data.origin;
      const files = await FilesetResolver.forVisionTasks(`${data.origin}/wasm`);
      // GPU delegate cuts inference from ~30-60ms to ~5-10ms on Apple Silicon; falls back to CPU
      // automatically when the browser has no WebGL2 in this worker context.
      try {
        detector = await HandLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: `${data.origin}/models/hand_landmarker.task`,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.35,
          minHandPresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        });
      } catch {
        detector = await HandLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: `${data.origin}/models/hand_landmarker.task`,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.35,
          minHandPresenceConfidence: 0.3,
          minTrackingConfidence: 0.3,
        });
      }
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'enablePose') {
      if (poseDetector && (!data.wantSegmentation || poseSegmentation)) {
        self.postMessage({ type: 'poseReady', segmentation: poseSegmentation });
        return;
      }
      poseDetector?.close();
      poseDetector = null;
      const files = await FilesetResolver.forVisionTasks(`${origin}/wasm`);
      // Segmentation masks are only used by the arm-capture flow. Turning them on unconditionally
      // added ~15 ms per pose frame; leave them off unless the caller explicitly asked for them.
      const wantSegmentation = !!data.wantSegmentation;
      try {
        poseDetector = await PoseLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: `${origin}/models/pose_landmarker.task`,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          outputSegmentationMasks: wantSegmentation,
        });
      } catch {
        poseDetector = await PoseLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: `${origin}/models/pose_landmarker.task`,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          outputSegmentationMasks: wantSegmentation,
        });
      }
      poseSegmentation = wantSegmentation;
      self.postMessage({ type: 'poseReady', segmentation: poseSegmentation });
    } else if (data.type === 'frame') {
      let frameTransferred = false;
      try {
        const started = performance.now();
        lastStamp = Math.max(lastStamp + 1, Math.round(data.timestamp));
        let result,
          detectError = '';
        try {
          result = detector.detectForVideo(data.bitmap, lastStamp);
        } catch (error) {
          detectError = error.message;
        }
        const handsDone = performance.now();
        const motion = self.TargetMotion.motionOf(data.bitmap, data.timestamp);
        const motionDone = performance.now();
        let capture;
        // Pose inference only runs when the caller actively needs it. The old "every 4th frame"
        // heartbeat was stalling the default punch flow with a CPU model that nothing consumed.
        if (
          poseDetector &&
          (data.capture ||
            data.scanArms ||
            (data.trackBody && data.timestamp - (lastPose?.timestamp || 0) > 100))
        ) {
          poseDetector.detectForVideo(data.bitmap, lastStamp, (pose) => {
            lastPose = {
              landmarks: pose.landmarks,
              worldLandmarks: pose.worldLandmarks,
              timestamp: data.timestamp,
            };
            if (data.capture && pose.segmentationMasks?.[0]) {
              const mask = pose.segmentationMasks[0];
              capture = {
                mask: new Float32Array(mask.getAsFloat32Array()),
                maskWidth: mask.width,
                maskHeight: mask.height,
                pose: lastPose,
                side: data.capture,
              };
            }
          });
        }
        if (capture) {
          const canvas = new OffscreenCanvas(data.bitmap.width, data.bitmap.height);
          canvas.getContext('2d').drawImage(data.bitmap, 0, 0);
          capture.image = await canvas.convertToBlob({ type: 'image/png' });
        }
        const poseDone = performance.now();
        let armSample;
        if (data.scanArms) {
          // Preserve finger/ring and fabric detail while scanning. This remains
          // capped and only transfers at the existing 150 ms scan cadence.
          const width = Math.min(1280, data.bitmap.width);
          const height = Math.round((width * data.bitmap.height) / data.bitmap.width);
          const canvas = new OffscreenCanvas(width, height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(data.bitmap, 0, 0, width, height);
          armSample = {
            data: ctx.getImageData(0, 0, width, height).data,
            width,
            height,
          };
        }
        self.postMessage(
          {
            type: 'result',
            landmarks: result?.landmarks ?? [],
            worldLandmarks: result?.worldLandmarks ?? [],
            handedness: result?.handedness ?? result?.handednesses ?? [],
            motion,
            detectError,
            timings: {
              hands: handsDone - started,
              motion: motionDone - handsDone,
              pose: poseDone - motionDone,
            },
            // CV must segment the exact image that produced these landmarks.
            frame: data.trackArmView ? data.bitmap : undefined,
            pose: lastPose,
            capture,
            armSample,
            timestamp: data.timestamp,
          },
          [
            ...(armSample ? [armSample.data.buffer] : []),
            ...(data.trackArmView ? [data.bitmap] : []),
          ],
        );
        frameTransferred = !!data.trackArmView;
      } finally {
        if (!frameTransferred) data.bitmap.close();
      }
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
  }
};
