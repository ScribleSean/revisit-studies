import {
  beforeEach, expect, test, vi,
} from 'vitest';
import type { StorageEngine } from '../../../../storage/engines/types';
import { analyzeRecording, embedTexts } from '../reviewApi';
import { runReviewBatch } from '../reviewJobs';

vi.mock('../reviewApi', () => ({ analyzeRecording: vi.fn(), embedTexts: vi.fn() }));
const clips = ['one', 'two', 'three'].map((participantId) => ({ participantId, taskId: 'task' }));
const settings = { pipeline: 'heuristic' as const, confusionWords: ['wait'] };
const value = {
  summary: { text: 'Summary', pipeline: 'heuristic', model: 'fixture' }, events: [], ocr: [], confusion: [], meta: { duration: 3 },
};
const getReviewRecording = vi.fn();
const saveReviewAnalysis = vi.fn();
const saveReviewArtifact = vi.fn();
const engine = { getReviewRecording, saveReviewAnalysis, saveReviewArtifact } as unknown as StorageEngine;
beforeEach(() => {
  vi.resetAllMocks();
  getReviewRecording.mockResolvedValue(new Blob(['video']));
  saveReviewAnalysis.mockResolvedValue({
    version: 1, revision: 'revision', updatedAt: '2026-09-09T12:00:00Z', value,
  });
  vi.mocked(analyzeRecording).mockResolvedValue(value);
  vi.mocked(embedTexts).mockResolvedValue([{ model: 'fixture', vector: [1, 0] }]);
});
test('continues after one failed recording and skips missing recordings', async () => {
  getReviewRecording.mockRejectedValueOnce(new Error('Download failed')).mockResolvedValueOnce(new Blob()).mockResolvedValueOnce(null);
  const jobs = await runReviewBatch(engine, clips, settings, new AbortController().signal, false, () => {});
  expect(jobs.map((job) => job.state)).toEqual(['failed', 'saved', 'skipped']);
  expect(saveReviewAnalysis).toHaveBeenCalledTimes(1);
  expect(saveReviewAnalysis.mock.calls[0][1]).toEqual(clips[1]);
});

test('cleanup warning is surfaced without losing the successful summary or marking it failed', async () => {
  vi.mocked(analyzeRecording).mockResolvedValue({ ...value, meta: { ...value.meta, cleanupWarning: 'Remove Gemini files/review-fixture' } });
  const jobs = await runReviewBatch(engine, clips.slice(0, 1), settings, new AbortController().signal, false, () => {});
  expect(jobs[0].state).toBe('saved');
  expect(jobs[0].error).toBe('Remove Gemini files/review-fixture');
  expect(saveReviewAnalysis.mock.calls[0][0].diagnostics).toEqual(['Remove Gemini files/review-fixture']);
  expect(saveReviewAnalysis).toHaveBeenCalledTimes(1);
});

test('captures the batch prompt before later edits and saves it with each analysis', async () => {
  const options = { ...settings, prompt: 'Original prompt' };
  await runReviewBatch(engine, clips.slice(0, 2), options, new AbortController().signal, false, () => { options.prompt = 'Later edit'; });
  expect(analyzeRecording).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(analyzeRecording).mock.calls) expect(call[1].prompt).toBe('Original prompt');
  for (const call of saveReviewAnalysis.mock.calls) expect(call[0].prompt).toBe('Original prompt');
});
test('cancellation preserves completed saves and does not start remaining recordings', async () => {
  const controller = new AbortController();
  const jobs = await runReviewBatch(engine, clips, settings, controller.signal, true, (rows) => { if (rows[0].state === 'saved') controller.abort(); });
  expect(jobs.map((job) => job.state)).toEqual(['saved', 'cancelled', 'cancelled']);
  expect(analyzeRecording).toHaveBeenCalledTimes(1);
  expect(saveReviewAnalysis).toHaveBeenCalledTimes(1);
});
test('index failure preserves analysis and successful indexing records its revision', async () => {
  vi.mocked(embedTexts).mockRejectedValueOnce(new Error('Model busy'));
  const jobs = await runReviewBatch(engine, clips.slice(0, 2), settings, new AbortController().signal, true, () => {});
  expect(jobs.map((job) => job.state)).toEqual(['saved', 'saved']);
  expect(jobs.map((job) => job.indexing)).toEqual(['failed', 'done']);
  expect(saveReviewArtifact).toHaveBeenCalledWith('embedding', { model: 'fixture', vector: [1, 0], analysisRevision: 'revision' }, clips[1]);
});
test('next analysis proceeds while the prior embedding is pending', async () => {
  let finish!: (value: { model: string; vector: number[] }[]) => void;
  vi.mocked(embedTexts).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = runReviewBatch(engine, clips.slice(0, 2), settings, new AbortController().signal, true, () => {});
  await vi.waitFor(() => expect(saveReviewAnalysis).toHaveBeenCalledTimes(2));
  finish([{ model: 'fixture', vector: [1, 0] }]);
  expect((await pending).every((job) => job.state === 'saved' && job.indexing === 'done')).toBe(true);
});
