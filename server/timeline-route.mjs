/**
 * POST /api/analyze-timeline — Whisper + PySceneDetect via scripts/mqp_timeline_events.py
 *
 * Multipart fields:
 *   - video (required)
 *   - companionAudio (optional) — study microphone audio from Firebase audio/{participant}_{task} when screen capture has no muxed audio track
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

function companionAudioExtFromMime(mime) {
  if (!mime || typeof mime !== 'string') return 'wav';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'wav';
}

export function registerTimelineRoutes(app, upload) {
  const tlUpload = upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'companionAudio', maxCount: 1 },
  ]);

  app.post('/api/analyze-timeline', tlUpload, async (req, res) => {
    const started = Date.now();
    const videoFile = req.files?.video?.[0];
    if (!videoFile?.buffer) {
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
    const audioPart = req.files?.companionAudio?.[0];
    const companionBuf = audioPart?.buffer || Buffer.alloc(0);
    const cacheKey = sha256Hex([videoFile.buffer, companionBuf, confusionWordsArg, whisperModel]);
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

    const ext = extFromMime(videoFile.mimetype);
    const tmp = path.join(tmpdir(), `mqp-timeline-${randomUUID()}.${ext}`);

    let companionTmp = '';
    if (audioPart?.buffer?.length) {
      const aext = companionAudioExtFromMime(audioPart.mimetype);
      companionTmp = path.join(tmpdir(), `mqp-companion-audio-${randomUUID()}.${aext}`);
    }

    try {
      await writeFile(tmp, videoFile.buffer);
      if (companionTmp) {
        await writeFile(companionTmp, audioPart.buffer);
      }
    } catch (e) {
      await unlink(tmp).catch(() => {});
      if (companionTmp) await unlink(companionTmp).catch(() => {});
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
      const out = await runTimelineOnVideoPath(tmp, confusionWordsArg, companionTmp || null);
      events = out.events;
      meta = out.meta || {};
    } catch (e) {
      res.status(422).json({
        error: e instanceof Error ? e.message : String(e),
        code: 'TIMELINE_SCRIPT_FAILED',
        durationMs: Date.now() - started,
      });
      return;
    } finally {
      await unlink(tmp).catch(() => {});
      if (companionTmp) await unlink(companionTmp).catch(() => {});
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
