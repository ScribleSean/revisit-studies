import { isTimelineEventType, type TimelineEvent } from '../analysis/individualStudy/screenRecordingSummarization/timelineEventTypes';
import type { StudyIndexedEvent } from '../analysis/individualStudy/screenRecordingSummarization/studyEventsIndexTypes';

export type SavedReviewPrompt = { id: string; name: string; text: string; updatedAt: string };

export function isReviewStorageArtifact(prefix: string, type: string) {
  return type.startsWith('review-') || ['screenRecordingPrompts', 'screenRecordingAnalysisSettings', 'studyEventsIndex'].includes(type)
    || /^screenRecording(Summary|Events|Tags|OcrFrames|ConfusionScore|Embedding)\//.test(prefix);
}

export interface ReviewArtifacts {
  summary: { text: string; pipeline: string; model: string };
  events: TimelineEvent[];
  tags: { id: string; timestamp: number; label: string }[];
  ocr: { timestamp: number; text: string }[];
  confusion: { start: number; end: number; score: number; evidence: string[] }[];
  embedding: { model: string; vector: number[]; analysisRevision?: string };
  prompt: { text: string };
  index: StudyIndexedEvent[];
  settings: { pipeline: 'heuristic' | 'gemini' | 'gpt4o' | 'local'; confusionWords: string[]; prompt?: string; promptLibrary?: SavedReviewPrompt[] };
}

export type ReviewArtifactKind = keyof ReviewArtifacts;
export const ANALYSIS_KINDS = ['summary', 'events', 'ocr', 'confusion'] as const;
export type ReviewAnalysisValue = Pick<ReviewArtifacts, typeof ANALYSIS_KINDS[number]> & { duration?: number; prompt?: string; diagnostics?: string[] };
export type ReviewAnalysis = { version: 1; revision: string; updatedAt: string; value: ReviewAnalysisValue };

export type ReviewClip = { participantId: string; taskId: string };
export type ReviewArtifact<K extends ReviewArtifactKind> = {
  version: 1;
  updatedAt: string;
  value: ReviewArtifacts[K];
};

export const REVIEW_ARTIFACT_KINDS: ReviewArtifactKind[] = ['summary', 'events', 'tags', 'ocr', 'confusion', 'embedding', 'prompt', 'index', 'settings'];

