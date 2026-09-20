import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExpressionSignal,
  blendMouth,
  EXPRESSIONS,
  EXPRESSION_ICONS,
} from '../src/sponsors/expression.js';

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (s) => (t += s) };
};

test('every expression the relay may send has a shape, an icon, and stays inside the rig', () => {
  // Must match EXPRESSIONS in omni_senses.py: the tool's enum is the contract.
  const names = ['smug', 'amused', 'stunned', 'winded', 'defiant', 'concerned'];
  assert.deepEqual(Object.keys(EXPRESSIONS).sort(), names.slice().sort());
  for (const name of names) {
    assert.ok(EXPRESSION_ICONS[name], name + ' has an icon');
    const time = clock(),
      signal = createExpressionSignal({ now: time.now });
    assert.equal(signal.set(name, 1), true);
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      time.advance(0.02);
      const shape = signal.read();
      for (const key of ['open', 'spread', 'round']) {
        assert.ok(shape[key] >= 0 && shape[key] <= 1, `${name}.${key} in range`);
        peak = Math.max(peak, shape[key]);
      }
    }
    assert.ok(peak > 0.1, name + ' is visible');
    assert.equal(signal.showing, null, name + ' eases away on its own');
    assert.deepEqual(signal.read(), { open: 0, spread: 0, round: 0 });
  }
});

test('a stunned jaw drops and recovers, a smirk just sits there, intensity scales both', () => {
  const time = clock(),
    signal = createExpressionSignal({ now: time.now });
  signal.set('stunned', 1);
  assert.deepEqual(signal.read(), { open: 0, spread: 0, round: 0 }); // eases in, never snaps
  time.advance(0.3);
  const dropped = signal.read().open;
  time.advance(1.7);
  assert.ok(dropped > 0.4 && signal.read().open < dropped * 0.6);

  signal.set('smug', 1);
  time.advance(1);
  const smirk = signal.read();
  time.advance(3);
  assert.deepEqual(signal.read(), smirk);
  assert.ok(smirk.spread > 0.5 && smirk.open === 0);

  signal.set('smug', 0.5);
  time.advance(1);
  assert.ok(Math.abs(signal.read().spread - smirk.spread / 2) < 1e-9);
});

test('what the model did not offer is ignored rather than guessed at', () => {
  const signal = createExpressionSignal({ now: () => 0 });
  for (const bad of ['furious', '', null, undefined, 'constructor', '__proto__'])
    assert.equal(signal.set(bad, 1), false);
  assert.equal(signal.showing, null);
  assert.equal(signal.set('winded', 'a lot'), true); // junk intensity falls back, stays clamped
  assert.equal(signal.showing.intensity, 0.6);
  signal.set('winded', 9);
  assert.equal(signal.showing.intensity, 1);
  signal.clear();
  assert.equal(signal.showing, null);
});

test('speech owns the jaw and the expression fills only what the voice is not using', () => {
  const stunned = { open: 0.6, spread: 0, round: 0.3 },
    smirk = { open: 0, spread: 0.6, round: 0 };
  // Silent: the expression shows in full.
  assert.deepEqual(blendMouth({ open: 0, spread: 0, round: 0 }, stunned), stunned);
  // Mid-word: the voice's jaw is untouched and the dropped jaw does not fight it.
  const talking = { open: 0.7, spread: 0.2, round: 0.1 };
  assert.deepEqual(blendMouth(talking, stunned), talking);
  // A smirk survives speech, softened: it lives in the corners, which talking barely uses.
  const smirking = blendMouth(talking, smirk);
  assert.equal(smirking.open, 0.7);
  assert.ok(smirking.spread > 0.25 && smirking.spread < 0.6);
  assert.deepEqual(blendMouth(null, null), { open: 0, spread: 0, round: 0 });
});
