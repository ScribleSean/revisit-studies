import {
  afterEach, expect, test, vi,
} from 'vitest';
import { queueReviewIndexUpdate } from '../reviewIndexQueue';

afterEach(() => vi.unstubAllGlobals());

test('serializes the same study while other studies continue', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const first = queueReviewIndexUpdate('one', async () => { calls.push('first'); await gate; calls.push('finished'); });
  const second = queueReviewIndexUpdate('one', async () => { calls.push('second'); });
  await queueReviewIndexUpdate('two', async () => { calls.push('other'); });
  expect(calls).toEqual(['first', 'other']);
  release();
  await Promise.all([first, second]);
  expect(calls).toEqual(['first', 'other', 'finished', 'second']);
});

test('a failed update does not poison later updates and uses browser locks when available', async () => {
  const request = vi.fn(async (_name: string, callback: () => Promise<void>) => callback());
  vi.stubGlobal('navigator', { locks: { request } });
  await expect(queueReviewIndexUpdate('study', async () => { throw new Error('Failed write'); })).rejects.toThrow('Failed write');
  const next = vi.fn(async () => {});
  await queueReviewIndexUpdate('study', next);
  expect(next).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][0]).toBe('revisit-review-index:study');
});
