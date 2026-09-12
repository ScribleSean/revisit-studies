import {
  afterEach, expect, test, vi,
} from 'vitest';
import { analyzeRecording, getReviewHealth } from '../reviewApi';

afterEach(() => vi.unstubAllGlobals());
const settings = { pipeline: 'heuristic' as const, confusionWords: ['not sure'] };
const { signal } = new AbortController();
const text = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob);
});
const valid = {
  result: {
    events: [{ type: 'reading', timestamp: 1, evidence: 'pause' }], summary: { text: 'One event', pipeline: 'heuristic', model: 'fixture' }, ocr: [], confusion: [], meta: { duration: 2 },
  },
};

test('rejects incomplete or out-of-bounds OCR and score results before storage', async () => {
  for (const change of [{ ocr: undefined }, { ocr: [{ timestamp: 2, text: 'past end' }] }, {
    confusion: [{
      start: 0, end: 3, score: 2, evidence: [],
    }],
  }]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { ...valid.result, ...change } }))));
    // eslint-disable-next-line no-await-in-loop
    await expect(analyzeRecording(new Blob(), settings, signal)).rejects.toThrow();
  }
});

test('rejects events outside the recording before they can be saved', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { ...valid.result, meta: { duration: 0.5 } } }))));
  await expect(analyzeRecording(new Blob(), settings, signal)).rejects.toThrow('timestamps');
});

test('sends binary recording and cancellation signal', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(valid)));
  vi.stubGlobal('fetch', fetch);
  const blob = new Blob(['fixture'], { type: 'video/webm' });
  expect(await analyzeRecording(blob, settings, signal)).toEqual(valid.result);
  expect(fetch).toHaveBeenCalledWith('/api/review/analyze?pipeline=heuristic', expect.objectContaining({ signal }));
  const request = fetch.mock.calls[0][1]; const length = Number(request.headers['x-review-metadata-length']);
  expect(JSON.parse(await text(request.body.slice(0, length)))).toEqual({ prompt: '', confusionWords: 'not sure' });
  expect(await text(request.body.slice(length))).toBe('fixture');
});

test('surfaces service errors and rejects malformed capabilities', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Local model unavailable' }), { status: 503 })).mockResolvedValueOnce(new Response('{"pipelines":[{}]}')));
  await expect(analyzeRecording(new Blob(), settings, signal)).rejects.toThrow('Local model unavailable');
  await expect(getReviewHealth(signal)).rejects.toThrow('capabilities');
});

test('preserves prompt punctuation, newlines and unicode in the analysis request', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(valid)));
  vi.stubGlobal('fetch', fetch);
  const prompt = 'Focus on A&B?\nDescribe café errors.';
  await analyzeRecording(new Blob(), { ...settings, prompt }, signal);
  const request = fetch.mock.calls[0][1]; const length = Number(request.headers['x-review-metadata-length']);
  expect(JSON.parse(await text(request.body.slice(0, length))).prompt).toBe(prompt);
  expect(fetch.mock.calls[0][0]).not.toContain('prompt=');
});
