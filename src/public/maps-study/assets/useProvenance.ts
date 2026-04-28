import { initializeTrrack, Registry } from '@trrack/core';
import { useMemo } from 'react';
import { DrawObjectModel, ProvenanceStateModel } from './types';

const useProvenance = () => {
  const { actions, trrack } = useMemo(() => {
    const reg = Registry.create();

    const trackDrawObjects = reg.register('drawObject', (state, drawObjects: DrawObjectModel[]) => {
      state.all.drawObjects = drawObjects;
      return state;
    });

    const trackSelectedCountiesFips = reg.register('selectedCounties', (state, selectedCountiesFips: string[]) => {
      state.all.selectedCountiesFips = selectedCountiesFips;
      return state;
    });

    const trackVerbalized = reg.register('verbalized', (state, verbalized: boolean) => {
      state.all.verbalized = verbalized;
      return state;
    });

    const trackTransform = reg.register('transform', (state, transform: {x: number, y: number, k: number}) => {
      state.all.transform = transform;
      return state;
    });

    const trrackInst = initializeTrrack<ProvenanceStateModel>({
      registry: reg,
      initialState: {
        all: {
          drawObjects: [],
          transform: { k: 1, x: 0, y: 0 },
          selectedCountiesFips: [],
          verbalized: false,
        },
      },
    });

    return {
      actions: {
        trackDrawObjects,
        trackTransform,
        trackSelectedCountiesFips,
        trackVerbalized,
      },
      trrack: trrackInst,
    };
  }, []);

  return { actions, trrack };
};

export type ProvenanceModel = ReturnType<typeof useProvenance>;

export default useProvenance;
