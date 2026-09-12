import { expect, test } from 'vitest';
import { rankClips } from '../semanticSearch';

const clip = (participantId: string, vector: number[], model = 'fixture') => ({
  participantId, taskId: 'task', text: participantId, embedding: { model, vector },
});
test('ranks by cosine and excludes model/dimension/invalid vector mismatches', () => {
  const result = rankClips({ model: 'fixture', vector: [1, 0] }, [clip('orthogonal', [0, 1]), clip('same', [3, 0]), clip('opposite', [-1, 0]), clip('wrong-model', [1, 0], 'other'), clip('wrong-dimension', [1]), clip('zero', [0, 0]), clip('nan', [NaN, 1])]);
  expect(result.map((row) => [row.participantId, row.score])).toEqual([['same', 1], ['orthogonal', 0], ['opposite', -1]]);
});
test('handles extreme finite magnitudes, deterministic ties, and top-five truncation', () => {
  const result = rankClips({ model: 'fixture', vector: [1e308, 1e308] }, ['g', 'f', 'e', 'd', 'c', 'b', 'a'].map((id) => clip(id, [1e-300, 1e-300])));
  expect(result.map((row) => row.participantId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(result[0].score).toBeCloseTo(1);
  expect(() => rankClips({ model: 'fixture', vector: [0] }, [])).toThrow();
});
