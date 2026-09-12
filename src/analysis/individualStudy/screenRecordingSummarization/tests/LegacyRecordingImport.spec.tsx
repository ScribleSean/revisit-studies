import { MantineProvider } from '@mantine/core';
import {
  act, cleanup, fireEvent, render, screen,
} from '@testing-library/react';
import {
  afterAll, afterEach, beforeAll, expect, test, vi,
} from 'vitest';
import type { StorageEngine } from '../../../../storage/engines/types';
import { LegacyRecordingImport } from '../LegacyRecordingImport';

beforeAll(() => vi.stubGlobal('matchMedia', vi.fn().mockImplementation((media: string) => ({
  matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
}))));
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
const clip = { participantId: 'participant', taskId: 'task' };
const result = {
  imported: ['analysis'], preserved: ['tags'], errors: [], cancelled: false,
};
function mount(importLegacyReviewRecording: ReturnType<typeof vi.fn>) {
  const imported = vi.fn(); const busyChanged = vi.fn();
  const rendered = render(<MantineProvider><LegacyRecordingImport engine={{ importLegacyReviewRecording } as unknown as StorageEngine} clip={clip} disabled={false} imported={imported} busyChanged={busyChanged} /></MantineProvider>);
  return { ...rendered, imported, busyChanged };
}

test('partial failure refreshes saved data, reports retry and preserves successful categories', async () => {
  const persist = vi.fn().mockResolvedValueOnce({ ...result, errors: ['embedding: offline'] }).mockResolvedValueOnce({ ...result, imported: ['embedding'], preserved: ['analysis', 'tags'] });
  const { imported } = mount(persist);
  fireEvent.click(screen.getByRole('button', { name: 'Import legacy recording results' }));
  expect(await screen.findByText(/embedding: offline/)).toBeDefined();
  expect(screen.getByLabelText('Legacy recording import status').textContent).toContain('Imported: analysis. Existing results preserved: tags.');
  expect(imported).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Import legacy recording results' }));
  expect(await screen.findByText(/Imported: embedding/)).toBeDefined();
  expect(screen.queryByText(/embedding: offline/)).toBeNull();
  expect(imported).toHaveBeenCalledTimes(2);
});

test('cancel disables duplicate starts and reports retained writes without claiming rollback', async () => {
  let finish!: (value: typeof result) => void;
  const persist = vi.fn(() => new Promise<typeof result>((resolve) => { finish = resolve; }));
  const { imported, busyChanged } = mount(persist);
  const start = screen.getByRole('button', { name: 'Import legacy recording results' }) as HTMLButtonElement;
  fireEvent.click(start); fireEvent.click(start);
  expect(start.disabled).toBe(true); expect(persist).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel recording import' }));
  expect((persist.mock.calls as unknown as [typeof clip, AbortSignal][])[0][1].aborted).toBe(true);
  await act(async () => finish({ ...result, cancelled: true }));
  expect(screen.getByLabelText('Legacy recording import status').textContent).toContain('Import stopped. Imported: analysis.');
  expect(imported).toHaveBeenCalledTimes(1);
  expect(busyChanged).toHaveBeenLastCalledWith(false);
  expect(start.disabled).toBe(false);
});

test('unmount aborts the read and suppresses callbacks from a late completion', async () => {
  let finish!: (value: typeof result) => void;
  const persist = vi.fn(() => new Promise<typeof result>((resolve) => { finish = resolve; }));
  const { unmount, imported, busyChanged } = mount(persist);
  fireEvent.click(screen.getByRole('button', { name: 'Import legacy recording results' }));
  unmount();
  expect((persist.mock.calls as unknown as [typeof clip, AbortSignal][])[0][1].aborted).toBe(true);
  await act(async () => finish(result));
  expect(imported).not.toHaveBeenCalled();
  expect(busyChanged).toHaveBeenLastCalledWith(false);
});
