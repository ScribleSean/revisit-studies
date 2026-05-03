/**
 * GET /api/analyze-gpt4v — sample frames + OpenAI vision (gpt-4o) summary.
 *
 * Query: videoUrl | localPath, mimeType, prompt (required).
 */
import {
  clampSampleTimes,
  extractJpegFrameBuffer,
  ffprobeDurationSeconds,
  guessImageMimeFromBuffer,
  sampleTimestamps,
} from './frame-sampler.mjs';
import { resolveVideoQueryToTemp, safeUnlink } from './resolve-video-input.mjs';

function getOpenAiKey() {
  return process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';
}

function pickModel() {
  return process.env.OPENAI_VISION_MODEL || 'gpt-4o';
}

function pickFallbackModel() {
  return process.env.OPENAI_VISION_MODEL_FALLBACK || 'gpt-4-vision-preview';
}

export function registerGpt4vRoutes(app) {
  app.get('/api/analyze-gpt4v', async (req, res) => {
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

    const prompt = typeof req.query.prompt === 'string' ? req.query.prompt : '';
    if (!prompt.trim()) {
      res.status(400).json({
        error: 'Missing query parameter prompt.',
        code: 'MISSING_PROMPT',
        durationMs: Date.now() - started,
      });
      return;
    }

    let tmp = '';
    let unlinkAfter = false;

    try {
      const resolved = await resolveVideoQueryToTemp(req);
      tmp = resolved.path;
      unlinkAfter = resolved.unlinkAfter;

      const framesEnv = Number(process.env.MQP_GPT4V_FRAMES || 10);
      const frames = Math.max(1, Math.min(20, Math.floor(framesEnv)));

      const duration = await ffprobeDurationSeconds(tmp);
      const times = clampSampleTimes(sampleTimestamps(duration ?? 0, frames, 20), duration ?? 0);

      let frameBuffers = [];
      try {
        frameBuffers = await Promise.all(times.map((t) => extractJpegFrameBuffer(tmp, t)));
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
        ...frameBuffers.map((buf) => ({
          type: 'image_url',
          image_url: { url: `data:${guessImageMimeFromBuffer(buf)};base64,${buf.toString('base64')}` },
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
      const status = msg.includes('Missing query') || msg.includes('videoUrl') ? 400 : 422;
      res.status(status).json({
        error: msg,
        code: 'API_ERROR',
        durationMs: Date.now() - started,
      });
    } finally {
      if (unlinkAfter) await safeUnlink(tmp);
    }
  });
}
