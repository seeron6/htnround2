import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createInstantExpression,
  verdict,
  HURT_MEMORY_MS,
} from '../src/sponsors/instant-expression.js';
import { createExpressionSignal, EXPRESSIONS } from '../src/sponsors/expression.js';

// The face reacts on the device the instant a punch lands, and OMNI's set_expression call confirms
// or corrects it a second or two later. Why: TRACKS/SENTRY.md, finding 2.
const person = { name: 'Seeron', count: 8, avg: 2.0, max: 4.8 };
const after = (speed, trigger = null) => ({
  participants: [person],
  last: { name: 'Seeron', speed, zone: 'jaw-R' },
  trigger,
});
const clock = (t = 0) => ({ now: () => t, advance: (by) => (t += by) });

test('the look follows the punch, by the rules the model is given', () => {
  const time = clock(100000),
    face = createInstantExpression({ now: time.now });
  // An ordinary punch, and a first punch with nothing to compare it to: the heel's resting face.
  assert.deepEqual(face.react(after(2.2)), {
    emotion: 'smug',
    intensity: 0.4,
    why: 'ordinary',
  });
  assert.equal(
    face.react({ participants: [], last: { name: 'Guest', speed: 9 } }).why,
    'ordinary',
  );
  assert.equal(face.react(null).emotion, 'smug');
  // "smug: weak or sloppy punches" -- worn harder than the resting smirk.
  assert.deepEqual(face.react(after(1.2)), {
    emotion: 'smug',
    intensity: 0.7,
    why: 'weak',
  });
  // "winded: a fast combo or sustained pressure"
  assert.equal(face.react(after(2.2, 'combo'), ['combo']).emotion, 'winded');
  // "stunned: a genuinely hard punch just landed". The jaw drops again for every one of them.
  const big = face.react(after(4.8));
  assert.deepEqual([big.emotion, big.restart, big.why], ['stunned', true, 'big']);
  assert.equal(face.react(after(2.2), ['personal-best']).intensity, 1);
  // A big one outranks the combo it landed in, as it does for the spoken line.
  assert.equal(face.react(after(4.8), ['combo']).emotion, 'stunned');
  // "defiant: it got hurt a moment ago and is coming back meaner" -- and only for a moment.
  time.advance(3000);
  assert.deepEqual(face.react(after(2.2)), {
    emotion: 'defiant',
    intensity: 0.65,
    why: 'hurt a moment ago',
  });
  assert.equal(
    face.react(after(1.2)).emotion,
    'smug',
    'a weak punch is still a weak punch',
  );
  time.advance(HURT_MEMORY_MS);
  assert.equal(face.react(after(2.2)).why, 'ordinary');
});

test('it only guesses what a punch can tell it, and only ever in words the face knows', () => {
  const face = createInstantExpression({ now: () => 0 }),
    seen = new Set();
  for (const speed of [0.4, 1.2, 2.2, 4.8, 9])
    for (const triggers of [
      [],
      ['combo'],
      ['personal-best'],
      ['combo', 'personal-best'],
    ])
      seen.add(face.react(after(speed), triggers).emotion);
  for (const emotion of seen) assert.ok(Object.hasOwn(EXPRESSIONS, emotion), emotion);
  // These need eyes and ears. They are the model's to give.
  assert.ok(!seen.has('amused') && !seen.has('concerned'));
});

test('safety beats a guess, and a jaw that just dropped gets to finish dropping', () => {
  const time = clock(),
    signal = createExpressionSignal({ now: () => time.now() / 1000 }),
    face = createInstantExpression({ now: time.now });
  // OMNI heard "stop, I feel dizzy". No punch puts the act back on; only OMNI's next answer can.
  signal.set('concerned', 0.8);
  time.advance(400);
  for (const speed of [1.2, 2.2, 4.8])
    assert.equal(face.react(after(speed), [], signal.showing), null);

  signal.set('stunned', 1, { restart: true });
  time.advance(600);
  assert.equal(
    face.react(after(2.2), [], signal.showing),
    null,
    'mid-drop: left alone',
  );
  assert.equal(
    face.react(after(4.8), [], signal.showing).emotion,
    'stunned',
    'a harder one may',
  );
  time.advance(1200);
  assert.equal(face.react(after(2.2), [], signal.showing).emotion, 'defiant');
});

