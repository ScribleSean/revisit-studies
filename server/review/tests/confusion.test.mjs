import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreConfusion } from '../confusion.mjs';

const event = (type, timestamp, evidence = '') => ({ type, timestamp, evidence });
test('uses report weights and full recording duration including empty windows', () => {
  const windows = scoreConfusion(['hesitation', 'confusion_word', 'confused_transition', 'scene_change', 'reading', 'active_interaction'].map((type) => event(type, 2)), [], 75);
  assert.deepEqual(windows.map(({ start, end, score }) => ({ start, end, score })), [{ start: 0, end: 30, score: 4.5 }, { start: 30, end: 60, score: 0 }, { start: 60, end: 75, score: 0 }]);
  assert.equal(scoreConfusion([event('active_interaction', 0)], [], 2)[0].score, -0.5);
});
test('grounds exact phrases in the same three-second bin without crossing frames', () => {
  const events = [event('confusion_word', 2.9, 'Matched: not sure')];
  assert.equal(scoreConfusion(events, [{ timestamp: 0, text: 'I am NOT sure.' }], 30)[0].score, 2.25);
  for (const frames of [[{ timestamp: 3, text: 'not sure' }], [{ timestamp: 1, text: 'not surely' }], [{ timestamp: 1, text: 'not' }, { timestamp: 2, text: 'sure' }]]) {
    assert.equal(scoreConfusion(events, frames, 30)[0].score, 1.5);
  }
});
test('places boundaries once, retains the final point, and permits configured weights', () => {
  assert.deepEqual(scoreConfusion([event('hesitation', 30), event('hesitation', 60)], [], 60).map((w) => w.score), [0, 2]);
  assert.equal(scoreConfusion([event('reading', 1)], [], 5, { weights: { reading: 3 } })[0].score, 3);
  assert.throws(() => scoreConfusion([], [], Infinity));
  assert.throws(() => scoreConfusion([], [], 10, { windowSeconds: 0 }));
  assert.throws(() => scoreConfusion([event('hesitation', -1)], [], 10));
});
