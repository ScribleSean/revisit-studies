import { memo, useEffect } from 'react';
import * as topojson from 'topojson-client';
import * as topojsonSimplify from 'topojson-simplify';
import type {
  Topology,
  Objects,
  GeometryCollection,
} from 'topojson-specification';
import type { FeatureCollection } from 'geojson';

import * as d3 from 'd3';
import { useSVGMap } from './useSVGMap';
import us from './data/us-10m.v1.json' assert { type: 'json' };
import { CountyModel } from './types';
import { useSharedState } from './SharedStateContext';
import ToolTip from './ToolTip';
import classes from './Map.module.css';

interface USObjectData extends Objects {
  counties: GeometryCollection;
  states: GeometryCollection;
}

interface GeoFeatureWithID extends GeoJSON.Feature<GeoJSON.Geometry> {
  id: string;
}

const typedUS = us as unknown as Topology<USObjectData>;
const simplifiedTopology = topojsonSimplify.presimplify(typedUS);
const simplified = topojsonSimplify.simplify(simplifiedTopology, 0.25);

const simplifiedCounties = (
  topojson.feature(simplified, simplified.objects.counties) as unknown as FeatureCollection<GeoJSON.Geometry>
).features;

// const width = 600;
// const height = 400;

interface Props {
  data: { [key: string]: CountyModel };
  plots: string[];
  formatters: ((k: number) => string)[];
  colorFn: (c: CountyModel) => string;
  width: number,
  height: number,
  transform: d3.ZoomTransform;
  setTransform: (z: d3.ZoomTransform) => void;
  taskid?: string;
}

function USMap({
  data, plots, formatters, colorFn, transform, setTransform, taskid, width, height,
}: Props) {
  const {
    svgRef, gRef, zoom, tooltipX, tooltipY,
  } = useSVGMap(
    width,
    height,
    transform,
    setTransform,
  );

  const {
    hoveredCounty, setHoveredCounty, toggleSelectedCounty,
  } = useSharedState();

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }

    const svg = d3
      .select<SVGSVGElement, unknown>(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .attr('style', 'max-width: 100%; height: auto;');

    svg.call(zoom);
    const path = d3.geoPath();

    let g = svg.select<SVGGElement>('g.nationalMapGroup');
    if (g.empty()) {
      g = svg.append<SVGGElement>('g').attr('class', 'nationalMapGroup');
      gRef.current = g;
    }
    g.selectAll('*').remove();

    async function load() {
      g.append('g')
        .selectAll('path')
        .data(simplifiedCounties as GeoFeatureWithID[])
        .join('path')
        .attr('d', path)
        .attr('stroke-width', 0.25)
        .attr('fill', (d) => {
          if (data[d.id]) {
            return colorFn(data[d.id]);
          }
          if (d.id && d.id.startsWith('02')) {
            return '#e8e8e8';
          }
          return 'url(#crosshatch)';
        })
        .attr('data-id', (d) => d.id)
        .attr('stroke', '#fff')
        .on('mouseenter', (_, d) => {
          setHoveredCounty(data[d.id]);
        })
        .on('mouseleave', () => {
          setHoveredCounty(null);
        })
        .on('click', (_, d) => {
          const county = data[d.id];
          if (county) {
            toggleSelectedCounty(county);
          }
        });

      g.append('g')
        .append('path')
        .attr('fill', 'none')
        .attr('pointer-events', 'none')
        .attr('stroke', '#fff')
        .attr('stroke-width', 1.5)
        .attr('stroke-linejoin', 'round')
        .attr(
          'd',
          path(
            topojson.mesh(
              simplifiedTopology,
              simplifiedTopology.objects.states,
              (a, b) => a !== b,
            ),
          ),
        );

      let coordsX: [number, number] = [0, 0];
      let coordsY: [number, number] = [0, 0];
      const projection = d3.geoAlbersUsa().scale(2500).translate([width / 2, height / 2]);

      if ((taskid === 'uNarrate-3') || (taskid === 'bNarrate-3')) {
        if (taskid === 'uNarrate-3') {
          coordsX = [-95.9, 36.7];
          coordsY = [-85, 35.85];
        } else if (taskid === 'bNarrate-3') {
          coordsX = [-98.6, 37.8];
          coordsY = [-88, 37.2];
        }

        const projectedX = projection(coordsX);
        const cx: [number, number] = projectedX ? projectedX as [number, number] : [0, 0];

        const projectedY = projection(coordsY);
        const cy: [number, number] = projectedY ? projectedY as [number, number] : [0, 0];

        g.append('ellipse')
          .attr('cx', cx[0])
          .attr('cy', cx[1])
          .attr('rx', 110)
          .attr('ry', 70)
          .attr('fill', 'none')
          .attr('stroke', 'yellow')
          .attr('stroke-width', 4);

        g.append('ellipse')
          .attr('cx', cy[0])
          .attr('cy', cy[1])
          .attr('rx', 110)
          .attr('ry', 70)
          .attr('fill', 'none')
          .attr('stroke', 'yellow')
          .attr('stroke-width', 5);

        g.append('circle')
          .attr('cx', cx[0])
          .attr('cy', cx[1] + 110)
          .attr('r', 30)
          .attr('fill', 'yellow');

        g.append('text')
          .text('X')
          .attr('x', cx[0])
          .attr('y', cx[1] + 110)
          .attr('dy', '.35em')
          .attr('text-anchor', 'middle')
          .attr('font-size', 42)
          .attr('font-weight', 'bold')
          .attr('stroke', 'black');

        g.append('circle')
          .attr('cx', cy[0])
          .attr('cy', cy[1] + 110)
          .attr('r', 30)
          .attr('fill', 'yellow');

        g.append('text')
          .text('Y')
          .attr('x', cy[0])
          .attr('y', cy[1] + 110)
          .attr('dy', '.35em')
          .attr('text-anchor', 'middle')
          .attr('font-size', 42)
          .attr('font-weight', 'bold')
          .attr('fill', 'black');
      }
    }
    load();
  }, [svgRef, gRef, zoom, data, colorFn, setHoveredCounty, toggleSelectedCounty, taskid, width, height]);

  return (
    <div>
      <div style={{ height, width }}>
        <svg ref={svgRef} width={width} height={height} className={classes.mapSvg}>
          <defs>
            <pattern
              id="crosshatch"
              patternUnits="userSpaceOnUse"
              width="3"
              height="3"
            >
              <image
                xlinkHref="data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSc4JyBoZWlnaHQ9JzgnPgogIDxyZWN0IHdpZHRoPSc4JyBoZWlnaHQ9JzgnIGZpbGw9JyNmZmYnLz4KICA8cGF0aCBkPSdNMCAwTDggOFpNOCAwTDAgOFonIHN0cm9rZS13aWR0aD0nMC41JyBzdHJva2U9JyNhYWEnLz4KPC9zdmc+Cg=="
                x="0"
                y="0"
                width="3"
                height="3"
              />
            </pattern>
          </defs>
        </svg>
        <ToolTip
          countyData={hoveredCounty}
          plots={plots}
          formatters={formatters}
          x={tooltipX}
          y={tooltipY}
        />
      </div>
    </div>
  );
}

export default memo(USMap);
