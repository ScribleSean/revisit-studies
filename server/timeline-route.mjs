/**
 * POST /api/analyze-timeline — Whisper + PySceneDetect via scripts/mqp_timeline_events.py
 */
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJsonCache, sha256Hex, writeJsonCache } from './cache.mjs';
import { runTimelineOnVideoPath } from './mqp-timeline-runner.mjs';

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

    let events;
    let meta;
    try {
      const out = await runTimelineOnVideoPath(tmp, confusionWordsArg);
      events = out.events;
      meta = out.meta || {};
    } catch (e) {
      await unlink(tmp).catch(() => {});
      res.status(422).json({
        error: e instanceof Error ? e.message : String(e),
        code: 'TIMELINE_SCRIPT_FAILED',
        durationMs: Date.now() - started,
      });
      return;
    } finally {
      await unlink(tmp).catch(() => {});
    }

    res.json({
      events,
      meta,
      durationMs: Date.now() - started,
    });

    await writeJsonCache(cacheKey, {
      events,
      meta,
      cachedAt: new Date().toISOString(),
    }).catch(() => {});
  });
}
