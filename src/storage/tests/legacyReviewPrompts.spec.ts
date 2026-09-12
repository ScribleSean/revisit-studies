import { expect, test } from 'vitest';
import { planLegacyPromptImport } from '../legacyReviewPrompts';

const old = {
  id: 'old', name: 'Observe errors', prompt: 'Describe visible errors.', updatedAt: '2026-04-01T12:00:00Z',
};
test('converts the actual legacy shape, preserving IDs, text and dates without mutating inputs', () => {
  const raw = { prompts: [old] };
  const plan = planLegacyPromptImport(raw, []);
  expect(plan.library).toEqual([{
    id: old.id, name: old.name, text: old.prompt, updatedAt: old.updatedAt,
  }]);
  expect(plan.imported).toBe(1); expect(plan.conflicts).toEqual([]);
  plan.library[0].text = 'Edited'; expect(raw.prompts[0].prompt).toBe(old.prompt);
});

test('repeated import is idempotent and retains current dates for identical entries', () => {
  const first = planLegacyPromptImport({ prompts: [old] }, []);
  first.library[0].updatedAt = '2026-09-09T12:00:00Z';
  const second = planLegacyPromptImport({ prompts: [old] }, first.library);
  expect(second).toMatchObject({ imported: 0, identical: 1, conflicts: [] });
  expect(second.library).toEqual(first.library);
});

test('reports ID and normalized name conflicts while preserving current edits and unrelated imports', () => {
  const current = [{
    id: old.id, name: old.name, text: 'Current edit', updatedAt: old.updatedAt,
  }];
  const result = planLegacyPromptImport({ prompts: [old, { ...old, id: 'other', name: ' OBSERVE ERRORS ' }, { ...old, id: 'new', name: 'Navigation' }] }, current);
  expect(result.conflicts).toEqual([{ id: 'old', name: old.name, reason: 'id' }, { id: 'other', name: ' OBSERVE ERRORS ', reason: 'name' }]);
  expect(result.imported).toBe(1); expect(result.library[0]).toEqual(current[0]);
  expect(current).toHaveLength(1);
});

test('malformed source is rejected instead of producing a partial migration', () => {
  for (const raw of [{}, { prompts: [old, null] }, { prompts: [old, { ...old, id: 'bad', updatedAt: 'invalid' }] }, { prompts: [old, old] }, { prompts: [{ ...old, prompt: 'x'.repeat(8001) }] }]) expect(() => planLegacyPromptImport(raw, [])).toThrow();
  expect(planLegacyPromptImport(null, []).imported).toBe(0);
});

test('combined library limits reject an oversized plan before any writes', () => {
  const current = Array.from({ length: 100 }, (_, index) => ({
    id: `id${index}`, name: `Name ${index}`, text: 'text', updatedAt: old.updatedAt,
  }));
  expect(() => planLegacyPromptImport({ prompts: [old] }, current)).toThrow();
  expect(current).toHaveLength(100);
});
