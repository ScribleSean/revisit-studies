import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewMetadataLength, reviewVideoChunks } from '../uploadMetadata.mjs';

test('metadata length is bounded and legacy uploads remain byte-identical', async () => {
  assert.equal(reviewMetadataLength(undefined), 0);
  for (const header of ['0', '-1', '1.2', '65537', '999999', ['1'], ' 1', '1e3']) assert.throws(() => reviewMetadataLength(header), { code: 'INVALID_OPTIONS' });
  assert.equal(reviewMetadataLength('65536'), 65536);
  const bytes = Buffer.from([0, 255, 17]); const chunks = [];
  for await (const chunk of reviewVideoChunks([bytes], 0, () => assert.fail('no metadata'))) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('metadata survives every split boundary and preserves binary media', async () => {
  const value = { prompt: 'Café &\n画', confusionWords: 'not sure' };
  const prefix = Buffer.from(JSON.stringify(value)); const media = Buffer.from([0, 255, 1, 254]);
  const body = Buffer.concat([prefix, media]);
  for (let split = 1; split < body.length; split += 1) {
    let parsed; const chunks = [];
    for await (const chunk of reviewVideoChunks([body.subarray(0, split), body.subarray(split)], prefix.length, (metadata) => { parsed = metadata; })) chunks.push(chunk);
    assert.deepEqual(parsed, value); assert.deepEqual(Buffer.concat(chunks), media);
  }
});

test('rejects truncated, malformed, invalid UTF8 and oversized prompt metadata', async () => {
  for (const [buffer, length] of [[Buffer.from('{}'), 3], [Buffer.from('xx'), 2], [Buffer.from([255]), 1], [Buffer.from('{}'), 2], ...[8001].map((n) => { const bytes = Buffer.from(JSON.stringify({ prompt: 'x'.repeat(n), confusionWords: '' })); return [bytes, bytes.length]; })]) {
    await assert.rejects(async () => { for await (const chunk of reviewVideoChunks([buffer], length, () => {})) assert.fail(String(chunk)); }, { code: 'INVALID_OPTIONS' });
  }
});
