import { expect, test } from 'vitest';
import { saveNamedPrompt } from '../promptLibrary';
import { validateReviewValue } from '../../../../storage/reviewArtifacts';

test('creates and updates a named prompt without changing unrelated entries or inputs', () => {
  const first = saveNamedPrompt([], '  Errors  ', 'Describe errors');
  const second = saveNamedPrompt(first.library, 'Navigation', 'Describe navigation');
  const updated = saveNamedPrompt(second.library, 'Errors revised', 'New text', first.id);
  expect(updated.id).toBe(first.id);
  expect(updated.library[0]).toMatchObject({ name: 'Errors revised', text: 'New text' });
  expect(updated.library[1]).toEqual(second.library[1]);
  expect(first.library[0].name).toBe('Errors');
  expect(second.library[0].text).toBe('Describe errors');
});

test('rejects duplicate names, missing targets and invalid limits', () => {
  const { library } = saveNamedPrompt([], 'Errors', 'text');
  expect(() => saveNamedPrompt(library, ' errors ', 'other')).toThrow('already exists');
  expect(() => saveNamedPrompt(library, 'Name', 'text', 'missing')).toThrow('no longer exists');
  for (const [name, text] of [['', 'text'], ['x'.repeat(101), 'text'], ['Name', 'x'.repeat(8001)]]) expect(() => saveNamedPrompt(library, name, text)).toThrow();
  expect(() => validateReviewValue('settings', { pipeline: 'local', confusionWords: [], promptLibrary: [library[0], library[0]] })).toThrow();
  expect(() => validateReviewValue('settings', { pipeline: 'local', confusionWords: [], promptLibrary: Array(101).fill(library[0]) })).toThrow();
});
