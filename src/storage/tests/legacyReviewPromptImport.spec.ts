import {
  afterEach, beforeEach, expect, test, vi,
} from 'vitest';
import { LocalStorageEngine } from '../engines/LocalStorageEngine';

let engine: LocalStorageEngine;
const source = {
  prompts: [{
    id: 'old', name: 'Errors', prompt: 'Describe errors', updatedAt: '2026-04-01T12:00:00Z',
  }],
};
beforeEach(async () => {
  engine = new LocalStorageEngine(true); await engine.connect(); await engine.initializeStudyDb('prompt-import-test');
  // @ts-expect-error Seed the old fork's actual artifact shape through local storage.
  await engine._pushToStorage('', 'screenRecordingPrompts', source);
});
afterEach(async () => { vi.restoreAllMocks(); await engine.removeSnapshotOrLive('prompt-import-test', 'prompt-import-test'); await engine.removeSnapshotOrLive('prompt-import-other', 'prompt-import-other'); });

test('imports durably, retains other settings and source, and concurrent repeats are idempotent', async () => {
  await engine.saveReviewArtifact('settings', { pipeline: 'local', confusionWords: ['unsure'], prompt: 'Working prompt' });
  const results = await Promise.all([engine.importLegacyReviewPrompts(), engine.importLegacyReviewPrompts()]);
  expect(results.map((result) => result.imported).sort()).toEqual([0, 1]);
  const saved = await engine.getReviewArtifact('settings');
  expect(saved?.value).toMatchObject({
    pipeline: 'local', prompt: 'Working prompt', confusionWords: ['unsure'], promptLibrary: [{ id: 'old', text: 'Describe errors' }],
  });
  await engine.importLegacyReviewPrompts();
  expect(await engine.getReviewArtifact('settings')).toEqual(saved);
  // @ts-expect-error Verify migration never changes its source artifact.
  expect(await engine._getFromStorage('', 'screenRecordingPrompts')).toEqual(source);
});

test('conflicting current edits are reported and not overwritten', async () => {
  const current = {
    id: 'old', name: 'Errors', text: 'Current edit', updatedAt: '2026-09-09T12:00:00Z',
  };
  await engine.saveReviewArtifact('settings', { pipeline: 'heuristic', confusionWords: [], promptLibrary: [current] });
  const before = await engine.getReviewArtifact('settings');
  expect((await engine.importLegacyReviewPrompts()).conflicts).toEqual([{ id: 'old', name: 'Errors', reason: 'id' }]);
  expect(await engine.getReviewArtifact('settings')).toEqual(before);
});

test('failed import write and pre-cancel preserve target and source', async () => {
  await engine.saveReviewArtifact('settings', { pipeline: 'local', confusionWords: [] });
  const before = await engine.getReviewArtifact('settings');
  // @ts-expect-error Inject a write failure at the persistence boundary.
  const write = vi.spyOn(engine, '_pushToStorage').mockRejectedValueOnce(new Error('Disk unavailable'));
  await expect(engine.importLegacyReviewPrompts()).rejects.toThrow('Disk unavailable');
  write.mockRestore();
  expect(await engine.getReviewArtifact('settings')).toEqual(before);
  const controller = new AbortController(); controller.abort();
  await expect(engine.importLegacyReviewPrompts(controller.signal)).rejects.toThrow();
  expect(await engine.getReviewArtifact('settings')).toEqual(before);
  // @ts-expect-error Verify migration source is untouched after failed writes.
  expect(await engine._getFromStorage('', 'screenRecordingPrompts')).toEqual(source);
});

test('cancellation during source reads drains them and prevents the settings write', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // @ts-expect-error Capture the real storage method for a delayed source read.
  const get = engine._getFromStorage.bind(engine);
  // @ts-expect-error Delay only legacy reads at the persistence boundary.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async (...args: Parameters<typeof get>) => { if (args[1] === 'screenRecordingPrompts') await gate; return get(...args); });
  const pending = engine.importLegacyReviewPrompts(controller.signal);
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  controller.abort(); release();
  await expect(pending).rejects.toThrow();
  read.mockRestore();
  expect(await engine.getReviewArtifact('settings')).toBeNull();
});

test('study switching while reading cannot redirect migrated settings', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // @ts-expect-error Capture real storage to delay the source read.
  const get = engine._getFromStorage.bind(engine);
  // @ts-expect-error Delay the captured study's legacy read.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async (...args: Parameters<typeof get>) => { if (args[1] === 'screenRecordingPrompts') await gate; return get(...args); });
  const pending = engine.importLegacyReviewPrompts();
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await engine.initializeStudyDb('prompt-import-other'); release();
  expect((await pending).imported).toBe(1);
  read.mockRestore();
  expect(await engine.getReviewArtifact('settings')).toBeNull();
  await engine.initializeStudyDb('prompt-import-test');
  expect((await engine.getReviewArtifact('settings'))?.value.promptLibrary?.[0].id).toBe('old');
});
