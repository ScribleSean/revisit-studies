import type { ReviewClip } from '../../../storage/reviewArtifacts';

export type RecordingTarget = ReviewClip & { timestamp?: number };

export function recordingQuery(clip: RecordingTarget) {
  const params = new URLSearchParams({ participant: clip.participantId, task: clip.taskId });
  if (Number.isFinite(clip.timestamp) && clip.timestamp! >= 0) params.set('time', String(clip.timestamp));
  return params;
}

export function recordingTarget(params: URLSearchParams): RecordingTarget | null {
  const participantId = params.get('participant'); const taskId = params.get('task');
  if (!participantId || !taskId) return null;
  const time = params.get('time'); const timestamp = time === null || !time.trim() ? undefined : Number(time);
  return { participantId, taskId, ...(timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0 ? { timestamp } : {}) };
}
