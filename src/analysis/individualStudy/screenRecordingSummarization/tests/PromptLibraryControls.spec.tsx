import { MantineProvider } from '@mantine/core';
import {
  act, cleanup, fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import {
  afterAll, afterEach, beforeAll, expect, test, vi,
} from 'vitest';
import { PromptLibraryControls } from '../PromptLibraryControls';

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
const saved = {
  id: 'saved', name: 'Errors', text: 'Original text', updatedAt: '2026-09-09T12:00:00Z',
};
const value = (label: string) => (screen.getByRole('textbox', { name: label }) as HTMLInputElement).value;

test('failed creation retains the entered name and permits retry without claiming success', async () => {
  const persist = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<MantineProvider><PromptLibraryControls library={[]} prompt="New text" disabled={false} select={vi.fn()} persist={persist} /></MantineProvider>);
  fireEvent.change(screen.getByLabelText('Prompt name'), { target: { value: 'New prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save as new prompt' }));
  expect(await screen.findByText(/Unable to save the named prompt/)).toBeDefined();
  expect(value('Prompt name')).toBe('New prompt');
  expect(screen.getByLabelText('Prompt library status').textContent).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Save as new prompt' }));
  await waitFor(() => expect(screen.getByLabelText('Prompt library status').textContent).toBe('Named prompt saved.'));
  expect(persist).toHaveBeenCalledTimes(2);
  expect(persist.mock.calls[1][0][0]).toMatchObject({ name: 'New prompt', text: 'New text' });
});

test('failed update retains selection and name; thrown deletion errors are handled and retry succeeds', async () => {
  const persist = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Storage offline')).mockResolvedValueOnce(true);
  render(<MantineProvider><PromptLibraryControls library={[saved]} prompt="Edited text" disabled={false} select={vi.fn()} persist={persist} /></MantineProvider>);
  fireEvent.click(screen.getByRole('textbox', { name: 'Saved prompts' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Errors' }));
  fireEvent.change(screen.getByLabelText('Prompt name'), { target: { value: 'Revised name' } });
  fireEvent.click(screen.getByRole('button', { name: 'Update saved prompt' }));
  expect(await screen.findByText(/Unable to save the named prompt/)).toBeDefined();
  expect(value('Prompt name')).toBe('Revised name');
  expect(value('Saved prompts')).toBe('Errors');
  expect(persist.mock.calls[0][0][0]).toMatchObject({ id: 'saved', name: 'Revised name', text: 'Edited text' });
  fireEvent.click(screen.getByRole('button', { name: 'Delete saved prompt' }));
  expect(await screen.findByText('Storage offline')).toBeDefined();
  expect(value('Saved prompts')).toBe('Errors');
  expect(value('Prompt name')).toBe('Revised name');
  fireEvent.click(screen.getByRole('button', { name: 'Delete saved prompt' }));
  await waitFor(() => expect(screen.getByLabelText('Prompt library status').textContent).toContain('Named prompt deleted.'));
  expect(persist.mock.calls[2][0]).toEqual([]);
  expect(value('Prompt name')).toBe('');
});

test('pending persistence disables repeated mutations', async () => {
  let finish!: (value: boolean) => void;
  const persist = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  render(<MantineProvider><PromptLibraryControls library={[]} prompt="text" disabled={false} select={vi.fn()} persist={persist} /></MantineProvider>);
  fireEvent.change(screen.getByLabelText('Prompt name'), { target: { value: 'Name' } });
  const button = screen.getByRole('button', { name: 'Save as new prompt' }) as HTMLButtonElement;
  fireEvent.click(button); fireEvent.click(button);
  expect(button.disabled).toBe(true); expect(persist).toHaveBeenCalledTimes(1);
  await act(async () => finish(false));
  expect(button.disabled).toBe(false);
});
