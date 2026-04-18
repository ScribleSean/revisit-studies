/**
 * POST /api/analyze-local — sample frames + local VLM via Ollama.
 *
 * Intended for privacy-preserving local-only analysis when Gemini cannot be used.
 * Requires an Ollama daemon on the same machine (default: http://127.0.0.1:11434).
 */
import { cleanupFiles, extractJpegFrameBuffer, ffprobeDurationSeconds, sampleTimestamps, writeTempVideoFromUpload } from './frame-sampler.mjs';

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

export function registerLocalRoutes(app, upload) {
  app.post('/api/analyze-local', upload.single('video'), async (req, res) => {
    const started = Date.now();
    if (!req.file?.buffer) {
      res.status(400).json({
        error: 'Missing video file (multipart field "video").',
        code: 'MISSING_FILE',
        durationMs: Date.now() - started,
      });
      return;
    }

    const baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
    const model = String(process.env.OLLAMA_VLM_MODEL || 'llava:7b');
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : '';
    const frames = Number(process.env.MQP_LOCAL_FRAMES || 6);
    let tmp = '';
    try {
      tmp = await writeTempVideoFromUpload({ buffer: req.file.buffer, mimeType: req.file.mimetype, prefix: 'mqp-local' });
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
      const times = sampleTimestamps(duration ?? 0, frames, 12);

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
      const status = code === 'OLLAMA_UNAVAILABLE' ? 503 : 422;
      res.status(status).json({
        error: msg,
        code,
        durationMs: Date.now() - started,
      });
    } finally {
      await cleanupFiles([tmp].filter(Boolean));
    }
  });
}
