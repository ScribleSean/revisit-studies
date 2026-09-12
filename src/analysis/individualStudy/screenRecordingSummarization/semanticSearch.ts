import type { ReviewArtifacts, ReviewClip } from '../../../storage/reviewArtifacts';

export type EmbeddedClip = ReviewClip & { embedding: ReviewArtifacts['embedding']; text: string };

function normalized(vector: number[]) {
  if (!Array.isArray(vector) || !vector.length || !Array.from(vector).every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const scale = vector.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (scale === 0) return null;
  const length = Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0));
  return vector.map((value) => (value / scale) / length);
}

/** Model and dimensionality must match; incompatible or malformed stored vectors are excluded. */
export function rankClips(query: ReviewArtifacts['embedding'], clips: EmbeddedClip[], limit = 5) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Search limit must be positive');
  const q = normalized(query.vector);
  if (!q || !query.model) throw new Error('Invalid query embedding');
  const ranked = clips.flatMap((clip) => {
    if (clip.embedding.model !== query.model || clip.embedding.vector.length !== q.length) return [];
    const vector = normalized(clip.embedding.vector);
    if (!vector) return [];
    const score = Math.max(-1, Math.min(1, q.reduce((sum, value, index) => sum + value * vector[index], 0)));
    return [{ ...clip, score }];
  });
  return ranked.sort((a, b) => b.score - a.score || JSON.stringify([a.participantId, a.taskId]).localeCompare(JSON.stringify([b.participantId, b.taskId]))).slice(0, limit);
}
