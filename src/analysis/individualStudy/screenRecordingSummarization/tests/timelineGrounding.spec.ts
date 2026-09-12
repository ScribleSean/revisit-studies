import { expect, test } from 'vitest';
import { timelineGrounding } from '../timelineGrounding';

test('grounds exact phrases on both event and OCR frame within the same three-second bin', () => {
  const result = timelineGrounding([
    { type: 'confusion_word', timestamp: 2.9, evidence: 'Matched: not sure' },
    { type: 'confusion_word', timestamp: 3, evidence: 'Matched: not sure' },
    { type: 'reading', timestamp: 1, evidence: 'Matched: not sure' },
  ], [{ timestamp: 0.5, text: 'I am NOT, sure.' }, { timestamp: 2, text: 'not surely' }]);
  expect([...result.eventIndices]).toEqual([0]);
  expect([...result.frameIndices]).toEqual([0]);
});

test('does not join separate frames, accept empty phrases, or ground invalid times', () => {
  const result = timelineGrounding([
    { type: 'confusion_word', timestamp: 1, evidence: 'Matched: not sure' },
    { type: 'confusion_word', timestamp: 1, evidence: 'Matched: !!!' },
    { type: 'confusion_word', timestamp: -1, evidence: 'Matched: not' },
  ], [{ timestamp: 0, text: 'not' }, { timestamp: 2, text: 'sure' }, { timestamp: Number.NaN, text: 'not sure' }]);
  expect(result.eventIndices.size).toBe(0);
  expect(result.frameIndices.size).toBe(0);
});
