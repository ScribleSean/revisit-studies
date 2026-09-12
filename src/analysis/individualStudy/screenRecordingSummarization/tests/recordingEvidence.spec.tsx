import { MantineProvider } from '@mantine/core';
import {
  cleanup, fireEvent, render, screen, within,
} from '@testing-library/react';
import {
  afterAll, afterEach, beforeAll, expect, test, vi,
} from 'vitest';
import { RecordingEvidence } from '../RecordingEvidence';

beforeAll(() => vi.stubGlobal('matchMedia', vi.fn().mockImplementation((media: string) => ({
  matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
}))));
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

test('dense evidence stays bounded and the last event remains seekable across a shrinking list', () => {
  const events = Array.from({ length: 2000 }, (_, timestamp) => ({ type: 'hesitation' as const, timestamp, evidence: `Event ${timestamp}` }));
  const seek = vi.fn();
  const props = {
    events, tags: [], ocr: [], confusion: [], seek, addTag: vi.fn(), removeTag: vi.fn(), busy: false,
  };
  const view = render(<MantineProvider><RecordingEvidence {...props} /></MantineProvider>);
  const list = within(screen.getByRole('region', { name: 'Events list' }));
  expect(list.getAllByTitle(/^Event /)).toHaveLength(50);
  fireEvent.click(list.getByRole('button', { name: 'Events last page' }));
  fireEvent.click(list.getByTitle('Event 1999'));
  expect(seek).toHaveBeenCalledWith(1999);
  expect(list.getAllByTitle(/^Event /)).toHaveLength(50);
  view.rerender(<MantineProvider><RecordingEvidence {...props} events={events.slice(0, 51)} /></MantineProvider>);
  expect(list.getAllByTitle(/^Event /)).toHaveLength(1);
  expect(list.getByTitle('Event 50')).toBeDefined();
  fireEvent.click(list.getByRole('button', { name: 'Events first page' }));
  expect(list.getAllByTitle(/^Event /)).toHaveLength(50);
});
