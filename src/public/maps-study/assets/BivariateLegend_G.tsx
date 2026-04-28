import { memo, useEffect, useRef } from 'react';
import * as d3 from 'd3';
import classes from './Map.module.css';

const svgWidth = 400;
const svgHeight = 250;
const legendWidth = 100;
const legendHeight = 100;

interface LegendProps {
  colors: readonly string[];
  xValues: readonly string[];
  yValues: readonly string[];
  avgColumnBPercentage: number;
}

function BivariateLegend({
  colors, xValues, yValues, avgColumnBPercentage,
}: LegendProps) {
  const legendRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!legendRef.current || !colors || !xValues || !yValues) {
      return;
    }

    d3.select(legendRef.current).selectAll('*').remove();
    const svg = d3
      .select(legendRef.current)
      .append('svg')
      .attr('style', 'display: block; margin-top: -23px; margin-bottom: -10px;')
      .attr('width', svgWidth)
      .attr('height', svgHeight);

    const legendGroup = svg
      .append('g')
      .attr('transform', `translate(${(svgWidth - legendWidth * 1.41) / 2}, ${(svgHeight - legendHeight * 1.41) / 2 + 65}) rotate(-45)`);

    legendGroup
      .selectAll('rect')
      .data(colors)
      .enter()
      .append('rect')
      .attr('x', (_, i) => (i % (xValues.length - 1)) * (legendWidth / (xValues.length - 1)))
      .attr('y', (_, i) => legendHeight - legendHeight / Math.floor(yValues.length - 1) - Math.floor(i / (yValues.length - 1)) * (legendHeight / Math.floor(yValues.length - 1)))
      .attr('width', legendWidth / (xValues.length - 1))
      .attr('height', legendHeight / (yValues.length - 1))
      .style('fill', (d) => d);

    const axesLines = legendGroup
      .append('g');

    // axes lines
    axesLines.append('line')
      .attr('x1', 0)
      .attr('y1', legendHeight)
      .attr('x2', legendWidth + 10)
      .attr('y2', legendHeight)
      .style('stroke', 'black')
      .style('stroke-width', 1);

    // arrow triangle
    axesLines.append('path')
      .attr('d', `M ${legendWidth + 20} ${legendHeight} l -10 -5 l 0 10 Z`)
      .style('fill', '#777');

    axesLines.append('line')
      .attr('x1', 0)
      .attr('y1', legendHeight)
      .attr('x2', 0)
      .attr('y2', -10)
      .style('stroke', 'black')
      .style('stroke-width', 1);

    axesLines.append('path')
      .attr('d', 'M 0 -20 l -5 10 l 10 0 Z')
      .style('fill', '#777');

    axesLines
      .append('g')
      .attr('transform', `translate(0, ${legendHeight})`)
      .selectAll('path')
      .data(xValues)
      .enter()
      .append('path')
      .attr('transform', (_, i) => `translate(${(i) * (legendWidth / (xValues.length - 1))}, 0) rotate(45)`)
      .attr('d', 'M 0 0 l 8 0')
      .attr('stroke', '#444')
      .attr('stroke-width', 1);

    axesLines
      .append('g')
      .selectAll('path')
      .data(xValues)
      .enter()
      .append('path')
      .attr('transform', (_, i) => `translate(0, ${legendHeight - i * (legendHeight / (yValues.length - 1))}) rotate(45)`)
      .attr('d', 'M 0 0 l -8 0')
      .attr('stroke', '#444')
      .attr('stroke-width', 1);

    // labels
    legendGroup
      .append('g')
      .attr('transform', `translate(0, ${legendHeight})`)
      .selectAll('text')
      .data(xValues)
      .enter()
      .append('text')
      .attr('transform', (_, i) => `translate(${(i) * (legendWidth / (xValues.length - 1))}, 0) rotate(45)`)
      .attr('dx', '0.75rem')
      .attr('dy', '.25rem')
      .attr('fill', '#b3b3b3')
      .attr('text-anchor', 'left')
      .style('font-size', '10px')
      .text((d) => d);

    legendGroup
      .append('g')
      .selectAll('text')
      .data(yValues)
      .enter()
      .append('text')
      .attr('transform', (_, i) => `translate(0, ${legendHeight - i * (legendHeight / (yValues.length - 1))}) rotate(45)`)
      .attr('dx', '-0.75rem')
      .attr('dy', '.25rem')
      .attr('fill', '#b3b3b3')
      .attr('text-anchor', 'end')
      .style('font-size', '10px')
      .text((d) => d);

    const leftLegendGroup = legendGroup.append('g')
      .attr('transform', 'translate(0, 0) rotate(45)');

    leftLegendGroup.append('text')
      .attr('transform', 'translate(-45, -10)')
      .attr('text-anchor', 'end')
      .style('font-size', '12px')
      .attr('fill', '#67aebf')
      .attr('font-weight', 'bold')
      .text('more sheep');

    leftLegendGroup.append('text')
      .attr('transform', 'translate(-45, 10)')
      .attr('text-anchor', 'end')
      .style('font-size', '12px')
      .attr('fill', '#b3b3b3')
      .text('fewer goats');

    const topLegendGroup = legendGroup.append('g')
      .attr('transform', `translate(${legendWidth}, 0) rotate(45)`);

    topLegendGroup.append('text')
      .attr('transform', 'translate(0, -30)')
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .attr('fill', '#67aebf')
      .attr('font-weight', 'bold')
      .text('more sheep');

    topLegendGroup.append('text')
      .attr('transform', 'translate(0, -10)')
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .attr('fill', '#c8595a')
      .attr('font-weight', 'bold')
      .text('more goats');

    const rightLegendGroup = legendGroup.append('g')
      .attr('transform', `translate(${legendWidth}, ${legendHeight}) rotate(45)`);

    rightLegendGroup.append('text')
      .attr('transform', 'translate(45, -10)')
      .attr('text-anchor', 'start')
      .style('font-size', '12px')
      .attr('fill', '#b3b3b3')
      .text('fewer sheep');

    rightLegendGroup.append('text')
      .attr('transform', 'translate(45, 10)')
      .attr('text-anchor', 'start')
      .style('font-size', '12px')
      .attr('fill', '#c8595a')
      .attr('font-weight', 'bold')
      .text('more goats');

    const bottomLegendGroup = legendGroup.append('g')
      .attr('transform', `translate(0, ${legendHeight}) rotate(45)`);

    bottomLegendGroup.append('text')
      .attr('transform', 'translate(0, 30)')
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .attr('fill', '#b3b3b3')
      .text('fewer sheep');

    bottomLegendGroup.append('text')
      .attr('transform', 'translate(0, 50)')
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .attr('fill', '#b3b3b3')
      .text('fewer goats');

    legendGroup.append('text')
      .attr('transform', `translate(${legendWidth / 2 + 10}, ${legendHeight + 40})`)
      .attr('text-anchor', 'middle')
      .style('font-size', '14px')
      .attr('fill', '#c8595a')
      .style('font-weight', 'bold')
      .text('Goats');

    legendGroup.append('text')
      .attr('transform', `translate(-40, ${legendHeight / 2 - 5}) rotate(-270)`)
      .attr('text-anchor', 'middle')
      .style('font-size', '14px')
      .attr('fill', '#67aebf')
      .style('font-weight', 'bold')
      .text('Sheep');
  }, [colors, xValues, yValues, avgColumnBPercentage]);

  return <div ref={legendRef} className={classes.bivariateLegend} />;
}

export default memo(BivariateLegend);
