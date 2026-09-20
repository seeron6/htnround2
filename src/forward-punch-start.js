import { TargetTracking } from './target-camera.js';

const MAX_FRAME_AGE_MS = 350;

// Reuse the round's punch detector with the existing webcam results. This only
// recognizes the start gesture; it never applies an impact or opens a camera.
export class ForwardPunchStart {
  constructor(video) {
    this.tracker = new TargetTracking(video, () => {});
    this.reset();
  }

  reset() {
    this.tracker.reset();
    this.lastFrameAt = null;
    this.started = false;
  }

  update(state, now, enabled) {
    const frameAt = state.timestamp;
    if (
      !enabled ||
      !state.active ||
      !state.calibrated ||
      !Number.isFinite(frameAt) ||
      now < frameAt ||
      now - frameAt > MAX_FRAME_AGE_MS
    ) {
      this.reset();
      return false;
    }
    if (this.started || frameAt === this.lastFrameAt) return false;
    if (
      this.lastFrameAt !== null &&
      (frameAt < this.lastFrameAt || frameAt - this.lastFrameAt > MAX_FRAME_AGE_MS)
    )
      this.reset();
    this.lastFrameAt = frameAt;
    const punch = this.tracker.consume(state, now);
    this.started = punch?.mode === 'jab' && punch.direction[2] < -0.65;
    return this.started;
  }
}
