import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { analysisKey } from './cache.mjs';
import { AnalysisError } from './process.mjs';
import { readEmbeddingRequest } from './embedding.mjs';
import { reviewMetadataLength, reviewVideoChunks } from './uploadMetadata.mjs';

const MEDIA_TYPES = new Set(['video/webm', 'video/mp4', 'video/ogg', 'application/octet-stream']);
const PIPELINES = new Set(['heuristic', 'gemini', 'gpt4o', 'local']);
const cacheable = (result) => !result?.meta?.scene_error && !result?.meta?.ocr_error && !(result?.meta?.audio_skipped && !['no_audio_stream', 'digital_silence'].includes(result.meta.audio_skip_reason));

function reply(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

/** Native HTTP keeps the bridge small; uploads never become an in-memory base64 copy. */
export function createReviewServer({ analyzers, embedder, cache, uploadRoot, maxBytes = 256 * 1024 * 1024, maxConcurrent = 2, timeoutMs = 15 * 60 * 1000, allowedOrigins = ['http://localhost:8080', 'http://127.0.0.1:8080'] }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Bridge limits must be positive');
  }
  let active = 0;
  const server = createServer(async (request, response) => {
    let directory;
    let timeout;
    let admitted = false;
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', abort);
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/review/health') {
        reply(response, 200, { version: 1, pipelines: [...PIPELINES].map((id) => ({ id, available: typeof analyzers[id] === 'function' })), embeddings: typeof embedder === 'function', active, maxConcurrent });
        return;
      }
      if (request.method !== 'POST' || !['/api/review/analyze', '/api/review/embed'].includes(url.pathname)) {
        reply(response, 404, { code: 'NOT_FOUND', message: 'Unknown review endpoint' });
        return;
      }
      if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) {
        reply(response, 403, { code: 'ORIGIN_DENIED', message: 'This origin cannot start local analysis' });
        return;
      }
      if (url.pathname === '/api/review/embed') {
        if (!embedder) { reply(response, 503, { code: 'UNAVAILABLE', message: 'Local embeddings are not configured' }); return; }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') { reply(response, 415, { message: 'Send JSON text for embedding' }); return; }
        if (active >= maxConcurrent) { reply(response, 429, { message: 'Analysis capacity is full. Try again when a job finishes.' }); return; }
        admitted = true;
        active += 1;
        timeout = setTimeout(() => {
          const error = new AnalysisError('TIMEOUT', 'Embedding exceeded its time limit');
          controller.abort(error);
          if (!request.complete) request.destroy(error);
        }, Math.min(timeoutMs, 120000));
        const texts = await readEmbeddingRequest(request);
        const key = analysisKey(Buffer.from(JSON.stringify(texts)), { type: 'embeddings', model: embedder.version });
        const hit = await cache.get(key);
        if (hit !== null) { reply(response, 200, { embeddings: hit, cached: true }); return; }
        const embeddings = await embedder(texts, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        await cache.set(key, embeddings);
        reply(response, 200, { embeddings, cached: false });
        return;
      }
      const pipeline = url.searchParams.get('pipeline') || 'heuristic';
      if (!PIPELINES.has(pipeline)) {
        reply(response, 400, { code: 'INVALID_PIPELINE', message: 'Unknown analysis pipeline' });
        return;
      }
      if (!analyzers[pipeline]) {
        reply(response, 503, { code: 'UNAVAILABLE', message: `${pipeline} is not configured` });
        return;
      }
      if (!MEDIA_TYPES.has(request.headers['content-type']?.split(';')[0])) {
        reply(response, 415, { code: 'UNSUPPORTED_MEDIA', message: 'Upload a video recording' });
        return;
      }
      const metadataLength = reviewMetadataLength(request.headers['x-review-metadata-length']);
      if (Number(request.headers['content-length']) > maxBytes + metadataLength) {
        reply(response, 413, { code: 'UPLOAD_LIMIT', message: 'Recording exceeds the upload limit' });
        return;
      }
      if (active >= maxConcurrent) {
        reply(response, 429, { code: 'BUSY', message: 'Analysis capacity is full. Try again after a running recording finishes.' });
        return;
      }
      let confusionWords = url.searchParams.get('confusionWords') || '';
      let prompt = url.searchParams.get('prompt') || '';
      if (confusionWords.length > 2000 || prompt.length > 8000) {
        reply(response, 400, { code: 'INVALID_OPTIONS', message: 'Analysis options are too long' });
        return;
      }
      active += 1;
      admitted = true;
      timeout = setTimeout(() => {
        const error = new AnalysisError('TIMEOUT', 'Analysis exceeded its time limit');
        controller.abort(error);
        // Abort a stalled upload as well as an active analysis process.
        if (!request.complete) request.destroy(error);
      }, timeoutMs);
      directory = await mkdtemp(path.join(uploadRoot, 'review-upload-'));
      const filename = path.join(directory, 'recording');
      const file = await open(filename, 'wx');
      const hash = createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of reviewVideoChunks(request, metadataLength, (metadata) => { ({ confusionWords, prompt } = metadata); })) {
          if (controller.signal.aborted) throw controller.signal.reason;
          size += chunk.length;
          if (size > maxBytes) throw new AnalysisError('UPLOAD_LIMIT', 'Recording exceeds the upload limit');
          hash.update(chunk);
          await file.writeFile(chunk);
        }
      } finally {
        await file.close();
      }
      if (!size) throw new AnalysisError('EMPTY_UPLOAD', 'The recording is empty');
      const settings = { version: 1, pipeline, confusionWords, prompt, mimeType: request.headers['content-type'].split(';')[0], analyzerVersion: analyzers[pipeline].version || '1' };
      const key = analysisKey(Buffer.from(hash.digest('hex')), settings);
      const hit = await cache.get(key);
      if (hit !== null && cacheable(hit)) {
        reply(response, 200, { result: hit, cached: true, analyzerVersion: settings.analyzerVersion });
        return;
      }
      const started = performance.now();
      const result = await analyzers[pipeline]({ filename, signal: controller.signal, ...settings });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cacheable(result)) await cache.set(key, result);
      reply(response, 200, { result, cached: false, analyzerVersion: settings.analyzerVersion, durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      const code = error instanceof AnalysisError ? error.code : controller.signal.aborted ? 'CANCELLED' : 'ANALYSIS_FAILED';
      const status = { INVALID_OPTIONS: 400, INVALID_TEXT: 400, UPLOAD_LIMIT: 413, EMPTY_UPLOAD: 400, CANCELLED: 499, TIMEOUT: 504, UNAVAILABLE: 503 }[code] || 500;
      reply(response, status, { code, message: error instanceof AnalysisError ? error.message : 'Analysis failed. Check local service dependencies and retry.' });
    } finally {
      clearTimeout(timeout);
      response.off('close', abort);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (admitted) active -= 1;
    }
  });
  server.on('close', () => { embedder?.close?.(); });
  return server;
}
