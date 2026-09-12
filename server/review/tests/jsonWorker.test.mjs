import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsonWorker } from '../jsonWorker.mjs';

const script = `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const v=JSON.parse(line); if(v.crash)process.exit(1); else if(v.hang){} else if(v.bad)console.log('invalid'); else setTimeout(()=>console.log(JSON.stringify({pid:process.pid,value:v.text})),v.delay||0);});`;
function worker(t, options) {
  const instance = createJsonWorker(process.execPath, ['-e', script], options);
  t.after(() => instance.close());
  return instance;
}
test('reuses a process and preserves queued request identities', async (t) => {
  const w = worker(t);
  const [a, b] = await Promise.all([w.request({ text: 'first', delay: 20 }), w.request({ text: 'second' })]);
  assert.equal(a.pid, b.pid);
  assert.equal(a.value, 'first'); assert.equal(b.value, 'second');
});
test('queued cancellation does not kill the active worker', async (t) => {
  const w = worker(t);
  const a = w.request({ text: 'active', delay: 100 });
  const controller = new AbortController();
  const b = w.request({ text: 'queued' }, controller.signal);
  const rejected = assert.rejects(b, { code: 'CANCELLED' });
  controller.abort(); await rejected;
  const first = await a;
  assert.equal((await w.request({ text: 'after' })).pid, first.pid);
});
test('active cancellation restarts for queued work and queue capacity is bounded', async (t) => {
  const w = worker(t, { maxQueue: 1 });
  const controller = new AbortController();
  const active = assert.rejects(w.request({ hang: true }, controller.signal), { code: 'CANCELLED' });
  const queued = w.request({ text: 'survives' });
  await assert.rejects(w.request({ text: 'excess' }), { code: 'BUSY' });
  controller.abort();
  await active;
  assert.equal((await queued).value, 'survives');
});
test('timeouts and malformed output terminate the worker and allow a fresh request', async (t) => {
  const w = worker(t, { timeoutMs: 500 });
  await assert.rejects(w.request({ hang: true }), { code: 'TIMEOUT' });
  assert.equal((await w.request({ text: 'recovered' })).value, 'recovered');
  await assert.rejects(w.request({ bad: true }), { code: 'INVALID_RESULT' });
  assert.equal((await w.request({ text: 'again' })).value, 'again');
});
test('crashed workers restart and closing rejects active and queued work', async (t) => {
  const w = worker(t);
  await assert.rejects(w.request({ crash: true }), { code: 'PROCESS_FAILED' });
  assert.equal((await w.request({ text: 'restarted' })).value, 'restarted');
  const active = assert.rejects(w.request({ hang: true }), { code: 'CANCELLED' });
  const queued = assert.rejects(w.request({ text: 'queued' }), { code: 'CANCELLED' });
  await w.close(); await Promise.all([active, queued]);
  await assert.rejects(w.request({ text: 'closed' }), { code: 'UNAVAILABLE' });
});
