import { MantineProvider } from '@mantine/core';
import {
  act, cleanup, fireEvent, render, screen,
} from '@testing-library/react';
import {
  afterAll, afterEach, beforeAll, expect, test, vi,
} from 'vitest';
import type { StorageEngine } from '../../../../storage/engines/types';
import { RecordingSearch } from '../RecordingSearch';
import { embedTexts } from '../reviewApi';

vi.mock('../reviewApi', () => ({ embedTexts: vi.fn() }));
beforeAll(() => vi.stubGlobal('matchMedia', vi.fn().mockImplementation((media: string) => ({
  matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
}))));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
afterAll(() => vi.unstubAllGlobals());

test('failed indexing drains admitted writes before allowing retry and preserves successful saves', async () => {
  const clips = ['one', 'two'].map((participantId) => ({ participantId, taskId: 'task' }));
  const analysis = { revision: 'current', value: { summary: { text: 'Saved summary' }, events: [], ocr: [] } };
  let finish!: () => void;
  const saveReviewArtifact = vi.fn().mockRejectedValueOnce(new Error('Upload failed'))
    .mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
  const engine = {
    getReviewAnalysis: vi.fn().mockResolvedValue(analysis), getReviewArtifact: vi.fn().mockResolvedValue(null), saveReviewArtifact,
  } as unknown as StorageEngine;
  vi.mocked(embedTexts).mockResolvedValue(clips.map(() => ({ model: 'fixture', vector: [1, 0] })));
  render(<MantineProvider><RecordingSearch engine={engine} clips={clips} available select={() => {}} /></MantineProvider>);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Index saved recordings' })); });
  expect(saveReviewArtifact).toHaveBeenCalledTimes(2);
  expect((screen.getByRole('button', { name: 'Index saved recordings' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/Upload failed/)).toBeNull();
  await act(async () => finish());
  expect(screen.getByRole('alert').textContent).toContain('Upload failed');
  expect((screen.getByRole('button', { name: 'Index saved recordings' }) as HTMLButtonElement).disabled).toBe(false);
  expect(saveReviewArtifact.mock.calls[1]).toEqual(['embedding', { model: 'fixture', vector: [1, 0], analysisRevision: 'current' }, clips[1]]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Index saved recordings' })); });
  expect(screen.getByRole('status').textContent).toBe('Indexed 2 recordings with saved analysis.');
  expect(saveReviewArtifact).toHaveBeenCalledTimes(4);
});

test('cancellation during writes drains the current batch without starting another', async () => {
  const clips = Array.from({ length: 33 }, (_, index) => ({ participantId: String(index), taskId: 'task' }));
  const analysis = { revision: 'current', value: { summary: { text: 'Saved summary' }, events: [], ocr: [] } };
  let finish!: () => void;
  const saveReviewArtifact = vi.fn().mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
  const engine = {
    getReviewAnalysis: vi.fn().mockResolvedValue(analysis), getReviewArtifact: vi.fn().mockResolvedValue(null), saveReviewArtifact,
  } as unknown as StorageEngine;
  vi.mocked(embedTexts).mockImplementation(async (texts) => texts.map(() => ({ model: 'fixture', vector: [1, 0] })));
  render(<MantineProvider><RecordingSearch engine={engine} clips={clips} available select={() => {}} /></MantineProvider>);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Index saved recordings' })); });
  expect(saveReviewArtifact).toHaveBeenCalledTimes(32);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel search operation' }));
  expect((screen.getByRole('button', { name: 'Index saved recordings' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish());
  expect(embedTexts).toHaveBeenCalledTimes(1);
  expect(saveReviewArtifact).toHaveBeenCalledTimes(32);
  expect(screen.getByRole('status').textContent).toBe('Search operation cancelled. Saved embeddings are preserved.');
  expect((screen.getByRole('button', { name: 'Index saved recordings' }) as HTMLButtonElement).disabled).toBe(false);
});
