function normalizeBase(base: string | undefined) {
  const b = (base || '/').trim() || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

// Prefer Vite's computed base URL (mirrors `vite.config.ts` `base`), since it is always set in prod builds.
export const PREFIX = import.meta.env.PROD
  ? normalizeBase(import.meta.env.BASE_URL)
  : '/';
