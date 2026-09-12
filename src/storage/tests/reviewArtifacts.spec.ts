import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import { LocalStorageEngine } from '../engines/LocalStorageEngine';
import {
  parseReviewAnalysis, parseReviewArtifact, reviewArtifactPrefix, validateReviewValue, type ReviewArtifacts,
} from '../reviewArtifacts';
import testConfig from './testConfigSimple.json';
import type { StudyConfig } from '../../parser/types';
import { generateSequenceArray } from '../../utils/handleRandomSequences';

const clip = { participantId: 'p::/one', taskId: 'task::/two' };
test('prompt validation accepts old artifacts but rejects invalid new prompt values', () => {
  const settings = { pipeline: 'local', confusionWords: [] };
  expect(() => validateReviewValue('settings', settings)).not.toThrow();
  const analysis = {
    version: 1,
    revision: 'revision',
    updatedAt: '2026-09-09',
    value: {
      summary: { text: '', pipeline: 'local', model: 'test' }, events: [], ocr: [], confusion: [],
    },
  };
  expect(parseReviewAnalysis(analysis)).toEqual(analysis);
  for (const diagnostics of [null, [42], Array(9).fill('warning'), ['x'.repeat(2001)]]) {
    expect(() => parseReviewAnalysis({ ...analysis, value: { ...analysis.value, diagnostics } })).toThrow('diagnostics');
  }
  for (const prompt of [null, 42, 'x'.repeat(8001)]) {
    expect(() => validateReviewValue('settings', { ...settings, prompt })).toThrow();
    expect(() => parseReviewAnalysis({ ...analysis, value: { ...analysis.value, prompt } })).toThrow();
  }
  expect(() => validateReviewValue('settings', { ...settings, prompt: 'x'.repeat(8000) })).not.toThrow();
});
const samples: ReviewArtifacts = {
  summary: { text: 'A participant inspected a chart.', pipeline: 'heuristic', model: 'rules-v1' },
  events: [{ type: 'hesitation', timestamp: 2, evidence: 'Silence for 3 seconds' }],
  tags: [{ id: 'tag-1', timestamp: 2, label: 'Verify hesitation' }],
  ocr: [{ timestamp: 2, text: 'Chart title' }],
  confusion: [{
    start: 0, end: 30, score: 0.2, evidence: ['Silence'],
  }],
  embedding: { model: 'fixture', vector: [0.1, 0.2] },
  prompt: { text: 'Describe observable behavior.' },
  index: [{
    ...clip, type: 'hesitation', timestamp: 2, source: 'auto',
  }],
  settings: {
    pipeline: 'heuristic',
    confusionWords: ['unsure'],
    promptLibrary: [{
      id: 'saved-prompt', name: 'Errors', text: 'Describe errors', updatedAt: '2026-09-09T12:00:00Z',
    }],
  },
};
const analysisValue = {
  summary: samples.summary, events: samples.events, ocr: samples.ocr, confusion: samples.confusion, diagnostics: ['OCR unavailable during this run'],
};

