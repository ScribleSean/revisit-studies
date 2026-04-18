export type TimelineEventType =
  | 'hesitation'
  | 'confusion_word'
  | 'scene_change'
  | 'reading'
  | 'confused_transition'
  | 'active_interaction';

export interface TimelineEvent {
  type: TimelineEventType;
  timestamp: number;
  evidence: string;
}

const TYPES: TimelineEventType[] = [
  'hesitation',
  'confusion_word',
  'scene_change',
  'reading',
  'confused_transition',
  'active_interaction',
];

export function isTimelineEventType(t: string): t is TimelineEventType {
  return (TYPES as string[]).includes(t);
}

export function parseTimelineEventsJson(text: string): TimelineEvent[] {
  try {
    const raw = JSON.parse(text) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { events?: unknown }).events)
        ? (raw as { events: unknown[] }).events
        : null;
    if (!arr) return [];
    return arr.reduce<TimelineEvent[]>((out, row) => {
      if (!row || typeof row !== 'object') return out;
      const o = row as { type?: unknown; timestamp?: unknown; evidence?: unknown };
      if (typeof o.type !== 'string' || !isTimelineEventType(o.type)) return out;
      const ts = typeof o.timestamp === 'number' ? o.timestamp : Number(o.timestamp);
      if (!Number.isFinite(ts)) return out;
      const ev = typeof o.evidence === 'string' ? o.evidence : '';
      out.push({ type: o.type, timestamp: ts, evidence: ev });
      return out;
    }, []);
  } catch {
    return [];
  }
}
