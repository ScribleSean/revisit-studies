import { useCallback, useEffect, useState } from 'react';
import { DrawObjectModel, ProvenanceStateModel, SetAnswer } from './types';
import { ProvenanceModel } from './useProvenance';

const useDrawing = (provenance: ProvenanceModel, setAnswer?: (answer: SetAnswer) => void, provenanceState?: ProvenanceStateModel) => {
  const [enabled, setEnabled] = useState(true);
  const [redoHistory, setRedoHistory] = useState<DrawObjectModel[]>([]);
  const [objects, setObjects] = useState<DrawObjectModel[]>([]);

  const { trrack, actions } = provenance;

  useEffect(() => {
    setObjects(provenanceState?.all.drawObjects || []);
  }, [provenanceState?.all.drawObjects]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        setEnabled(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        setEnabled(false);
      }
    };

    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const add = useCallback((v: number[][]) => {
    setRedoHistory([]);
    const d = objects;
    const newObjects = [...d, v];
    setObjects(newObjects);
    trrack.apply('Add', actions.trackDrawObjects(newObjects));
  }, [objects, trrack, actions]);

  const clear = useCallback(() => {
    setRedoHistory([]);
    setObjects([]);
    trrack.apply('Clear', actions.trackDrawObjects([]));
  }, [trrack, actions]);

  const undo = useCallback(() => {
    setObjects((o) => {
      if (o.length > 0) {
        const newObjects = [...o];
        const newO = newObjects.pop();
        if (newO) {
          setRedoHistory((r) => {
            const newR = [...r];
            newR.push(newO);
            return newR;
          });
        }
        trrack.apply('Undo', actions.trackDrawObjects(newObjects));
        return newObjects;
      }
      trrack.apply('Undo', actions.trackDrawObjects([]));
      return [];
    });
  }, [trrack, actions]);

  const redo = useCallback(() => {
    const newR = [...redoHistory];

    if (newR.length === 0) return;

    const h = newR.pop()!;
    const newObjects = [...objects, h];
    setObjects(newObjects);
    trrack.apply('Redo', actions.trackDrawObjects(newObjects));
    setRedoHistory(newR);
  }, [redoHistory, objects, trrack, actions]);

  return {
    enabled,
    setEnabled,
    objects,
    undo,
    redo,
    undoEnabled: !!objects.length,
    redoEnabled: !!redoHistory.length,
    add,
    clear,
  };
};

export default useDrawing;
