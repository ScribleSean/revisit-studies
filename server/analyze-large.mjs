/**
 * Local Gemini Files API bridge for screen recordings over the inline (~20MB) limit.
 * Run: yarn serve:mass-api (from repo root). Vite dev server proxies /api/analyze-large here.
 */
import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const PORT = Number(process.env.MASS_API_PORT || process.env.VITE_MASS_API_PORT || 3001, 10);
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function getApiKey() {
  return process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasKey: Boolean(getApiKey()) });
});

app.post('/api/analyze-large', upload.single('video'), async (req, res) => {
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

  const modelId = normalizeModelId(req.body.model);
  const mimeType = req.file.mimetype || 'video/webm';
  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);

  let uploadedName = null;
  try {
    const uploadResult = await fileManager.uploadFile(req.file.buffer, {
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
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: `Video exceeds server limit (${MAX_UPLOAD_BYTES} bytes).`,
      code: 'FILE_TOO_LARGE',
    });
    return;
  }
  res.status(500).json({
    error: err instanceof Error ? err.message : 'Unexpected server error',
    code: 'INTERNAL',
  });
});

app.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[mqp] Gemini mass-analyze API at http://127.0.0.1:${PORT} (POST /api/analyze-large)`);
});
