import { StoredAnswer, TrrackedProvenance } from '../../../store/types';

export interface CountyModel {
  fips: string;
  county: string;
  [key: string]: number | string;
}

export type ColumnFormat = 'thousands-separator' | 'normal-percentage' | 'percentage';

export type ColumnScale = 'linear' | 'logarithmic';

export type DrawObjectModel = number[][];

export interface ProvenanceStateModel {
  all: {
    drawObjects: DrawObjectModel[]
    transform: {x: number, y: number, k: number}
    selectedCountiesFips: string[]
    verbalized: false
  }
}

export interface SetAnswer {
  status: boolean;
  provenanceGraph?: TrrackedProvenance;
  answers: StoredAnswer['answer'];
}
