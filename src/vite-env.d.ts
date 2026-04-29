/// <reference types="vite/client" />

declare module 'topojson-simplify' {
  import type { Topology } from 'topojson-specification';

  /** Preserves the topology generic so `topojson.feature` resolves to the GeometryCollection overload. */
  export function presimplify<T extends Topology>(topology: T): T;

  export function simplify<T extends Topology>(topology: T, weight?: number): T;
}
