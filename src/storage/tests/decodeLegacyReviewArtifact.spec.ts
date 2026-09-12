import { Blob as NodeBlob } from 'node:buffer';
import {
  afterAll, beforeAll, expect, test, vi,
} from 'vitest';
import { decodeLegacyReviewArtifact } from '../decodeLegacyReviewArtifact';

beforeAll(() => vi.stubGlobal('Blob', NodeBlob));
afterAll(() => vi.unstubAllGlobals());
test('decodes each storage representation and distinguishes missing artifacts', async () => {
  const value = { events: [{ timestamp: 2, evidence: 'Café' }] };
  for (const input of [value, JSON.stringify(value), new Blob([JSON.stringify(value)])]) {
    // eslint-disable-next-line no-await-in-loop
    const decoded = await decodeLegacyReviewArtifact(input);
    expect(decoded).toEqual(value); expect(decoded).not.toBe(value);
  }
  expect(await decodeLegacyReviewArtifact(null)).toBeNull();
  await expect(decodeLegacyReviewArtifact('broken')).rejects.toThrow('not valid JSON');
  expect(await decodeLegacyReviewArtifact(new Blob(['Plain summary']), true)).toBe('Plain summary');
});

test('oversized blobs are rejected before reading and cancellation prevents decoded output', async () => {
  const oversized = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]);
  const read = vi.spyOn(oversized, 'text');
  await expect(decodeLegacyReviewArtifact(oversized)).rejects.toThrow('decode limit');
  expect(read).not.toHaveBeenCalled();
  const controller = new AbortController();
  const blob = new Blob(['{}']);
  vi.spyOn(blob, 'text').mockImplementation(async () => { controller.abort(); return '{}'; });
  await expect(decodeLegacyReviewArtifact(blob, false, controller.signal)).rejects.toThrow();
});
