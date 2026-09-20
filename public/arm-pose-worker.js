/* Optional elbow estimates for the live arm cutout. Kept off the hand/segmenter workers. */
self.exports = {};
importScripts('/vendor/vision_bundle.cjs');
const { FilesetResolver, PoseLandmarker } = self.exports;
let detector,
  lastTimestamp = -1;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const files = await FilesetResolver.forVisionTasks(`${data.origin}/wasm`);
      const options = {
        runningMode: 'VIDEO',
        numPoses: 1,
        outputSegmentationMasks: false,
        baseOptions: {
          modelAssetPath: `${data.origin}/models/pose_landmarker.task`,
          delegate: 'GPU',
        },
      };
      try {
        detector = await PoseLandmarker.createFromOptions(files, options);
      } catch {
        options.baseOptions.delegate = 'CPU';
        detector = await PoseLandmarker.createFromOptions(files, options);
      }
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'frame') {
      try {
        lastTimestamp = Math.max(lastTimestamp + 1, data.timestamp);
        const result = detector.detectForVideo(data.bitmap, lastTimestamp);
        self.postMessage({
          type: 'pose',
          landmarks: result.landmarks,
          timestamp: data.timestamp,
        });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
