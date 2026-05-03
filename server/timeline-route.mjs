/**
 * GET /api/analyze-timeline — Whisper + PySceneDetect via scripts/mqp_timeline_events.py
 *
 * Query:
 *   - videoUrl (required, https) OR localPath (only if MQP_ALLOW_LOCAL_VIDEO_PATH=true)
 *   - mimeType (optional, default video/webm)
 *   - companionAudioUrl | companionLocalPath (optional mic audio)
 *   - companionMimeType (optional)
 *   - confusionWords (optional comma-separated)
 */
import { readFile } from 'node:fs/promises';
import { sha256Hex, readJsonCache } from './cache.mjs';
import { runTimelineOnVideoPath } from './mqp-timeline-runner.mjs';
import { resolveCompanionAudioQueryToTemp, resolveVideoQueryToTemp, safeUnlink } from './resolve-video-input.mjs';

export function registerTimelineRoutes(app) {
  app.get('/api/analyze-timeline', async (req, res) => {
    const started = Date.now();
    let videoPath = '';
    let videoUnlink = false;
    let companionTmp = '';
    let companionUnlink = false;

    try {
      const resolved = await resolveVideoQueryToTemp(req);
      videoPath = resolved.path;
      videoUnlink = resolved.unlinkAfter;

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

      const whisperModel = String(process.env.WHISPER_MODEL || 'base');
      const videoBuf = await readFile(videoPath);
      let companionBuf = Buffer.alloc(0);
      if (companionTmp) {
        companionBuf = await readFile(companionTmp);
      }

      const cacheKey = sha256Hex([videoBuf, companionBuf, confusionWordsArg, whisperModel]);
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

      const out = await runTimelineOnVideoPath(videoPath, confusionWordsArg, companionTmp || null);
      res.json({
        events: out.events,
        meta: out.meta || {},
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('Missing query') || msg.includes('videoUrl') ? 'MISSING_INPUT' : 'TIMELINE_FAILED';
      res.status(code === 'MISSING_INPUT' ? 400 : 422).json({
        error: msg,
        code,
        durationMs: Date.now() - started,
      });
    } finally {
      if (videoUnlink) await safeUnlink(videoPath);
      if (companionUnlink) await safeUnlink(companionTmp);
    }
  });
}
