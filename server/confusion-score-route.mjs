/**
 * POST /api/confusion-score — run timeline + OCR, then scripts/mqp_confusion_score.py
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOcrOnVideoPath } from './mqp-ocr-runner.mjs';
import { runTimelineOnVideoPath } from './mqp-timeline-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mqp_confusion_score.py');

function extFromMime(mime) {
  if (!mime || typeof mime !== 'string') return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('quicktime')) return 'mov';
  return 'webm';
}

function defaultPythonExecutable() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  return 'python3';
}

export function registerConfusionScoreRoutes(app, upload) {
  app.post('/api/confusion-score', upload.single('video'), async (req, res) => {
    const started = Date.now();
    if (!req.file?.buffer) {
      res.status(400).json({
        error: 'Missing video file (multipart field "video").',
        code: 'MISSING_FILE',
        durationMs: Date.now() - started,
      });
      return;
    }

    const confusionWords = typeof req.body?.confusionWords === 'string' ? req.body.confusionWords : '';
    const confusionWordsArg = confusionWords
      .split(',')
      .map((w) => String(w).trim())
      .filter(Boolean)
      .join(',');

    const ext = extFromMime(req.file.mimetype);
    const tmp = path.join(tmpdir(), `mqp-confusion-${randomUUID()}.${ext}`);

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

    try {
      const { events, meta: timelineMeta, stderr: tlStderr } = await runTimelineOnVideoPath(tmp, confusionWordsArg);
      let frames = [];
      let ocrMeta = {};
      try {
        const ocr = await runOcrOnVideoPath(tmp, req.file.mimetype || 'video/webm');
        frames = ocr.frames;
        ocrMeta = ocr.meta || {};
      } catch (ocrErr) {
        // Fusion can still run with empty OCR (no grounding bonus).
        ocrMeta = { ocr_skipped: true, ocr_error: ocrErr instanceof Error ? ocrErr.message : String(ocrErr) };
      }

      const py = process.env.MQP_CONFUSION_PYTHON || defaultPythonExecutable();
      const scriptPath = process.env.MQP_CONFUSION_SCRIPT || DEFAULT_SCRIPT;
      const stdinPayload = JSON.stringify({ events, ocr: { frames } });

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
        child.stdin.write(stdinPayload);
        child.stdin.end();
      });

      if (result.code !== 0) {
        let errMsg = (result.stderr && result.stderr.trim()) || `Confusion score script exited with code ${result.code}`;
        try {
          const parsedErr = JSON.parse(result.stdout.trim() || '{}');
          if (parsedErr && typeof parsedErr.error === 'string' && parsedErr.error) {
            errMsg = parsedErr.error;
          }
        } catch {
          // ignore; use stderr / exit code message
        }
        res.status(422).json({
          error: errMsg,
          code: 'FUSION_SCRIPT_EXIT',
          durationMs: Date.now() - started,
          stderr: result.stderr.slice(0, 2000),
        });
        return;
      }

      let fusion;
      try {
        fusion = JSON.parse(result.stdout.trim() || '{}');
      } catch {
        res.status(422).json({
          error: 'Invalid JSON from confusion score script',
          code: 'BAD_JSON',
          durationMs: Date.now() - started,
          stderr: result.stderr.slice(0, 2000),
        });
        return;
      }
      if (fusion.error && !fusion.windows) {
        res.status(422).json({
          error: String(fusion.error),
          code: 'FUSION_SCRIPT_FAILED',
          durationMs: Date.now() - started,
        });
        return;
      }

      res.json({
        windows: fusion.windows || [],
        totalScore: fusion.totalScore ?? 0,
        maxWindow: fusion.maxWindow ?? null,
        meta: {
          timeline: timelineMeta,
          ocr: ocrMeta,
          timelineStderrTail: tlStderr?.slice?.(0, 500),
          fusionMeta: fusion.meta || {},
        },
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(422).json({
        error: msg,
        code: 'CONFUSION_SCORE_FAILED',
        durationMs: Date.now() - started,
      });
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
}
