/**
 * POST /api/analyze-timeline — Whisper + PySceneDetect via scripts/mqp_timeline_events.py
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonCache, sha256Hex, writeJsonCache } from './cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mqp_timeline_events.py');

const TIMELINE_TIMEOUT_MS = Number(process.env.MQP_TIMELINE_TIMEOUT_MS || 15 * 60 * 1000, 10);

/** Prefer repo `.venv` so Whisper matches Cursor's `python.defaultInterpreterPath`. */
function defaultPythonExecutable() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  return 'python3';
}

function extFromMime(mime) {
  if (!mime || typeof mime !== 'string') return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  return 'webm';
}

export function registerTimelineRoutes(app, upload) {
  app.post('/api/analyze-timeline', upload.single('video'), async (req, res) => {
    const started = Date.now();
    if (!req.file?.buffer) {
      res.status(400).json({
        error: 'Missing video file (multipart field "video").',
        code: 'MISSING_FILE',
        durationMs: Date.now() - started,
      });
      return;
    }

    const py = process.env.MQP_TIMELINE_PYTHON || defaultPythonExecutable();
    const scriptPath = process.env.MQP_TIMELINE_SCRIPT || DEFAULT_SCRIPT;

    const confusionWords = typeof req.body?.confusionWords === 'string' ? req.body.confusionWords : '';
    const confusionWordsArg = confusionWords
      .split(',')
      .map((w) => String(w).trim())
      .filter(Boolean)
      .join(',');

    const whisperModel = String(process.env.WHISPER_MODEL || 'base');
    const cacheKey = sha256Hex([req.file.buffer, confusionWordsArg, whisperModel]);
    const cached = await readJsonCache(cacheKey);
    if (cached && Array.isArray(cached.events)) {
      // eslint-disable-next-line no-console
      console.log(`[mqp-cache] hit analyze-timeline ${cacheKey.slice(0, 12)}`);
      res.json({
        events: cached.events,
        meta: cached.meta || {},
        durationMs: Date.now() - started,
        cacheHit: true,
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[mqp-cache] miss analyze-timeline ${cacheKey.slice(0, 12)}`);

    const ext = extFromMime(req.file.mimetype);
    const tmp = path.join(tmpdir(), `mqp-timeline-${randomUUID()}.${ext}`);

    try {
      await writeFile(tmp, req.file.buffer);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Failed to write temp file',
        code: 'TEMP_WRITE_FAILED',
        durationMs: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    try {
      const result = await new Promise((resolve, reject) => {
        const args = [scriptPath, tmp];
        if (confusionWordsArg) {
          args.push('--confusion-words', confusionWordsArg);
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
    } catch (e) {
      await unlink(tmp).catch(() => {});
      res.status(422).json({
        error: e instanceof Error ? e.message : String(e),
        code: 'TIMELINE_SCRIPT_FAILED',
        durationMs: Date.now() - started,
        stderr: stderr.slice(0, 4000),
      });
      return;
    } finally {
      await unlink(tmp).catch(() => {});
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout.trim() || '{}');
    } catch {
      res.status(422).json({
        error: 'Invalid JSON from timeline script',
        code: 'BAD_JSON',
        durationMs: Date.now() - started,
        raw: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
      });
      return;
    }

    const events = Array.isArray(parsed.events) ? parsed.events : [];
    if (parsed.error && events.length === 0) {
      res.status(422).json({
        error: String(parsed.error),
        code: 'TIMELINE_ERROR',
        events: [],
        durationMs: Date.now() - started,
        stderr: stderr.slice(0, 2000),
      });
      return;
    }

    res.json({
      events,
      meta: parsed.meta || {},
      durationMs: Date.now() - started,
    });

    await writeJsonCache(cacheKey, {
      events,
      meta: parsed.meta || {},
      cachedAt: new Date().toISOString(),
    }).catch(() => {});
  });
}
