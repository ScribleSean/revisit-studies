import {
  afterEach, beforeEach, expect, test, vi,
} from 'vitest';
import { LocalStorageEngine } from '../engines/LocalStorageEngine';
import type { ParticipantData } from '../types';

let engine: LocalStorageEngine;
const clips = [{ participantId: 'shown', taskId: 'task' }, { participantId: 'hidden', taskId: 'other-task' }];
const events = [{ type: 'reading' as const, timestamp: 1, evidence: 'Reading' }];
beforeEach(async () => {
  engine = new LocalStorageEngine(true);
  await engine.connect();
  await engine.initializeStudyDb('index-rebuild-test');
  vi.spyOn(engine, 'getAllParticipantIds').mockResolvedValue(clips.map((clip) => clip.participantId));
  await Promise.all(clips.map(async (clip) => {
    const participant = { participantId: clip.participantId, answers: { task: { identifier: clip.taskId } } } as unknown as ParticipantData;
    // @ts-expect-error Persist fixtures through the real local storage boundary.
    await engine._pushToStorage(`participants/${clip.participantId}`, 'participantData', participant);
    await engine.saveReviewArtifact('events', events, clip);
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await engine.removeSnapshotOrLive('index-rebuild-test', 'index-rebuild-test');
  await engine.removeSnapshotOrLive('index-rebuild-other', 'index-rebuild-other');
});

test('rebuilds all registered participants from legacy evidence and tags, replacing corrupt index', async () => {
  await engine.saveReviewArtifact('tags', [{ id: 'one', timestamp: 2, label: 'Review' }], clips[1]);
  // @ts-expect-error Inject a malformed derived index while preserving sources.
  await engine._pushToStorage('review/study', 'review-index', { version: 999 });
  const saved = await engine.rebuildReviewIndex();
  expect(saved.value).toHaveLength(3);
  expect(saved.value.filter((event) => event.participantId === 'hidden')).toHaveLength(2);
  expect(await engine.getReviewArtifact('index')).toEqual(saved);
});

test('failed source reads preserve the previous saved index', async () => {
  const original = await engine.getReviewArtifact('index');
  // @ts-expect-error Capture storage reads for fault injection.
  const get = engine._getFromStorage.bind(engine);
  // Fail a source read only; derived index reads remain available.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async (...args: Parameters<typeof get>) => {
    if (args[1] === 'review-tags') throw new Error('Permission denied');
    return get(...args);
  });
  await expect(engine.rebuildReviewIndex()).rejects.toThrow('Permission denied');
  read.mockRestore();
  expect(await engine.getReviewArtifact('index')).toEqual(original);
});

test('cancellation during participant discovery leaves the saved index untouched', async () => {
  const original = await engine.getReviewArtifact('index');
  const controller = new AbortController();
  vi.mocked(engine.getAllParticipantIds).mockImplementation(async () => { controller.abort(); return ['shown']; });
  await expect(engine.rebuildReviewIndex(controller.signal)).rejects.toThrow();
  expect(await engine.getReviewArtifact('index')).toEqual(original);
});

test('cancellation drains at most four admitted participant reads before returning', async () => {
  const original = await engine.getReviewArtifact('index');
  vi.mocked(engine.getAllParticipantIds).mockResolvedValue(Array.from({ length: 20 }, (_, index) => String(index)));
  let release!: (value: null) => void;
  const pending = new Promise<null>((resolve) => { release = resolve; });
  let admitted = 0;
  // @ts-expect-error Capture the real boundary for controlled reads.
  const get = engine._getFromStorage.bind(engine);
  // Hold participant reads while allowing index verification.
  const read = vi.spyOn(engine, '_getFromStorage').mockImplementation(async (...args: Parameters<typeof get>) => {
    if (args[1] === 'participantData') { admitted += 1; return pending; }
    return get(...args);
  });
  const controller = new AbortController();
  const checked = expect(engine.rebuildReviewIndex(controller.signal)).rejects.toThrow();
  await vi.waitFor(() => expect(admitted).toBe(4));
  controller.abort();
  release(null);
  await checked;
  expect(admitted).toBe(4);
  read.mockRestore();
  expect(await engine.getReviewArtifact('index')).toEqual(original);
});

test('a save overlapping rebuild remains represented by its current committed source', async () => {
  let release!: (value: string[]) => void;
  vi.mocked(engine.getAllParticipantIds).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  const rebuild = engine.rebuildReviewIndex();
  await vi.waitFor(() => expect(engine.getAllParticipantIds).toHaveBeenCalled());
  const value = {
    summary: { text: 'Updated', pipeline: 'heuristic', model: 'test' },
    events: [{ type: 'hesitation' as const, timestamp: 3, evidence: 'New source' }],
    ocr: [],
    confusion: [],
  };
  const save = engine.saveReviewAnalysis(value, clips[0]);
  await vi.waitFor(async () => expect((await engine.getReviewAnalysis(clips[0]))?.value.summary.text).toBe('Updated'));
  release(clips.map((clip) => clip.participantId));
  await Promise.all([rebuild, save]);
  const indexed = (await engine.getReviewArtifact('index'))!.value;
  expect(indexed.filter((event) => event.participantId === 'shown')).toEqual([expect.objectContaining({ evidence: 'New source', timestamp: 3 })]);
  expect(indexed.filter((event) => event.participantId === 'hidden')).toHaveLength(1);
});

test('rebuild retains the originating study when the active study changes', async () => {
  const pending = engine.rebuildReviewIndex();
  // @ts-expect-error Simulate navigation after starting a rebuild.
  engine.studyId = 'index-rebuild-other';
  const saved = await pending;
  expect(await engine.getReviewArtifact('index')).toBeNull();
  await engine.initializeStudyDb('index-rebuild-test');
  expect(await engine.getReviewArtifact('index')).toEqual(saved);
  expect(engine.getAllParticipantIds).toHaveBeenCalledWith('index-rebuild-test');
});

test('malformed participant data fails without silently dropping its indexed entries', async () => {
  const original = await engine.getReviewArtifact('index');
  // @ts-expect-error Inject corrupt source data.
  await engine._pushToStorage('participants/hidden', 'participantData', { participantId: 'wrong', answers: {} });
  await expect(engine.rebuildReviewIndex()).rejects.toThrow('Invalid participant data');
  expect(await engine.getReviewArtifact('index')).toEqual(original);
});
