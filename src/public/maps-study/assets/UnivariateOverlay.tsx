import {
  useCallback, useEffect, useMemo, useState, useRef,
} from 'react';
import * as d3 from 'd3';
import {
  Box, Button, Flex,
  Slider,
} from '@mantine/core';
import {
  IconArrowBackUp, IconArrowForwardUp, IconEdit, IconHandFinger,
  IconTrashX,
} from '@tabler/icons-react';
import { initializeTrrack, Registry } from '@trrack/core';
import { PREFIX } from '../../../utils/Prefix';
import {
  ColumnFormat, ColumnScale, CountyModel,
} from './types';
import USMap from './USMap';
import { SharedStateProvider, useSharedState } from './SharedStateContext';
import { formatColumn } from './utils';
import UnivariateLegend from './UnivariateLegend';
import classes from './Map.module.css';
import DrawOverlay from './DrawOverlay';
import useDrawing from './useDrawing';
import { TrrackedProvenance } from '../../../store/types';
import useProvenance from './useProvenance';
import { ParticipantData } from '../../../storage/types';

interface Parameters {
  taskid: string
  dataPath: string
  columnA: string
  columnB: string
  columnAFormat: ColumnFormat
  columnBFormat: ColumnFormat
  columnAScale: ColumnScale
  columnBScale: ColumnScale
  draw: boolean
  countySelections: boolean
}

const colorsA = d3.schemeReds[5];
const colorsB = d3.schemeBlues[5];
// const thresholdsA = [0, 12, 24, 100];
// const thresholdsB = [0, 50, 75, 100];
const thresholdsA = [0, 9, 12, 24, 53, 100];
const thresholdsB = [0, 5, 50, 75, 96, 100];

// const n = colorsA.length;

function getScale(data: CountyModel[], column: string, columnScale: ColumnScale, colors: readonly string[]) {
  const thresholds = column === 'medicaid_rate' ? thresholdsA : thresholdsB;
  const scale = d3.scaleThreshold<number, string>()
    .domain(thresholds.slice(1, -1))
    .range(colors);

  return scale;
}

