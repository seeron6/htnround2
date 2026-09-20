import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { obs } from '../src/sponsors/sentry.js';
import {
  startFlightRecorder,
  afterSentryStarts,
} from '../src/sponsors/flight-recorder.js';

// The browser half of the Sentry wiring. What it sends is checked in a real browser against
// scripts/sentry_sink.py (TRACKS/SENTRY.md, "How this was verified"). What is locked in here is
// the two things an edit elsewhere could silently undo: that the app is untouched without a DSN,
// and that the privacy stance and the hooks are still in the source.
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('without a DSN a flow is a plain pass-through and every note is a no-op', async () => {
  let sent = 0;
  const reply = await obs.flow(
    'coach.turn',
    { 'coach.mode': 'face' },
    async (span, within) => {
      span.setAttribute('coach.model', 'x');
      span.setStatus({ code: 2 });
      return within(() => {
        sent++;
        return 'the reply';
      });
    },
  );
  assert.equal(reply, 'the reply');
  assert.equal(sent, 1, 'the request inside within() must run exactly once');
  assert.equal(obs.enabled, false);
  // A failed turn must fail the same way it did before there was a span around it.
  await assert.rejects(
    obs.flow('coach.turn', {}, async () => {
      throw new TypeError('the relay went away');
    }),
    /the relay went away/,
  );
  assert.throws(() =>
    obs.flow('x', {}, () => {
      throw new RangeError('sync');
    }),
  );
  // None of these may throw, need a window, or import the SDK.
  obs.log('a', { n: 1 });
  obs.warn('b');
  obs.metric('m', 12.5, 'millisecond', { k: 'v', gone: undefined });
  obs.metric('m', NaN);
  obs.metric('m', null);
  obs.count('c', { k: 'v' });
  obs.crumb('punch', 'webcam left 1.2 m/s', { speed: 1.2 });
  obs.tag('app', 'test');
  obs.feedback(null);
  assert.equal(
    await obs.span('coach.turn', {}, async (span) => (span.setAttribute('a', 1), 7)),
    7,
  );
});

test('the flight recorder needs no browser to be imported, and starts nothing outside one', () => {
  assert.equal(typeof window, 'undefined');
  startFlightRecorder();
  afterSentryStarts(null);
});

test('Session Replay can never record a face, what was said, or a guest name', () => {
  const source = read('src/sponsors/sentry.js');
  assert.match(source, /sendDefaultPii:\s*false/);
  assert.match(source, /blockAllMedia:\s*true/);
  assert.match(source, /maskAllInputs:\s*true/);
  assert.match(source, /mask:\s*\[\s*'\.sd-log',\s*'\[data-k="board"\]'\s*\]/);
  assert.match(source, /block:\s*\[\s*'video',\s*'canvas'\s*\]/);
  assert.match(
    source,
    /enableScreenshot:\s*false/,
    'a feedback screenshot could hold a face',
  );
  assert.doesNotMatch(
    source,
    /replayCanvasIntegration\s*\(/,
    'the 3D canvas is the reconstructed face: it must never be recorded',
  );
  assert.doesNotMatch(
    source,
    /networkDetailAllowUrls/,
    'request bodies hold webcam frames',
  );
  // The conversation log and the scoreboard still carry the class and attribute that are masked.
  assert.match(read('src/sponsors/cornerman.js'), /class="sd-log"/);
  assert.match(read('src/sponsors/arena-host.js'), /<table data-k="board">/);
});

test('the hot loop stays out of spans, breadcrumbs and replays', () => {
  const source = read('src/sponsors/sentry.js');
  const hot = new RegExp(source.match(/const HOT = \/(.+?)\/;/)[1]);
  for (const url of ['/physics/step', '/api/meshy-job?id=1', '/api/face-status?id=1'])
    assert.ok(hot.test(url), url + ' would flood the breadcrumb trail');
  for (const url of [
    '/physics/open',
    '/api/save?type=json',
    '/api/meshy-train',
    '/sponsors/coach/turn',
  ])
    assert.ok(!hot.test(url), url + " is a person's action and must be kept");
  assert.match(
    source,
    /shouldCreateSpanForRequest:\s*\(url\)\s*=>\s*!HOT\.test\(url\)/,
  );
});

test('the hooks that feed the flight recorder are still in place', () => {
  const boot = read('src/sponsors/boot.js');
  assert.ok(
    boot.indexOf('startFlightRecorder();') > 0 &&
      boot.indexOf('startFlightRecorder();') < boot.indexOf('async function start()'),
    'the recorder must start with the page, before the DSN is known',
  );
  assert.match(
    boot,
    /await initSentry\(config\.sentry\);[\s\S]{0,200}afterSentryStarts\(dock\)/,
  );
  const panel = read('src/sponsors/cornerman.js');
  assert.match(
    panel,
    /obs\.flow\(\s*'coach\.turn'/,
    'a turn must be a trace of its own',
  );
  assert.match(panel, /within\(\(\) =>\s*fetch\(api \+ '\/sponsors\/coach\/turn'/);
  assert.match(panel, /'face\.grunt_latency'/);
  // main.js publishes what the recorder listens to. If these go, punches vanish from replays.
  const main = read('src/main.js');
  assert.match(main, /new CustomEvent\('punching-face-contact'/);
  assert.match(main, /time:\s*performance\.now\(\)/);
});

test('the Python services keep their new Sentry hooks', () => {
  const meshy = read('meshy_backend.py');
  assert.match(meshy, /sponsor_obs\.traced\(\s*self\._run,\s*'meshy\.build'/);
  assert.match(meshy, /sponsor_obs\.job_state\(state\)/);
  assert.match(meshy, /except ImportError:\s*sponsor_obs = None/);
  assert.match(
    read('physics_server.py'),
    /except Exception as crash:[\s\S]{0,400}sponsor_obs\.capture\(crash/,
    'a Newton crash must reach Sentry, not only the terminal',
  );
  const relay = read('sponsor_server.py');
  assert.match(relay, /sponsor_obs\.agent_span\(/);
  assert.match(relay, /sponsor_obs\.tool_span\(\s*'set_expression'/);
  assert.match(relay, /args=\(cfg, data, started, turn_span\)/);
});
