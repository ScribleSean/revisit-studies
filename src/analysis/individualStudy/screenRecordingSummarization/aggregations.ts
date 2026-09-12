import type { StudyIndexedEvent } from './studyEventsIndexTypes';

function validTime(event: StudyIndexedEvent) {
  return Number.isFinite(event.timestamp) && event.timestamp >= 0;
}

function groupClips(events: StudyIndexedEvent[]) {
  const clips = new Map<string, StudyIndexedEvent[]>();
  for (const event of events) {
    if (validTime(event)) {
      // JSON preserves both IDs even when they contain separators.
      const key = JSON.stringify([event.participantId, event.taskId]);
      const clip = clips.get(key) || [];
      clip.push(event);
      clips.set(key, clip);
    }
  }
  return [...clips.values()].map((clip) => clip.sort((a, b) => a.timestamp - b.timestamp));
}

function groupedCounts(events: StudyIndexedEvent[], field: 'taskId' | 'participantId') {
  const result: Record<string, Record<string, number>> = Object.create(null);
  for (const event of events) {
    if (validTime(event)) {
      result[event[field]] ||= Object.create(null);
      result[event[field]][event.type] = (result[event[field]][event.type] || 0) + 1;
    }
  }
  return result;
}

export function eventsByTask(events: StudyIndexedEvent[]) {
  return groupedCounts(events, 'taskId');
}

export function eventsByParticipant(events: StudyIndexedEvent[]) {
  return groupedCounts(events, 'participantId');
}

export function eventsByParticipantTask(events: StudyIndexedEvent[]) {
  const result: Record<string, Record<string, number>> = Object.create(null);
  for (const event of events) {
    if (validTime(event)) {
      result[event.participantId] ||= Object.create(null);
      result[event.participantId][event.taskId] = (result[event.participantId][event.taskId] || 0) + 1;
    }
  }
  return result;
}

function validateOptions(seconds: number, topN: number, allowZero: boolean) {
  if (!Number.isFinite(seconds) || seconds < 0 || (!allowZero && seconds === 0)) {
    throw new RangeError('Time interval must be finite and positive (co-occurrence permits zero).');
  }
  if (!Number.isSafeInteger(topN) || topN < 0) throw new RangeError('Result limit must be a nonnegative integer.');
}

export function densestTimeWindows(events: StudyIndexedEvent[], windowSeconds = 30, topN = 10) {
  validateOptions(windowSeconds, topN, false);
  if (!topN) return [];
  // Retain offsets until ranking finishes. Copying every overlapping window
  // would use quadratic memory for dense clips.
  const candidates: { clip: StudyIndexedEvent[]; from: number; to: number; count: number }[] = [];
  for (const clip of groupClips(events)) {
    let to = 0;
    for (let from = 0; from < clip.length; from += 1) {
      while (to < clip.length && clip[to].timestamp <= clip[from].timestamp + windowSeconds) to += 1;
      candidates.push({
        clip, from, to, count: to - from,
      });
    }
  }
  return candidates.sort((a, b) => b.count - a.count).slice(0, topN).map(({
    clip, from, to, count,
  }) => ({
    participantId: clip[from].participantId,
    taskId: clip[from].taskId,
    start: clip[from].timestamp,
    end: clip[from].timestamp + windowSeconds,
    count,
    events: clip.slice(from, to),
  }));
}

export function coOccurrences(events: StudyIndexedEvent[], gapSeconds = 2, topN = 10) {
  validateOptions(gapSeconds, topN, true);
  if (!topN) return [];
  const pairs = new Map<string, { a: string; b: string; count: number }>();
  for (const clip of groupClips(events)) {
    const active = new Map<string, number>();
    let first = 0;
    for (let index = 0; index < clip.length; index += 1) {
      const current = clip[index];
      while (clip[first].timestamp < current.timestamp - gapSeconds) {
        const oldType = clip[first].type;
        const remaining = (active.get(oldType) || 0) - 1;
        if (remaining) active.set(oldType, remaining);
        else active.delete(oldType);
        first += 1;
      }
      // Count by type in a sliding window, not by enumerating every event pair.
      for (const [otherType, count] of active) {
        if (otherType !== current.type) {
          const [a, b] = [otherType, current.type].sort();
          const key = JSON.stringify([a, b]);
          const pair = pairs.get(key) || { a, b, count: 0 };
          pair.count += count;
          pairs.set(key, pair);
        }
      }
      active.set(current.type, (active.get(current.type) || 0) + 1);
    }
  }
  return [...pairs.values()].sort((a, b) => b.count - a.count).slice(0, topN);
}
