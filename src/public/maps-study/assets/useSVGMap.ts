import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import * as d3 from 'd3';
import { usePrevious } from '@mantine/hooks';
import { useSharedState } from './SharedStateContext';
import classes from './Map.module.css';

export function useSVGMap(
  width: number,
  height: number,
  transform: d3.ZoomTransform,
  setTransform: (z: d3.ZoomTransform) => void,
) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gRef = useRef<d3.Selection<
    SVGGElement,
    unknown,
    null,
    undefined
  > | null>(null);
  const prevTransform = useRef(transform);

  const { hoveredCounty, selectedCounties } = useSharedState();

  const prevSelectedCounties = usePrevious(selectedCounties);

  const hoveredCountyId = hoveredCounty?.fips;
  const prevHoveredCountyId = useRef(hoveredCountyId);
  const [tooltipX, setTooltipX] = useState(0);
  const [tooltipY, setTooltipY] = useState(0);

  const zoomed = useCallback(
    (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      setTransform(event.transform);
    },
    [setTransform],
  );

  const zoom = useMemo(
    () => d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.45, 20])
      .on('zoom', zoomed),
    [zoomed],
  );

  useEffect(() => {
    gRef.current?.attr('transform', transform.toString());
    if (svgRef.current) {
      zoom.transform(d3.select(svgRef.current), transform);
    }
    if (Math.abs(transform.k - prevTransform.current.k) > 0.2) {
      prevTransform.current = transform;
      gRef.current?.attr('stroke-width', 0.25 / transform.k);
    }
  }, [transform, zoom]);

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }
    if (prevHoveredCountyId.current && gRef.current) {
      const e = gRef.current.select(
        `[data-id="${prevHoveredCountyId.current}"]`,
      );
      if (!e.empty() && !e.classed('county-brushed')) {
        e.attr('stroke', '#fff').attr('stroke-width', 0.5);
      }
    }

    if (hoveredCountyId) {
      const e = d3
        .select(svgRef.current)
        .select<SVGPathElement>(`[data-id="${hoveredCountyId}"]`);

      if (e.empty()) {
        return;
      }

      if (!e.classed('county-brushed')) {
        e.attr('stroke', '#000').attr('stroke-width', 5 / transform.k);
      }
      e.raise();

      const elemRect = e.node()?.getBoundingClientRect();
      if (!elemRect) {
        return;
      }
      const parentRect = svgRef.current.getBoundingClientRect();

      let x = elemRect.left + elemRect.width / 2;
      let y = elemRect.top + elemRect.height + 10;

      if (x < parentRect.left) {
        x = parentRect.left;
      } else if (x > parentRect.right) {
        x = parentRect.right;
      }

      if (y < parentRect.top) {
        y = parentRect.top;
      } else if (y > parentRect.bottom) {
        y = parentRect.bottom;
      }

      setTooltipX(x);
      setTooltipY(y);
    }
    prevHoveredCountyId.current = hoveredCountyId;
  }, [
    hoveredCountyId,
    transform,
    prevHoveredCountyId,
    svgRef,
    width,
    height,
    setTooltipX,
    setTooltipY,
  ]);

  useEffect(() => {
    if (!svgRef.current) {
      return;
    }

    const svg = d3
      .select<SVGSVGElement, unknown>(svgRef.current);

    prevSelectedCounties?.forEach((county) => {
      const e = svg.select(`[data-id='${county.fips}']`);
      e.classed(classes.mapSvgActiveCounty, false);
    });
    selectedCounties.forEach((county) => {
      const e = svg.select(`[data-id='${county.fips}']`);
      e.classed(classes.mapSvgActiveCounty, true);
      e.raise();
    });
  }, [svgRef, gRef, prevSelectedCounties, selectedCounties]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const [[x0, y0], [x1, y1]] = [
        [-56.74777081105434, -12.469025989284091],
        [942.332624291058, 600],
      ];

      const newZoom = d3.zoomIdentity
        .translate(width / 2, height / 2 - 15)
        // .scale(0.8)
        .scale(
          Math.min(8, 1 / Math.max((x1 - x0) / width, (y1 - y0) / height)),
        )
        .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);

      setTransform(newZoom);
    }, 100);
    return () => clearTimeout(timer);
  }, [gRef, zoom.transform, height, width, setTransform]);

  return {
    svgRef,
    gRef,
    transform,
    prevTransform,
    zoom,
    tooltipX,
    tooltipY,
  };
}
