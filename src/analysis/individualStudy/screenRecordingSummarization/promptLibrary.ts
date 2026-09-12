import { validateReviewValue, type SavedReviewPrompt } from '../../../storage/reviewArtifacts';

export function saveNamedPrompt(library: SavedReviewPrompt[], name: string, text: string, id?: string) {
  if (id && !library.some((entry) => entry.id === id)) throw new Error('The selected prompt no longer exists.');
  const entry = {
    id: id || crypto.randomUUID(), name: name.trim(), text, updatedAt: new Date().toISOString(),
  };
  const next = id ? library.map((row) => (row.id === id ? entry : row)) : [...library, entry];
  if (next.some((row) => row.id !== entry.id && row.name.trim().toLocaleLowerCase() === entry.name.toLocaleLowerCase())) throw new Error('A prompt with this name already exists. Select it to update it.');
  validateReviewValue('settings', { pipeline: 'heuristic', confusionWords: [], promptLibrary: next });
  return { library: next, id: entry.id };
}
