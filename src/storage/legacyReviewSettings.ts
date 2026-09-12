import type { ReviewArtifacts } from './reviewArtifacts';

/** Read the two pipeline preference formats written by the MQP fork. */
export function legacyReviewPipeline(raw: unknown): ReviewArtifacts['settings']['pipeline'] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid legacy analysis settings');
  const value = raw as Record<string, unknown>;
  if (value.useLocalModel !== undefined && typeof value.useLocalModel !== 'boolean') throw new Error('Invalid legacy local-model preference');
  if (value.summarizationPipeline !== undefined) {
    if (value.summarizationPipeline === 'gemini' || value.summarizationPipeline === 'gpt4o' || value.summarizationPipeline === 'local') return value.summarizationPipeline;
    throw new Error('Unknown legacy analysis pipeline');
  }
  if (typeof value.useLocalModel === 'boolean') return value.useLocalModel ? 'local' : 'gemini';
  throw new Error('Legacy analysis settings have no pipeline preference');
}
