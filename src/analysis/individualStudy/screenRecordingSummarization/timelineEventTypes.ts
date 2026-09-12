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
      if (typeof o.timestamp !== 'number' && (typeof o.timestamp !== 'string' || !o.timestamp.trim())) return out;
      const ts = Number(o.timestamp);
      if (!Number.isFinite(ts) || ts < 0) return out;
      const ev = typeof o.evidence === 'string' ? o.evidence : '';
      out.push({ type: o.type, timestamp: ts, evidence: ev });
      return out;
    }, []).sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}
