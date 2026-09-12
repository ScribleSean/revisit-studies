import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { frameTimes, sampleFrames } from '../frames.mjs';

test('sampling validates limits and excludes EOF even for a short recording', () => {
  assert.deepEqual(frameTimes(4, 2), [0, 2]);
  assert.ok(frameTimes(0.01, 20).every((time) => time < 0.01));
  for (const duration of [0, -1, Infinity, NaN]) assert.throws(() => frameTimes(duration, 2));
  for (const count of [0, 21, 1.5, NaN]) assert.throws(() => frameTimes(4, count));
});

test('decodes and consumes sequentially, removes frames and temporary directory', async () => {
  let output;
  const steps = [];
  await sampleFrames({ filename: 'input', duration: 4, count: 2,
    runner: async (_, args, options) => {
      output = args.at(-1); steps.push(`decode ${args[args.indexOf('-ss') + 1]}`);
      assert.equal(options.timeoutMs, 30000);
      await writeFile(output, Buffer.from([255, 216, 1, 255, 217]));
    }, consume: async ({ timestamp, jpeg }) => {
      steps.push(`consume ${timestamp}`); assert.equal(jpeg.length, 5);
      await assert.rejects(access(output));
    } });
  assert.deepEqual(steps, ['decode 0', 'consume 0', 'decode 2', 'consume 2']);
  await assert.rejects(access(path.dirname(output)));
});

test('cancellation after consumption stops subsequent decodes and cleans up', async () => {
  const controller = new AbortController(); let output; let calls = 0;
  await assert.rejects(sampleFrames({ filename: 'input', duration: 4, count: 3, signal: controller.signal,
    runner: async (_, args) => { calls += 1; output = args.at(-1); await writeFile(output, Buffer.from([255, 216, 255, 217])); },
    consume: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(calls, 1); await assert.rejects(access(path.dirname(output)));
});

test('invalid JPEG and consumer failure clean temporary resources', async () => {
  for (const invalid of [true, false]) {
    let output;
    await assert.rejects(sampleFrames({ filename: 'input', duration: 4, count: 1,
      runner: async (_, args) => { output = args.at(-1); await writeFile(output, invalid ? 'bad' : Buffer.from([255, 216, 255, 217])); },
      consume: async () => { throw new Error('Model unavailable'); },
    }), invalid ? { code: 'INVALID_FRAME' } : /Model unavailable/);
    await assert.rejects(access(path.dirname(output)));
  }
});

test('cancellation during the final frame is not reported as successful sampling', async () => {
  const controller = new AbortController();
  await assert.rejects(sampleFrames({ filename: 'input', duration: 1, count: 1, signal: controller.signal,
    runner: async (_, args) => writeFile(args.at(-1), Buffer.from([255, 216, 255, 217])),
    consume: async () => controller.abort(),
  }), { name: 'AbortError' });
});
