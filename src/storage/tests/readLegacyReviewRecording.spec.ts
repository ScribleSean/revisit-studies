import {
  afterEach, beforeEach, expect, test, vi,
} from 'vitest';
import { LocalStorageEngine } from '../engines/LocalStorageEngine';

let engine: LocalStorageEngine;
const clip = { participantId: 'participant', taskId: 'task' };
beforeEach(async () => { engine = new LocalStorageEngine(true); await engine.connect(); await engine.initializeStudyDb('legacy-recording-test'); });
afterEach(async () => { vi.restoreAllMocks(); await engine.removeSnapshotOrLive('legacy-recording-test', 'legacy-recording-test'); });

test('reads actual old paths and validates a combined result without writing new artifacts', async () => {
  // @ts-expect-error Seed historical object storage formats.
  await engine._pushToStorage('screenRecordingSummary/participant', 'task', { summary: 'Historical summary', model: 'old' });
  // @ts-expect-error Seed historical OCR format.
  await engine._pushToStorage('screenRecordingOcrFrames/participant', 'task', { frames: [{ timestampSec: 2, text: 'Submit' }] });
  const result = await engine.readLegacyReviewRecording(clip);
  expect(result.analysis?.summary.text).toBe('Historical summary');
  expect(result.analysis?.ocr).toEqual([{ timestamp: 2, text: 'Submit' }]);
  expect(result.tags).toBeNull();
  expect(await engine.getReviewAnalysis(clip)).toBeNull();
});

test('read errors propagate and cancellation does not start later artifact reads', async () => {
  const controller = new AbortController();
  // @ts-expect-error Inject cancellation at the read boundary.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async () => { controller.abort(); return null; });
  await expect(engine.readLegacyReviewRecording(clip, controller.signal)).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
  read.mockRejectedValue(new Error('Permission denied'));
  await expect(engine.readLegacyReviewRecording(clip)).rejects.toThrow('Permission denied');
});

test('caller clip mutation cannot redirect later reads', async () => {
  const identity = { ...clip };
  const observed: [string, string, string?][] = [];
  // @ts-expect-error Inspect captured read identities.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async (prefix: string, type: string, studyId?: string) => { observed.push([prefix, type, studyId]); identity.participantId = 'other'; identity.taskId = 'changed'; return null; });
  expect(await engine.readLegacyReviewRecording(identity)).toEqual({ analysis: null, tags: null, embedding: null });
  expect(read).toHaveBeenCalledTimes(6);
  for (const call of observed) { expect(call[0]).toMatch(/\/participant$/); expect(call[1]).toBe('task'); expect(call[2]).toBe('legacy-recording-test'); }
});

test('durable import preserves source, indexes events, and repeated import preserves current revisions', async () => {
  const summary = { summary: 'Historical summary', model: 'old' };
  // @ts-expect-error Seed the historical storage path.
  await engine._pushToStorage('screenRecordingSummary/participant', 'task', summary);
  // @ts-expect-error Seed historical tags independently.
  await engine._pushToStorage('screenRecordingTags/participant', 'task', { tags: [{ id: 'tag', timestamp: 1, label: 'Review' }] });
  expect(await engine.importLegacyReviewRecording(clip)).toMatchObject({ imported: ['analysis', 'tags'], preserved: [], errors: [] });
  const saved = await engine.getReviewAnalysis(clip);
  expect(saved?.value.summary.text).toBe('Historical summary');
  expect((await engine.getReviewArtifact('index'))?.value).toHaveLength(1);
  expect(await engine.importLegacyReviewRecording(clip)).toMatchObject({ imported: [], preserved: ['analysis', 'tags'], errors: [] });
  expect(await engine.getReviewAnalysis(clip)).toEqual(saved);
  // @ts-expect-error Historical source remains untouched.
  expect(await engine._getFromStorage('screenRecordingSummary/participant', 'task')).toEqual(summary);
});

test('partial write failures are reported and retry only fills missing categories', async () => {
  // @ts-expect-error Seed historical summary.
  await engine._pushToStorage('screenRecordingSummary/participant', 'task', { summary: 'Summary' });
  // @ts-expect-error Seed historical tags.
  await engine._pushToStorage('screenRecordingTags/participant', 'task', [{ id: 'tag', timestamp: 1, label: 'Review' }]);
  // @ts-expect-error Capture the original write boundary.
  const push = engine._pushToStorage.bind(engine);
  // @ts-expect-error Fail only tag materialization.
  const write = vi.spyOn(engine, '_pushToStorage').mockImplementation(async (...args: Parameters<typeof push>) => { if (args[1] === 'review-tags') throw new Error('Disk failure'); return push(...args); });
  const first = await engine.importLegacyReviewRecording(clip);
  expect(first.imported).toEqual(['analysis']); expect(first.errors).toEqual(['tags: Disk failure']);
  const revision = (await engine.getReviewAnalysis(clip))?.revision;
  write.mockRestore();
  expect(await engine.importLegacyReviewRecording(clip)).toMatchObject({ imported: ['tags'], preserved: ['analysis'], errors: [] });
  expect((await engine.getReviewAnalysis(clip))?.revision).toBe(revision);
});

test('retry repairs a failed derived index even when source categories are already imported', async () => {
  // @ts-expect-error Seed historical tags.
  await engine._pushToStorage('screenRecordingTags/participant', 'task', [{ id: 'tag', timestamp: 1, label: 'Review' }]);
  // @ts-expect-error Capture writes for derived-index fault injection.
  const push = engine._pushToStorage.bind(engine);
  // @ts-expect-error Fail only index writes, preserving successful source import.
  const write = vi.spyOn(engine, '_pushToStorage').mockImplementation(async (...args: Parameters<typeof push>) => { if (args[1] === 'review-index') throw new Error('Index unavailable'); return push(...args); });
  const first = await engine.importLegacyReviewRecording(clip);
  expect(first.imported).toEqual(['tags']); expect(first.errors.join(' ')).toContain('Index unavailable');
  write.mockRestore();
  expect((await engine.importLegacyReviewRecording(clip)).errors).toEqual([]);
  expect((await engine.getReviewArtifact('index'))?.value).toHaveLength(1);
});
