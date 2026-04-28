import { memo, useEffect, useRef } from 'react';
import * as d3 from 'd3';
import classes from './Map.module.css';

const svgWidth = 600;
const svgHeight = 50;
const legendWidth = 500;
const legendHeight = 10;

interface LegendProps {
  colors: readonly string[];
  values: readonly string[];
  columnType: string;
  avgColumnPercentage?: number;
}

function UnivariateLegend({
  colors, values, columnType, avgColumnPercentage,
}: LegendProps) {
  const legendRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!legendRef.current || !colors || !values) {
      return;
    }

    d3.select(legendRef.current).selectAll('*').remove();
    const svg = d3
      .select(legendRef.current)
      .append('svg')
      .attr('style', 'display: block; margin-right: 0px; margin-top: 15px;')
      .attr('width', svgWidth)
      .attr('height', svgHeight);

    const legendGroup = svg
      .append('g')
      .attr('transform', `translate(${(svgWidth - legendWidth) / 2}, 0)`);

    legendGroup
      .selectAll('rect')
      .data(colors)
      .enter()
      .append('rect')
      .attr('x', (_, i) => i * (legendWidth / colors.length))
      .attr('y', 15)
      .attr('width', legendWidth / colors.length)
      .attr('height', legendHeight)
      .style('fill', (d) => d);

    legendGroup
      .selectAll('text')
      .data(values)
      .enter()
      .append('text')
      .attr('x', (_, i) => i * (legendWidth / (values.length - 1)))
      .attr('y', legendHeight)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .attr('fill', '#999')
      // .text((d) => d);
      .text((d) => `${parseFloat(d).toFixed(0)}%`);

    const legendText = columnType.trim() === 'voter_rate' ? 'Vote Share' : 'Medicaid';
    legendGroup
      .append('text')
      .attr('class', 'legend-label')
      .attr('x', 0)
      .attr('y', 36)
      .attr('text-anchor', 'start')
      .style('font-size', '12px')
      .attr('fill', '#999')
      .text(`Low ${legendText}`);

    if (avgColumnPercentage) {
      legendGroup
        .append('line')
        .attr('x1', legendWidth * avgColumnPercentage + 20)
        .attr('y1', 13)
        .attr('x2', legendWidth * avgColumnPercentage + 20)
        .attr('y2', 40)
        .attr('stroke', '#333')
        .attr('stroke-dasharray', 2);

      legendGroup
        .append('text')
        .attr('text-anchor', 'left')
        .attr('x', legendWidth * avgColumnPercentage + 20)
        .attr('y', 40)
        .attr('dy', '-2')
        .attr('dx', '5')
        .attr('fill', '#999')
        .attr('font-style', 'italic')
        .style('font-size', '11px')
        .style('font-size', '11px')
        .text('average medicaid');
    }

    legendGroup
      .append('text')
      .attr('class', 'legend-label')
      .attr('x', legendWidth)
      .attr('y', 36)
      .attr('text-anchor', 'end')
      .style('font-size', '12px')
      .attr('font-weight', 'bold')
      .attr('fill', colors[colors.length - 1])
      .text(`High ${legendText}`);
  }, [colors, values, columnType, avgColumnPercentage]);

  return <div ref={legendRef} className={classes.univariateLegend} />;
}

export default memo(UnivariateLegend);
