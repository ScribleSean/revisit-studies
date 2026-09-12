import { expect, test } from 'vitest';
import { parseTimelineEventsJson } from '../timelineEventTypes';

test('rejects coercible invalid timestamps rather than placing them at zero', () => {
  const timestamps = [null, false, '', ' ', [], -1, 'NaN'];
  expect(parseTimelineEventsJson(JSON.stringify(timestamps.map((timestamp) => ({ type: 'hesitation', timestamp, evidence: 'test' }))))).toEqual([]);
});

test('accepts legacy numeric strings and orders valid evidence by time', () => {
  expect(parseTimelineEventsJson(JSON.stringify({
    events: [
      { type: 'reading', timestamp: '2.5', evidence: 'quiet' },
      { type: 'hesitation', timestamp: 0, evidence: 'pause' },
      { type: 'unknown', timestamp: 1 },
    ],
  }))).toEqual([
    { type: 'hesitation', timestamp: 0, evidence: 'pause' },
    { type: 'reading', timestamp: 2.5, evidence: 'quiet' },
  ]);
});

test('handles malformed JSON and non-event values', () => {
  for (const input of ['{', 'null', '1', '{}', '[null,1,"x"]']) {
    expect(parseTimelineEventsJson(input)).toEqual([]);
  }
});
