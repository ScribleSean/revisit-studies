import {
  Button, Group, Pagination, Stack, Table, Text,
} from '@mantine/core';
import { useMemo, useState } from 'react';

const ROWS_PER_PAGE = 25;
const COLUMNS_PER_PAGE = 12;

/** A count heatmap with bounded DOM size and numeric labels independent of color. */
export function EventCountMatrix({
  counts, caption, rowLabel, select,
}: { counts: Record<string, Record<string, number>>; caption: string; rowLabel: string; select?: (row: string, column: string) => void }) {
  const [rowPage, setRowPage] = useState(1);
  const [columnPage, setColumnPage] = useState(1);
  const { rows, columns, maximum } = useMemo(() => {
    const entries = Object.entries(counts);
    const allColumns = new Set<string>();
    let max = 0;
    entries.forEach(([, values]) => Object.entries(values).forEach(([column, count]) => { allColumns.add(column); max = Math.max(max, count); }));
    return { rows: entries.map(([key]) => key).sort(), columns: [...allColumns].sort(), maximum: max };
  }, [counts]);
  const rowPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const columnPages = Math.max(1, Math.ceil(columns.length / COLUMNS_PER_PAGE));
  const currentRowPage = Math.min(rowPage, rowPages);
  const currentColumnPage = Math.min(columnPage, columnPages);
  const shownRows = rows.slice((currentRowPage - 1) * ROWS_PER_PAGE, currentRowPage * ROWS_PER_PAGE);
  const shownColumns = columns.slice((currentColumnPage - 1) * COLUMNS_PER_PAGE, currentColumnPage * COLUMNS_PER_PAGE);
  return (
    <Stack gap="xs">
      <Text size="sm">Darker cells indicate more events. The color scale uses the full matrix; numbers show exact counts.</Text>
      <Table.ScrollContainer minWidth={500}>
        <Table captionSide="top">
          <Table.Caption>{caption}</Table.Caption>
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">{rowLabel}</Table.Th>
              {shownColumns.map((column) => <Table.Th scope="col" key={column} style={{ overflowWrap: 'anywhere', minWidth: 100 }}>{column}</Table.Th>)}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shownRows.map((row) => (
              <Table.Tr key={row}>
                <Table.Th scope="row" style={{ overflowWrap: 'anywhere', minWidth: 140 }}>{row}</Table.Th>
                {shownColumns.map((column) => {
                  const count = counts[row][column] || 0;
                  return (
                    <Table.Td key={column} style={{ backgroundColor: count && maximum ? `rgba(34, 139, 230, ${0.08 + 0.32 * (count / maximum)})` : undefined, textAlign: 'center' }}>
                      {select && count > 0 ? <Button variant="subtle" style={{ color: 'var(--mantine-color-text)' }} mih={44} aria-label={`${row} · ${column}: ${count} events`} onClick={() => select(row, column)}>{count}</Button> : count}
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {rowPages > 1 && (
      <Group>
        <Text size="sm">Rows</Text>
        <Pagination aria-label={`${caption} row pages`} total={rowPages} value={currentRowPage} onChange={setRowPage} />
      </Group>
      )}
      {columnPages > 1 && (
      <Group>
        <Text size="sm">Columns</Text>
        <Pagination aria-label={`${caption} column pages`} total={columnPages} value={currentColumnPage} onChange={setColumnPage} />
      </Group>
      )}
    </Stack>
  );
}
