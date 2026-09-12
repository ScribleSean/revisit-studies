export type ReviewDiagnosticMeta = {
  duration: number;
  audio_skipped?: boolean;
  audio_skip_reason?: string;
  scene_error?: string;
  ocr_error?: string;
  cleanupWarning?: string;
};

/** Historical diagnostics travel with the analysis, not the current service state. */
export function recordedDiagnostics(meta: ReviewDiagnosticMeta): string[] {
  if (meta.audio_skipped !== undefined && typeof meta.audio_skipped !== 'boolean') throw new Error('Invalid audio diagnostic');
  for (const value of [meta.audio_skip_reason, meta.scene_error, meta.ocr_error, meta.cleanupWarning]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 2000)) throw new Error('Invalid analysis diagnostic');
  }
  return [
    meta.audio_skipped ? `Audio analysis skipped: ${meta.audio_skip_reason || 'unavailable'}` : '',
    meta.scene_error ? `Scene analysis: ${meta.scene_error}` : '',
    meta.ocr_error ? `OCR unavailable: ${meta.ocr_error}` : '',
    meta.cleanupWarning || '',
  ].filter(Boolean).map((message) => (message.length > 2000 ? `${message.slice(0, 1999)}…` : message));
}
