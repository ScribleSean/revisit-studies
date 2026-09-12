import {
  afterEach, beforeEach, expect, test, vi,
} from 'vitest';
import { LocalStorageEngine } from '../../../../storage/engines/LocalStorageEngine';
import { buildReviewArtifactExport, serializeReviewArtifactExport } from '../buildReviewArtifactExport';

const identity = { participantId: 'participant/one', taskId: 'task:one' };
let engine: LocalStorageEngine;
beforeEach(async () => {
  engine = new LocalStorageEngine(true);
  await engine.connect(); await engine.initializeStudyDb('artifact-export-test');
  vi.spyOn(engine, 'getReviewStudyClips').mockResolvedValue({ studyId: 'artifact-export-test', clips: [identity] });
});
afterEach(async () => { vi.restoreAllMocks(); await engine.removeSnapshotOrLive('artifact-export-test', 'artifact-export-test'); });

test('exports all nine categories and atomic metadata through real local storage without reading videos', async () => {
  const analysis = await engine.saveReviewAnalysis({
    summary: { text: 'Saved summary', pipeline: 'local', model: 'fixture' },
    events: [{ timestamp: 2, type: 'reading', evidence: 'Read' }],
    ocr: [{ timestamp: 1, text: 'Text' }],
    confusion: [{
      start: 0, end: 4, score: -1, evidence: ['Activity'],
    }],
    duration: 4,
    prompt: 'Analysis prompt',
    diagnostics: ['No audio'],
  }, identity);
  await engine.saveReviewArtifact('tags', [{ id: 'tag', timestamp: 3, label: 'Review' }], identity);
  await engine.saveReviewArtifact('embedding', { model: 'fixture', vector: [1, 2], analysisRevision: analysis.revision }, identity);
  await engine.saveReviewArtifact('prompt', { text: 'Separate stored prompt' }, identity);
  await engine.saveReviewArtifact('settings', { pipeline: 'local', confusionWords: ['help'], prompt: 'Current prompt' });
  const video = vi.spyOn(engine, 'getReviewRecording');
  const archive = await buildReviewArtifactExport(engine, new AbortController().signal, () => {});
  expect(video).not.toHaveBeenCalled();
  expect(archive.clips[0].analysis).toEqual(await engine.getReviewAnalysis(identity));
  for (const kind of ['summary', 'events', 'ocr', 'confusion', 'tags', 'embedding', 'prompt'] as const) {
    // eslint-disable-next-line no-await-in-loop
    expect(archive.clips[0].artifacts[kind]).toEqual(await engine.getReviewArtifact(kind, identity));
  }
  expect(archive.study.settings).toEqual(await engine.getReviewArtifact('settings'));
  expect(archive.study.index).toEqual(await engine.getReviewArtifact('index'));
  expect(JSON.parse(serializeReviewArtifactExport(archive))).toEqual(archive);
});

test('keeps missing categories explicit and preserves participant/task identity', async () => {
  const archive = await buildReviewArtifactExport(engine, new AbortController().signal, () => {});
  expect(archive.clips[0]).toMatchObject({ ...identity, analysis: null });
  expect(Object.values(archive.clips[0].artifacts)).toEqual(Array(7).fill(null));
  expect(archive.study).toEqual({ settings: null, index: null });
});

test('unreadable source aborts export instead of silently omitting a category', async () => {
  vi.spyOn(engine, 'getReviewArtifact').mockRejectedValue(new Error('Read denied'));
  await expect(buildReviewArtifactExport(engine, new AbortController().signal, () => {})).rejects.toThrow('Read denied');
});

test('cancellation and a study switch prevent returning mixed or partial output', async () => {
  const controller = new AbortController();
  await expect(buildReviewArtifactExport(engine, controller.signal, () => controller.abort())).rejects.toThrow();
  vi.spyOn(engine, 'getReviewStudyId').mockReturnValue('other-study');
  await expect(buildReviewArtifactExport(engine, new AbortController().signal, () => {})).rejects.toThrow('Study changed');
});
