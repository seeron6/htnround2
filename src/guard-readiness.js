export const GUARD_HOLD_MS = 3000;
export const GUARD_FRAME_MAX_AGE_MS = 500;

// Use the palm rather than fingertips so open hands and closed fists both work.
export function handsInGuardTargets(landmarks, video, preview, targets) {
  if (!video.width || !video.height || !preview.width || !preview.height)
    return targets.map(() => false);
  const scale = Math.max(preview.width / video.width, preview.height / video.height);
  const points = landmarks.flatMap((hand) => {
    const palm = [0, 5, 9, 13, 17].map((index) => hand[index]);
    if (palm.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y)))
      return [];
    const x = palm.reduce((sum, point) => sum + point.x, 0) / palm.length;
    const y = palm.reduce((sum, point) => sum + point.y, 0) / palm.length;
    // Match the preview's centered object-fit: cover and horizontal mirror.
    return [
      {
        x: preview.left + preview.width / 2 + (0.5 - x) * video.width * scale,
        y: preview.top + preview.height / 2 + (y - 0.5) * video.height * scale,
      },
    ];
  });
  return targets.map((target) =>
    points.some((point) => {
      const x = Math.abs(point.x - target.left - target.width / 2);
      const y = Math.abs(point.y - target.top - target.height / 2);
      if (
        !target.width ||
        !target.height ||
        x > target.width / 2 ||
        y > target.height / 2
      )
        return false;
      // The target outlines have a 35% elliptical corner radius.
      const cornerX = Math.max(0, x - target.width * 0.15) / (target.width * 0.35);
      const cornerY = Math.max(0, y - target.height * 0.15) / (target.height * 0.35);
      return cornerX ** 2 + cornerY ** 2 <= 1;
    }),
  );
}

export class GuardReadyHold {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = null;
    this.lastFrameAt = null;
    this.completed = false;
  }

  update(ready, frameAt, now) {
    const fresh =
      Number.isFinite(frameAt) &&
      now >= frameAt &&
      now - frameAt <= GUARD_FRAME_MAX_AGE_MS;
    if (!ready || !fresh) {
      this.reset();
      return { progress: 0, complete: false };
    }
    if (
      this.lastFrameAt !== null &&
      (frameAt < this.lastFrameAt ||
        frameAt - this.lastFrameAt > GUARD_FRAME_MAX_AGE_MS)
    )
      this.reset();
    this.startedAt ??= frameAt;
    this.lastFrameAt = frameAt;
    // Only observed camera time can finish the hold; a frozen frame cannot.
    const progress = Math.min(1, (frameAt - this.startedAt) / GUARD_HOLD_MS);
    const complete = progress === 1 && !this.completed;
    this.completed ||= complete;
    return { progress, complete };
  }
}
