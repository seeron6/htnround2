import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { videoLabTelemetry } from '../scripts/video-lab-telemetry.mjs';

test('a benchmark opts out of both SDKs even when it inherits demo DSNs', () => {
  const result = videoLabTelemetry({
    SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
    SENTRY_DISABLED: '0',
    VITE_SENTRY_DISABLED: '0',
  });
  assert.equal(result.SENTRY_DISABLED, '1');
  assert.equal(result.VITE_SENTRY_DISABLED, '1');
  assert.equal(result.SENTRY_ENVIRONMENT, 'video-lab');
  assert.equal(result.VITE_SENTRY_ENVIRONMENT, 'video-lab');
});

test('explicit benchmark telemetry opt-in labels both SDKs consistently', () => {
  const result = videoLabTelemetry({ CONTACT_VIDEO_SENTRY: '1' });
  assert.equal(result.SENTRY_DISABLED, '0');
  assert.equal(result.VITE_SENTRY_DISABLED, '0');
  assert.equal(result.SENTRY_ENVIRONMENT, 'video-lab');
  assert.equal(result.VITE_SENTRY_ENVIRONMENT, 'video-lab');
  assert.equal(
    videoLabTelemetry({ CONTACT_VIDEO_SENTRY: '1', SENTRY_ENVIRONMENT: 'diagnostic' })
      .VITE_SENTRY_ENVIRONMENT,
    'diagnostic',
  );
});

test('disabled browser telemetry never imports the SDK even with a configured DSN', async () => {
  const source = await readFile(
    new URL('../src/sponsors/sentry.js', import.meta.url),
    'utf8',
  );
  // Apply the same import.meta.env substitution Vite makes for the lab.
  const compiled = source.replaceAll(
    'import.meta.env',
    JSON.stringify(videoLabTelemetry({})),
  );
  const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
  assert.equal(
    await module.initSentry({ dsn: 'https://public@o0.ingest.sentry.io/1' }),
    false,
  );
  assert.equal(module.obs.enabled, false);
});
