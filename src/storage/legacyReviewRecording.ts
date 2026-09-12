import { validateReviewValue, type ReviewAnalysisValue, type ReviewArtifacts } from './reviewArtifacts';

type LegacyRecording = Partial<Record<'summary' | 'events' | 'ocr' | 'confusion' | 'tags' | 'embedding', unknown>>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function rows(value: unknown, key: string): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : object(value) ? value[key] : undefined;
  if (!Array.isArray(list) || !Array.from(list).every(object)) throw new Error(`Invalid legacy ${key}`);
  return list;
}
const number = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);

/** Convert decoded legacy artifacts; original blobs remain the authoritative historical record. */
export function convertLegacyRecording(source: LegacyRecording) {
  const hasAnalysis = ['summary', 'events', 'ocr', 'confusion'].some((kind) => source[kind as keyof LegacyRecording] != null);
  let analysis: ReviewAnalysisValue | null = null;
  if (hasAnalysis) {
    const rawSummary = source.summary;
    let text = ''; let model = ''; let prompt: string | undefined;
    if (typeof rawSummary === 'string') text = rawSummary;
    else if (rawSummary != null) {
      if (!object(rawSummary)) throw new Error('Invalid legacy summary');
      const content = rawSummary.summary ?? rawSummary.analysis ?? rawSummary.text;
      if (typeof content !== 'string') throw new Error('Invalid legacy summary text');
      text = content;
      if (rawSummary.model !== undefined && typeof rawSummary.model !== 'string') throw new Error('Invalid legacy summary model');
      model = rawSummary.model as string || '';
      if (rawSummary.prompt !== undefined) {
        if (typeof rawSummary.prompt !== 'string' || rawSummary.prompt.length > 8000) throw new Error('Invalid legacy summary prompt');
        ({ prompt } = rawSummary);
      }
    }
    const events = source.events == null ? [] : rows(source.events, 'events').map((row) => ({ type: row.type, timestamp: number(row.timestamp), evidence: row.evidence ?? '' }));
    const ocr = source.ocr == null ? [] : rows(source.ocr, 'frames').map((row) => ({ timestamp: number(row.timestampSec), text: row.text }));
    const confusion = source.confusion == null ? [] : rows(source.confusion, 'windows').map((row) => ({
      start: number(row.startSec), end: number(row.endSec), score: number(row.score), evidence: [] as string[],
    }));
    validateReviewValue('events', events); validateReviewValue('ocr', ocr); validateReviewValue('confusion', confusion);
    analysis = {
      summary: { text, model, pipeline: 'legacy' }, events, ocr, confusion, ...(prompt === undefined ? {} : { prompt }),
    };
  }
  let tags: ReviewArtifacts['tags'] | null = null;
  if (source.tags != null) {
    const converted = rows(source.tags, 'tags').map((row) => ({ ...row, timestamp: number(row.timestamp) }));
    validateReviewValue('tags', converted); tags = converted;
  }
  let embedding: ReviewArtifacts['embedding'] | null = null;
  if (source.embedding != null) {
    if (!object(source.embedding)) throw new Error('Invalid legacy embedding');
    const converted = { model: source.embedding.model, vector: source.embedding.embedding };
    validateReviewValue('embedding', converted); embedding = structuredClone(converted);
    // No analysisRevision: historical embeddings must be reindexed before current semantic search uses them.
  }
  return { analysis, tags, embedding };
}
