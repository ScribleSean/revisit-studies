import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewClip } from '../../../storage/reviewArtifacts';
import type { StudyIndexedEvent } from './studyEventsIndexTypes';

/** Build from authoritative artifacts. Never publish an incomplete read as an index. */
export async function buildEventsIndex(engine: Pick<StorageEngine, 'getReviewAnalysis' | 'getReviewArtifact'>, clips: ReviewClip[], signal: AbortSignal) {
  const unique = [...new Map(clips.map((clip) => [JSON.stringify([clip.participantId, clip.taskId]), { ...clip }])).values()];
  const results: StudyIndexedEvent[][] = new Array(unique.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (next < unique.length && !failed) {
      signal.throwIfAborted();
      const index = next;
      next += 1;
      const clip = unique[index];
      try {
        // Read at most four clips at a time. Legacy analysis can require
        // several underlying artifact reads inside getReviewAnalysis.
        // eslint-disable-next-line no-await-in-loop
        const [analysisRead, tagsRead] = await Promise.allSettled([
          engine.getReviewAnalysis(clip), engine.getReviewArtifact('tags', clip),
        ]);
        signal.throwIfAborted();
        if (analysisRead.status === 'rejected') throw analysisRead.reason;
        if (tagsRead.status === 'rejected') throw tagsRead.reason;
        const analysis = analysisRead.value;
        const tags = tagsRead.value;
        results[index] = [
          ...(analysis?.value.events || []).map((event): StudyIndexedEvent => ({ ...event, ...clip, source: 'auto' })),
          ...(tags?.value || []).map((tag): StudyIndexedEvent => ({
            ...clip, timestamp: tag.timestamp, type: 'tag', evidence: tag.label, source: 'tag',
          })),
        ];
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  // Wait for admitted reads even after a failure, so a retry cannot accumulate workers.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, unique.length) }, worker));
  signal.throwIfAborted();
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.flat();
}
