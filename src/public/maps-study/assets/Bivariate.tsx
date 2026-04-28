import {
  useCallback, useEffect, useMemo, useState, useRef,
} from 'react';
import * as d3 from 'd3';
import {
  Box, Button, Checkbox, Flex, Text,
} from '@mantine/core';
import {
  IconArrowBackUp, IconArrowForwardUp, IconEdit, IconHandFinger,
  IconTrashX,
} from '@tabler/icons-react';
import { TextButton } from './TextButton';
import { PREFIX } from '../../../utils/Prefix';
import {
  ColumnFormat, ColumnScale, CountyModel, ProvenanceStateModel,
} from './types';
import USMap from './USMap';
import { SharedStateProvider, useSharedState } from './SharedStateContext';
import { formatColumn } from './utils';
import BivariateLegend from './BivariateLegend';
import classes from './Map.module.css';
import useDrawing from './useDrawing';
import DrawOverlay from './DrawOverlay';
import useProvenance from './useProvenance';
import { StimulusParams } from '../../../store/types';
import { useNextStep } from '../../../store/hooks/useNextStep';
import { useIsAnalysis } from '../../../store/hooks/useIsAnalysis';
import { useStoredAnswer } from '../../../store/hooks/useStoredAnswer';

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

function getScale(data: CountyModel[], column: string, columnScale: ColumnScale) {
  let values: number[];

  if (columnScale === 'logarithmic') {
    values = data.map((d) => +d[column]).filter((d) => d > 0).map((d) => Math.log10(d));
  } else {
    values = data.map((d) => +d[column]);
  }

  // Define manual breakpoints based on column type
  let breakpoints: number[];

  if (column === 'voter_rate') {
    breakpoints = [50, 75];
  } else if (column === 'medicaid_rate') {
    breakpoints = [12, 24];
  } else {
    const quantileScale = d3.scaleQuantile()
      .domain(values)
      .range(d3.range(3));
    breakpoints = quantileScale.quantiles();
  }

  const scale = (value: number) => {
    if (value < breakpoints[0]) return 0;
    if (value < breakpoints[1]) return 1;
    return 2;
  };

  scale.domain = () => d3.extent(values) as [number, number];
  scale.quantiles = () => breakpoints;
  return scale;
}

