/**
 * Base URL for the mass API (health, timeline, OCR, Gemini upload, embeddings).
 * Empty string = same-origin requests (Vite dev proxy → `yarn serve:mass-api`).
 *
 * During `yarn serve`, this intentionally returns **empty** so traffic uses the Vite
 * proxy—even if `.env` sets `VITE_GEMINI_MASS_API_URL` for production builds.
 * That avoids health/OCR/embed pointing at Render while Python runs locally.
 *
 * To call the remote mass API while in dev, set `VITE_MASS_API_USE_REMOTE=true`.
 */
export function getMassApiBaseUrl(): string {
  const configured = (import.meta.env.VITE_GEMINI_MASS_API_URL || '').trim().replace(/\/$/, '');
  if (!configured) return '';
  if (import.meta.env.DEV && import.meta.env.VITE_MASS_API_USE_REMOTE !== 'true') {
    return '';
  }
  return configured;
}
