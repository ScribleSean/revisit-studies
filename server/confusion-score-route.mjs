/**
 * GET /api/confusion-score — timeline + OCR + scripts/mqp_confusion_score.py
 *
 * Same query params as analyze-timeline for video + optional companion audio.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOcrOnVideoPath } from './mqp-ocr-runner.mjs';
import { runTimelineOnVideoPath } from './mqp-timeline-runner.mjs';
import { resolveCompanionAudioQueryToTemp, resolveVideoQueryToTemp, safeUnlink } from './resolve-video-input.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mqp_confusion_score.py');

function defaultPythonExecutable() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  return 'python3';
}

export function registerConfusionScoreRoutes(app) {
  app.get('/api/confusion-score', async (req, res) => {
    const started = Date.now();
    let videoPath = '';
    let videoUnlink = false;
    let companionTmp = '';
    let companionUnlink = false;

    try {
      const resolved = await resolveVideoQueryToTemp(req);
      videoPath = resolved.path;
      videoUnlink = resolved.unlinkAfter;
      const mimeType = resolved.mimeType || 'video/webm';

      const companion = await resolveCompanionAudioQueryToTemp(req);
      if (companion) {
        companionTmp = companion.path;
        companionUnlink = companion.unlinkAfter;
      }

      const confusionWords = typeof req.query.confusionWords === 'string' ? req.query.confusionWords : '';
      const confusionWordsArg = confusionWords
        .split(',')
        .map((w) => String(w).trim())
        .filter(Boolean)
        .join(',');

      const { events, meta: timelineMeta, stderr: tlStderr } = await runTimelineOnVideoPath(
        videoPath,
        confusionWordsArg,
        companionTmp || null,
      );
      let frames = [];
      let ocrMeta = {};
      try {
        const ocr = await runOcrOnVideoPath(videoPath, mimeType);
        frames = ocr.frames;
        ocrMeta = ocr.meta || {};
      } catch (ocrErr) {
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
          // ignore
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
      const missing = msg.includes('Missing query') || msg.includes('videoUrl');
      res.status(missing ? 400 : 422).json({
        error: msg,
        code: missing ? 'MISSING_INPUT' : 'CONFUSION_SCORE_FAILED',
        durationMs: Date.now() - started,
      });
    } finally {
      if (videoUnlink) await safeUnlink(videoPath);
      if (companionUnlink) await safeUnlink(companionTmp);
    }
  });
}
