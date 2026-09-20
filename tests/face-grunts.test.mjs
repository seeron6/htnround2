import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gruntLevel, createGrunts } from '../src/sponsors/grunts.js';

const person = { name: 'Seeron', count: 8, avg: 2.0, max: 4.8 };
const after = (speed, name = 'Seeron') => ({
  participants: [person],
  last: { name, speed, zone: 'jaw-R' },
});

test('the grunt is as big as the punch was for that person, like the spoken line after it', () => {
  // Same thresholds as intensity_of() in omni_senses.py, so grunt and sentence never disagree.
  assert.equal(gruntLevel(after(4.8)), 'high');
  assert.equal(gruntLevel(after(1.2)), 'low');
  assert.equal(gruntLevel(after(2.2)), 'mid');
  assert.equal(gruntLevel(after(2.2), ['personal-best']), 'high');
  assert.equal(gruntLevel(after(2.2), ['combo']), 'mid');
  // Too few punches to know what is hard for them, a stranger, or nothing at all: a plain grunt.
  assert.equal(
    gruntLevel({
      participants: [{ ...person, count: 2 }],
      last: { name: 'Seeron', speed: 9 },
    }),
    'mid',
  );
  assert.equal(
    gruntLevel({ participants: [], last: { name: 'Guest', speed: 9 } }),
    'mid',
  );
  for (const nothing of [null, undefined, {}, { last: null }])
    assert.equal(gruntLevel(nothing), 'mid');
});

test('a voice with no recorded grunts stays silent instead of throwing', async () => {
  const grunts = createGrunts();
  assert.equal(grunts.has('Ryan'), false);
  assert.equal(grunts.play(null, null, 'Ryan', 'high'), 0);
  assert.equal(grunts.play({}, {}, 'Nobody', 'high'), 0);
});

test('every cast voice has a recorded grunt at every level, and the files exist', () => {
  const root = new URL('../public/omni-reactions/', import.meta.url);
  const index = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
  for (const voice of ['Ryan', 'Ethan', 'Marcus', 'Dylan', 'Jennifer', 'Katerina'])
    for (const level of ['low', 'mid', 'high']) {
      assert.ok(index[voice]?.[level]?.length >= 1, `${voice} has a ${level} grunt`);
      for (const name of index[voice][level]) {
        const file = new URL(`${voice}/${name}`, root);
        assert.ok(existsSync(file), `${voice}/${name} exists`);
        const header = readFileSync(file).subarray(0, 4).toString('latin1');
        assert.equal(header, 'RIFF');
      }
    }
});
