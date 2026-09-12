import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analysisKey, createAnalysisCache } from '../cache.mjs';

test('cache keys include content and canonical analysis configuration', () => {
  const key = analysisKey(Buffer.from('video'), { model: 'a', options: { x: 1, y: 2 } });
  assert.equal(key, analysisKey(Buffer.from('video'), { options: { y: 2, x: 1 }, model: 'a' }));
  assert.notEqual(key, analysisKey(Buffer.from('other'), { model: 'a', options: { x: 1, y: 2 } }));
  assert.notEqual(key, analysisKey(Buffer.from('video'), { model: 'b', options: { x: 1, y: 2 } }));
  assert.throws(() => analysisKey(Buffer.from('video'), { temperature: Number.NaN }), /finite/);
});

test('a cache hit protects an older entry from eviction', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-lru-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = createAnalysisCache(directory, { maxEntries: 2 });
  const keys = [1, 2, 3].map((n) => analysisKey(Buffer.from(String(n)), {}));
  await cache.set(keys[0], 'first');
  await cache.set(keys[1], 'second');
  assert.equal(await cache.get(keys[0]), 'first');
  await cache.set(keys[2], 'third');
  assert.equal(await cache.get(keys[1]), null);
  assert.equal(await cache.get(keys[0]), 'first');
});

test('cache survives a new instance, bounds concurrent writes, and rejects traversal', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = createAnalysisCache(directory, { maxEntries: 2, maxBytes: 4096 });
  const keys = [1, 2, 3].map((n) => analysisKey(Buffer.from(String(n)), {}));
  await Promise.all(keys.map((key, n) => cache.set(key, { n })));
  assert.equal((await readdir(directory)).length, 2);
  assert.deepEqual(await createAnalysisCache(directory).get(keys[2]), { n: 2 });
  assert.equal(await cache.get(keys[0]), null);
  assert.equal(await cache.set(keys[0], 'x'.repeat(5000)), false);
  await assert.rejects(cache.get('../escape'), /Invalid cache key/);
  await writeFile(path.join(directory, `${keys[2]}.json`), '{');
  assert.equal(await cache.get(keys[2]), null);
});
