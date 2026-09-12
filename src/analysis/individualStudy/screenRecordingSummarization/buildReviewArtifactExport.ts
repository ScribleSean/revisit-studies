import type { StorageEngine } from '../../../storage/engines/types';
import type {
  ReviewArtifact, ReviewArtifacts, ReviewAnalysis, ReviewClip,
} from '../../../storage/reviewArtifacts';

type ClipArtifacts = { [K in 'summary' | 'events' | 'ocr' | 'confusion' | 'tags' | 'embedding' | 'prompt']: ReviewArtifact<K> | null };
export type ReviewArtifactExport = {
  format: 'revisit-review-artifacts'; version: 1; studyId: string; generatedAt: string;
  study: { settings: ReviewArtifact<'settings'> | null; index: ReviewArtifact<'index'> | null };
  clips: (ReviewClip & { analysis: ReviewAnalysis | null; artifacts: ClipArtifacts })[];
};
const maximumCharacters = 50000000;

export async function buildReviewArtifactExport(engine: StorageEngine, signal: AbortSignal, progress: (done: number, total: number) => void) {
  const scope = await engine.getReviewStudyClips(signal);
  const check = () => { signal.throwIfAborted(); if (engine.getReviewStudyId() !== scope.studyId) throw new Error('Study changed during export'); };
  check();
  const studyReads = await Promise.allSettled([engine.getReviewArtifact('settings'), engine.getReviewArtifact('index')]);
  check();
  const [settings, index] = studyReads.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value; });
  const archive: ReviewArtifactExport = {
    format: 'revisit-review-artifacts',
    version: 1,
    studyId: scope.studyId,
    generatedAt: new Date().toISOString(),
    study: { settings: settings as ReviewArtifact<'settings'> | null, index: index as ReviewArtifact<'index'> | null },
    clips: [],
  };
  let size = JSON.stringify(archive).length;
  const checkSize = () => { if (size > maximumCharacters) throw new Error('Artifact export exceeds the 50-million-character limit'); };
  checkSize(); progress(0, scope.clips.length);
  for (const identity of scope.clips) {
    check();
    // One atomic analysis read keeps its four categories on the same revision.
    // eslint-disable-next-line no-await-in-loop
    const reads = await Promise.allSettled([engine.getReviewAnalysis(identity), engine.getReviewArtifact('tags', identity), engine.getReviewArtifact('embedding', identity), engine.getReviewArtifact('prompt', identity)]);
    check();
    for (const result of reads) if (result.status === 'rejected') throw result.reason;
    const analysis = (reads[0] as PromiseFulfilledResult<ReviewAnalysis | null>).value;
    const category = <K extends 'summary' | 'events' | 'ocr' | 'confusion'>(kind: K): ReviewArtifact<K> | null => (analysis ? { version: 1, updatedAt: analysis.updatedAt, value: analysis.value[kind] as ReviewArtifacts[K] } : null);
    const clip = {
      ...identity,
      analysis,
      artifacts: {
        summary: category('summary'),
        events: category('events'),
        ocr: category('ocr'),
        confusion: category('confusion'),
        tags: (reads[1] as PromiseFulfilledResult<ReviewArtifact<'tags'> | null>).value,
        embedding: (reads[2] as PromiseFulfilledResult<ReviewArtifact<'embedding'> | null>).value,
        prompt: (reads[3] as PromiseFulfilledResult<ReviewArtifact<'prompt'> | null>).value,
      },
    };
    size += JSON.stringify(clip).length + 1; checkSize();
    archive.clips.push(clip); progress(archive.clips.length, scope.clips.length);
  }
  check();
  return archive;
}

export function serializeReviewArtifactExport(archive: ReviewArtifactExport) {
  const json = JSON.stringify(archive);
  if (json.length > maximumCharacters) throw new Error('Artifact export exceeds the 50-million-character limit');
  return json;
}
