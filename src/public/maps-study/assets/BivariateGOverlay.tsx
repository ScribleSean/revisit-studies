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
import BivariateLegend from './BivariateLegend_G';
import classes from './Map.module.css';
import useDrawing from './useDrawing';
import DrawOverlay from './DrawOverlay';
import useProvenance from './useProvenance';
import { TrrackedProvenance } from '../../../store/types';
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

const colors = [
  '#e8e8e8',
  '#e4acac',
  '#c85a5a',
  '#b0d5df',
  '#ad9ea5',
  '#985356',
  '#64acbe',
  '#627f8c',
  '#574249',
];

const n = Math.floor(Math.sqrt(colors.length));

const parseNumber = (value: string | number): number => {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;

  const cleaned = String(value).replace(/,/g, '');
  const num = +cleaned;
  return Number.isNaN(num) ? NaN : num;
};

function getBivariateScale(data: CountyModel[], column: string, columnScale: ColumnScale) {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  let values: number[] = [];

  if (columnScale === 'logarithmic') {
    values = data.map((d) => +d[column]).map((d) => Math.log10(d));
  } else {
    values = data.map((d) => +d[column]);
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  const scale = d3.scaleThreshold<number, number>()
    .domain([250, 800])
    .range([0, 1, 2]);

  return scale;
}

function BiVariate(props: {parameters: Parameters, participantsData: ParticipantData[], trialId: string, heatmapEnabled?: boolean}) {
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
  // const { provenanceState, setAnswer } = props;
  const { taskid } = props.parameters;

  const drawButtonRef = useRef<HTMLButtonElement>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const redoButtonRef = useRef<HTMLButtonElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);

  const {
    selectedCounties, setEnableCountySelection, verbalized,
  } = useSharedState();

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
            console.warn('NA data', d);
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

        const _formattedData = _data.reduce<{ [fips: string]: CountyModel }>(
          (acc, d) => {
            acc[d.fips] = {
              ...d,
              fips: d.fips,
              county: d.county,
              [columnA]: parseNumber(d[columnA] as string),
              [columnB]: parseNumber(d[columnB] as string),
            };

            return acc;
          },
          {},
        );

        setData(_data as CountyModel[]);
        setDataById(_formattedData);
      }
    };

    getData();
  }, [dataPath, columnA, columnB]);

  const { x, y } = useMemo(() => ({
    x: getBivariateScale(data, columnA, columnAScale),
    y: getBivariateScale(data, columnB, columnBScale),
  }), [data, columnA, columnB, columnAScale, columnBScale]);

  const avgMedicaidRateAxisValue = useMemo(() => {
    const m = d3.mean((data), (d) => +d.medicaid_rate || 0) || 0;

    const [min, max] = y.domain();

    const percentageY = ((m - min) / (max - min));
    return percentageY;
  }, [data, y]);

  const colorFn = useCallback(
    (county: CountyModel) => {
      if (!county) return '#f5f5f5';
      let xValue = 0;
      let yValue = 0;

      if (Number.isNaN(county[columnA]) || Number.isNaN(county[columnB])) {
        return '#f5f5f5';
      }

      if (columnAScale === 'logarithmic') {
        xValue = Math.log10(county[columnA] as number);
      } else {
        xValue = (county[columnA] || 0) as number;
      }
      if (columnBScale === 'logarithmic') {
        yValue = Math.log10(county[columnB] as number);
      } else {
        yValue = (county[columnB] || 0) as number;
      }

      const xIndex = x(xValue);
      const yIndex = y(yValue);

      return colors[
        yIndex * n + xIndex
      ];
    },
    [x, y, columnA, columnB, columnAScale, columnBScale],
  );

  const { legendValuesColumnA, legendValuesColumnB } = useMemo(() => {
    let _legendValuesColumnA: string[] = [];
    if (columnAScale === 'logarithmic') {
      _legendValuesColumnA = [x.domain()[0], ...x.domain(), x.domain()[1]].map((a) => formatColumn(columnAFormat)(10 ** a));
    } else {
      _legendValuesColumnA = ['<250', '500', '750', '1000+'].map((a) => a);
    }

    let _legendValuesColumnB: string[] = [];
    if (columnBScale === 'logarithmic') {
      _legendValuesColumnB = [y.domain()[0], ...y.domain(), y.domain()[1]].map((a) => formatColumn(columnBFormat)(10 ** a));
    } else {
      _legendValuesColumnB = ['<250', '500', '750', '1000+'].map((a) => a);
    }

    return {
      legendValuesColumnA: _legendValuesColumnA,
      legendValuesColumnB: _legendValuesColumnB,
    };
  }, [columnAScale, columnBScale, x, y, columnAFormat, columnBFormat]);

  return (
    <div>
      <Flex gap="md" align="center" direction="column">
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
        <Flex>
          <div className={classes.mapWrapper} id="biv-map">
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
                colorFn={colorFn}
                plots={[columnA, columnB]}
                formatters={[formatColumn(columnAFormat), formatColumn(columnBFormat)]}
                transform={transform}
                setTransform={handleTransform}
                taskid={taskid}
                width={800}
                height={400}
              />
            </div>
            <DrawOverlay
              width={800}
              height={400}
              addObject={addDrawObject}
              // objects={drawObjects}
              objects={allDrawings}
              transform={transform}
              isEnabled={drawingEnabled}
              heatmapEnabled={heatmapEnabled}
            />
          </div>
          <Box w={400}>
            <BivariateLegend colors={colors} xValues={legendValuesColumnA} yValues={legendValuesColumnB} avgColumnBPercentage={avgMedicaidRateAxisValue} />
          </Box>
        </Flex>
      </Flex>
      <div
        id="tooltipContainer"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 1000,
        }}
      />

    </div>
  );
}

function BiVariateWrapper(props: {parameters: Record<string, unknown>, participantsData: ParticipantData[], trialId: string, heatmapEnabled?: boolean}) {
  const { parameters: p, ...rprops } = props;
  const parameters = p as unknown as Parameters;
  return (
    <SharedStateProvider>
      <BiVariate parameters={parameters} {...rprops} />
    </SharedStateProvider>
  );
}

export default BiVariateWrapper;
