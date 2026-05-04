/**
 * OCR keyframe pipeline (ffmpeg frames + scripts/mqp_ocr_events.py) for a video path on disk.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupFiles,
  clampSampleTimes,
  extractJpegFrameBuffer,
  resolveVideoSampleDurationSeconds,
  sampleTimestamps,
} from './frame-sampler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mqp_ocr_events.py');

function defaultPythonExecutable() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  return 'python3';
}

/**
 * @param {string} videoPath
 * @param {string} mimeType
 * @returns {Promise<{ frames: unknown[]; meta: Record<string, unknown>; stderr: string }>}
 */
export async function runOcrOnVideoPath(videoPath, mimeType) {
  const framesEnv = Number(process.env.MQP_OCR_FRAMES || 8);
  const frames = Math.max(1, Math.min(20, Math.floor(framesEnv)));

  const duration = await resolveVideoSampleDurationSeconds(videoPath);
  const times = clampSampleTimes(sampleTimestamps(duration, frames, 20), duration);

  const tmpFiles = [];
  const frameInputs = [];
  try {
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i];
      const jpeg = await extractJpegFrameBuffer(videoPath, t);
      const imgPath = path.join(tmpdir(), `mqp-ocr-frame-${Date.now()}-${i}.jpg`);
      await writeFile(imgPath, jpeg);
      tmpFiles.push(imgPath);
      frameInputs.push({ index: i, timestampSec: t, imagePath: imgPath });
    }
  } catch (e) {
    await cleanupFiles(tmpFiles);
    throw e;
  }

  const py = process.env.MQP_OCR_PYTHON || defaultPythonExecutable();
  const scriptPath = process.env.MQP_OCR_SCRIPT || DEFAULT_SCRIPT;
  const payload = JSON.stringify({
    frames: frameInputs,
    meta: {
      durationSeconds: duration,
      framesRequested: frames,
    },
  });

  let stdout = '';
  let stderr = '';
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(py, [scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      });
      child.stdin.write(payload);
      child.stdin.end();
    });
    stdout = result.stdout;
    stderr = result.stderr;
    if (result.code !== 0 && !stdout.trim()) {
      await cleanupFiles(tmpFiles);
      throw new Error(stderr.slice(0, 2000) || 'OCR script failed');
    }
  } catch (e) {
    await cleanupFiles(tmpFiles);
    throw e;
  } finally {
    await cleanupFiles(tmpFiles);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() || '{}');
  } catch {
    throw new Error(`Invalid JSON from OCR script: ${stdout.slice(0, 500)}`);
  }
  const outFrames = Array.isArray(parsed.frames) ? parsed.frames : [];
  const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
  return { frames: outFrames, meta, stderr };
}
