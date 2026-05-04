/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When set (e.g. `prod-`), overrides dev/prod prefix for Storage paths (`dev-maps-study` vs `prod-maps-study`). */
  readonly VITE_FIREBASE_COLLECTION_PREFIX?: string;
  /** When "true", skip Firebase App Check initialization (e.g. analyst builds where reCAPTCHA domain/token mismatches GitHub Pages). */
  readonly VITE_FIREBASE_DISABLE_APP_CHECK?: string;
  /** Dev only: when "true", use `VITE_GEMINI_MASS_API_URL` instead of the default Vite proxy to localhost mass-api. */
  readonly VITE_MASS_API_USE_REMOTE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'topojson-simplify' {
  import type { Topology } from 'topojson-specification';

  /** Preserves the topology generic so `topojson.feature` resolves to the GeometryCollection overload. */
  export function presimplify<T extends Topology>(topology: T): T;

  export function simplify<T extends Topology>(topology: T, weight?: number): T;
}
