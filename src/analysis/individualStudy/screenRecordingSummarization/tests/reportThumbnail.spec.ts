import {
  afterEach, beforeEach, expect, test, vi,
} from 'vitest';
import { reportThumbnail } from '../reportThumbnail';

let video: HTMLVideoElement;
let canvas: HTMLCanvasElement;
const revoke = vi.fn();
const draw = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); revoke.mockClear(); draw.mockClear();
  video = document.createElement('video'); canvas = document.createElement('canvas');
  vi.spyOn(video, 'load').mockImplementation(() => {});
  vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/jpeg;base64,aA==');
  vi.spyOn(document, 'createElement').mockImplementation((tag) => (tag === 'video' ? video : canvas));
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:thumbnail-fixture', revokeObjectURL: revoke });
  Object.defineProperties(video, { duration: { value: 4, configurable: true }, videoWidth: { value: 1600 }, videoHeight: { value: 900 } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('captures at a quarter duration with bounded dimensions and releases the video', async () => {
  const pending = reportThumbnail(new Blob(), new AbortController().signal);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(1);
  video.dispatchEvent(new Event('seeked'));
  expect(await pending).toBe('data:image/jpeg;base64,aA==');
  expect(draw).toHaveBeenCalledWith(video, 0, 0, 320, 180);
  expect(revoke).toHaveBeenCalledWith('blob:thumbnail-fixture');
  expect(video.getAttribute('src')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test('decode timeout rejects and releases handlers and object URL', async () => {
  const checked = expect(reportThumbnail(new Blob(), new AbortController().signal)).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15000);
  await checked;
  expect(video.onseeked).toBeNull();
  expect(revoke).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('cancellation rejects promptly and measured duration handles unknown browser metadata', async () => {
  Object.defineProperty(video, 'duration', { value: Number.POSITIVE_INFINITY });
  const controller = new AbortController();
  const checked = expect(reportThumbnail(new Blob(), controller.signal, 8)).rejects.toThrow();
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(video.currentTime).toBe(2);
  controller.abort(); await checked;
  expect(video.onloadedmetadata).toBeNull();
  expect(revoke).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
