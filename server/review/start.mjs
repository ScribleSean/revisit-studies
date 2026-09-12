import { access, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalysisCache } from './cache.mjs';
import { createReviewServer } from './http.mjs';
import { runProcess } from './process.mjs';
import { createTimelineAnalyzer } from './timeline.mjs';
import { createEmbedder } from './embedding.mjs';
import { createLocalAnalyzer, createOllamaClient } from './ollama.mjs';
import { createOpenAiAnalyzer, createOpenAiVisionClient } from './openai.mjs';
import { createGeminiAnalyzer, createGeminiVideoClient } from './gemini.mjs';
import { createCleanupJournal } from './cleanupJournal.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.REVIEW_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const ffprobe = process.env.FFPROBE || 'ffprobe';
const ffmpegDirectory = process.env.REVIEW_FFMPEG_DIRECTORY || '';
const analyzers = {};
let embedder;
let cleanupClient;
try {
  await access(path.join(root, '.review-models/minilm/config.json'));
  await runProcess(python, ['-c', 'import sentence_transformers'], { timeoutMs: 30000 });
  embedder = createEmbedder({ python });
} catch (error) {
  console.warn(`Local embeddings unavailable (${error.code || 'STARTUP_CHECK_FAILED'}). Check the Python environment and MiniLM files in .review-models/minilm.`);
}
try {
  await runProcess(python, ['-c', 'import cv2, scenedetect'], { timeoutMs: 30000 });
  await runProcess(ffprobe, ['-version'], { timeoutMs: 5000 });
  analyzers.heuristic = createTimelineAnalyzer({ python, ffprobe, ffmpegDirectory });
} catch {
  console.warn('Local timeline unavailable. Install scripts/requirements-review.txt in .venv and configure ffprobe.');
}
if (analyzers.heuristic && process.env.OLLAMA_VLM_MODEL) {
  try {
    const client = createOllamaClient({ baseUrl: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_VLM_MODEL });
    const ffmpeg = process.env.REVIEW_FFMPEG || (ffmpegDirectory ? path.join(ffmpegDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg');
    await runProcess(ffmpeg, ['-version'], { timeoutMs: 5000 });
    if (await client.available(AbortSignal.timeout(5000))) {
      analyzers.local = createLocalAnalyzer({ timeline: analyzers.heuristic, client, ffmpeg, count: Number(process.env.REVIEW_LOCAL_FRAMES || 6) });
    } else console.warn('Configured Ollama model does not advertise vision support.');
  } catch {
    console.warn('Local VLM unavailable. Check the running Ollama server, installed vision model and frame settings.');
  }
}
const uploadRoot = path.join(root, '.review-uploads');
if (analyzers.heuristic && process.env.REVIEW_ENABLE_CLOUD === '1' && process.env.OPENAI_API_KEY) {
  try {
    const ffmpeg = process.env.REVIEW_FFMPEG || (ffmpegDirectory ? path.join(ffmpegDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg');
    await runProcess(ffmpeg, ['-version'], { timeoutMs: 5000 });
    const client = createOpenAiVisionClient({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_VISION_MODEL || 'gpt-4o' });
    analyzers.gpt4o = createOpenAiAnalyzer({ timeline: analyzers.heuristic, client, ffmpeg, count: Number(process.env.REVIEW_OPENAI_FRAMES || 10) });
  } catch {
    console.warn('OpenAI vision unavailable. Check local timeline dependencies, ffmpeg and cloud configuration.');
  }
}
await mkdir(uploadRoot, { recursive: true });
if (analyzers.heuristic && process.env.REVIEW_ENABLE_CLOUD === '1' && process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL) {
  try {
    // A one-way scope binds pending names to the configured key without persisting the key.
    const scope = createHash('sha256').update('review-gemini-cleanup:').update(process.env.GEMINI_API_KEY).digest('hex');
    const journal = createCleanupJournal(path.join(root, '.review-cleanup', scope));
    const client = createGeminiVideoClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL, journal });
    cleanupClient = client;
    analyzers.gemini = createGeminiAnalyzer({ timeline: analyzers.heuristic, client });
  } catch { console.warn('Gemini unavailable. Check server API key and explicit GEMINI_MODEL configuration.'); }
}
const server = createReviewServer({ analyzers, embedder, uploadRoot, cache: createAnalysisCache(path.join(root, '.review-cache')) });
if (cleanupClient) {
  const shutdown = new AbortController();
  let running = false;
  const recover = async () => {
    if (running || shutdown.signal.aborted) return;
    running = true;
    try {
      const result = await cleanupClient.recoverCleanup(shutdown.signal);
      if (result?.attempted || result?.failed) console.log(`Gemini cleanup: ${result.removed} removed, ${result.pending} pending, ${result.failed} failed.`);
    } catch { if (!shutdown.signal.aborted) console.warn('Gemini cleanup recovery could not read or update its journal. Pending entries are retained.'); }
    finally { running = false; }
  };
  void recover();
  const timer = setInterval(recover, 60000); timer.unref();
  server.on('close', () => { shutdown.abort(); clearInterval(timer); });
}
const port = Number(process.env.REVIEW_PORT || 3001);
server.listen(port, '127.0.0.1', () => console.log(`ReVIEW bridge listening on http://127.0.0.1:${port}`));
