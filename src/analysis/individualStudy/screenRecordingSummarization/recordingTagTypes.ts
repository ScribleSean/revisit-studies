export type RecordingTag = {
  id: string;
  timestamp: number;
  label: string;
  color?: string;
  createdAt?: string;
  createdBy?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function parseRecordingTagsJson(text: string): RecordingTag[] {
  try {
    const raw = JSON.parse(text) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : raw && isRecord(raw) && Array.isArray(raw.tags)
        ? raw.tags
        : null;
    if (!arr) return [];
    return arr.reduce<RecordingTag[]>((out, row) => {
      if (!isRecord(row)) return out;
      const id = typeof row.id === 'string' ? row.id : '';
      const ts = typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp);
      const label = typeof row.label === 'string' ? row.label : '';
      if (!id || !Number.isFinite(ts) || !label.trim()) return out;
      const tag: RecordingTag = { id, timestamp: ts, label: label.trim() };
      if (typeof row.color === 'string') tag.color = row.color;
      if (typeof row.createdAt === 'string') tag.createdAt = row.createdAt;
      if (typeof row.createdBy === 'string') tag.createdBy = row.createdBy;
      out.push(tag);
      return out;
    }, []);
  } catch {
    return [];
  }
}

export function formatRecordingTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
