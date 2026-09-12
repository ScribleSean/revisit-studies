import {
  beforeEach, expect, test, vi,
} from 'vitest';
import type { StorageEngine } from '../../../../storage/engines/types';
import { buildStudyReport } from '../buildStudyReport';
import { reportThumbnail } from '../reportThumbnail';

vi.mock('../reportThumbnail', () => ({ reportThumbnail: vi.fn() }));
const clips = [{ participantId: 'one', taskId: 'task' }, { participantId: 'two', taskId: 'task' }];
const analysis = {
  version: 1,
  revision: 'revision',
  updatedAt: '2026-09-09T00:00:00Z',
  value: {
    duration: 4, summary: { text: 'Summary', pipeline: 'heuristic', model: 'test' }, events: [{ timestamp: 1, type: 'reading', evidence: 'Read' }], ocr: [], confusion: [],
  },
};
const getReviewStudyId = vi.fn();
const getReviewAnalysis = vi.fn();
const getReviewArtifact = vi.fn();
const getReviewRecording = vi.fn();
const engine = {
  getReviewStudyClips: async () => ({ studyId: 'study', clips }), getReviewStudyId, getReviewAnalysis, getReviewArtifact, getReviewRecording,
} as unknown as StorageEngine;
beforeEach(() => {
  vi.resetAllMocks();
  getReviewStudyId.mockReturnValue('study'); getReviewAnalysis.mockResolvedValue(analysis);
  getReviewArtifact.mockResolvedValue({ value: [{ id: 'tag', timestamp: 2, label: 'Check' }] });
  getReviewRecording.mockResolvedValue(new Blob(['video']));
  vi.mocked(reportThumbnail).mockResolvedValue('data:image/jpeg;base64,aA==');
});

test('includes every discovered clip and preserves evidence when one video fails', async () => {
  getReviewRecording.mockRejectedValueOnce(new Error('Video missing'));
  const progress = vi.fn();
  const report = await buildStudyReport(engine, new AbortController().signal, progress);
  expect(report.clips).toHaveLength(2);
  expect(report.clips[0].mediaWarning).toBe('Video missing');
  expect(report.clips[1].thumbnail).toContain('data:image/jpeg');
  expect(report.aggregates.totalEvents).toBe(4);
  expect(report.aggregates.byParticipantTask.two.task).toBe(2);
  expect(progress).toHaveBeenLastCalledWith(2, 2);
  expect(reportThumbnail).toHaveBeenCalledWith(expect.any(Blob), expect.any(AbortSignal), 4);
});

test('a source read failure rejects rather than exporting incomplete statistics', async () => {
  getReviewArtifact.mockRejectedValueOnce(new Error('Tags unreadable'));
  await expect(buildStudyReport(engine, new AbortController().signal, () => {})).rejects.toThrow('Tags unreadable');
  expect(getReviewRecording).not.toHaveBeenCalled();
});

test('cancellation after one clip does not process remaining recordings', async () => {
  const controller = new AbortController();
  await expect(buildStudyReport(engine, controller.signal, (done) => { if (done === 1) controller.abort(); })).rejects.toThrow();
  expect(getReviewRecording).toHaveBeenCalledOnce();
});

test('study changes prevent a report from mixing study identities', async () => {
  getReviewStudyId.mockReturnValueOnce('study').mockReturnValue('other');
  await expect(buildStudyReport(engine, new AbortController().signal, () => {})).rejects.toThrow('Study changed');
  expect(getReviewRecording).not.toHaveBeenCalled();
});
