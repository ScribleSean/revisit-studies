import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createGeminiVideoClient, createGeminiAnalyzer } from '../gemini.mjs';
import { createCleanupJournal } from '../cleanupJournal.mjs';

const origin = 'https://generativelanguage.googleapis.com';
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-gemini-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filename = path.join(directory, 'video');
  const video = Buffer.from([0, 255, 10, 42, 128]); await writeFile(filename, video);
  const calls = []; let name; let bytes;
  const fetcher = async (raw, options) => {
    const url = new URL(raw); calls.push({ url, ...options });
    assert.equal(url.origin, origin); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-goog-api-key'], 'fixture');
    if (options.method === 'DELETE') return overrides.remove ? overrides.remove(url, options) : Response.json({});
    if (options.headers['X-Goog-Upload-Command'] === 'start') {
      name = JSON.parse(options.body).file.name;
      assert.match(name, /^files\/review-[a-f0-9]{32}$/);
      return new Response('', { headers: { 'x-goog-upload-url': overrides.uploadUrl || `${origin}/upload/v1beta/files?upload_id=fixture` } });
    }
    if (options.headers['X-Goog-Upload-Command'] === 'upload, finalize') {
      const chunks = []; for await (const chunk of options.body) chunks.push(chunk); bytes = Buffer.concat(chunks);
      if (overrides.upload) return overrides.upload(name, options);
      return Response.json({ file: { name, state: 'PROCESSING' } });
    }
    if (options.method === 'GET') return overrides.poll ? overrides.poll(name, options) : Response.json({ name, state: 'ACTIVE', uri: `${origin}/v1beta/${name}` });
    return overrides.generate ? overrides.generate(options) : Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thought', thought: true }, { text: 'Video summary.' }] } }] });
  };
  const client = createGeminiVideoClient({ apiKey: 'fixture', model: 'gemini-fixture', pollMs: 1, fetcher, journal: overrides.journal });
  return { filename, video, calls, client, fetcher, uploadedBytes: () => bytes };
}

test('streams original video, polls processing, summarizes with explicit model and cleans up', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.summarize({ filename: f.filename, mimeType: 'video/webm', prompt: 'Focus on errors' }), { text: 'Video summary.' });
  assert.deepEqual(f.uploadedBytes(), f.video);
  assert.deepEqual(f.calls.map((call) => call.method), ['POST', 'POST', 'GET', 'POST', 'DELETE']);
  assert.equal(f.calls[0].headers['X-Goog-Upload-Header-Content-Length'], '5');
  assert.equal(f.calls[1].duplex, 'half');
  const payload = JSON.parse(f.calls[3].body);
  assert.equal(payload.contents[0].parts[1].text, 'Researcher prompt: Focus on errors');
  assert.equal(payload.generationConfig.maxOutputTokens, 1200);
  assert.equal(payload.contents[0].parts[0].file_data.mime_type, 'video/webm');
  assert.equal(f.calls[3].url.pathname, '/v1beta/models/gemini-fixture:generateContent');
  assert.equal(f.calls[4].url.href, payload.contents[0].parts[0].file_data.file_uri);
});

test('untrusted upload destinations never receive credentials or video', async (t) => {
  const f = await fixture(t, { uploadUrl: 'https://example.com/upload/stolen' });
  await assert.rejects(f.client.summarize({ filename: f.filename, mimeType: 'video/mp4' }), { code: 'INVALID_RESULT' });
  assert.equal(f.uploadedBytes(), undefined);
  assert.deepEqual(f.calls.map(({ method }) => method), ['POST', 'DELETE']);
});

test('processing failure and incomplete generation still remove known remote file', async (t) => {
  for (const overrides of [
    { poll: (name) => Response.json({ name, state: 'FAILED' }) },
    { generate: () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }) },
    { generate: () => new Response('private content', { status: 429 }) },
    { generate: () => new Response('invalid json') },
    { generate: () => new Response('x'.repeat(1048577)) },
  ]) {
    const f = await fixture(t, overrides);
    await assert.rejects(f.client.summarize({ filename: f.filename, mimeType: 'video/webm' }), (error) => !error.message.includes('private content'));
    assert.equal(f.calls.at(-1).method, 'DELETE');
  }
});

