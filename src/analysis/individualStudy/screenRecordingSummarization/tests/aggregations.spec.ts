import { describe, expect, test } from 'vitest';
import {
  coOccurrences, densestTimeWindows, eventsByParticipantTask, eventsByTask,
} from '../aggregations';
import type { StudyIndexedEvent } from '../studyEventsIndexTypes';

function event(participantId: string, taskId: string, timestamp: number, type = 'hesitation'): StudyIndexedEvent {
  return {
    participantId, taskId, timestamp, type, source: 'auto',
  };
}

describe('recording aggregation boundaries', () => {
  test('participant/task counts preserve identities and exclude invalid timestamps', () => {
    const counts = eventsByParticipantTask([
      event('__proto__', 'constructor', 0), event('__proto__', 'constructor', 1, 'tag'),
      event('a::b', 'c', 2), event('a', 'b::c', 3), event('a', 'c', -1),
    ]);
    expect(Object.getOwnPropertyDescriptor(counts, '__proto__')?.value.constructor).toBe(2);
    expect(counts['a::b'].c).toBe(1);
    expect(counts.a['b::c']).toBe(1);
    expect(counts.a.c).toBeUndefined();
  });
  test('keeps composite clip identities distinct', () => {
    const events = [event('a::b', 'c', 0), event('a', 'b::c', 1, 'reading')];
    expect(densestTimeWindows(events).map(({ participantId, taskId, count }) => ({ participantId, taskId, count }))).toEqual([
      { participantId: 'a::b', taskId: 'c', count: 1 },
      { participantId: 'a', taskId: 'b::c', count: 1 },
    ]);
    expect(coOccurrences(events)).toEqual([]);
  });

  test('treats prototype property names as ordinary task IDs', () => {
    const result = eventsByTask([event('p', '__proto__', 0), event('p', 'constructor', 1)]);
    expect(Object.keys(result)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value.hesitation).toBe(1);
    expect(Object.getOwnPropertyDescriptor(result, 'constructor')?.value.hesitation).toBe(1);
  });

  test('counts distinct event types in the same clip within an inclusive gap', () => {
    const events = [event('p', 't', 0), event('p', 't', 1), event('p', 't', 2, 'reading'), event('other', 't', 1, 'reading')];
    expect(coOccurrences(events, 2)).toEqual([{ a: 'hesitation', b: 'reading', count: 2 }]);
  });

  test('sorts without mutating input and includes the window boundary', () => {
    const events = [event('p', 't', 30), event('p', 't', 0), event('p', 't', 31)];
    expect(densestTimeWindows(events, 30, 1)[0]).toMatchObject({ start: 0, end: 30, count: 2 });
    expect(events.map((item) => item.timestamp)).toEqual([30, 0, 31]);
  });

  test('rejects invalid window options and timestamps', () => {
    expect(() => densestTimeWindows([], 0)).toThrow(RangeError);
    expect(() => densestTimeWindows([], 30, -1)).toThrow(RangeError);
    expect(() => coOccurrences([], Number.NaN)).toThrow(RangeError);
    expect(densestTimeWindows([event('p', 't', -1), event('p', 't', Number.NaN)])).toEqual([]);
    expect(densestTimeWindows([event('p', 't', 1)], 30, 0)).toEqual([]);
  });

  test('sliding co-occurrence matches exhaustive pairs across unsorted clips', () => {
    const events = Array.from({ length: 120 }, (_, i) => event(`p${i % 3}`, `t${i % 2}`, (i * 7) % 31, ['reading', 'hesitation', 'scene_change', 'tag'][i % 4]));
    const expected = new Map<string, number>();
    events.forEach((a, i) => {
      events.slice(i + 1).forEach((b) => {
        if (a.participantId === b.participantId && a.taskId === b.taskId && a.type !== b.type && Math.abs(a.timestamp - b.timestamp) <= 3) {
          const key = JSON.stringify([a.type, b.type].sort());
          expected.set(key, (expected.get(key) || 0) + 1);
        }
      });
    });
    const actual = new Map(coOccurrences(events, 3, 100).map(({ a, b, count }) => [JSON.stringify([a, b]), count]));
    expect(actual).toEqual(expected);
  });

  test('handles a dense clip without materializing all overlapping windows', () => {
    const events = Array.from({ length: 20000 }, (_, i) => event('p', 't', i / 1000, i % 2 ? 'reading' : 'hesitation'));
    expect(densestTimeWindows(events, 30, 1)[0].count).toBe(20000);
    expect(coOccurrences(events, 30)).toEqual([{ a: 'hesitation', b: 'reading', count: 100000000 }]);
  });
});
