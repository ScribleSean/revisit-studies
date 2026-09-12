import { expect, test } from 'vitest';
import { recordingQuery, recordingTarget } from '../recordingNavigation';

test('recording links round-trip tuple identities and fractional seek times', () => {
  const clip = { participantId: 'participant /&你好', taskId: 'task?=one', timestamp: 2.25 };
  expect(recordingTarget(new URLSearchParams(recordingQuery(clip).toString()))).toEqual(clip);
});

test('invalid link times cannot seek and incomplete identities cannot select a clip', () => {
  expect(recordingTarget(new URLSearchParams('participant=p'))).toBeNull();
  for (const value of ['', 'NaN', 'Infinity', '-1']) expect(recordingTarget(new URLSearchParams({ participant: 'p', task: 't', time: value }))).toEqual({ participantId: 'p', taskId: 't' });
  expect(recordingQuery({ participantId: 'p', taskId: 't', timestamp: -2 }).has('time')).toBe(false);
});
