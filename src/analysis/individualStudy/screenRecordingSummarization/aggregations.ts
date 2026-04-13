import type { StudyIndexedEvent } from './studyEventsIndexTypes';

function key2(a: string, b: string) {
  return `${a}::${b}`;
}

export function eventsByTask(events: StudyIndexedEvent[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const e of events) {
    out[e.taskId] ||= {};
    out[e.taskId][e.type] = (out[e.taskId][e.type] || 0) + 1;
  }
  return out;
}

export function eventsByParticipant(events: StudyIndexedEvent[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const e of events) {
    out[e.participantId] ||= {};
    out[e.participantId][e.type] = (out[e.participantId][e.type] || 0) + 1;
  }
  return out;
}

export function densestTimeWindows(
  events: StudyIndexedEvent[],
  windowSeconds: number = 30,
  topN: number = 10,
) {
  const byClip = new Map<string, StudyIndexedEvent[]>();
  for (const e of events) {
    const k = key2(e.participantId, e.taskId);
    const list = byClip.get(k) || [];
    list.push(e);
    byClip.set(k, list);
  }

  const windows: Array<{
    participantId: string;
    taskId: string;
    start: number;
    end: number;
    count: number;
    events: StudyIndexedEvent[];
  }> = [];

  for (const [clipKey, clipEvents] of byClip.entries()) {
    const [participantId, taskId] = clipKey.split('::');
    const sorted = [...clipEvents].sort((a, b) => a.timestamp - b.timestamp);
    let j = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const start = sorted[i].timestamp;
      while (j < sorted.length && sorted[j].timestamp <= start + windowSeconds) j += 1;
      const slice = sorted.slice(i, j);
      windows.push({
        participantId,
        taskId,
        start,
        end: start + windowSeconds,
        count: slice.length,
        events: slice,
      });
    }
  }

  return windows.sort((a, b) => b.count - a.count).slice(0, topN);
}

export function coOccurrences(
  events: StudyIndexedEvent[],
  gapSeconds: number = 2,
  topN: number = 10,
) {
  const byClip = new Map<string, StudyIndexedEvent[]>();
  for (const e of events) {
    const k = key2(e.participantId, e.taskId);
    const list = byClip.get(k) || [];
    list.push(e);
    byClip.set(k, list);
  }

  const counts: Record<string, number> = {};
  for (const clipEvents of byClip.values()) {
    const sorted = [...clipEvents].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const dt = sorted[j].timestamp - sorted[i].timestamp;
        if (dt > gapSeconds) break;
        const a = sorted[i].type;
        const b = sorted[j].type;
        const k = a <= b ? `${a}::${b}` : `${b}::${a}`;
        counts[k] = (counts[k] || 0) + 1;
      }
    }
  }

  return Object.entries(counts)
    .map(([k, count]) => {
      const [a, b] = k.split('::');
      return { a, b, count };
    })
    .sort((x, y) => y.count - x.count)
    .slice(0, topN);
}
