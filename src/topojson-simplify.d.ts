declare module 'topojson-simplify' {
  import type { Topology } from 'topojson-specification';

  export function presimplify<T extends Topology>(topology: T): T;
  export function simplify<T extends Topology>(topology: T, weight: number): T;
}
