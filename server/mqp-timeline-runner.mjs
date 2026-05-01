/**
 * Run scripts/mqp_timeline_events.py on a video file already on disk (no HTTP / multer).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mqp_timeline_events.py');

const TIMELINE_TIMEOUT_MS = Number(process.env.MQP_TIMELINE_TIMEOUT_MS || 15 * 60 * 1000, 10);

export function defaultTimelinePythonExecutable() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  return 'python3';
}

/**
 * @param {string} videoPath absolute path to temp video
 * @param {string} confusionWordsCsv comma-separated phrases (optional)
 * @param {string | null} companionAudioPath absolute path to temp study mic audio (optional)
 * @returns {Promise<{ events: unknown[]; meta: Record<string, unknown>; stderr: string }>}
 */
export async function runTimelineOnVideoPath(videoPath, confusionWordsCsv = '', companionAudioPath = null) {
  const py = process.env.MQP_TIMELINE_PYTHON || defaultTimelinePythonExecutable();
  const scriptPath = process.env.MQP_TIMELINE_SCRIPT || DEFAULT_SCRIPT;
  const confusionWordsArg = String(confusionWordsCsv || '')
    .split(',')
    .map((w) => String(w).trim())
    .filter(Boolean)
    .join(',');

  let stdout = '';
  let stderr = '';
  const result = await new Promise((resolve, reject) => {
    const args = [scriptPath, videoPath];
    if (confusionWordsArg) {
      args.push('--confusion-words', confusionWordsArg);
    }
    if (companionAudioPath) {
      args.push('--audio-path', companionAudioPath);
    }
    const child = spawn(py, args, {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timeline script timed out after ${TIMELINE_TIMEOUT_MS}ms`));
    }, TIMELINE_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
  stdout = result.stdout;
  stderr = result.stderr;

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim() || '{}');
  } catch {
    throw new Error(`Invalid JSON from timeline script: ${stdout.slice(0, 500)}`);
  }
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
  if (parsed.error && events.length === 0) {
    throw new Error(String(parsed.error));
  }
  return { events, meta, stderr };
}
