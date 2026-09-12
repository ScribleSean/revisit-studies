import { validateReviewValue, type SavedReviewPrompt } from './reviewArtifacts';

export type LegacyPromptConflict = { id: string; name: string; reason: 'id' | 'name' };

/** Plans a copy from the old fork's root screenRecordingPrompts artifact. Never mutates either source. */
export function planLegacyPromptImport(raw: unknown, current: SavedReviewPrompt[]) {
  validateReviewValue('settings', { pipeline: 'heuristic', confusionWords: [], promptLibrary: current });
  if (raw === null || raw === undefined) {
    return {
      library: structuredClone(current), imported: 0, identical: 0, conflicts: [] as LegacyPromptConflict[],
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || !('prompts' in raw) || !Array.isArray(raw.prompts) || raw.prompts.length > 100) throw new Error('Invalid legacy prompt library');
  const incoming: SavedReviewPrompt[] = Array.from(raw.prompts).map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('id' in entry) || !('name' in entry) || !('prompt' in entry) || !('updatedAt' in entry)) throw new Error('Invalid legacy prompt entry');
    const converted = {
      id: entry.id, name: entry.name, text: entry.prompt, updatedAt: entry.updatedAt,
    };
    validateReviewValue('settings', { pipeline: 'heuristic', confusionWords: [], promptLibrary: [converted] });
    return converted as SavedReviewPrompt;
  });
  if (new Set(incoming.map((entry) => entry.id)).size !== incoming.length) throw new Error('Legacy prompt IDs are duplicated');
  const library = structuredClone(current);
  const conflicts: LegacyPromptConflict[] = [];
  let imported = 0; let identical = 0;
  for (const entry of incoming) {
    const byId = library.find((saved) => saved.id === entry.id);
    const byName = library.find((saved) => saved.name.trim().toLowerCase() === entry.name.trim().toLowerCase());
    if (byId && byId.name === entry.name && byId.text === entry.text) identical += 1;
    else if (byId || byName) conflicts.push({ id: entry.id, name: entry.name, reason: byId ? 'id' : 'name' });
    else { library.push({ ...entry }); imported += 1; }
  }
  validateReviewValue('settings', { pipeline: 'heuristic', confusionWords: [], promptLibrary: library });
  return {
    library, imported, identical, conflicts,
  };
}
