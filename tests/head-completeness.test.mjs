import test from 'node:test';
import assert from 'node:assert/strict';
import { requireCompleteHead } from '../src/head-completeness.js';

test('a tinted shell and old portrait sessions remain incomplete', () => {
  for (const stats of [
    { includesHairCapture: false, appearance: { fullHead: true } },
    { source: 'Single image landmark proxy' },
    { appearance: { rearAppearance: 'Unobserved gray' } },
    { appearance: { fullHead: false } },
  ])
    assert.throws(() => requireCompleteHead(stats), /whole-head views/);
});

test('complete local heads work with local inferred gaps or AI detail', () => {
  for (const astraCompletion of [false, true])
    assert.doesNotThrow(() =>
      requireCompleteHead({
        includesHairCapture: true,
        appearance: {
          fullHead: true,
          astraCompletion,
          rearAppearance: 'Photographic material continuation',
        },
      }),
    );
});
