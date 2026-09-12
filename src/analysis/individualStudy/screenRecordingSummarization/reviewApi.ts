import { validateReviewValue, type ReviewArtifacts } from '../../../storage/reviewArtifacts';
import { recordedDiagnostics, type ReviewDiagnosticMeta } from './recordedDiagnostics';

export type ReviewPipeline = ReviewArtifacts['settings']['pipeline'];
export type ReviewHealth = { pipelines: { id: ReviewPipeline; available: boolean }[]; embeddings?: boolean };
export type ReviewResult = {
  events: ReviewArtifacts['events'];
  summary: ReviewArtifacts['summary'];
  ocr: ReviewArtifacts['ocr'];
  confusion: ReviewArtifacts['confusion'];
  meta: ReviewDiagnosticMeta;
};

async function responseJson(response: Response) {
  const data = await response.json().catch(() => { throw new Error('The analysis service returned an unreadable response.'); });
  if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : 'The analysis request failed.');
  return data;
}

export async function getReviewHealth(signal: AbortSignal): Promise<ReviewHealth> {
  const data = await responseJson(await fetch('/api/review/health', { signal }));
  if (!Array.isArray(data.pipelines) || data.pipelines.some((p: { id?: unknown; available?: unknown }) => !p || !['heuristic', 'gemini', 'gpt4o', 'local'].includes(String(p.id)) || typeof p.available !== 'boolean')) {
    throw new Error('The analysis service returned invalid capabilities.');
  }
  return data;
}

export async function embedTexts(texts: string[], signal: AbortSignal): Promise<ReviewArtifacts['embedding'][]> {
  const data = await responseJson(await fetch('/api/review/embed', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts }), signal,
  }));
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('Invalid embedding response');
  data.embeddings.forEach((embedding: unknown) => validateReviewValue('embedding', embedding));
  return data.embeddings;
}

export async function analyzeRecording(blob: Blob, settings: ReviewArtifacts['settings'], signal: AbortSignal): Promise<ReviewResult> {
  validateReviewValue('settings', settings);
  const confusionWords = settings.confusionWords.join(',');
  if (confusionWords.length > 2000) throw new Error('Confusion phrases exceed 2,000 characters.');
  const metadata = new Blob([JSON.stringify({ prompt: settings.prompt || '', confusionWords })]);
  const query = new URLSearchParams({ pipeline: settings.pipeline });
  const data = await responseJson(await fetch(`/api/review/analyze?${query}`, {
    method: 'POST', body: new Blob([metadata, blob]), headers: { 'content-type': blob.type || 'video/webm', 'x-review-metadata-length': String(metadata.size) }, signal,
  }));
  const { result } = data;
  validateReviewValue('events', result?.events);
  validateReviewValue('summary', result?.summary);
  validateReviewValue('ocr', result?.ocr);
  validateReviewValue('confusion', result?.confusion);
  if (!Number.isFinite(result.meta?.duration) || result.meta.duration <= 0 || result.events.some((event: { timestamp: number }) => event.timestamp > result.meta.duration)) {
    throw new Error('The analysis service returned invalid recording timestamps.');
  }
  if (result.ocr?.some((frame: { timestamp: number }) => frame.timestamp >= result.meta.duration) || result.confusion?.some((window: { end: number }) => window.end > result.meta.duration)) throw new Error('The analysis service returned evidence outside the recording.');
  recordedDiagnostics(result.meta);
  return result;
}
