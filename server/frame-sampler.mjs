import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function extFromMime(mime) {
  if (!mime || typeof mime !== 'string') return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  return 'webm';
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    });
  });
}

export async function ffprobeDurationSeconds(videoPath) {
  const res = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const text = res.stdout.toString('utf8').trim();
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function sampleTimestamps(durationSeconds, n, maxN = 12) {
  const safeN = Math.max(1, Math.min(maxN, Math.floor(n)));
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return Array.from({ length: safeN }, (_, i) => i);
  }
  // Spread across the clip; avoid exact endpoints.
  return Array.from({ length: safeN }, (_, i) => ((i + 1) / (safeN + 1)) * durationSeconds);
}

export async function extractJpegFrameBuffer(videoPath, seconds) {
  const res = await run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(seconds),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]);
  if (res.code !== 0 || !res.stdout || res.stdout.length === 0) {
    const err = res.stderr.toString('utf8').slice(0, 1500);
    throw new Error(`ffmpeg failed to extract frame: ${err || `exit=${res.code}`}`);
  }
  return res.stdout;
}

export async function writeTempVideoFromUpload({ buffer, mimeType, prefix }) {
  const ext = extFromMime(mimeType);
  const tmp = path.join(tmpdir(), `${prefix}-${randomUUID()}.${ext}`);
  await writeFile(tmp, buffer);
  return tmp;
}

export async function cleanupFiles(pathsToDelete) {
  await Promise.all(pathsToDelete.map((p) => unlink(p).catch(() => {})));
}