export function reviewArtifactPrefix(kind: ReviewArtifactKind, clip?: ReviewClip) {
  if (!REVIEW_ARTIFACT_KINDS.includes(kind)) throw new Error('Unknown review artifact kind');
  const studyScoped = kind === 'settings' || kind === 'index';
  if (studyScoped && clip) throw new Error('Study artifact cannot have a clip identity');
  if (!studyScoped && (!clip?.participantId || !clip?.taskId)) throw new Error('Recording artifact requires participant and task IDs');
  // A single flat directory makes snapshot copy/delete independent of nesting.
  // Encode the tuple rather than concatenating IDs with an ambiguous delimiter.
  return `review/${studyScoped ? 'study' : encodeURIComponent(JSON.stringify([clip!.participantId, clip!.taskId]))}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && Array.from(value).every((item) => typeof item === 'string');
}

function rows(value: unknown, validate: (row: Record<string, unknown>) => boolean) {
  return Array.isArray(value) && Array.from(value).every((row) => object(row) && validate(row));
}

export function validateReviewValue<K extends ReviewArtifactKind>(kind: K, value: unknown): asserts value is ReviewArtifacts[K] {
  if (kind === 'settings' && object(value) && value.promptLibrary !== undefined) {
    const library = value.promptLibrary;
    if (!Array.isArray(library) || library.length > 100 || !rows(library, (row) => typeof row.id === 'string' && !!row.id && typeof row.name === 'string' && !!row.name.trim() && row.name.length <= 100 && typeof row.text === 'string' && row.text.length <= 8000 && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt))) || new Set(library.map((row) => row.id)).size !== library.length || new Set(library.map((row) => row.name.trim().toLocaleLowerCase())).size !== library.length) throw new Error('Invalid review prompt library');
  }
  let valid = false;
  switch (kind) {
    case 'summary': valid = object(value) && typeof value.text === 'string' && typeof value.pipeline === 'string' && typeof value.model === 'string'; break;
    case 'events': valid = rows(value, (row) => time(row.timestamp) && typeof row.type === 'string' && isTimelineEventType(row.type) && typeof row.evidence === 'string'); break;
    case 'tags': valid = rows(value, (row) => typeof row.id === 'string' && !!row.id && time(row.timestamp) && typeof row.label === 'string' && !!row.label.trim()); break;
    case 'ocr': valid = rows(value, (row) => time(row.timestamp) && typeof row.text === 'string'); break;
    case 'confusion': valid = rows(value, (row) => time(row.start) && time(row.end) && row.end > row.start && typeof row.score === 'number' && Number.isFinite(row.score) && strings(row.evidence)); break;
    case 'embedding': valid = object(value) && typeof value.model === 'string' && !!value.model && Array.isArray(value.vector) && value.vector.length > 0 && Array.from(value.vector).every((v) => typeof v === 'number' && Number.isFinite(v)) && value.vector.some((v) => v !== 0) && (value.analysisRevision === undefined || (typeof value.analysisRevision === 'string' && !!value.analysisRevision)); break;
    case 'prompt': valid = object(value) && typeof value.text === 'string'; break;
    case 'index': valid = rows(value, (row) => typeof row.participantId === 'string' && !!row.participantId && typeof row.taskId === 'string' && !!row.taskId && time(row.timestamp) && typeof row.type === 'string' && (row.type === 'tag' || isTimelineEventType(row.type)) && (row.source === 'auto' || row.source === 'tag') && (row.evidence === undefined || typeof row.evidence === 'string')); break;
    case 'settings': valid = object(value) && typeof value.pipeline === 'string' && ['heuristic', 'gemini', 'gpt4o', 'local'].includes(value.pipeline) && strings(value.confusionWords) && (value.prompt === undefined || (typeof value.prompt === 'string' && value.prompt.length <= 8000)); break;
    default: valid = false;
  }
  if (!valid) throw new Error(`Invalid review ${kind} data`);
}

export function parseReviewArtifact<K extends ReviewArtifactKind>(kind: K, data: unknown): ReviewArtifact<K> | null {
  if (data === null || data === undefined) return null;
  if (!object(data) || data.version !== 1 || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt))) {
    throw new Error(`Invalid or unsupported review ${kind} artifact`);
  }
  validateReviewValue(kind, data.value);
  return { version: 1, updatedAt: data.updatedAt, value: data.value };
}

export function parseReviewAnalysis(data: unknown): ReviewAnalysis | null {
  if (data === null || data === undefined) return null;
  if (!object(data) || data.version !== 1 || typeof data.revision !== 'string' || !data.revision || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) || !object(data.value)) throw new Error('Invalid review analysis');
  for (const kind of ANALYSIS_KINDS) validateReviewValue(kind, data.value[kind]);
  if (data.value.prompt !== undefined && (typeof data.value.prompt !== 'string' || data.value.prompt.length > 8000)) throw new Error('Invalid review analysis prompt');
  if (data.value.diagnostics !== undefined && (!strings(data.value.diagnostics) || data.value.diagnostics.length > 8 || data.value.diagnostics.some((message) => message.length > 2000))) throw new Error('Invalid review analysis diagnostics');
  if (data.value.duration !== undefined) {
    const { duration } = data.value;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid review analysis duration');
    const value = data.value as ReviewAnalysisValue;
    if (value.events.some((event) => event.timestamp > duration) || value.ocr.some((frame) => frame.timestamp >= duration) || value.confusion.some((window) => window.end > duration)) throw new Error('Review evidence exceeds recording duration');
  }
  return data as ReviewAnalysis;
}
