import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewAnalysis, ReviewArtifacts, ReviewClip } from '../../../storage/reviewArtifacts';
import { analyzeRecording, embedTexts } from './reviewApi';
import { recordedDiagnostics } from './recordedDiagnostics';

export function analysisText(analysis: ReviewAnalysis) {
  const { summary, events, ocr } = analysis.value;
  return [summary.text, ...events.map((event) => event.evidence), ...ocr.map((frame) => frame.text)].join('\n').slice(0, 8000);
}

export async function indexAnalysis(engine: StorageEngine, clip: ReviewClip, analysis: ReviewAnalysis, signal: AbortSignal) {
  const [embedding] = await embedTexts([analysisText(analysis)], signal);
  if (signal.aborted) return;
  await engine.saveReviewArtifact('embedding', { ...embedding, analysisRevision: analysis.revision }, clip);
}

export type ReviewJob = { clip: ReviewClip; state: 'pending' | 'analyzing' | 'saved' | 'skipped' | 'failed' | 'cancelled'; error?: string; indexing?: 'pending' | 'done' | 'failed' };

export async function runReviewBatch(engine: StorageEngine, clips: ReviewClip[], settings: ReviewArtifacts['settings'], signal: AbortSignal, embeddings: boolean, progress: (jobs: ReviewJob[]) => void) {
  const jobs: ReviewJob[] = structuredClone(clips).map((clip) => ({ clip, state: 'pending' }));
  const options = structuredClone(settings);
  const notify = () => progress(structuredClone(jobs));
  let indexing: Promise<void> = Promise.resolve();
  notify();
  for (const job of jobs) {
    if (signal.aborted) break;
    job.state = 'analyzing'; notify();
    try {
      // eslint-disable-next-line no-await-in-loop
      const recording = await engine.getReviewRecording(job.clip, signal);
      if (!recording) { job.state = 'skipped'; job.error = 'No saved recording'; } else {
        // eslint-disable-next-line no-await-in-loop
        const result = await analyzeRecording(recording, options, signal);
        if (signal.aborted) break;
        // eslint-disable-next-line no-await-in-loop
        const analysis = await engine.saveReviewAnalysis({
          summary: result.summary, events: result.events, ocr: result.ocr, confusion: result.confusion, duration: result.meta.duration, prompt: options.prompt || '', diagnostics: recordedDiagnostics(result.meta),
        }, job.clip);
        job.state = 'saved'; job.error = [analysis.indexWarning, ...recordedDiagnostics(result.meta)].filter(Boolean).join(' ') || undefined; notify();
        if (embeddings && !signal.aborted) {
          // Keep at most one embedding request alongside the next video analysis.
          // eslint-disable-next-line no-await-in-loop
          await indexing;
          if (signal.aborted) break;
          job.indexing = 'pending';
          indexing = indexAnalysis(engine, job.clip, analysis, signal).then(() => { if (!signal.aborted) job.indexing = 'done'; }).catch((reason) => {
            job.indexing = 'failed'; job.error = [job.error, `Analysis saved; indexing failed: ${String(reason.message || reason)}`].filter(Boolean).join(' ');
          }).finally(notify);
        }
      }
    } catch (reason) {
      job.state = signal.aborted ? 'cancelled' : 'failed';
      job.error = reason instanceof Error ? reason.message : String(reason);
    }
    notify();
  }
  await indexing;
  if (signal.aborted) {
    jobs.forEach((job) => {
      if (job.state === 'pending' || job.state === 'analyzing') job.state = 'cancelled';
      if (job.indexing === 'pending') { job.indexing = 'failed'; job.error = 'Analysis saved; indexing cancelled'; }
    });
  }
  notify();
  return jobs;
}
