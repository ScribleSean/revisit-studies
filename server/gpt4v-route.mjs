/**
 * POST /api/analyze-gpt4v — sample frames + OpenAI vision (gpt-4o) summary.
 *
 * Requires OPENAI_API_KEY in .env (server-side only).
 */
import {
  cleanupFiles,
  extractJpegFrameBuffer,
  ffprobeDurationSeconds,
  sampleTimestamps,
  writeTempVideoFromUpload,
} from './frame-sampler.mjs';

function getOpenAiKey() {
  return process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';
}

function pickModel() {
  return process.env.OPENAI_VISION_MODEL || 'gpt-4o';
}

function pickFallbackModel() {
  return process.env.OPENAI_VISION_MODEL_FALLBACK || 'gpt-4-vision-preview';
}

export function registerGpt4vRoutes(app, upload) {
  app.post('/api/analyze-gpt4v', upload.single('video'), async (req, res) => {
    const started = Date.now();
    const apiKey = getOpenAiKey();
    if (!apiKey) {
      res.status(503).json({
        error: 'Set OPENAI_API_KEY in .env for the mass-analyze server.',
        code: 'NO_KEY',
        durationMs: Date.now() - started,
      });
      return;
    }

    if (!req.file?.buffer) {
      res.status(400).json({
        error: 'Missing video file (multipart field "video").',
        code: 'MISSING_FILE',
        durationMs: Date.now() - started,
      });
      return;
    }

    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';
    if (!prompt.trim()) {
      res.status(400).json({
        error: 'Missing prompt.',
        code: 'MISSING_PROMPT',
        durationMs: Date.now() - started,
      });
      return;
    }

    const framesEnv = Number(process.env.MQP_GPT4V_FRAMES || 10);
    const frames = Math.max(1, Math.min(20, Math.floor(framesEnv)));

    let tmp = '';
    try {
      tmp = await writeTempVideoFromUpload({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        prefix: 'mqp-gpt4v',
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
      const duration = await ffprobeDurationSeconds(tmp);
      const times = sampleTimestamps(duration ?? 0, frames, 20);

      let imagesBase64;
      try {
        const buffers = await Promise.all(times.map((t) => extractJpegFrameBuffer(tmp, t)));
        imagesBase64 = buffers.map((b) => b.toString('base64'));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(422).json({
          error: msg,
          code: 'FRAME_EXTRACT_FAILED',
          durationMs: Date.now() - started,
        });
        return;
      }

      const systemPreamble = [
        'You are analyzing usability-study screen recordings.',
        'You will be given several still frames sampled across the clip, in chronological order.',
        'Write a concise summary that a researcher can use without watching the full video.',
      ].join(' ');

      const userContent = [
        { type: 'text', text: `${systemPreamble}\n\nResearcher prompt:\n${prompt.trim()}` },
        ...imagesBase64.map((b64) => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${b64}` },
        })),
      ];

      const callOpenAi = async (modelId) => {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: userContent }],
            max_tokens: 1200,
          }),
        });
        const j = await r.json().catch(() => ({}));
        return { r, j };
      };

      let primaryModel = pickModel();
      let { r, j } = await callOpenAi(primaryModel);

      if (!r.ok && r.status === 404 && pickFallbackModel() !== primaryModel) {
        primaryModel = pickFallbackModel();
        ({ r, j } = await callOpenAi(primaryModel));
      }

      if (!r.ok) {
        const errMsg = typeof j?.error?.message === 'string' ? j.error.message : `HTTP ${r.status}`;
        res.status(422).json({
          error: errMsg,
          code: 'API_ERROR',
          durationMs: Date.now() - started,
        });
        return;
      }

      const choice = Array.isArray(j?.choices) && j.choices.length > 0 ? j.choices[0] : null;
      const content = choice?.message?.content;
      const summary = typeof content === 'string' ? content.trim() : '';

      if (!summary) {
        res.status(422).json({
          error: 'Empty completion from OpenAI',
          code: 'API_ERROR',
          durationMs: Date.now() - started,
        });
        return;
      }

      res.json({
        summary,
        modelUsed: typeof j?.model === 'string' ? j.model : primaryModel,
        framesUsed: times.length,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(422).json({
        error: msg,
        code: 'API_ERROR',
        durationMs: Date.now() - started,
      });
    } finally {
      await cleanupFiles([tmp].filter(Boolean));
    }
  });
}
