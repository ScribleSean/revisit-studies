/**
 * Local Gemini Files API bridge for screen recordings over the inline (~20MB) limit.
 * Run: yarn serve:mass-api (from repo root). Vite dev server proxies /api/* here.
 *
 * All analysis endpoints are GET-only: pass storage HTTPS URLs (videoUrl, companionAudioUrl, …).
 */
import express from 'express';
import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { registerTimelineRoutes } from './timeline-route.mjs';
import { registerLocalRoutes } from './local-route.mjs';
import { registerOcrRoutes } from './ocr-route.mjs';
import { registerGpt4vRoutes } from './gpt4v-route.mjs';
import { registerConfusionScoreRoutes } from './confusion-score-route.mjs';
import { registerEmbedSummaryRoutes } from './embed-summary-route.mjs';
import { readJsonCache, sha256Hex } from './cache.mjs';
import { getMassApiCapabilities } from './mass-api-capabilities.mjs';
import { resolveVideoQueryToTemp, safeUnlink } from './resolve-video-input.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = parseInt(process.env.PORT || process.env.MASS_API_PORT || process.env.VITE_MASS_API_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

function getApiKey() {
  return process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
}

function getOpenAiKey() {
  return process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';
}

function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return 'gemini-2.0-flash';
  return model.replace(/^models\//, '');
}

function sleep(ms) {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(getApiKey()),
    hasOpenAiKey: Boolean(getOpenAiKey()),
    capabilities: getMassApiCapabilities(),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    ollamaModel: process.env.OLLAMA_VLM_MODEL || 'llava:7b',
  });
});

app.get('/api/analyze-large', async (req, res) => {
  const started = Date.now();
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(503).json({
      error: 'Set GEMINI_API_KEY or VITE_GEMINI_API_KEY in .env for the mass-analyze server.',
      code: 'MISSING_KEY',
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
    const mimeType = resolved.mimeType || 'video/webm';

    const modelId = normalizeModelId(typeof req.query.model === 'string' ? req.query.model : '');
    const buf = await readFile(tmp);

    const cacheKey = sha256Hex([buf, prompt, modelId]);
    const cached = await readJsonCache(cacheKey);
    if (cached && typeof cached.summary === 'string') {
      // eslint-disable-next-line no-console
      console.log(`[mqp-cache] hit analyze-large ${cacheKey.slice(0, 12)}`);
      res.json({
        summary: cached.summary,
        modelUsed: cached.modelUsed || (modelId.startsWith('models/') ? modelId : `models/${modelId}`),
        durationMs: Date.now() - started,
        cacheHit: true,
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[mqp-cache] miss analyze-large ${cacheKey.slice(0, 12)}`);

    const fileManager = new GoogleAIFileManager(apiKey);
    const genAI = new GoogleGenerativeAI(apiKey);

    let uploadedName = null;
    try {
      const uploadResult = await fileManager.uploadFile(buf, {
        mimeType,
        displayName: `mqp-screen-${Date.now()}`,
      });
      uploadedName = uploadResult.file.name;

      const deadline = Date.now() + 12 * 60 * 1000;
      let meta = uploadResult.file;
      while (meta.state === FileState.PROCESSING && Date.now() < deadline) {
        await sleep(2000);
        meta = await fileManager.getFile(uploadedName);
      }

      if (meta.state === FileState.FAILED) {
        const reason = meta.error?.message || 'File processing failed';
        res.status(422).json({
          error: reason,
          code: 'FILE_PROCESSING_FAILED',
          durationMs: Date.now() - started,
        });
        return;
      }
      if (meta.state !== FileState.ACTIVE) {
        res.status(422).json({
          error: `File not ready (state=${meta.state}).`,
          code: 'FILE_NOT_ACTIVE',
          durationMs: Date.now() - started,
        });
        return;
      }

      const model = genAI.getGenerativeModel({ model: modelId });
      const result = await model.generateContent([
        { fileData: { mimeType: meta.mimeType, fileUri: meta.uri } },
        { text: prompt },
      ]);

      const text = result.response.text();
      const modelUsed = modelId.startsWith('models/') ? modelId : `models/${modelId}`;

      try {
        if (uploadedName) await fileManager.deleteFile(uploadedName);
      } catch {
        /* best-effort cleanup */
      }

      res.json({
        summary: text,
        modelUsed,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      if (uploadedName) {
        try {
          await fileManager.deleteFile(uploadedName);
        } catch {
          /* ignore */
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      res.status(422).json({
        error: msg,
        code: 'GENERATION_FAILED',
        durationMs: Date.now() - started,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const missing = msg.includes('Missing query') || msg.includes('videoUrl');
    res.status(missing ? 400 : 422).json({
      error: msg,
      code: missing ? 'MISSING_INPUT' : 'ANALYZE_LARGE_FAILED',
      durationMs: Date.now() - started,
    });
  } finally {
    if (unlinkAfter) await safeUnlink(tmp);
  }
});

registerTimelineRoutes(app);
registerLocalRoutes(app);
registerOcrRoutes(app);
registerGpt4vRoutes(app);
registerConfusionScoreRoutes(app);
registerEmbedSummaryRoutes(app);

app.use((err, _req, res, _next) => {
  res.status(500).json({
    error: err instanceof Error ? err.message : 'Unexpected server error',
    code: 'INTERNAL',
  });
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[mqp] API listening on http://${HOST}:${PORT} — GET /api/analyze-large, /api/analyze-local, /api/analyze-gpt4v, /api/analyze-timeline, /api/extract-ocr, /api/confusion-score, /api/embed-summary, GET /api/health`,
  );
});
