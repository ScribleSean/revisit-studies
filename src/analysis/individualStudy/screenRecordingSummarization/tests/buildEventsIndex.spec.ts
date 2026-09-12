import { expect, test, vi } from 'vitest';
import { buildEventsIndex } from '../buildEventsIndex';
import type { StorageEngine } from '../../../../storage/engines/types';

function fixture() {
  const getReviewAnalysis = vi.fn().mockResolvedValue({ value: { events: [{ timestamp: 2, type: 'reading', evidence: 'Pause' }] } });
  const getReviewArtifact = vi.fn().mockResolvedValue({ value: [{ id: 'tag', timestamp: 1, label: 'Check this' }] });
  const engine = { getReviewAnalysis, getReviewArtifact } as unknown as StorageEngine;
  return { engine, getReviewAnalysis, getReviewArtifact };
}
const clips = [{ participantId: 'a::b', taskId: 'c' }, { participantId: 'a', taskId: 'b::c' }];

test('includes automatic evidence and tags with exact identities, deduplicating clip inputs', async () => {
  const { engine, getReviewAnalysis } = fixture();
  const events = await buildEventsIndex(engine, [...clips, clips[0]], new AbortController().signal);
  expect(getReviewAnalysis).toHaveBeenCalledTimes(2);
  expect(events).toEqual(clips.flatMap((clip) => [
    {
      ...clip, timestamp: 2, type: 'reading', evidence: 'Pause', source: 'auto',
    },
    {
      ...clip, timestamp: 1, type: 'tag', evidence: 'Check this', source: 'tag',
    },
  ]));
});

test('reads missing artifacts as empty but never returns a partial index after read failure', async () => {
  const { engine, getReviewAnalysis, getReviewArtifact } = fixture();
  getReviewAnalysis.mockResolvedValue(null);
  getReviewArtifact.mockResolvedValue(null);
  expect(await buildEventsIndex(engine, clips, new AbortController().signal)).toEqual([]);
  getReviewArtifact.mockRejectedValueOnce(new Error('Permission denied'));
  await expect(buildEventsIndex(engine, clips, new AbortController().signal)).rejects.toThrow('Permission denied');
});

test('bounds admitted clips and cancellation prevents queued reads', async () => {
  const { engine, getReviewAnalysis } = fixture();
  const controller = new AbortController();
  let release!: (value: null) => void;
  const pending = new Promise<null>((resolve) => { release = resolve; });
  getReviewAnalysis.mockReturnValue(pending);
  const result = buildEventsIndex(engine, Array.from({ length: 30 }, (_, index) => ({ participantId: String(index), taskId: 'task' })), controller.signal);
  const assertion = expect(result).rejects.toThrow();
  expect(getReviewAnalysis).toHaveBeenCalledTimes(4);
  controller.abort();
  release(null);
  await assertion;
  expect(getReviewAnalysis).toHaveBeenCalledTimes(4);
});

test('a failed tag read drains its admitted analysis read before rejecting', async () => {
  const { engine, getReviewAnalysis, getReviewArtifact } = fixture();
  let release!: (value: null) => void;
  getReviewAnalysis.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  getReviewArtifact.mockRejectedValue(new Error('Tag read failed'));
  let settled = false;
  const result = buildEventsIndex(engine, [clips[0]], new AbortController().signal);
  const checked = expect(result.finally(() => { settled = true; })).rejects.toThrow('Tag read failed');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(settled).toBe(false);
  release(null);
  await checked;
});
