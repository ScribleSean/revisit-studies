import { createReadStream } from 'node:fs';
import path from 'node:path';

export function createBridgeAnalyzer({ baseUrl, pipeline = 'heuristic', allowCloud = false, timeoutMs = 15 * 60 * 1000, maxResponseBytes = 16 * 1024 * 1024 }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Evaluation bridge must be a loopback HTTP origin');
  if (!['heuristic', 'local', 'gpt4o', 'gemini'].includes(pipeline)) throw new Error('Unknown evaluation pipeline');
  if (['gpt4o', 'gemini'].includes(pipeline) && !allowCloud) throw new Error('Cloud evaluation requires --allow-cloud and may incur provider charges');
  const analyzer = async ({ filename, signal }) => {
    signal.throwIfAborted();
    const mimeType = { '.webm': 'video/webm', '.mp4': 'video/mp4' }[path.extname(filename).toLowerCase()];
    if (!mimeType) throw new Error('Bridge evaluation supports WebM and MP4 files');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Evaluation request timed out')), timeoutMs);
    const stream = createReadStream(filename, { signal: controller.signal });
    try {
      const url = new URL('/api/review/analyze', base); url.searchParams.set('pipeline', pipeline);
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': mimeType }, body: stream, duplex: 'half', redirect: 'error', signal: controller.signal });
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxResponseBytes) throw new Error('Evaluation response exceeds size limit');
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Error('Evaluation bridge returned invalid JSON'); }
      if (!response.ok) {
        const error = new Error(`Evaluation bridge HTTP ${response.status}${typeof payload.code === 'string' && /^[A-Z_]{1,60}$/.test(payload.code) ? ` (${payload.code})` : ''}`);
        error.code = payload.code === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'BRIDGE_ERROR';
        throw error;
      }
      if (!payload.result || typeof payload.result !== 'object' || typeof payload.cached !== 'boolean') throw new Error('Evaluation bridge returned an invalid result envelope');
      return { ...payload.result, evaluationTransport: { pipeline, cached: payload.cached, analyzerVersion: typeof payload.analyzerVersion === 'string' ? payload.analyzerVersion : null, serverDurationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null } };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); stream.destroy();
    }
  };
  analyzer.version = `bridge-client-v1:${pipeline}`;
  analyzer.measurement = 'Sequential requests through the local HTTP bridge. Client elapsed time includes upload and cache lookup. Each result records whether it was cached; cached timings must not be treated as model inference latency.';
  return analyzer;
}
