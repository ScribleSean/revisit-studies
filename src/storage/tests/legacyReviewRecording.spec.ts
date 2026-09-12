import { expect, test } from 'vitest';
import { convertLegacyRecording } from '../legacyReviewRecording';

test('converts old wrapper fields without inventing duration or score evidence', () => {
  const converted = convertLegacyRecording({
    summary: { summary: 'Observed behavior', model: 'old-model', prompt: 'Describe errors' },
    events: { events: [{ type: 'reading', timestamp: '2.5', evidence: 'Pause' }] },
    ocr: {
      frames: [{
        index: 0, timestampSec: '1', text: 'Submit', wordCount: 1,
      }],
    },
    confusion: { windows: [{ startSec: '0', endSec: '30', score: '-1.5' }], totalScore: -1.5 },
  });
  expect(converted.analysis).toEqual({
    summary: { text: 'Observed behavior', model: 'old-model', pipeline: 'legacy' },
    prompt: 'Describe errors',
    events: [{ type: 'reading', timestamp: 2.5, evidence: 'Pause' }],
    ocr: [{ timestamp: 1, text: 'Submit' }],
    confusion: [{
      start: 0, end: 30, score: -1.5, evidence: [],
    }],
  });
  expect(converted.analysis?.duration).toBeUndefined();
});

test('preserves plain summaries, summary aliases and independently saved tags', () => {
  for (const summary of ['Plain summary', { analysis: 'Plain summary' }, { text: 'Plain summary' }]) expect(convertLegacyRecording({ summary }).analysis?.summary.text).toBe('Plain summary');
  const result = convertLegacyRecording({
    tags: {
      tags: [{
        id: 'tag', timestamp: '3', label: 'Review', color: 'purple', createdBy: 'Analyst',
      }],
    },
  });
  expect(result.analysis).toBeNull();
  expect(result.tags?.[0]).toMatchObject({ timestamp: 3, color: 'purple', createdBy: 'Analyst' });
  expect(convertLegacyRecording({})).toEqual({ analysis: null, tags: null, embedding: null });
});

test('embedding is copied without claiming freshness against current analysis', () => {
  const raw = { model: 'old-model', embedding: [1, 2] };
  const result = convertLegacyRecording({ embedding: raw });
  expect(result.embedding).toEqual({ model: 'old-model', vector: [1, 2] });
  result.embedding!.vector[0] = 99; expect(raw.embedding).toEqual([1, 2]);
});

test('malformed rows reject the recording instead of silently dropping evidence', () => {
  for (const source of [
    { summary: {} }, { events: { events: [{ type: 'unknown', timestamp: 1 }] } },
    { ocr: { frames: [{ timestampSec: null, text: 'Text' }] } },
    { confusion: { windows: [{ startSec: 4, endSec: 2, score: 1 }] } },
    { tags: [null] }, { embedding: { model: 'model', embedding: [0, 0] } },
  ]) expect(() => convertLegacyRecording(source)).toThrow();
});
