/**
 * GET /api/extract-ocr — sample frames + OCR key text.
 *
 * Query: videoUrl | localPath (same rules as analyze-timeline), mimeType optional.
 */
import { runOcrOnVideoPath } from './mqp-ocr-runner.mjs';
import { resolveVideoQueryToTemp, safeUnlink } from './resolve-video-input.mjs';

export function registerOcrRoutes(app) {
  app.get('/api/extract-ocr', async (req, res) => {
    const started = Date.now();
    let videoPath = '';
    let unlinkAfter = false;
    try {
      const resolved = await resolveVideoQueryToTemp(req);
      videoPath = resolved.path;
      unlinkAfter = resolved.unlinkAfter;
      const mimeType = resolved.mimeType || 'video/webm';

      const { frames, meta } = await runOcrOnVideoPath(videoPath, mimeType);
      res.json({
        frames,
        meta,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const low = msg.toLowerCase();
      const code = low.includes('missing query') || low.includes('videourl')
        ? 'MISSING_INPUT'
        : low.includes('ffmpeg') || low.includes('frame')
          ? 'FRAME_EXTRACT_FAILED'
          : 'OCR_SCRIPT_FAILED';
      const status = code === 'MISSING_INPUT' ? 400 : 422;
      res.status(status).json({
        error: msg,
        code,
        durationMs: Date.now() - started,
      });
    } finally {
      if (unlinkAfter) await safeUnlink(videoPath);
    }
  });
}
