import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
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

/** Keeps decode timestamps inside the container duration so ffmpeg does not EOF with “success” and empty output. */
export function clampSampleTimes(times, durationSeconds) {
  if (!Array.isArray(times)) return [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return times;
  const maxT = Math.max(0, durationSeconds - 0.001);
  return times.map((t) => Math.min(Math.max(0, Number(t) || 0), maxT));
}

/** Best-effort MIME for data URLs (JPEG vs PNG). */
export function guessImageMimeFromBuffer(buf) {
  if (!buf || buf.length < 3) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

/**
 * Decode one frame to an image buffer (JPEG or PNG bytes).
 * WebM/VP9 clips often produce **exit 0 with zero stdout bytes** when using MJPEG
 * `image2pipe`; writing to a temp file is much more reliable.
 */
export async function extractJpegFrameBuffer(videoPath, seconds) {
  const tNum = Number(seconds);
  const tSafe = Number.isFinite(tNum) ? tNum : 0;
  const ss = String(seconds);
  /** Even dimensions + RGB24 avoids MJPEG/YUV full-range encoder failures on VP9/WebM screen captures. */
  const vfRgbEven = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=rgb24';
  const stem = path.join(tmpdir(), `mqp-ff-${randomUUID()}`);
  const outJpg = `${stem}.jpg`;
  const outPng = `${stem}.png`;
  const outBmp = `${stem}.bmp`;

  const t0 = Math.max(0, tSafe - 0.05);
  const t1 = tSafe + 0.35;

  /** @type {Array<{ label: string; path: string; args: string[] }>} */
  const attempts = [
    {
      label: 'hwaccel_none+select_between+png',
      path: outPng,
      args: [
        '-hide_banner', '-loglevel', 'warning',
        '-hwaccel', 'none',
        '-threads', '1',
        '-fflags', '+genpts',
        '-i', videoPath,
        '-vf',
        `select=between(t\\,${t0}\\,${t1}),setpts=PTS-STARTPTS,${vfRgbEven}`,
        '-frames:v', '1',
        '-c:v', 'png',
        '-y',
        outPng,
      ],
    },
    {
      label: 'accurate_seek+png+rgb24',
      path: outPng,
      args: [
        '-hide_banner', '-loglevel', 'warning',
        '-hwaccel', 'none',
        '-fflags', '+genpts',
        '-i', videoPath,
        '-ss', ss,
        '-frames:v', '1',
        '-vf', vfRgbEven,
        '-c:v', 'png',
        '-y',
        outPng,
      ],
    },
    {
      label: 'fast_seek+png+rgb24',
      path: outPng,
      args: [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+genpts',
        '-ss', ss,
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', vfRgbEven,
        '-c:v', 'png',
        '-y',
        outPng,
      ],
    },
    {
      label: 'trim_decode+png+rgb24',
      path: outPng,
      args: [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+genpts',
        '-i', videoPath,
        '-vf',
        `trim=start=${tSafe}:duration=0.06,setpts=PTS-STARTPTS,${vfRgbEven}`,
        '-frames:v', '1',
        '-c:v', 'png',
        '-y',
        outPng,
      ],
    },
    {
      label: 'accurate_seek+bmp+rgb24',
      path: outBmp,
      args: [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+genpts',
        '-i', videoPath,
        '-ss', ss,
        '-frames:v', '1',
        '-vf', vfRgbEven,
        '-c:v', 'bmp',
        '-y',
        outBmp,
      ],
    },
    {
      label: 'mjpeg_unofficial+yuvj420p',
      path: outJpg,
      args: [
        '-hide_banner', '-loglevel', 'warning',
        '-strict', '-2',
        '-fflags', '+genpts',
        '-i', videoPath,
        '-ss', ss,
        '-frames:v', '1',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt', 'yuvj420p',
        '-q:v', '2',
        '-y',
        outJpg,
      ],
    },
  ];

  const errors = [];
  try {
    for (const a of attempts) {
      await unlink(a.path).catch(() => {});
      const res = await run('ffmpeg', a.args);
      const stderr = res.stderr.toString('utf8').trim().slice(0, 2000);
      const exists = existsSync(a.path);
      let size = 0;
      if (exists) {
        try {
          size = statSync(a.path).size;
        } catch {
          size = 0;
        }
      }
      if (res.code === 0 && size > 0) {
        const buf = await readFile(a.path);
        if (buf.length > 0) {
          return buf;
        }
      }
      errors.push(`${a.label}(exit=${res.code}, fileBytes=${size})${stderr ? ` — ${stderr}` : ''}`);
    }
    throw new Error(`ffmpeg failed to extract frame at ${seconds}s · ${errors.join(' · ')}`);
  } finally {
    await unlink(outJpg).catch(() => {});
    await unlink(outPng).catch(() => {});
    await unlink(outBmp).catch(() => {});
  }
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
