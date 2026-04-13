import { describe, expect, test } from 'vitest';

import {
  coOccurrences,
  densestTimeWindows,
  eventsByParticipant,
  eventsByTask,
} from './aggregations';
import type { StudyIndexedEvent } from './studyEventsIndexTypes';

function e(participantId: string, taskId: string, type: string, t: number): StudyIndexedEvent {
  return {
    participantId,
    taskId,
    type,
    timestamp: t,
    source: type === 'tag' ? 'tag' : 'auto',
  };
}

describe('screenRecordingSummarization/aggregations', () => {
  test('eventsByTask groups counts by type', () => {
    const events = [e('p1', 't1', 'hesitation', 1), e('p1', 't1', 'hesitation', 2), e('p2', 't2', 'tag', 3)];
    const byTask = eventsByTask(events);
    expect(byTask.t1.hesitation).toBe(2);
    expect(byTask.t2.tag).toBe(1);
  });

  test('eventsByParticipant groups counts by type', () => {
    const events = [e('p1', 't1', 'scene_change', 1), e('p1', 't2', 'scene_change', 3), e('p2', 't1', 'tag', 4)];
    const byP = eventsByParticipant(events);
    expect(byP.p1.scene_change).toBe(2);
    expect(byP.p2.tag).toBe(1);
  });

  test('densestTimeWindows returns top windows per clip', () => {
    const events = [
      e('p1', 't1', 'hesitation', 1),
      e('p1', 't1', 'scene_change', 5),
      e('p1', 't1', 'tag', 7),
      e('p2', 't9', 'tag', 100),
    ];
    const windows = densestTimeWindows(events, 10, 3);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].participantId).toBe('p1');
    expect(windows[0].taskId).toBe('t1');
    expect(windows[0].count).toBe(3);
  });

  test('coOccurrences counts pairs within gap', () => {
    const events = [
      e('p1', 't1', 'hesitation', 1),
      e('p1', 't1', 'tag', 2),
      e('p1', 't1', 'scene_change', 10),
      e('p1', 't1', 'scene_change', 11),
    ];
    const pairs = coOccurrences(events, 2, 10);
    const ht = pairs.find((p) => (p.a === 'hesitation' && p.b === 'tag') || (p.a === 'tag' && p.b === 'hesitation'));
    expect(ht?.count).toBe(1);
  });
});