test('OMNI agreeing a second later carries the look on; it does not twitch the face', () => {
  const time = clock(),
    signal = createExpressionSignal({ now: time.now });
  const lowest = (seconds) => {
    let low = Infinity;
    for (let i = 0; i < seconds * 50; i++) {
      time.advance(0.02);
      low = Math.min(low, signal.read().spread);
    }
    return low;
  };
  signal.set('smug', 0.7); // the device, as the punch lands
  time.advance(1.2);
  const settled = signal.read().spread;
  assert.ok(settled > 0.4);
  signal.set('smug', 0.7); // OMNI, 1.2 s later, agreeing
  assert.ok(lowest(1) >= settled - 1e-9, 'the smirk dipped when OMNI confirmed it');
  // It holds from the confirmation, not from the punch: the smirk outlives its first 6 s.
  time.advance(4.5);
  assert.ok(signal.read().spread > 0.4);

  // A different strength is reached smoothly, never in one frame.
  signal.set('smug', 1);
  time.advance(0.02);
  const step = signal.read().spread - settled;
  assert.ok(step > 0 && step < 0.05, 'strength jumped by ' + step);
  time.advance(1);
  assert.ok(Math.abs(signal.read().spread - 0.6) < 1e-9);
});

test('a confirmed jaw drop does not drop twice, a second hard punch does', () => {
  const time = clock(),
    signal = createExpressionSignal({ now: time.now });
  signal.set('stunned', 1, { restart: true }); // the device, as the punch lands
  time.advance(0.3);
  const dropped = signal.read().open;
  time.advance(1.2);
  const recovering = signal.read().open;
  assert.ok(recovering < dropped * 0.7);
  signal.set('stunned', 1); // OMNI agrees, 1.5 s after the punch
  time.advance(0.3);
  assert.ok(
    signal.read().open <= recovering,
    'the jaw dropped a second time for one punch',
  );
  signal.set('stunned', 1, { restart: true }); // another hard punch
  time.advance(0.3);
  assert.ok(Math.abs(signal.read().open - dropped) < 1e-9);
  // OMNI disagreeing replaces it, easing in from rest as any new look does.
  signal.set('amused', 0.8);
  assert.deepEqual(signal.read(), { open: 0, spread: 0, round: 0 });
  assert.equal(signal.showing.emotion, 'amused');
});

test('the chip says who chose the look', () => {
  assert.equal(verdict(null, 'smug'), 'OMNI');
  assert.equal(verdict({ emotion: 'smug' }, 'smug'), 'OMNI agrees');
  assert.equal(verdict({ emotion: 'smug' }, 'amused'), 'OMNI corrected it');
});

test('the device and the relay agree on how hard a punch was', (t) => {
  // intensity_of() in omni_senses.py decides how the spoken line is delivered; the look must match
  // it, or the face would gasp a sentence it is smirking through. Ask the real function.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const cases = [
    [after(4.8), []],
    [after(2.2, 'personal-best'), ['personal-best']],
    [after(2.2, 'combo'), ['combo']],
    [after(4.8, 'combo'), ['combo']],
    [after(1.2), []],
    [after(1.2, 'combo'), ['combo']],
    [after(2.2), []],
    [
      {
        participants: [{ ...person, count: 2 }],
        last: { name: 'Seeron', speed: 9 },
        trigger: null,
      },
      [],
    ],
  ];
  const python = spawnSync(
    'python3',
    [
      '-c',
      'import json,sys;sys.path.insert(0,sys.argv[1]);import omni_senses as s;' +
        'print(json.dumps([s.intensity_of(c) for c in json.loads(sys.argv[2])]))',
      root,
      JSON.stringify(cases.map(([telemetry]) => telemetry)),
    ],
    { encoding: 'utf8' },
  );
  if (python.status !== 0)
    return t.skip('python3 is not available: ' + python.stderr.slice(0, 120));
  const relay = JSON.parse(python.stdout);
  assert.deepEqual(relay, [
    'big',
    'big',
    'pressure',
    'big',
    'weak',
    'pressure',
    null,
    null,
  ]);
  const look = { big: 'stunned', pressure: 'winded', weak: 'smug', null: 'smug' };
  cases.forEach(([telemetry, triggers], i) => {
    const face = createInstantExpression({ now: () => 0 });
    assert.equal(
      face.react(telemetry, triggers).emotion,
      look[relay[i]],
      `case ${i}: the relay says ${relay[i]}`,
    );
  });
});

test('the panel still wears it, measures it, and says who chose it', () => {
  const panel = readFileSync(
    new URL('../src/sponsors/cornerman.js', import.meta.url),
    'utf8',
  );
  assert.match(
    panel,
    /import \{ createInstantExpression, verdict \} from '\.\/instant-expression\.js'/,
  );
  assert.match(
    panel,
    /data-k="instant" checked/,
    'the switch that lets it be compared live',
  );
  assert.match(
    panel,
    /instant\.react\(stats\.snapshot\(now\), triggers, expression\.showing\)/,
  );
  assert.match(panel, /'face\.expression\.instant_latency'/);
  assert.match(panel, /'face\.expression\.verdict'/);
  // OMNI's answer still arrives through the same door, with nothing marking it as a guess.
  assert.match(
    panel,
    /event === 'expression'\)\s*\{\s*wear\(data\.emotion, data\.intensity\);/,
  );
});