function UniVariate(props: {parameters: Parameters, participantsData: ParticipantData[], trialId: string, heatmapEnabled ?: boolean}) {
  const {
    draw: hasDrawing, dataPath, columnA, columnB, columnAFormat, columnBFormat, columnAScale, columnBScale, countySelections,
  } = props.parameters;
  const [mapOpacity, setMapOpacity] = useState(100);

  const { participantsData, trialId, heatmapEnabled } = props;

  const allDrawings = useMemo(() => {
    const provenanceData = participantsData.map((participantData) => {
      // console.log(Object.keys(participantData.answers));
      const keys: {[k: string]: string} = {};

      for (const k of Object.keys(participantData.answers)) {
        const kk = k.substring(0, k.lastIndexOf('_'));
        keys[kk] = k;
        if (kk === trialId) {
          const reg = Registry.create();

          const trrack = initializeTrrack({ registry: reg, initialState: {} });

          const provGraph = participantData.answers[k].provenanceGraph.stimulus as unknown as TrrackedProvenance;
          if (provGraph) {
            trrack.importObject(structuredClone(provGraph));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (trrack.getState() as any).all.drawObjects;
          }
        }
      }
      return null;
    }).filter((a) => !!a);

    return provenanceData.flat();
  }, [participantsData, trialId]);

  useEffect(() => {
    document.body.classList.add(classes.mapsPageBg);

    return () => {
      document.body.classList.remove(classes.mapsPageBg);
    };
  }, []);

  const [data, setData] = useState<CountyModel[]>([]);
  const [dataById, setDataById] = useState<{ [key: string]: CountyModel }>({});

  const [transform, setTransform] = useState(d3.zoomIdentity);
  const provenance = useProvenance();
  const { trrack, actions } = provenance;

  const {
    selectedCounties, setEnableCountySelection, verbalized,
  } = useSharedState();
  const { taskid } = props.parameters;

  const drawButtonRef = useRef<HTMLButtonElement>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const redoButtonRef = useRef<HTMLButtonElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEnableCountySelection(countySelections);
  }, [countySelections, setEnableCountySelection]);

  useEffect(() => {
    trrack.apply('SelectDeselect', actions.trackSelectedCountiesFips(selectedCounties.map((county) => county.fips)));
  }, [trrack, actions, selectedCounties]);

  useEffect(() => {
    trrack.apply('Verbalized', actions.trackVerbalized(verbalized));
  }, [trrack, actions, verbalized]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const {
    enabled: drawingEnabled,
    setEnabled: setDrawingEnabled,
    add: addDrawObject, undo, redo, undoEnabled, redoEnabled, clear: clearDrawing,
  } = useDrawing(provenance);

  const handleTransform = useCallback((d: d3.ZoomTransform) => {
    setTransform(d);
    window.d3 = d3;

    const serialized = {
      x: d.x,
      y: d.y,
      k: d.k,
    };

    trrack.apply('Transform', actions.trackTransform(serialized));
  }, [trrack, actions]);

  useEffect(() => {
    const getData = async function getData() {
      if (dataPath && columnA && columnB) {
        const _data = (await d3.csv(`${PREFIX}${dataPath}`, (d): CountyModel | null => {
          const result: CountyModel = {
            fips: d.fips || '',
            county: d.county || '',
          };
          if (d[columnA] === '#N/A' || d[columnB] === '#N/A') {
            return null;
          }
          // Add all remaining keys dynamically
          for (const key in d) {
            if (key !== 'fips' && key !== 'county') {
              const val = d[key];
              result[key] = val;
            }
          }
          return result;
        })).filter((d) => !!d);

        const _formattedData = _data.reduce<{ [fips: string]: CountyModel }>((acc, d) => {
          acc[d.fips] = {
            ...d,
            fips: d.fips,
            county: d.county,
            [columnA]: +d[columnA],
            [columnB]: +d[columnB],
          };

          return acc;
        }, {});

        setData(_data as CountyModel[]);
        setDataById(_formattedData);
      }
    };

    getData();
  }, [dataPath, columnA, columnB]);

  const x = useMemo(
    () => getScale(data, columnA, columnAScale, colorsA),
    [data, columnA, columnAScale],
  );

  const y = useMemo(
    () => getScale(data, columnB, columnBScale, colorsB),
    [data, columnB, columnBScale],
  );

  const avgMedicaidRateAxisValue = useMemo(() => 0.56, []);

  const colorFnColumnA = useCallback((county: CountyModel) => {
    if (!county) return '#f5f5f5';
    const v = county[columnA] as number;
    if (columnAScale === 'logarithmic') { return x(Math.log10(v + 1)); }
    return x(v);
  }, [x, columnA, columnAScale]);

  const colorFnColumnB = useCallback((county: CountyModel) => {
    if (!county) return '#f5f5f5';
    const v = county[columnB] as number;
    if (columnBScale === 'logarithmic') { return y(Math.log10(v + 1)); }
    return y(v);
  }, [y, columnB, columnBScale]);

  const { legendValuesColumnA, legendValuesColumnB } = useMemo(() => {
    const tA = columnA === 'medicaid_rate' ? thresholdsA : thresholdsB;
    const tB = columnB === 'medicaid_rate' ? thresholdsA : thresholdsB;
    return {
      legendValuesColumnA: tA.map((v) => formatColumn(columnAFormat)(v)),
      legendValuesColumnB: tB.map((v) => formatColumn(columnBFormat)(v)),
    };
  }, [columnA, columnB, columnAFormat, columnBFormat]);

  // const nextButtonEnabled = useMemo(() => {
  //   if (isAnalysis) {
  //     return false;
  //   }
  //   if (hasThinkaloud && !verbalized) {
  //     return false;
  //   }
  //   if (hasCountiesSelection && selectedCounties.length < 5) {
  //     return false;
  //   }
  //   if (hasDrawing && drawObjects.length === 0) {
  //     return false;
  //   }
  //   return true;
  // }, [hasCountiesSelection, hasThinkaloud, selectedCounties, verbalized, isAnalysis, hasDrawing, drawObjects.length]);

  return (
    <div>
      <Flex align="center" direction="column" mt="lg">
        {hasDrawing && (
          <Box pos="relative">
            <Flex pos="relative" direction="row">
              <Button
                ref={drawButtonRef}
                type="button"
                variant={drawingEnabled ? 'filled' : 'default'}
                color="rgba(92, 92, 92, 1)"
                onClick={() => {
                  setDrawingEnabled((e) => !e);
                }}
                title="Toggle drawing"
                size="sm"
              >
                {drawingEnabled ? (
                  <IconEdit size={16} />
                ) : <IconHandFinger size={16} /> }
                Toggle Drawing / Panning
              </Button>
              <Button
                ref={undoButtonRef}
                ml="md"
                type="button"
                variant="default"
                onClick={undo}
                title="Undo"
                disabled={!undoEnabled}
                size="sm"
              >
                <IconArrowBackUp size={16} />
                Undo
              </Button>
              <Button
                ref={redoButtonRef}
                ml="md"
                type="button"
                variant="default"
                onClick={redo}
                title="Redo"
                disabled={!redoEnabled}
                size="sm"
              >
                <IconArrowForwardUp size={16} />
                Redo
              </Button>
              <Button
                ref={clearButtonRef}
                ml="md"
                type="button"
                variant="default"
                onClick={clearDrawing}
                title="Clear"
                size="sm"
              >
                <IconTrashX size={16} />
                Clear all
              </Button>
            </Flex>
          </Box>
        )}
        <Flex gap="md" direction="row" justify="center">
          <div className={classes.mapRow}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div>Medicaid Rate</div>
              <div className={classes.mapWrapperUnivariate} id="medicaid-rate-map">
                {heatmapEnabled && (
                <div style={{ position: 'absolute', top: -50, width: 300 }}>
                  <Slider
                    color="blue"
                    size="xl"
                    value={mapOpacity}
                    marks={[
                      { value: 20, label: '20%' },
                      { value: 50, label: '50%' },
                      { value: 80, label: '80%' },
                    ]}
                    onChange={setMapOpacity}
                  />
                </div>
                )}
                <div style={{ opacity: mapOpacity / 100 }}>
                  <USMap
                    data={dataById}
                    colorFn={colorFnColumnB}
                    plots={[columnB]}
                    formatters={[formatColumn(columnAFormat)]}
                    transform={transform}
                    setTransform={handleTransform}
                    taskid={taskid}
                    width={600}
                    height={350}
                  />
                </div>
                <UnivariateLegend colors={colorsB} values={legendValuesColumnB} columnType={columnB} avgColumnPercentage={avgMedicaidRateAxisValue} />
                {hasDrawing && (
                  <DrawOverlay
                    width={600}
                    height={350}
                    // height={422}
                    // width={797}
                    addObject={addDrawObject}
                    objects={allDrawings}
                    transform={transform}
                    isEnabled={drawingEnabled}
                    heatmapEnabled={heatmapEnabled}
                  />
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div>Trump 2024 Vote Share</div>
              <div className={classes.mapWrapperUnivariate} id="trump-vote-map">
                <div style={{ opacity: mapOpacity / 100 }}>

                  <USMap
                    data={dataById}
                    colorFn={colorFnColumnA}
                    plots={[columnA]}
                    formatters={[formatColumn(columnAFormat)]}
                    transform={transform}
                    setTransform={handleTransform}
                    taskid={taskid}
                    width={600}
                    height={350}
                  />
                </div>
                <UnivariateLegend colors={colorsA} values={legendValuesColumnA} columnType={columnA} />
                {hasDrawing && (
                <DrawOverlay
                  width={600}
                  height={350}
                  addObject={addDrawObject}
                  objects={allDrawings}
                  transform={transform}
                  isEnabled={drawingEnabled}
                  heatmapEnabled={heatmapEnabled}
                />
                )}
              </div>
            </div>
          </div>
        </Flex>
      </Flex>
      <div
        id="tooltipContainer"
        style={{
          position: 'fixed', top: 0, left: 0, zIndex: 1000,
        }}
      />
    </div>
  );
}

function UniVariateWrapper(props: {parameters: Record<string, unknown>, participantsData: ParticipantData[], trialId: string, heatmapEnabled?: boolean}) {
  const { parameters: p, ...rprops } = props;
  const parameters = p as unknown as Parameters;
  return (
    <SharedStateProvider>
      <UniVariate parameters={parameters} {...rprops} />
    </SharedStateProvider>
  );
}

export default UniVariateWrapper;
