import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createReviewServer } from '../http.mjs';
import { createAnalysisCache } from '../cache.mjs';
import { createBridgeAnalyzer } from '../../../evaluation/bridge.mjs';

async function setup(t, makeServer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-eval-bridge-'));
  const filename = path.join(directory, 'clip.webm'); await writeFile(filename, Buffer.from([0, 10, 255, 128]));
  const server = makeServer(directory);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { filename, baseUrl: `http://127.0.0.1:${server.address().port}`, signal: new AbortController().signal };
}

test('bridge evaluator streams original bytes, distinguishes cached results, and reports unavailable pipelines', async (t) => {
  let calls = 0;
  const options = await setup(t, (directory) => createReviewServer({ uploadRoot: directory, cache: createAnalysisCache(path.join(directory, 'cache')), analyzers: { heuristic: async ({ filename }) => {
    assert.deepEqual(await readFile(filename), Buffer.from([0, 10, 255, 128])); calls += 1;
    return { meta: { duration: 4 }, summary: { text: 'Synthetic' }, events: [] };
  } } }));
  const analyze = createBridgeAnalyzer(options);
  const first = (await analyze(options)).evaluationTransport;
  const second = (await analyze(options)).evaluationTransport;
  assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(first.analyzerVersion, '1'); assert.equal(second.analyzerVersion, first.analyzerVersion);
  assert.equal(calls, 1);
  await assert.rejects(createBridgeAnalyzer({ ...options, pipeline: 'local' })(options), { code: 'UNAVAILABLE' });
});

test('cloud requires explicit opt-in and bridge destinations cannot leave loopback', () => {
  assert.throws(() => createBridgeAnalyzer({ baseUrl: 'http://127.0.0.1:3001', pipeline: 'gemini' }), /allow-cloud/);
  for (const baseUrl of ['https://127.0.0.1', 'http://example.com', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/?key=secret']) assert.throws(() => createBridgeAnalyzer({ baseUrl }), /loopback/);
});

test('response limits and redirect rejection stop invalid bridge responses', async (t) => {
  let mode = 'large';
  const options = await setup(t, () => createServer((request, response) => {
    request.resume();
    if (mode === 'large') response.end('x'.repeat(1025));
    else { response.writeHead(302, { location: 'http://example.com' }); response.end(); }
  }));
  await assert.rejects(createBridgeAnalyzer({ ...options, maxResponseBytes: 1024 })(options), /size limit/);
  mode = 'redirect';
  await assert.rejects(createBridgeAnalyzer(options)(options));
});

test('cancellation closes an actual stalled response', async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  let closed; const disconnected = new Promise((resolve) => { closed = resolve; });
  const options = await setup(t, () => createServer((request, response) => {
    request.resume(); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
    response.once('close', closed); started();
  }));
  const controller = new AbortController();
  const pending = createBridgeAnalyzer(options)({ ...options, signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending);
  await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Connection remained open')), 2000); timer.unref(); })]);
});