function BiVariate(props: StimulusParams<Parameters, ProvenanceStateModel>) {
  const {
    draw: hasDrawing, dataPath, columnA, columnB, columnAFormat, columnBFormat, columnAScale, columnBScale, countySelections,
  } = props.parameters;

  useEffect(() => {
    document.body.classList.add(classes.mapsPageBg);

    return () => {
      document.body.classList.remove(classes.mapsPageBg);
    };
  }, []);

  const { formOrder } = useStoredAnswer();
  const { hasCountiesSelection, hasThinkaloud } = useMemo(() => {
    const r = formOrder?.response || [];

    return {
      hasCountiesSelection: r.indexOf('selectedCounties') !== -1,
      hasThinkaloud: r.indexOf('thinkaloud') !== -1,
    };
  }, [formOrder]);

  const isAnalysis = useIsAnalysis();

  const [data, setData] = useState<CountyModel[]>([]);
  const [dataById, setDataById] = useState<{ [key: string]: CountyModel }>({});
  const [transform, setTransform] = useState(d3.zoomIdentity);

  const [canGoToNextStep, setCanGoToNextStep] = useState(false);

  const provenance = useProvenance();
  const { trrack, actions } = provenance;
  const { provenanceState, setAnswer } = props;
  const { taskid } = props.parameters;

  const nextButtonRef = useRef<HTMLButtonElement>(null);
  const drawButtonRef = useRef<HTMLButtonElement>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const redoButtonRef = useRef<HTMLButtonElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);

  const {
    selectedCounties, setSelectedCounties, setEnableCountySelection, toggleSelectedCounty, verbalized, setVerbalized,
  } = useSharedState();

  const { goToNextStep } = useNextStep();

  const handleRecordAnswers = useCallback(() => {
    setAnswer({
      status: true,
      answers: hasDrawing ? {} : {
        [taskid]: selectedCounties.map((county) => county.fips),
      },
      provenanceGraph: trrack.graph.backend,
    });

    setCanGoToNextStep(true);
  }, [selectedCounties, trrack, setAnswer, taskid, hasDrawing]);

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

  useEffect(() => {
    if (canGoToNextStep) {
      setTimeout(() => {
        goToNextStep();
      }, 2000);
    }
  }, [canGoToNextStep, goToNextStep]);

  const {
    enabled: drawingEnabled,
    setEnabled: setDrawingEnabled,
    add: addDrawObject, objects: drawObjects, undo, redo, undoEnabled, redoEnabled, clear: clearDrawing,
  } = useDrawing(provenance, setAnswer, provenanceState);

  useEffect(() => {
    const t = provenanceState?.all.transform;
    const _transform = d3.zoomIdentity.translate(t?.x || 0, t?.y || 0).scale(t?.k || 1);
    setTransform(_transform);
  }, [provenanceState?.all.transform]);

  useEffect(() => {
    if (provenanceState?.all.selectedCountiesFips) {
      setSelectedCounties(provenanceState.all.selectedCountiesFips.map((fips) => dataById[fips]));
    }
  }, [provenanceState?.all.selectedCountiesFips, dataById, setSelectedCounties]);

  useEffect(() => {
    if (provenanceState?.all.verbalized !== undefined) {
      setVerbalized(provenanceState.all.verbalized);
    }
  }, [provenanceState?.all.verbalized, setVerbalized]);

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
              [columnA]: +d[columnA],
              [columnB]: +d[columnB],
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
    x: getScale(data, columnA, columnAScale),
    y: getScale(data, columnB, columnBScale),
  }), [data, columnA, columnB, columnAScale, columnBScale]);

  const avgMedicaidRateAxisValue = useMemo(
    () => 0.3,
    // const m = d3.mean((data), (d) => +d.medicaid_rate || 0) || 0;

    // const [min, max] = y.domain();

    // const percentageY = ((m - min) / (max - min));

    // console.log(percentageY);

    // return percentageY;
    [],
  );

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
      return colors[
        y(yValue) * n + x(xValue)
      ];
    },
    [x, y, columnA, columnB, columnAScale, columnBScale],
  );

  const { legendValuesColumnA, legendValuesColumnB } = useMemo(() => {
    let _legendValuesColumnA:string[] = [];
    if (columnAScale === 'logarithmic') {
      _legendValuesColumnA = [x.domain()[0], ...x.quantiles(), x.domain()[1]].map((a) => formatColumn(columnAFormat)(10 ** a));
    } else {
      _legendValuesColumnA = [x.domain()[0], ...x.quantiles(), x.domain()[1]].map((a) => formatColumn(columnAFormat)(a));
    }

    let _legendValuesColumnB:string[] = [];
    if (columnBScale === 'logarithmic') {
      _legendValuesColumnB = [y.domain()[0], ...y.quantiles(), y.domain()[1]].map((a) => formatColumn(columnBFormat)(10 ** a));
    } else {
      _legendValuesColumnB = [y.domain()[0], ...y.quantiles(), y.domain()[1]].map((a) => formatColumn(columnBFormat)(a));
    }

    return {
      legendValuesColumnA: _legendValuesColumnA,
      legendValuesColumnB: _legendValuesColumnB,
    };
  }, [columnAScale, columnBScale, x, y, columnAFormat, columnBFormat]);

  const nextButtonEnabled = useMemo(() => {
    if (isAnalysis) {
      return false;
    }
    if (hasThinkaloud && !verbalized) {
      return false;
    }
    if (hasCountiesSelection && selectedCounties.length < 5) {
      return false;
    }
    if (hasDrawing && drawObjects.length === 0) {
      return false;
    }
    return true;
  }, [hasCountiesSelection, hasThinkaloud, selectedCounties, verbalized, isAnalysis, hasDrawing, drawObjects.length]);

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
            {hasDrawing && (
            <DrawOverlay
              width={800}
              height={400}
              addObject={addDrawObject}
              objects={drawObjects}
              transform={transform}
              isEnabled={drawingEnabled}
            />
            )}
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
      {hasCountiesSelection && (
        <div id="selectedCounties">
          <Text fw={600} mb="xs">
            You selected (
            {selectedCounties.length}
            {' '}
            / 5):
          </Text>
          {selectedCounties.map((county) => (
            <TextButton
              key={county.fips}
              name={`${county.county}, ${county.state}`}
              onClick={() => {
                toggleSelectedCounty(county);
              }}
            />
          ))}
          {selectedCounties.length === 0 && <Text c="gray.5">No counties selected</Text>}
        </div>
      )}

      {hasThinkaloud && (
      <Box mt="lg">
        <Checkbox
          label="Have you verbalized your thoughts?"
          onChange={(e) => setVerbalized(e.currentTarget.checked)}
        />
      </Box>
      )}

      <div>
        {/* <Button onClick={handleRecordAnswers} disabled={(hasDrawing || (taskid === 'bNarrate-3')) ? false : selectedCounties.length !== 5 || isAnalysis} mt="10" color="lime">Next</Button> */}
        <Button ref={nextButtonRef} onClick={handleRecordAnswers} disabled={!nextButtonEnabled} mt="10" color="lime" loading={!!canGoToNextStep}>Next</Button>
      </div>
    </div>
  );
}

function BiVariateWrapper(props: StimulusParams<Parameters, ProvenanceStateModel>) {
  return (
    <SharedStateProvider>
      <BiVariate {...props} />
    </SharedStateProvider>
  );
}

export default BiVariateWrapper;
