import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenAiAnalyzer, createOpenAiVisionClient } from '../openai.mjs';
import { createReviewServer } from '../http.mjs';
import { createAnalysisCache } from '../cache.mjs';

const completed = { choices: [{ finish_reason: 'stop', message: { content: ' Visible error. ' } }] };
test('vision request uses fixed endpoint, requested model, bounded output and no storage or fallback', async () => {
  const calls = [];
  const client = createOpenAiVisionClient({ apiKey: 'fixture-key', fetcher: async (url, options) => { calls.push({ url, ...options }); return Response.json(completed); } });
  const content = [{ type: 'text', text: 'Frame at 0 seconds' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aW1hZ2U=' } }];
  assert.equal(await client.summarize(content), 'Visible error.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-key');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.model, 'gpt-4o'); assert.equal(payload.max_completion_tokens, 1200);
  assert.equal(payload.store, false); assert.equal(payload.stream, false);
  assert.deepEqual(payload.messages[1].content, content);
});

test('refusal, truncation, malformed and oversized responses reject rather than save partial output', async () => {
  const responses = [
    Response.json({ choices: [{ finish_reason: 'length', message: { content: 'cut off' } }] }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'text', refusal: 'refused' } }] }),
    Response.json({ choices: [] }), new Response('bad'), new Response(Buffer.from([0xff])), new Response('x'.repeat(1100)),
  ];
  for (const response of responses) {
    await assert.rejects(createOpenAiVisionClient({ apiKey: 'fixture', maxBytes: 1024, fetcher: async () => response }).summarize([]), (error) => ['INVALID_RESULT', 'OUTPUT_LIMIT'].includes(error.code));
  }
});

test('provider failures never leak error bodies or trigger another billed request', async () => {
  let calls = 0;
  const client = createOpenAiVisionClient({ apiKey: 'fixture', fetcher: async () => { calls += 1; return new Response('private provider detail', { status: 429 }); } });
  await assert.rejects(client.summarize([]), (error) => error.code === 'PROVIDER_ERROR' && /429/.test(error.message) && !/private/.test(error.message));
  assert.equal(calls, 1);
  await assert.rejects(createOpenAiVisionClient({ apiKey: 'fixture', fetcher: async () => { throw new Error('secret transport content'); } }).summarize([]), { code: 'UNAVAILABLE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.summarize([], controller.signal), { code: 'CANCELLED' });
  assert.equal(calls, 1);
});

test('real HTTP stalled body is bounded by timeout and cancellation and releases connection', { timeout: 5000 }, async (t) => {
  const closed = []; const disconnected = [];
  const server = createServer((_, response) => {
    const index = disconnected.length;
    disconnected.push(new Promise((resolve) => { closed[index] = resolve; }));
    response.on('close', closed[index]); response.writeHead(200); response.write('{');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  let headersReceived;
  const fetcher = async (_, options) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, options);
    headersReceived?.();
    return response;
  };
  await assert.rejects(createOpenAiVisionClient({ apiKey: 'fixture', fetcher, timeoutMs: 100 }).summarize([]), { code: 'TIMEOUT' });
  assert.equal(disconnected.length, 1);
  await disconnected[0];
  const controller = new AbortController();
  const admitted = new Promise((resolve) => { headersReceived = resolve; });
  const pending = createOpenAiVisionClient({ apiKey: 'fixture', fetcher }).summarize([], controller.signal);
  const rejection = assert.rejects(pending, { code: 'CANCELLED' });
  await admitted; controller.abort();
  await rejection;
  assert.equal(disconnected.length, 2);
  await disconnected[1];
});

const evidence = { events: [{ timestamp: 2, type: 'scene_change', evidence: 'cut' }], ocr: [], confusion: [], meta: { duration: 4 } };
test('frame analyzer preserves timeline evidence, orders timestamped frames and uses researcher prompt', async () => {
  let sent;
  const timeline = async () => evidence; timeline.version = 'fixture';
  const analyzer = createOpenAiAnalyzer({ timeline, count: 2,
    client: { model: 'gpt-4o', summarize: async (content) => { sent = content; return 'summary'; } },
    sampler: async ({ consume }) => { await consume({ timestamp: 0, jpeg: Buffer.from('one') }); await consume({ timestamp: 2, jpeg: Buffer.from('two') }); },
  });
  const result = await analyzer({ filename: 'fixture', prompt: 'Focus on errors' });
  assert.deepEqual(result.summary, { text: 'summary', model: 'gpt-4o', pipeline: 'gpt4o' });
  assert.equal(result.events, evidence.events); assert.equal(result.meta.framesSampled, 2);
  assert.equal(sent[0].text, 'Researcher prompt: Focus on errors');
  assert.equal(sent[1].text, 'Frame at 0.00 seconds'); assert.equal(sent[3].text, 'Frame at 2.00 seconds');
  assert.equal(sent[2].image_url.url, 'data:image/jpeg;base64,b25l');
  assert.match(analyzer.version, /gpt-4o:2:fixture/);
});

test('frame limits, missing frames and cancellation stop before provider submission', async () => {
  let calls = 0;
  const client = { model: 'fixture', summarize: async () => { calls += 1; } };
  const timeline = async () => evidence;
  await assert.rejects(createOpenAiAnalyzer({ timeline, client, count: 1, maxFrameBytes: 2,
    sampler: async ({ consume }) => consume({ timestamp: 0, jpeg: Buffer.from('large') }),
  })({}), { code: 'FRAME_LIMIT' });
  await assert.rejects(createOpenAiAnalyzer({ timeline, client, sampler: async () => {} })({}), { code: 'INVALID_FRAME' });
  const controller = new AbortController();
  await assert.rejects(createOpenAiAnalyzer({ timeline, client, sampler: async () => controller.abort() })({ signal: controller.signal }));
  assert.equal(calls, 0);
});

test('HTTP bridge runs the configured GPT adapter, caches success and never caches provider failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-openai-test-'));
  let requests = 0; let fail = false;
  const client = createOpenAiVisionClient({ apiKey: 'fixture-key', fetcher: async () => {
    requests += 1;
    return fail ? new Response('private', { status: 429 }) : Response.json(completed);
  } });
  const analyzer = createOpenAiAnalyzer({ timeline: async () => evidence, client, count: 1,
    sampler: async ({ consume }) => consume({ timestamp: 0, jpeg: Buffer.from('jpeg') }),
  });
  const server = createReviewServer({ analyzers: { gpt4o: analyzer }, cache: createAnalysisCache(path.join(root, 'cache')), uploadRoot: root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${endpoint}/api/review/health`)).json();
  assert.equal(health.pipelines.find(({ id }) => id === 'gpt4o').available, true);
  const post = (body) => fetch(`${endpoint}/api/review/analyze?pipeline=gpt4o`, { method: 'POST', headers: { 'content-type': 'video/webm' }, body });
  const first = await post('fixture-video');
  assert.equal(first.status, 200);
  const { result: value } = await first.json();
  assert.deepEqual(value.summary, { text: 'Visible error.', pipeline: 'gpt4o', model: 'gpt-4o' });
  assert.deepEqual(value.events, evidence.events);
  assert.equal((await post('fixture-video')).status, 200); assert.equal(requests, 1);
  fail = true;
  const failure = await post('different-video');
  assert.notEqual(failure.status, 200);
  assert.equal((await failure.json()).code, 'PROVIDER_ERROR');
  fail = false;
  assert.equal((await post('different-video')).status, 200); assert.equal(requests, 3);
});
