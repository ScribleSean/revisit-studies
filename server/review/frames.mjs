import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalysisError, runProcess } from './process.mjs';

export function frameTimes(duration, count) {
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Frame sampling requires positive duration');
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new RangeError('Frame count must be between 1 and 20');
  return Array.from({ length: count }, (_, index) => index * duration / count);
}

/** Consume each frame before decoding the next; never accumulate video-sized buffers. */
export async function sampleFrames({ filename, duration, count, signal, ffmpeg = 'ffmpeg', consume, runner = runProcess }) {
  const times = frameTimes(duration, count);
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-frames-'));
  const output = path.join(directory, 'frame.jpg');
  try {
    for (const timestamp of times) {
      signal?.throwIfAborted();
      await runner(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-threads', '2', '-ss', String(timestamp), '-i', filename,
        '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', output], { signal, timeoutMs: 30000, maxOutputBytes: 1048576 });
      signal?.throwIfAborted();
      const info = await stat(output);
      if (!info.size || info.size > 4 * 1024 * 1024) throw new AnalysisError('FRAME_LIMIT', 'Decoded frame is empty or exceeds 4 MiB');
      const jpeg = await readFile(output);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
        throw new AnalysisError('INVALID_FRAME', 'Frame decoder did not produce a JPEG');
      }
      await unlink(output);
      signal?.throwIfAborted();
      await consume({ timestamp, jpeg });
      signal?.throwIfAborted();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
