import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewAnalysis, ReviewArtifacts, ReviewClip } from '../../../storage/reviewArtifacts';
import type { StudyIndexedEvent } from './studyEventsIndexTypes';
import {
  coOccurrences, densestTimeWindows, eventsByParticipantTask, eventsByTask,
} from './aggregations';
import { reportThumbnail } from './reportThumbnail';

export type StudyReportClip = ReviewClip & { analysis: ReviewAnalysis | null; tags: ReviewArtifacts['tags']; thumbnail: string | null; mediaWarning?: string };
export type StudyReport = {
  studyId: string; generatedAt: string; clips: StudyReportClip[];
  aggregates: { totalEvents: number; byTask: ReturnType<typeof eventsByTask>; byParticipantTask: ReturnType<typeof eventsByParticipantTask>; denseWindows: ReturnType<typeof densestTimeWindows>; pairs: ReturnType<typeof coOccurrences> };
};

export async function buildStudyReport(engine: StorageEngine, signal: AbortSignal, progress: (done: number, total: number) => void) {
  const scope = await engine.getReviewStudyClips(signal);
  const check = () => { signal.throwIfAborted(); if (engine.getReviewStudyId() !== scope.studyId) throw new Error('Study changed during export'); };
  const clips: StudyReportClip[] = [];
  const events: StudyIndexedEvent[] = [];
  let size = 0;
  progress(0, scope.clips.length);
  for (const identity of scope.clips) {
    check();
    // Do not return a partial analysis report after a source read failure.
    // eslint-disable-next-line no-await-in-loop
    const [analysisRead, tagsRead] = await Promise.allSettled([engine.getReviewAnalysis(identity), engine.getReviewArtifact('tags', identity)]);
    check();
    if (analysisRead.status === 'rejected') throw analysisRead.reason;
    if (tagsRead.status === 'rejected') throw tagsRead.reason;
    const clip: StudyReportClip = {
      ...identity, analysis: analysisRead.value, tags: tagsRead.value?.value || [], thumbnail: null,
    };
    try {
      // Only one recording is downloaded/decoded at a time.
      // eslint-disable-next-line no-await-in-loop
      const recording = await engine.getReviewRecording(identity, signal);
      check();
      if (recording) {
        // eslint-disable-next-line no-await-in-loop
        clip.thumbnail = await reportThumbnail(recording, signal, clip.analysis?.value.duration);
      } else clip.mediaWarning = 'No saved screen recording';
    } catch (error) {
      check();
      clip.mediaWarning = error instanceof Error ? error.message : String(error);
    }
    check();
    size += JSON.stringify(clip).length;
    if (size > 50000000) throw new Error('Report exceeds the 50-million-character export limit');
    for (const event of clip.analysis?.value.events || []) events.push({ ...event, ...identity, source: 'auto' });
    for (const tag of clip.tags) {
      events.push({
        ...identity, timestamp: tag.timestamp, type: 'tag', evidence: tag.label, source: 'tag',
      });
    }
    clips.push(clip); progress(clips.length, scope.clips.length);
  }
  check();
  return {
    studyId: scope.studyId,
    generatedAt: new Date().toISOString(),
    clips,
    aggregates: {
      totalEvents: events.length, byTask: eventsByTask(events), byParticipantTask: eventsByParticipantTask(events), denseWindows: densestTimeWindows(events), pairs: coOccurrences(events),
    },
  } satisfies StudyReport;
}
