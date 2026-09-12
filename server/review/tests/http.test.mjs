import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { request } from 'node:http';
import { createAnalysisCache } from '../cache.mjs';
import { createReviewServer } from '../http.mjs';

async function fixture(t, analyzers, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-'));
  const server = createReviewServer({ analyzers, cache: createAnalysisCache(path.join(directory, 'cache')), uploadRoot: directory, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Windows can briefly retain a directory handle while the aborted request's cleanup finishes.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, directory };
}

const upload = (base, body = 'video', query = '', headers = {}) => fetch(`${base}/api/review/analyze${query}`, { method: 'POST', body, headers: { 'content-type': 'video/webm', ...headers } });

test('video MIME reaches cloud analyzers and separates incompatible cached requests', async (t) => {
  const types = [];
  const { base } = await fixture(t, { gemini: async ({ mimeType }) => { types.push(mimeType); return { meta: {}, summary: { text: mimeType } }; } });
  for (const [mimeType, cached] of [['video/webm', false], ['video/webm;codecs=vp8', true], ['video/mp4', false]]) {
    const response = await upload(base, 'same-bytes', '?pipeline=gemini', { 'content-type': mimeType });
    assert.equal(response.status, 200); assert.equal((await response.json()).cached, cached);
  }
  assert.deepEqual(types, ['video/webm', 'video/mp4']);
});

test('full-length Unicode prompt uses body metadata without changing video or cache identity', async (t) => {
  const prompts = []; const video = Buffer.from([0, 255, 10, 20]);
  const { base } = await fixture(t, { local: async ({ filename, prompt }) => {
    assert.deepEqual(await readFile(filename), video); prompts.push(prompt); return { meta: {}, summary: { text: prompt } };
  } }, { maxBytes: video.length });
  const prompt = '画'.repeat(8000);
  const prefix = Buffer.from(JSON.stringify({ prompt, confusionWords: '' }));
  for (let index = 0; index < 2; index += 1) {
    const response = await upload(base, Buffer.concat([prefix, video]), '?pipeline=local', { 'x-review-metadata-length': String(prefix.length) });
    assert.equal(response.status, 200);
    const data = await response.json(); assert.equal(data.result.summary.text, prompt); assert.equal(data.cached, index === 1);
  }
  assert.deepEqual(prompts, [prompt]);
  const invalid = await upload(base, '{}', '?pipeline=local', { 'x-review-metadata-length': '2' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_OPTIONS');
});

test('analysis cache separates researcher prompts and forwards exact text', async (t) => {
  const prompts = [];
  const { base } = await fixture(t, { local: async ({ prompt }) => { prompts.push(prompt); return { meta: {}, summary: { text: prompt } }; } });
  const first = 'A&B?\nCafé'; const second = 'Other prompt';
  for (const prompt of [first, first, second]) {
    const response = await upload(base, 'same-video', `?${new URLSearchParams({ pipeline: 'local', prompt })}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.summary.text, prompt);
  }
  assert.deepEqual(prompts, [first, second]);
  const prefix = Buffer.from(JSON.stringify({ prompt: first, confusionWords: '' }));
  const equivalent = await upload(base, Buffer.concat([prefix, Buffer.from('same-video')]), '?pipeline=local', { 'x-review-metadata-length': String(prefix.length) });
  assert.equal((await equivalent.json()).cached, true);
  assert.deepEqual(prompts, [first, second]);
});

test('embedding batches are bounded, cached and isolated by model version', async (t) => {
  let calls = 0;
  const embedder = async (texts) => { calls += 1; return texts.map(() => ({ model: 'fixture', vector: [1, 0] })); };
  embedder.version = 'fixture-v1';
  const { base } = await fixture(t, {}, { embedder });
  const embed = (body) => fetch(`${base}/api/review/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await (await embed({ texts: ['submit button'] })).json()).cached, false);
  assert.equal((await (await embed({ texts: ['submit button'] })).json()).cached, true);
  embedder.version = 'fixture-v2';
  assert.equal((await (await embed({ texts: ['submit button'] })).json()).cached, false);
  assert.equal(calls, 2);
  for (const texts of [[], [''], ['x'.repeat(8001)], Array(33).fill('a'), [12]]) {
    assert.equal((await embed({ texts })).status, 400);
  }
  assert.equal((await embed(null)).status, 400);
  assert.equal((await embed({ texts: ['x'.repeat(1100000)] })).status, 413);
  assert.equal((await (await fetch(`${base}/api/review/health`)).json()).embeddings, true);
});

test('retries degraded results after dependency recovery and caches successful silent recordings', async (t) => {
  let calls = 0;
  const { base } = await fixture(t, { heuristic: async () => {
    calls += 1;
    return calls === 1 ? { meta: { audio_skipped: true, audio_skip_reason: 'Model unavailable' } } : { meta: { audio_skipped: true, audio_skip_reason: 'no_audio_stream' } };
  } });
  assert.equal((await (await upload(base)).json()).cached, false);
  assert.equal((await (await upload(base)).json()).cached, false);
  assert.equal((await (await upload(base)).json()).cached, true);
  assert.equal(calls, 2);
});

test('ignores legacy cached results with failed scene or OCR analysis', async (t) => {
  let calls = 0;
  let saved;
  const { base } = await fixture(t, { heuristic: async () => { calls += 1; return { meta: {} }; } }, {
    cache: { get: async () => ({ meta: { scene_error: 'Decoder failed', ocr_error: 'Tesseract unavailable' } }), set: async (_, value) => { saved = value; } },
  });
  assert.equal((await (await upload(base)).json()).cached, false);
  assert.equal(calls, 1);
  assert.deepEqual(saved, { meta: {} });
});

test('caches exact digital silence but retries silent clips with failed visual extraction', async (t) => {
  for (const diagnostic of [{}, { scene_error: 'Decoder failed' }, { ocr_error: 'OCR failed' }]) {
    let calls = 0;
    const { base } = await fixture(t, { heuristic: async () => {
      calls += 1;
      return { meta: { audio_skipped: true, audio_skip_reason: 'digital_silence', ...diagnostic } };
    } });
    assert.equal((await (await upload(base)).json()).cached, false);
    const shouldCache = Object.keys(diagnostic).length === 0;
    assert.equal((await (await upload(base)).json()).cached, shouldCache);
    assert.equal(calls, shouldCache ? 1 : 2);
  }
});

test('uploads to a file, caches by settings, and cleans temporary data', async (t) => {
  let calls = 0;
  const { base, directory } = await fixture(t, { heuristic: async ({ filename }) => { calls += 1; return { text: await readFile(filename, 'utf8') }; } });
  const first = await (await upload(base)).json();
  assert.equal(first.cached, false);
  assert.deepEqual(first.result, { text: 'video' });
  assert.equal((await (await upload(base)).json()).cached, true);
  await upload(base, 'video', '?confusionWords=unsure');
  assert.equal(calls, 2);
  // Wait for the response's cleanup by waiting until its active count is zero.
  for (let i = 0; i < 20; i += 1) {
    if (!(await (await fetch(`${base}/api/review/health`)).json()).active) break;
  }
  assert.deepEqual(await readdir(directory), ['cache']);
});

test('rejects unavailable pipelines, untrusted origins, and invalid uploads', async (t) => {
  const { base } = await fixture(t, { heuristic: async () => ({}) }, { maxBytes: 5 });
  assert.equal((await upload(base, 'v', '?pipeline=local')).status, 503);
  assert.equal((await upload(base, 'v', '?pipeline=unknown')).status, 400);
  assert.equal((await upload(base, 'v', '', { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await upload(base, '123456')).status, 413);
  assert.equal((await upload(base, '')).status, 400);
  assert.equal((await upload(base, 'v', '', { 'content-type': 'text/plain' })).status, 415);
});

test('rejects excess concurrent jobs and aborts timed-out work', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { base } = await fixture(t, { heuristic: ({ signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }, { maxConcurrent: 1, timeoutMs: 250 });
  const first = upload(base);
  await ready;
  assert.equal((await upload(base)).status, 429);
  assert.equal((await first).status, 504);
});

test('a stalled upload releases its analysis slot', { timeout: 5000 }, async (t) => {
  const { base } = await fixture(t, { heuristic: async () => ({}) }, { timeoutMs: 100 });
  await new Promise((resolve) => {
    const pending = request(`${base}/api/review/analyze`, { method: 'POST', headers: { 'content-type': 'video/webm', 'content-length': '100' } });
    pending.on('error', resolve);
    pending.on('close', resolve);
    pending.write('incomplete');
  });
  for (let i = 0; i < 20; i += 1) {
    const health = await (await fetch(`${base}/api/review/health`)).json();
    if (!health.active) return;
  }
  assert.fail('Stalled upload retained an analysis slot');
});
