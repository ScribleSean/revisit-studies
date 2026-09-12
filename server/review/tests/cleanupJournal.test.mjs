import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCleanupJournal } from '../cleanupJournal.mjs';

const first = `files/review-${'a'.repeat(32)}`;
const second = `files/review-${'b'.repeat(32)}`;
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = 1000;
  const config = { leaseMs: 100, now: () => time, ...options };
  return { root, journal: createCleanupJournal(root, config), reopen: () => createCleanupJournal(root, config), advance: (ms) => { time += ms; } };
}

test('records minimal intent atomically before upload and recovers after restart only after lease', async (t) => {
  const f = await fixture(t);
  await f.journal.begin(first);
  const files = await readdir(f.root); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.json'));
  const entry = JSON.parse(await readFile(path.join(f.root, files[0]), 'utf8'));
  assert.deepEqual(Object.keys(entry).sort(), ['attempts', 'createdAt', 'name', 'nextAttemptAt', 'settleAfter', 'version']);
  const restarted = f.reopen(); let calls = 0;
  assert.deepEqual(await restarted.recover(async () => { calls += 1; return true; }), { attempted: 0, removed: 0, failed: 0, pending: 1 });
  f.advance(100);
  assert.deepEqual(await restarted.recover(async (name) => { assert.equal(name, first); calls += 1; return true; }), { attempted: 1, removed: 1, failed: 0, pending: 0 });
  assert.equal(calls, 1); assert.deepEqual(await readdir(f.root), []);
});

test('early missing-file result stays tracked until ambiguous upload can settle', async (t) => {
  const f = await fixture(t);
  await f.journal.begin(first); await f.journal.settled(first, false);
  assert.equal((await readdir(f.root)).length, 1);
  f.advance(99);
  assert.equal((await f.journal.recover(async () => false)).attempted, 0);
  f.advance(1);
  assert.deepEqual(await f.journal.recover(async () => false), { attempted: 1, removed: 1, failed: 0, pending: 0 });
  await f.journal.begin(second); await f.journal.settled(second, true);
  assert.deepEqual(await readdir(f.root), []);
});

test('an extended analysis lease protects an active upload beyond the default lease', async (t) => {
  const f = await fixture(t);
  await f.journal.begin(first, 500); f.advance(100);
  assert.equal((await f.reopen().recover(async () => true)).attempted, 0);
  f.advance(400); assert.equal((await f.reopen().recover(async () => true)).removed, 1);
});

test('failures back off without losing IDs and recovery limits remote calls per pass', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.journal.begin(first), f.journal.begin(second)]); f.advance(100);
  assert.deepEqual(await f.journal.recover(async () => { throw new Error('offline'); }, undefined, 1), { attempted: 1, removed: 0, failed: 1, pending: 2 });
  assert.deepEqual(await f.journal.recover(async () => true), { attempted: 1, removed: 1, failed: 0, pending: 1 });
  f.advance(59999); assert.equal((await f.reopen().recover(async () => true)).attempted, 0);
  f.advance(1); assert.equal((await f.reopen().recover(async () => true)).removed, 1);
});

test('capacity and identity checks reject new uploads; corrupt records are retained', async (t) => {
  const f = await fixture(t, { maxEntries: 1 });
  const writes = await Promise.allSettled([f.journal.begin(first), f.journal.begin(second)]);
  assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.throws(() => f.journal.begin('../outside'));
  const [file] = await readdir(f.root); await writeFile(path.join(f.root, file), '{bad');
  f.advance(100);
  const result = await f.reopen().recover(async () => { throw new Error('must not delete unknown data'); });
  assert.equal(result.failed, 1); assert.equal(result.attempted, 0); assert.equal(result.pending, 1);
});

test('cancellation retains queued entries and invalid deletion acknowledgements never clear them', async (t) => {
  const f = await fixture(t); await f.journal.begin(first); f.advance(100);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.journal.recover(async () => true, controller.signal));
  assert.equal((await f.journal.recover(async () => undefined)).failed, 1);
  assert.equal((await readdir(f.root)).length, 1);
});
