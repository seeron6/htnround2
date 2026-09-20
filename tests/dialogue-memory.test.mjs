import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueMemory } from '../src/sponsors/dialogue-memory.js';

test('the next turn remembers heard words and shown objects, paired with the actual reply', () => {
  const memory = createDialogueMemory();
  memory.remember({
    hasAudio: true,
    perception: { heard: 'Call me Robin.', seen: 'Holding a blue mug.' },
    reply: 'Hello Robin.',
  });
  memory.remember({ text: 'What colour was it?', reply: 'Blue.' });
  assert.deepEqual(memory.history(), [
    {
      role: 'user',
      content: 'OMNI heard: Call me Robin.\nOMNI saw: Holding a blue mug.',
    },
    { role: 'assistant', content: 'Hello Robin.' },
    { role: 'user', content: 'Said: What colour was it?' },
    { role: 'assistant', content: 'Blue.' },
  ]);
});

test('six exchanges are bounded, with no placeholder speech or raw media replay', () => {
  const memory = createDialogueMemory();
  for (let i = 0; i < 8; i++)
    memory.remember({
      text: `Turn ${i}`,
      reply: `Reply ${i}`,
      audioWav: 'SECRET',
      frames: ['SECRET'],
    });
  assert.equal(memory.history().length, 12);
  assert.equal(memory.history()[0].content, 'Said: Turn 2');
  assert.doesNotMatch(
    JSON.stringify(memory.history()),
    /SECRET|spoken question|asked for a cue/,
  );
  memory.remember({ hasAudio: true, reply: 'Could you say that again?' });
  assert.match(memory.history().at(-2).content, /words were not recovered/);
});

test("a skipped reply still preserves the person's evidence; forgetting respects source", () => {
  const memory = createDialogueMemory();
  memory.remember({
    hasRoom: true,
    perception: { heard: 'Room speech', seen: 'A red glove.' },
    reply: '',
  });
  memory.remember({
    hasAudio: true,
    perception: { heard: 'Direct speech', seen: 'Waving.' },
    reply: 'Hi.',
  });
  memory.forgetRoom();
  memory.forgetVision();
  assert.doesNotMatch(JSON.stringify(memory.history()), /Room speech|red glove|Waving/);
  assert.match(JSON.stringify(memory.history()), /Direct speech/);
  memory.clear();
  assert.deepEqual(memory.history(), []);
});

test('oversized or malformed observations stay bounded for the relay', () => {
  const memory = createDialogueMemory();
  memory.remember({
    text: 't'.repeat(1000),
    perception: { heard: 'h'.repeat(1000), seen: 's'.repeat(1000) },
    reply: 'r'.repeat(1000),
  });
  assert.ok(memory.history().every((m) => m.content.length < 600));
  memory.remember({ perception: { heard: [], seen: {} }, reply: null });
  assert.ok(memory.history().every((m) => typeof m.content === 'string'));
});
