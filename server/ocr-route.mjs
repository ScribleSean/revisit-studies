/**
 * POST /api/extract-ocr — sample frames + OCR key text.
 *
 * Uses ffmpeg for frame sampling and a Python script that runs pytesseract or the tesseract CLI.
 */
import { cleanupFiles, writeTempVideoFromUpload } from './frame-sampler.mjs';
import { runOcrOnVideoPath } from './mqp-ocr-runner.mjs';

export function registerOcrRoutes(app, upload) {
  app.post('/api/extract-ocr', upload.single('video'), async (req, res) => {
    const started = Date.now();
    if (!req.file?.buffer) {
      res.status(400).json({
        error: 'Missing video file (multipart field "video").',
        code: 'MISSING_FILE',
        durationMs: Date.now() - started,
      });
      return;
    }

    let videoPath = '';
    try {
      videoPath = await writeTempVideoFromUpload({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        prefix: 'mqp-ocr',
      });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Failed to write temp file',
        code: 'TEMP_WRITE_FAILED',
        durationMs: Date.now() - started,
      });
      return;
    }

    try {
      const { frames, meta } = await runOcrOnVideoPath(videoPath, req.file.mimetype || 'video/webm');
      res.json({
        frames,
        meta,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('ffmpeg') || msg.includes('frame') ? 'FRAME_EXTRACT_FAILED' : 'OCR_SCRIPT_FAILED';
      res.status(422).json({
        error: msg,
        code,
        durationMs: Date.now() - started,
      });
    } finally {
      await cleanupFiles([videoPath].filter(Boolean));
    }
  });
}
