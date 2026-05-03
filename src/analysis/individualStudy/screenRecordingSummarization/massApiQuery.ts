/**
 * Helpers for GET-only mass-api calls (videoUrl / companionAudioUrl must be fetchable by the server).
 */

/** URLs the mass-api server can fetch (HTTPS storage or dev localhost HTTP). */
export function massApiFetchableMediaUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (u.startsWith('https://')) return u;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(u)) return u;
  return null;
}

export const MASS_API_FETCHABLE_URL_HELP = 'Mass API needs HTTPS storage download URLs (Firebase/Supabase). Local IndexedDB mode uses blob URLs, which the server cannot fetch.';

/** UTF-8 → base64url (no padding) for long query payloads (e.g. embed-summary). */
export function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildMassApiUrl(baseUrl: string, params: Record<string, string | undefined | null>): string {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  });
  const q = qs.toString();
  if (!q) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${q}`;
}