test('cancelled upload and processing timeout clean up using an independent signal', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { upload: (name) => { controller.abort(); return Response.json({ file: { name, state: 'PROCESSING' } }); } });
  await assert.rejects(f.client.summarize({ filename: f.filename, mimeType: 'video/webm', signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(f.calls.at(-1).method, 'DELETE'); assert.equal(f.calls.at(-1).signal.aborted, false);
  const slow = await fixture(t, { poll: (name) => Response.json({ name, state: 'PROCESSING' }) });
  const client = createGeminiVideoClient({ apiKey: 'fixture', model: 'gemini-fixture', fetcher: slow.fetcher, pollMs: 10, processingTimeoutMs: 40 });
  await assert.rejects(client.summarize({ filename: slow.filename, mimeType: 'video/webm' }), { code: 'TIMEOUT' });
  assert.equal(slow.calls.at(-1).method, 'DELETE');
});

test('cleanup failure retains successful summary with a diagnostic, or augments original failure', async (t) => {
  const remove = () => new Response('secret', { status: 500 });
  const f = await fixture(t, { remove });
  const result = await f.client.summarize({ filename: f.filename, mimeType: 'video/webm' });
  assert.equal(result.text, 'Video summary.'); assert.match(result.cleanupWarning, /Remote cleanup failed for Gemini files\/review-/);
  const broken = await fixture(t, { remove, generate: () => new Response('secret', { status: 429 }) });
  await assert.rejects(broken.client.summarize({ filename: broken.filename, mimeType: 'video/webm' }), (error) => error.code === 'PROVIDER_ERROR' && /Remote cleanup failed/.test(error.message) && !/secret/.test(error.message));
});

test('analyzer preserves local evidence and cleanup warning; invalid MIME never uploads', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.summarize({ filename: f.filename, mimeType: 'application/octet-stream' }), { code: 'UNSUPPORTED_MEDIA' });
  assert.equal(f.calls.length, 0);
  const evidence = { events: [], ocr: [], confusion: [], meta: { duration: 4 } };
  const analyzer = createGeminiAnalyzer({ timeline: async () => evidence, client: { model: 'gemini-fixture', summarize: async () => ({ text: 'summary', cleanupWarning: 'cleanup needed' }) } });
  const result = await analyzer({});
  assert.equal(result.events, evidence.events); assert.equal(result.meta.cleanupWarning, 'cleanup needed');
  assert.deepEqual(result.summary, { text: 'summary', model: 'gemini-fixture', pipeline: 'gemini' });
});

test('native fetch streams video through real loopback HTTP and deletes the remote file', async (t) => {
  const f = await fixture(t);
  let name; let uploaded; let removed = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.headers['x-goog-upload-command'] === 'start') {
      name = JSON.parse(body.toString()).file.name;
      response.writeHead(200, { 'x-goog-upload-url': `${origin}/upload/v1beta/files?upload_id=test` }); response.end();
    } else if (request.headers['x-goog-upload-command'] === 'upload, finalize') {
      uploaded = body;
      response.end(JSON.stringify({ file: { name, state: 'ACTIVE', uri: `${origin}/v1beta/${name}` } }));
    } else if (request.method === 'DELETE') {
      removed = request.url === `/v1beta/${name}`; response.end('{}');
    } else response.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Local HTTP summary' }] } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const fetcher = (raw, options) => { const url = new URL(raw); return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, options); };
  const client = createGeminiVideoClient({ apiKey: 'fixture', model: 'gemini-fixture', fetcher });
  assert.deepEqual(await client.summarize({ filename: f.filename, mimeType: 'video/webm' }), { text: 'Local HTTP summary' });
  assert.deepEqual(uploaded, f.video); assert.equal(removed, true);
});

test('journal write failure prevents all provider traffic', async (t) => {
  const f = await fixture(t, { journal: { begin: async () => { throw new Error('disk full'); } } });
  await assert.rejects(f.client.summarize({ filename: f.filename, mimeType: 'video/webm' }), { code: 'CLEANUP_TRACKING_FAILED' });
  assert.equal(f.calls.length, 0);
});

test('failed deletion survives a new client and is retried without reuploading or regenerating', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-gemini-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 1000; let fail = true;
  const options = { now: () => time };
  const f = await fixture(t, { journal: createCleanupJournal(directory, options), remove: () => fail ? new Response('', { status: 500 }) : Response.json({}) });
  const result = await f.client.summarize({ filename: f.filename, mimeType: 'video/webm' });
  assert.match(result.cleanupWarning, /Remote cleanup failed/);
  assert.equal((await f.client.recoverCleanup()).attempted, 0);
  time += 60000; fail = false;
  const before = f.calls.length;
  const restarted = createGeminiVideoClient({ apiKey: 'fixture', model: 'gemini-fixture', fetcher: f.fetcher, journal: createCleanupJournal(directory, options) });
  assert.deepEqual(await restarted.recoverCleanup(), { attempted: 1, removed: 1, failed: 0, pending: 0 });
  assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).method, 'DELETE');
});
