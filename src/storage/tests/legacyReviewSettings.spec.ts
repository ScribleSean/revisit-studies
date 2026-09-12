import {
  afterEach, beforeEach, expect, test, vi,
} from 'vitest';
import { legacyReviewPipeline } from '../legacyReviewSettings';
import { LocalStorageEngine } from '../engines/LocalStorageEngine';

let engine: LocalStorageEngine;
beforeEach(async () => {
  engine = new LocalStorageEngine(true); await engine.connect(); await engine.initializeStudyDb('settings-import-test');
});
afterEach(async () => { vi.restoreAllMocks(); await engine.removeSnapshotOrLive('settings-import-test', 'settings-import-test'); });

test.each([false, true])('a delayed import captures its study and respects cancellation: %s', async (cancel) => {
  // @ts-expect-error Seed the old storage shape.
  await engine._pushToStorage('', 'screenRecordingAnalysisSettings', { useLocalModel: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // @ts-expect-error Capture storage reads to delay only the source.
  const get = engine._getFromStorage.bind(engine);
  // Inject a controlled in-flight read.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async (...args: Parameters<typeof get>) => { if (args[1] === 'screenRecordingAnalysisSettings') await gate; return get(...args); });
  const controller = new AbortController();
  const pending = engine.importLegacyReviewSettings(controller.signal);
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await engine.initializeStudyDb('settings-import-other');
  if (cancel) controller.abort();
  release();
  if (cancel) await expect(pending).rejects.toThrow();
  else expect(await pending).toEqual({ pipeline: 'local', changed: true });
  read.mockRestore();
  expect(await engine.getReviewArtifact('settings')).toBeNull();
  await engine.removeSnapshotOrLive('settings-import-other', 'settings-import-other');
  await engine.initializeStudyDb('settings-import-test');
  expect((await engine.getReviewArtifact('settings'))?.value.pipeline ?? null).toBe(cancel ? null : 'local');
});

test('reads both historical formats and rejects unknown or malformed preferences', () => {
  expect(legacyReviewPipeline({ useLocalModel: true })).toBe('local');
  expect(legacyReviewPipeline({ useLocalModel: false })).toBe('gemini');
  expect(legacyReviewPipeline({ summarizationPipeline: 'gpt4o', useLocalModel: true })).toBe('gpt4o');
  expect(legacyReviewPipeline(null)).toBeNull();
  for (const raw of [{}, [], 'gemini', { useLocalModel: 'false' }, { summarizationPipeline: 'retired' }]) expect(() => legacyReviewPipeline(raw)).toThrow();
});

test('changes only pipeline, preserves original source and concurrent prompt imports, and repeats without writing', async () => {
  // @ts-expect-error Seed the historical root artifact.
  await engine._pushToStorage('', 'screenRecordingAnalysisSettings', { useLocalModel: true });
  const source = {
    prompts: [{
      id: 'one', name: 'Observe', prompt: 'Look carefully', updatedAt: '2026-04-01T00:00:00Z',
    }],
  };
  // @ts-expect-error Seed the historical root prompt artifact.
  await engine._pushToStorage('', 'screenRecordingPrompts', source);
  await engine.saveReviewArtifact('settings', { pipeline: 'heuristic', confusionWords: ['unsure'], prompt: 'Current prompt' });
  await Promise.all([engine.importLegacyReviewSettings(), engine.importLegacyReviewPrompts()]);
  const saved = await engine.getReviewArtifact('settings');
  expect(saved?.value).toMatchObject({
    pipeline: 'local', confusionWords: ['unsure'], prompt: 'Current prompt', promptLibrary: [{ id: 'one' }],
  });
  expect(await engine.importLegacyReviewSettings()).toEqual({ pipeline: 'local', changed: false });
  expect(await engine.getReviewArtifact('settings')).toEqual(saved);
  // @ts-expect-error Verify source preservation.
  expect(await engine._getFromStorage('', 'screenRecordingAnalysisSettings')).toEqual({ useLocalModel: true });
});

test('missing settings do not invent a provider or create an artifact', async () => {
  expect(await engine.importLegacyReviewSettings()).toEqual({ pipeline: null, changed: false });
  expect(await engine.getReviewArtifact('settings')).toBeNull();
});

test('write failure and cancellation preserve current preferences', async () => {
  // @ts-expect-error Seed the historical root artifact.
  await engine._pushToStorage('', 'screenRecordingAnalysisSettings', { summarizationPipeline: 'gemini' });
  await engine.saveReviewArtifact('settings', { pipeline: 'heuristic', confusionWords: [] });
  const before = await engine.getReviewArtifact('settings');
  // Inject failure at the write boundary.
  vi.spyOn(engine, '_pushToStorage').mockRejectedValueOnce(new Error('Disk unavailable'));
  await expect(engine.importLegacyReviewSettings()).rejects.toThrow('Disk unavailable');
  expect(await engine.getReviewArtifact('settings')).toEqual(before);
  const controller = new AbortController(); controller.abort();
  await expect(engine.importLegacyReviewSettings(controller.signal)).rejects.toThrow();
  expect(await engine.getReviewArtifact('settings')).toEqual(before);
});
