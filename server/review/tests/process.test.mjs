import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../process.mjs';

test('captures bounded successful output and stdin', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'fixture' });
  assert.equal(result.stdout, 'fixture');
});

test('rejects nonzero exit even when stdout looks valid', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("{}"); process.exit(2)']), { code: 'PROCESS_FAILED' });
});

test('stops a timed out process and excessive output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), { code: 'TIMEOUT' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(5000))'], { maxOutputBytes: 100 }), { code: 'OUTPUT_LIMIT' });
});

test('cancels before launch and during execution', async () => {
  await assert.rejects(runProcess(process.execPath, [], { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});