describe('versioned review storage', () => {
  let engine: LocalStorageEngine;
  test('retains measured duration and rejects out-of-range evidence without replacing a saved analysis', async () => {
    const first = await engine.saveReviewAnalysis({ ...analysisValue, duration: 30 }, clip);
    expect((await engine.getReviewAnalysis(clip))?.value.duration).toBe(30);
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(engine.saveReviewAnalysis({ ...analysisValue, duration }, clip)).rejects.toThrow();
    }
    expect(await engine.getReviewAnalysis(clip)).toEqual(first);
    await expect(engine.saveReviewAnalysis({ ...analysisValue, duration: 30, ocr: [{ timestamp: 30, text: 'At EOF' }] }, clip)).rejects.toThrow('exceeds recording duration');
    // Existing bundles without duration remain valid.
    expect((await engine.saveReviewAnalysis(analysisValue, clip)).value.duration).toBeUndefined();
  });
  test('concurrent clip and tag saves preserve every source in the durable index', async () => {
    const other = { participantId: 'p', taskId: 'other' };
    await Promise.all([
      engine.saveReviewAnalysis(analysisValue, clip),
      engine.saveReviewAnalysis(analysisValue, other),
      engine.saveReviewArtifact('tags', samples.tags, clip),
    ]);
    const index = (await engine.getReviewArtifact('index'))!.value;
    expect(index).toHaveLength(3);
    expect(index.filter((event) => event.source === 'auto')).toHaveLength(2);
    expect(index.find((event) => event.source === 'tag')).toMatchObject({ ...clip, evidence: 'Verify hesitation' });
    await engine.saveReviewAnalysis({ ...analysisValue, events: [] }, clip);
    const replaced = (await engine.getReviewArtifact('index'))!.value;
    expect(replaced).toHaveLength(2);
    expect(replaced.some((event) => event.participantId === other.participantId && event.taskId === other.taskId)).toBe(true);
    await engine.deleteReviewArtifact('tags', clip);
    expect((await engine.getReviewArtifact('index'))!.value).toEqual([expect.objectContaining({ ...other, source: 'auto' })]);
  });

  test('index failure reports a warning while retaining the committed analysis', async () => {
    // @ts-expect-error Preserve the real storage boundary for fault injection.
    const push = engine._pushToStorage.bind(engine);
    // Fail only the derived index, after source commit succeeds.
    const upload = vi.spyOn(engine, '_pushToStorage').mockImplementation(async (...args: Parameters<typeof push>) => {
      if (args[1] === 'review-index') throw new Error('Index upload failed');
      return push(...args);
    });
    const saved = await engine.saveReviewAnalysis(analysisValue, clip);
    expect(saved.indexWarning).toContain('Recording data saved; study index update failed');
    expect((await engine.getReviewAnalysis(clip))?.revision).toBe(saved.revision);
    upload.mockRestore();
    expect((await engine.saveReviewAnalysis(analysisValue, clip)).indexWarning).toBeUndefined();
    expect((await engine.getReviewArtifact('index'))?.value).toHaveLength(1);
  });

  test('overlapping revisions index the final committed source without duplicate events', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => engine.saveReviewAnalysis({
      ...analysisValue, events: [{ type: 'reading', timestamp: index, evidence: String(index) }],
    }, clip)));
    const current = (await engine.getReviewAnalysis(clip))!;
    expect((await engine.getReviewArtifact('index'))?.value).toEqual(current.value.events.map((event) => ({ ...event, ...clip, source: 'auto' })));
  });

  test('index maintenance retains the originating study and clip identity', async () => {
    const identity = { ...clip };
    const pending = engine.saveReviewAnalysis(analysisValue, identity);
    identity.taskId = 'changed';
    // @ts-expect-error Simulate switching study after starting a save.
    engine.studyId = 'review-other';
    await pending;
    expect(await engine.getReviewArtifact('index')).toBeNull();
    await engine.initializeStudyDb('review-test');
    expect((await engine.getReviewArtifact('index'))?.value).toEqual([expect.objectContaining(clip)]);
  });
  test('atomic analysis save failure preserves the complete previous result', async () => {
    const first = await engine.saveReviewAnalysis(analysisValue, clip);
    // Inject a failed storage write at the commit boundary.
    vi.spyOn(engine, '_pushToStorage').mockRejectedValueOnce(new Error('Upload interrupted'));
    await expect(engine.saveReviewAnalysis({ ...analysisValue, summary: { ...samples.summary, text: 'New' }, events: [] }, clip)).rejects.toThrow('Upload interrupted');
    expect(await engine.getReviewAnalysis(clip)).toEqual(first);
    expect((await engine.getReviewArtifact('events', clip))?.value).toEqual(samples.events);
    await expect(engine.saveReviewArtifact('events', [], clip)).rejects.toThrow('saveReviewAnalysis');
  });

  test('legacy artifacts load together and a new analysis changes revision', async () => {
    await engine.saveReviewArtifact('summary', samples.summary, clip);
    await engine.saveReviewArtifact('events', samples.events, clip);
    const legacy = await engine.getReviewAnalysis(clip);
    expect(legacy?.revision).toMatch(/^legacy:/);
    expect(legacy?.value.events).toEqual(samples.events);
    const current = await engine.saveReviewAnalysis(analysisValue, clip);
    expect(current.revision).not.toEqual(legacy?.revision);
    await engine.saveReviewArtifact('embedding', { ...samples.embedding, analysisRevision: current.revision }, clip);
    const next = await engine.saveReviewAnalysis({ ...analysisValue, events: [] }, clip);
    expect(next.revision).not.toBe(current.revision);
    expect((await engine.getReviewArtifact('embedding', clip))?.value.analysisRevision).not.toBe(next.revision);
    expect((await engine.getReviewArtifact('events', clip))?.value).toEqual([]);
  });

  test('atomic analysis captures its originating study and caller data before yielding', async () => {
    const value = structuredClone(analysisValue);
    const pending = engine.saveReviewAnalysis(value, clip);
    value.events.length = 0;
    // @ts-expect-error Simulate a study switch while saving.
    engine.studyId = 'review-other';
    await pending;
    expect(await engine.getReviewAnalysis(clip)).toBeNull();
    await engine.initializeStudyDb('review-test');
    expect((await engine.getReviewAnalysis(clip))?.value.events).toEqual(samples.events);
  });
  test('rejects sparse arrays and coercible pipeline values before serialization', () => {
    expect(() => validateReviewValue('events', Array(1))).toThrow();
    expect(() => validateReviewValue('settings', { pipeline: 'heuristic', confusionWords: Array(1) })).toThrow();
    const sparseVector = Array(3); sparseVector[0] = 1;
    expect(() => validateReviewValue('embedding', { model: 'test', vector: sparseVector })).toThrow();
    expect(() => validateReviewValue('settings', { pipeline: ['heuristic'], confusionWords: [] })).toThrow();
  });

  beforeEach(async () => {
    engine = new LocalStorageEngine(true);
    await engine.connect();
    await engine.initializeStudyDb('review-test');
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await engine.removeSnapshotOrLive('review-test', 'review-test');
    await engine.removeSnapshotOrLive('review-other', 'review-other');
    await engine.removeSnapshotOrLive('review-copy', 'review-copy');
  });

  test('recording downloads forward cancellation and release temporary URLs on failure', async () => {
    // Isolate the adapter URL primitive from the shared download contract.
    vi.spyOn(engine, '_getScreenRecordingUrl').mockResolvedValue('blob:review-download');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { revokeObjectURL: revoke });
    const fetchRecording = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', fetchRecording);
    const controller = new AbortController();
    await expect(engine.getReviewRecording(clip, controller.signal)).rejects.toThrow('HTTP 403');
    expect(fetchRecording).toHaveBeenCalledWith('blob:review-download', { signal: controller.signal });
    expect(revoke).toHaveBeenCalledWith('blob:review-download');
    fetchRecording.mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    await expect(engine.getReviewRecording(clip, controller.signal)).rejects.toThrow('Cancelled');
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  test('round-trips all nine categories through a fresh storage instance', async () => {
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      await engine.saveReviewArtifact(kind, samples[kind], kind === 'settings' || kind === 'index' ? undefined : clip);
    }
    const reader = new LocalStorageEngine(true);
    await reader.connect();
    await reader.initializeStudyDb('review-test');
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      const data = await reader.getReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip);
      expect(data?.version).toBe(1);
      expect(data?.value).toEqual(samples[kind]);
    }
  });

  test('preserves raw weighted confusion scores without probability clamping', async () => {
    const windows = [{
      start: 0, end: 30, score: 4.5, evidence: ['Weighted events'],
    }, {
      start: 30, end: 40, score: -0.5, evidence: ['Active interaction'],
    }];
    await engine.saveReviewArtifact('confusion', windows, clip);
    expect((await engine.getReviewArtifact('confusion', clip))?.value).toEqual(windows);
    expect(() => validateReviewValue('confusion', [{ ...windows[0], score: Infinity }])).toThrow();
  });

  test('isolates studies and encoded clip identities', async () => {
    await engine.saveReviewArtifact('events', samples.events, clip);
    expect(await engine.getReviewArtifact('events', { participantId: 'p', taskId: '::/one::task::/two' })).toBeNull();
    await engine.initializeStudyDb('review-other');
    expect(await engine.getReviewArtifact('events', clip)).toBeNull();
  });

  test('in-flight saves retain their original study and payload', async () => {
    const pendingValue = [{ type: 'reading' as const, timestamp: 1, evidence: 'original' }];
    const pending = engine.saveReviewArtifact('events', pendingValue, clip);
    pendingValue[0].evidence = 'mutated';
    // Switch while save is suspended at its first verification await.
    // @ts-expect-error Control the state transition without adding unrelated async setup.
    engine.studyId = 'review-other';
    await pending;
    expect(await engine.getReviewArtifact('events', clip)).toBeNull();
    await engine.initializeStudyDb('review-test');
    expect((await engine.getReviewArtifact('events', clip))?.value[0].evidence).toBe('original');
  });

  test('copy and deletion preserve all artifact categories without touching live data', async () => {
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      await engine.saveReviewArtifact(kind, samples[kind], kind === 'settings' || kind === 'index' ? undefined : clip);
    }
    // @ts-expect-error Exercise the real local snapshot copy primitive.
    await engine._copyDirectory('dev-review-test/', 'dev-review-copy/');
    await engine.initializeStudyDb('review-copy');
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await engine.getReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip))?.value).toEqual(samples[kind]);
    }
    await engine.removeSnapshotOrLive('review-copy', 'review-copy');
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await engine.getReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip)).toBeNull();
    }
    await engine.initializeStudyDb('review-test');
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await engine.getReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip))?.value).toEqual(samples[kind]);
    }
  });

  test('empty event lists overwrite prior events and delete returns to missing', async () => {
    await engine.saveReviewArtifact('events', samples.events, clip);
    await engine.saveReviewArtifact('events', [], clip);
    expect((await engine.getReviewArtifact('events', clip))?.value).toEqual([]);
    await engine.deleteReviewArtifact('events', clip);
    expect(await engine.getReviewArtifact('events', clip)).toBeNull();
  });

  test('public snapshot restore recovers all nine categories and atomic metadata after edits and deletion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    const config = testConfig as StudyConfig;
    await engine.setSequenceArray(await generateSequenceArray(config));
    await engine.initializeParticipantSession({}, config, {
      userAgent: 'test', resolution: { width: 1000, height: 800 }, language: 'en', ip: '',
    });
    await engine.flushPendingParticipantData();
    const original = await engine.saveReviewAnalysis(analysisValue, clip);
    for (const kind of ['tags', 'embedding', 'prompt', 'settings'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await engine.saveReviewArtifact(kind, samples[kind], kind === 'settings' ? undefined : clip);
    }
    const originals = new Map<keyof ReviewArtifacts, unknown>();
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      originals.set(kind, await engine.getReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip));
    }
    expect((await engine.createSnapshot('review-test', false)).status).toBe('SUCCESS');
    const [snapshot] = Object.keys(await engine.getSnapshots('review-test'));
    await engine.saveReviewAnalysis({
      ...analysisValue, events: [], ocr: [], confusion: [], diagnostics: [], summary: { ...samples.summary, text: 'Changed' },
    }, clip);
    for (const kind of ['tags', 'embedding', 'prompt', 'settings', 'index'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await engine.deleteReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip);
    }
    vi.setSystemTime(new Date('2026-09-09T12:00:05Z'));
    expect((await engine.restoreSnapshot('review-test', snapshot)).status).toBe('SUCCESS');
    expect(await engine.getReviewAnalysis(clip)).toEqual(original);
    for (const kind of Object.keys(samples) as (keyof ReviewArtifacts)[]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await engine.getReviewArtifact(kind, kind === 'settings' || kind === 'index' ? undefined : clip)).toEqual(originals.get(kind));
    }
    for (const name of Object.keys(await engine.getSnapshots('review-test'))) {
      // eslint-disable-next-line no-await-in-loop
      await engine.removeSnapshotOrLive(name, 'review-test');
    }
  });

  test('rejects invalid data and scope before storage', async () => {
    await expect(engine.saveReviewArtifact('events', [{ type: 'reading', timestamp: -1, evidence: '' }], clip)).rejects.toThrow('Invalid');
    await expect(engine.saveReviewArtifact('embedding', { model: 'test', vector: [0, 0] }, clip)).rejects.toThrow('Invalid');
    expect(() => reviewArtifactPrefix('events')).toThrow('requires');
    expect(() => reviewArtifactPrefix('settings', clip)).toThrow('cannot');
    expect(() => parseReviewArtifact('events', {})).toThrow('unsupported');
    expect(() => parseReviewArtifact('events', { version: 2, updatedAt: new Date().toISOString(), value: [] })).toThrow('unsupported');
  });
});
