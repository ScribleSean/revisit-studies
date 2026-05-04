/**
 * GET /api/analyze-local — sample frames + local VLM via Ollama.
 *
 * Query: videoUrl | localPath, mimeType, prompt (required).
 */
import {
  clampSampleTimes,
  extractJpegFrameBuffer,
  resolveVideoSampleDurationSeconds,
  sampleTimestamps,
} from './frame-sampler.mjs';
import { resolveVideoQueryToTemp, safeUnlink } from './resolve-video-input.mjs';

async function ollamaGenerate({ baseUrl, model, prompt, imagesBase64 }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/generate`;
  const payload = {
    model,
    prompt,
    stream: false,
    ...(imagesBase64 ? { images: imagesBase64 } : {}),
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = new Error(`Ollama request failed: ${msg}`);
    err.code = 'OLLAMA_UNAVAILABLE';
    throw err;
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.code = 'OLLAMA_ERROR';
    throw err;
  }

  const text = typeof json.response === 'string' ? json.response : '';
  return text.trim();
}

export function registerLocalRoutes(app) {
  app.get('/api/analyze-local', async (req, res) => {
    const started = Date.now();
    let tmp = '';
    let unlinkAfter = false;

    try {
      const prompt = typeof req.query.prompt === 'string' ? req.query.prompt : '';
      if (!prompt.trim()) {
        res.status(400).json({
          error: 'Missing query parameter prompt.',
          code: 'MISSING_PROMPT',
          durationMs: Date.now() - started,
        });
        return;
      }

      const resolved = await resolveVideoQueryToTemp(req);
      tmp = resolved.path;
      unlinkAfter = resolved.unlinkAfter;

      const baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
      const model = String(process.env.OLLAMA_VLM_MODEL || 'llava:7b');
      const frames = Number(process.env.MQP_LOCAL_FRAMES || 6);

      const duration = await resolveVideoSampleDurationSeconds(tmp);
      const times = clampSampleTimes(sampleTimestamps(duration, frames, 12), duration);

      const framePrompt = [
        'You are analyzing a usability study screen recording.',
        'Describe what is happening in this single frame as concretely as possible.',
        'Mention any visible UI state, cursor interactions, tooltips, errors, or strategy shifts if evident.',
      ].join(' ');

      const descriptions = await Promise.all(
        times.map(async (t) => {
          const jpeg = await extractJpegFrameBuffer(tmp, t);
          const base64 = jpeg.toString('base64');
          const text = await ollamaGenerate({
            baseUrl,
            model,
            prompt: `${framePrompt}\n\nFrame time: ${t.toFixed(1)}s`,
            imagesBase64: [base64],
          });
          return `- t=${t.toFixed(1)}s: ${text}`;
        }),
      );

      const synthesisPrompt = [
        'You are given descriptions of sampled frames from a screen recording.',
        'Write a 3–5 sentence high-level summary of what the participant did and where they struggled.',
        prompt.trim() ? `User prompt: ${prompt.trim()}` : '',
        'Frame descriptions:',
        descriptions.join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n');

      const summary = await ollamaGenerate({
        baseUrl,
        model,
        prompt: synthesisPrompt,
      });

      res.json({
        summary,
        modelUsed: model,
        durationMs: Date.now() - started,
        meta: {
          framesSampled: times.length,
          durationSeconds: duration,
          ollamaBaseUrl: baseUrl,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = typeof e?.code === 'string' ? e.code : (msg.includes('Ollama request failed') ? 'OLLAMA_UNAVAILABLE' : 'LOCAL_ANALYZE_FAILED');
      const status = code === 'OLLAMA_UNAVAILABLE' ? 503 : msg.includes('Missing query') || msg.includes('videoUrl') ? 400 : 422;
      res.status(status).json({
        error: msg,
        code,
        durationMs: Date.now() - started,
      });
    } finally {
      if (unlinkAfter) await safeUnlink(tmp);
    }
  });
}
