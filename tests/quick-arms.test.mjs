import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { ArmScanAccumulator, sampleArmFrame } from '../src/arm-personalization.js';
import { appearanceArms } from './helpers/synthetic-arms.mjs';

// Load the production controller without its browser stylesheet. Tests invoke
// its real completion path; only DOM/rendering boundaries are replaced here.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css'))
      return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { QuickArms } = await import('../src/quick-arms.js');
hooks.deregister();

function controller(accumulator) {
  return {
    accumulator,
    started: 1000,
    timer: null,
    running: true,
    tracking: { scanArms: true },
    draft: { left: { watch: false, ring: true }, right: { watch: true, ring: false } },
    draftSamples: { left: { old: true } },
    setScanning(value) {
      this.scanningUI = value;
    },
    syncFields() {},
    buildPreview() {
      this.renderedDraft = structuredClone(this.draft);
    },
    previewRenderer: { render() {} },
    status(message, state) {
      this.result = { message, state };
    },
  };
}

test('scan completion replaces old manual jewelry flags with each arm’s detected result', (t) => {
  t.mock.method(performance, 'now', () => 9000);
  const f = appearanceArms();
  const samples = sampleArmFrame(f.image, f.landmarks, f.pose);
  const accumulator = new ArmScanAccumulator();
  for (let i = 1; i <= 5; i++) accumulator.add(samples, i);
  const state = controller(accumulator);
  QuickArms.prototype.finish.call(state);
  assert.equal(state.result.state, 'success');
  assert.equal(state.renderedDraft.left.watch, true);
  assert.equal(state.renderedDraft.left.ring, false);
  assert.equal(state.renderedDraft.right.watch, false);
  assert.equal(state.renderedDraft.right.ring, true);
  assert.equal(state.renderedDraft.right.ringFinger, 3);
  assert.equal(state.renderedDraft.left.skin, '#583c30');
  assert.equal(state.renderedDraft.right.clothing, '#20305a');
  assert.equal(state.draft.left.sample, undefined);
  assert.ok(state.draftSamples.left.upperStrip);
  assert.match(
    state.result.message,
    /Left: long sleeves, watch\. Right: short sleeves, ring/,
  );
  assert.equal(state.tracking.scanArms, false);
});

test('a rejected scan leaves the previous draft intact and reports that nothing was applied', (t) => {
  t.mock.method(performance, 'now', () => 9000);
  const state = controller(new ArmScanAccumulator());
  const previous = state.draft;
  QuickArms.prototype.finish.call(state);
  assert.equal(state.draft, previous);
  assert.equal(state.draftSamples.left.old, true);
  assert.equal(state.result.state, 'error');
  assert.match(state.result.message, /Scan did not apply:/);
});

test('synchronized scan pixels remain usable when delivery is delayed on a busy machine', () => {
  const f = appearanceArms();
  const accumulator = new ArmScanAccumulator();
  const state = { running: true, started: 1, accumulator };
  QuickArms.prototype.accept.call(state, {
    timestamp: 2,
    armSample: f.image,
    landmarks: f.landmarks,
    pose: { timestamp: 2, landmarks: [f.pose] },
  });
  assert.deepEqual(accumulator.frames, { left: 1, right: 1 });
  QuickArms.prototype.accept.call(state, {
    timestamp: 0,
    armSample: f.image,
    landmarks: f.landmarks,
    pose: { timestamp: 0, landmarks: [f.pose] },
  });
  assert.deepEqual(accumulator.frames, { left: 1, right: 1 });
});
