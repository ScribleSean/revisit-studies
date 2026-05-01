/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** When "true", skip Firebase App Check initialization (e.g. analyst builds where reCAPTCHA domain/token mismatches GitHub Pages). */
  readonly VITE_FIREBASE_DISABLE_APP_CHECK?: string;
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
