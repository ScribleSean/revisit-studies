import { ColumnFormat } from './types';

const formatter = {
  'thousands-separator': (d: number) => Math.round(d).toLocaleString(),
  'normal-percentage': (d: number) => `${(d * 100).toFixed(2)}%`,
  percentage: (d: number) => `${(d || 0).toFixed(2)}%`,
};

export function formatColumn(formatKey: ColumnFormat) {
  return formatter[formatKey];
}
