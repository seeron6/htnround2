export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const tenths = Math.round(seconds * 10),
    minutes = Math.floor(tenths / 600);
  return `${minutes}m ${((tenths % 600) / 10).toFixed(1)}s`;
}

const labels = {
  photos: 'Pipeline setup',
  cameras: 'Camera recovery',
  geometry: 'Face measurements',
  astra: 'AI hair & glasses analysis',
  eyes: 'Eye scan & detail',
  surface: 'Head template',
  semantics: 'Ear & accessory measurements',
  'accessory-cleanup': 'Glasses-free reference',
  hair: 'Hair silhouette',
  accessories: 'Glasses & strand detail',
  rig: 'Physics binding',
  rear: 'Rear prediction',
  texture: 'Photographic texture',
};

export function timingRows(source, timing, now = Date.now() / 1000) {
  const rows = [];
  if (source) {
    rows.push(['Video length', duration(source.durationSeconds)]);
    rows.push([
      source.extractionComplete ? 'Frame extraction' : 'Partial frame extraction',
      duration(source.extractionSeconds),
    ]);
  }
  if (timing) {
    const attempts = timing.previousAttempts ?? [];
    if (attempts.length)
      rows.push([
        'Earlier reconstruction attempts',
        duration(attempts.reduce((sum, t) => sum + (t.reconstructionSeconds ?? 0), 0)),
      ]);
    if (timing.startupSeconds)
      rows.push(['Worker startup', duration(timing.startupSeconds)]);
    for (const item of timing.stages ?? [])
      rows.push([labels[item.stage] ?? item.stage, duration(item.seconds)]);
    if (timing.status === 'running' && timing.activeStage)
      rows.push([
        `${labels[timing.activeStage] ?? timing.activeStage} · running`,
        duration(Math.max(0, now - timing.stageStartedAt)),
      ]);
    if (timing.status === 'complete') {
      rows.push(['Reconstruction', duration(timing.reconstructionSeconds)]);
      if (timing.loadSeconds != null)
        rows.push(['Load model & physics', duration(timing.loadSeconds)]);
      if (source?.extractionComplete) {
        const filesReadyAt = timing.requestedAt + timing.reconstructionSeconds;
        const readyAt = timing.readyObservedAt ?? filesReadyAt;
        if (
          Number.isFinite(source.uploadStartedAt) &&
          readyAt >= source.uploadStartedAt
        )
          rows.push([
            timing.readyObservedAt != null
              ? 'Upload → model ready'
              : 'Upload → model files',
            duration(readyAt - source.uploadStartedAt),
          ]);
        else
          // Old scans did not store the start of upload, so do not invent wall time.
          rows.push([
            'Measured processing',
            duration(source.extractionSeconds + timing.reconstructionSeconds),
          ]);
      }
    } else if (timing.status === 'failed') {
      const failedAt = timing.requestedAt + timing.reconstructionSeconds;
      rows.push([
        'Build failed after',
        duration(
          source?.uploadStartedAt && failedAt >= source.uploadStartedAt
            ? failedAt - source.uploadStartedAt
            : timing.reconstructionSeconds,
        ),
      ]);
    }
  }
  if (source?.uploadStartedAt && (!timing || timing.status === 'running'))
    rows.push(['Upload elapsed', duration(Math.max(0, now - source.uploadStartedAt))]);
  return rows;
}
