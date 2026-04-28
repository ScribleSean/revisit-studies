import { Text } from '@mantine/core';
import { memo } from 'react';
import { createPortal } from 'react-dom';
import classes from './Map.module.css';
import STATES from './data/states.json';
import { CountyModel } from './types';

type ToolTipProps = {
  countyData: CountyModel | null;
  plots: string[];
  formatters: ((k: number) => string)[];
  x: number;
  y: number;
};

type State = {
  fips: string;
  name: string;
};

const statesFipsMap: Record<string, State> = {};
(STATES as State[]).forEach((state) => {
  statesFipsMap[state.fips] = state;
});

function ToolTip({
  countyData, plots, formatters, x, y,
}: ToolTipProps) {
  const state = countyData?.fips
    ? statesFipsMap[countyData.fips.slice(0, 2)]
    : undefined;

  if (!countyData) {
    return null;
  }

  return createPortal(
    <div
      className={classes.mapTooltip}
      style={{
        left: x,
        top: y,
        display: countyData ? 'block' : 'none',
      }}
    >
      <Text size="sm" fw={700}>
        {countyData.county}
      </Text>
      <Text size="sm" fw={700}>
        {state?.name}
      </Text>
      {plots.map((plot, idx) => (
        <Text size="xs" tt="capitalize" key={plot}>
          {plot}
          :
          {' '}
          {formatters[idx](countyData[plot] as number)}
        </Text>
      ))}
    </div>,
    document.getElementById('tooltipContainer') as HTMLElement,
  );
}

export default memo(ToolTip);
