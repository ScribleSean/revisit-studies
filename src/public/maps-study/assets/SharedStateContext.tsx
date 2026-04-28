import {
  createContext, ReactNode, useCallback, useContext, useMemo, useState,
} from 'react';
import { CountyModel } from './types';

const SharedStateContext = createContext<{
  hoveredCounty: CountyModel | null;
  setHoveredCounty:(_: CountyModel | null) => void;
  selectedCounties: CountyModel[];
  setSelectedCounties:(_: CountyModel[]) => void;
  toggleSelectedCounty: (_:CountyModel) => void;
  enableCountySelection: boolean;
  setEnableCountySelection: (_: boolean) => void;
  verbalized: boolean;
  setVerbalized: (_:boolean) => void;
    }>({
      hoveredCounty: null,
      setHoveredCounty: (_: CountyModel | null) => {},
      selectedCounties: [],
      setSelectedCounties: (_: CountyModel[]) => {},
      toggleSelectedCounty: (_: CountyModel) => {},
      enableCountySelection: false,
      setEnableCountySelection: (_: boolean) => {},
      verbalized: false,
      setVerbalized: (_:boolean) => {},
    });

export function SharedStateProvider({ children }: {children: ReactNode}) {
  const [hoveredCounty, setHoveredCounty] = useState<CountyModel | null>(null);
  const [selectedCounties, setSelectedCounties] = useState<CountyModel[]>([]);
  const [enableCountySelection, setEnableCountySelection] = useState<boolean>(false);
  const [verbalized, setVerbalized] = useState(false);

  const toggleSelectedCounty = useCallback((county: CountyModel) => {
    if (enableCountySelection) {
      setSelectedCounties((counties) => {
        if (counties.findIndex((c) => c.fips === county.fips) === -1) {
          if (counties.length >= 5) {
            return counties;
          }
          return [...counties, county];
        }
        return counties.filter((c) => c.fips !== county.fips);
      });
    } else {
      setSelectedCounties([]);
    }
  }, [enableCountySelection]);

  const sharedValue = useMemo(() => ({
    hoveredCounty,
    setHoveredCounty,
    selectedCounties,
    setSelectedCounties,
    toggleSelectedCounty,
    enableCountySelection,
    setEnableCountySelection,
    verbalized,
    setVerbalized,
  }), [hoveredCounty, selectedCounties, toggleSelectedCounty, enableCountySelection, verbalized]);

  return (
    <SharedStateContext.Provider value={sharedValue}>
      {children}
    </SharedStateContext.Provider>
  );
}

export const useSharedState = () => useContext(SharedStateContext);
