import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLocalAnalyzer, createOllamaClient } from '../ollama.mjs';

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('real HTTP stalled response times out and closes its connection', { timeout: 5000 }, async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const baseUrl = await localServer(t, (_, response) => {
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"response":"');
  });
  await assert.rejects(createOllamaClient({ baseUrl, timeoutMs: 300 }).generate('prompt'), { code: 'TIMEOUT' });
  await disconnected;
});

test('real HTTP cancellation after headers stops a stalled body', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  let started; let closed;
  const admitted = new Promise((resolve) => { started = resolve; });
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const baseUrl = await localServer(t, (_, response) => {
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{'); started();
  });
  const pending = createOllamaClient({ baseUrl }).generate('prompt', undefined, controller.signal);
  const rejection = assert.rejects(pending, { code: 'CANCELLED' });
  await admitted; controller.abort(); await rejection; await disconnected;
});

test('real HTTP oversized body stops reading before server finishes', { timeout: 5000 }, async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const baseUrl = await localServer(t, (_, response) => {
    response.on('close', closed);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('x'.repeat(1024));
  });
  await assert.rejects(createOllamaClient({ baseUrl, maxBytes: 100 }).generate('prompt'), { code: 'OUTPUT_LIMIT' });
  await disconnected;
});

test('Ollama sends nonstreaming base64 requests and verifies vision capability', async () => {
  const calls = [];
  const client = createOllamaClient({ fetcher: async (url, options) => {
    calls.push({ url, ...options, payload: JSON.parse(options.body) });
    return Response.json(url.pathname === '/api/show' ? { capabilities: ['vision'] } : { done: true, response: ' summary ' });
  } });
  assert.equal(await client.available(), true);
  assert.equal(await client.generate('prompt', ['jpeg']), 'summary');
  assert.deepEqual(calls[1].payload, { model: 'llava:7b', prompt: 'prompt', stream: false, options: { num_predict: 800 }, images: ['jpeg'] });
  assert.equal(calls[1].redirect, 'error');
});

test('rejects nonlocal endpoints and invalid, oversized or failed responses', async () => {
  for (const baseUrl of ['https://example.com', 'http://example.com', 'http://user@localhost', 'http://localhost/path']) assert.throws(() => createOllamaClient({ baseUrl }));
  for (const response of [Response.json({ response: 'unfinished' }), Response.json({ done: true, response: '' }), new Response('bad'), new Response('error', { status: 500 }), new Response('x'.repeat(50))]) {
    const client = createOllamaClient({ maxBytes: 40, fetcher: async () => response });
    await assert.rejects(client.generate('prompt'));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createOllamaClient({ fetcher: () => { throw new Error('must not request'); } }).generate('prompt', undefined, controller.signal), { code: 'CANCELLED' });
});

test('local analysis preserves timestamp evidence and synthesizes after ordered frame descriptions', async () => {
  const evidence = { meta: { duration: 4 }, events: [{ timestamp: 2, type: 'scene_change' }], ocr: [], confusion: [] };
  const calls = [];
  const analyzer = createLocalAnalyzer({ timeline: async () => evidence, count: 2,
    client: { model: 'test-model', generate: async (prompt, images) => { calls.push({ prompt, images }); return images ? 'Visible button' : 'Final summary'; } },
    sampler: async ({ consume }) => { await consume({ timestamp: 0, jpeg: Buffer.from('one') }); await consume({ timestamp: 2, jpeg: Buffer.from('two') }); },
  });
  const result = await analyzer({ filename: 'input', prompt: 'Focus on errors' });
  assert.equal(result.events, evidence.events);
  assert.deepEqual(result.summary, { text: 'Final summary', pipeline: 'local', model: 'test-model' });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].images, undefined);
  assert.match(calls[2].prompt, /Focus on errors/);
  assert.match(calls[2].prompt, /Frame 0.00s: Visible button\nFrame 2.00s: Visible button/);
});

test('model failure rejects analysis rather than returning a partial summary', async () => {
  let synthesis = false;
  const analyzer = createLocalAnalyzer({ timeline: async () => ({ meta: { duration: 4 } }),
    client: { model: 'test', generate: async (_, images) => { if (!images) synthesis = true; throw new Error('offline'); } },
    sampler: async ({ consume }) => consume({ timestamp: 0, jpeg: Buffer.from('frame') }),
  });
  await assert.rejects(analyzer({ filename: 'input' }), /offline/);
  assert.equal(synthesis, false);
});
