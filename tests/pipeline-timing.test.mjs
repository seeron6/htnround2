import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, timingRows } from '../src/pipeline-timing.js';
test('upload wall time includes initialization, build gaps and readiness polling', () => {
  const source = {
    durationSeconds: 24.3,
    extractionSeconds: 15.6,
    extractionComplete: true,
    uploadStartedAt: 100,
  };
  const timing = {
    status: 'complete',
    requestedAt: 121,
    reconstructionSeconds: 80,
    readyObservedAt: 202.5,
    loadSeconds: 1.1,
    stages: [{ stage: 'cameras', seconds: 31 }],
  };
  assert.deepEqual(timingRows(source, timing).at(-1), [
    'Upload → model ready',
    '1m 42.5s',
  ]);
  assert.ok(
    timingRows(source, timing).some(
      ([label, value]) => label === 'Load model & physics' && value === '1.1 s',
    ),
  );
  assert.equal(duration(119.99), '2m 0.0s');
});
test('old scans show processing time without claiming unknown upload wall time', () => {
  assert.deepEqual(
    timingRows(
      {
        durationSeconds: 24.3,
        extractionSeconds: 15.6,
        extractionComplete: true,
      },
      { status: 'complete', reconstructionSeconds: 121.2, loadSeconds: 1.1 },
    ).at(-1),
    ['Measured processing', '2m 16.8s'],
  );
});
test('file completion and failure use the original upload clock', () => {
  const source = { uploadStartedAt: 100, extractionComplete: true };
  assert.deepEqual(
    timingRows(source, {
      status: 'complete',
      requestedAt: 120,
      reconstructionSeconds: 80,
    }).at(-1),
    ['Upload → model files', '1m 40.0s'],
  );
  assert.deepEqual(
    timingRows(
      source,
      {
        status: 'running',
        requestedAt: 120,
        reconstructionSeconds: 80,
      },
      151,
    ).at(-1),
    ['Upload elapsed', '51.0 s'],
  );
  assert.deepEqual(
    timingRows(
      source,
      {
        status: 'failed',
        requestedAt: 120,
        reconstructionSeconds: 80,
      },
      500,
    ).at(-1),
    ['Build failed after', '1m 40.0s'],
  );
});
test('partial import or failed reconstruction cannot claim a complete end-to-end time', () => {
  const source = {
    durationSeconds: 24.3,
    extractionSeconds: 5,
    extractionComplete: false,
  };
  assert.ok(
    !timingRows(source, { status: 'complete', reconstructionSeconds: 30 }).some(
      ([label]) => label.startsWith('Upload →'),
    ),
  );
  assert.ok(
    !timingRows(
      { ...source, extractionComplete: true },
      { status: 'failed', reconstructionSeconds: 30 },
    ).some(([label]) => label.startsWith('Upload →')),
  );
  assert.deepEqual(
    timingRows(
      null,
      { status: 'running', activeStage: 'astra', stageStartedAt: 10 },
      14,
    ).at(-1),
    ['AI hair & glasses analysis · running', '4.0 s'],
  );
});
