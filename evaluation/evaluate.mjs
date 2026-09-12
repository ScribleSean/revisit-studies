import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { matchEvents, validateEvents } from './metrics.mjs';

async function sha256(filename, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function evaluate({ manifestPath, analyzer, signal = new AbortController().signal }) {
  signal.throwIfAborted();
  if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('Evaluation manifest exceeds 1 MiB');
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 1024 * 1024) throw new Error('Evaluation manifest exceeds 1 MiB');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== 1 || !['synthetic', 'human-labeled'].includes(manifest.provenance) || typeof manifest.description !== 'string' || !Array.isArray(manifest.clips) || !manifest.clips.length || manifest.clips.length > 100) throw new Error('Invalid evaluation manifest');
  if (manifest.provenance === 'human-labeled' && (typeof manifest.raterId !== 'string' || !manifest.raterId.trim())) throw new Error('Human-labeled data must identify its rater');
  const ids = new Set();
  // Validate the entire corpus before starting expensive analysis.
  const clips = [];
  for (const clip of manifest.clips) {
    signal.throwIfAborted();
    if (!clip || typeof clip.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(clip.id) || ids.has(clip.id) || typeof clip.file !== 'string' || !Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error('Invalid or duplicate evaluation clip');
    validateEvents(clip.events, clip.duration); ids.add(clip.id);
    const filename = path.resolve(path.dirname(manifestPath), clip.file);
    const file = await stat(filename);
    if (!file.isFile() || file.size === 0 || file.size > 256 * 1024 * 1024) throw new Error('Evaluation video must be a nonempty file at most 256 MiB');
    clips.push({ ...clip, filename });
  }
  const startedAt = new Date().toISOString();
  const results = [];
  for (const clip of clips) {
    signal.throwIfAborted();
    const videoSha256 = await sha256(clip.filename, signal);
    const start = performance.now();
    try {
      const result = await analyzer({ filename: clip.filename, signal });
      signal.throwIfAborted();
      const durationMs = performance.now() - start;
      const actualDuration = result?.meta?.duration;
      if (!Number.isFinite(actualDuration) || Math.abs(actualDuration - clip.duration) > 0.25) throw new Error(`Measured duration differs from expected ${clip.duration}s`);
      const metrics = matchEvents(clip.events, result.events, actualDuration);
      results.push({ id: clip.id, videoSha256, status: 'ok', durationMs, actualDuration, metrics, result });
    } catch (error) {
      signal.throwIfAborted();
      results.push({ id: clip.id, videoSha256, status: error?.code === 'UNAVAILABLE' ? 'skipped' : 'error', durationMs: performance.now() - start, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    version: 1, startedAt, finishedAt: new Date().toISOString(),
    provenance: manifest.provenance, description: manifest.description, raterId: manifest.raterId ?? null,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    analyzerVersion: analyzer.version ?? 'unversioned', nodeVersion: process.version,
    summaryQualityRatings: null, humanReviewTimeMeasurements: null,
    measurement: analyzer.measurement || 'Sequential direct analyzer calls without the HTTP cache. Latency includes model loading when needed; no warmup is excluded.',
    results,
  };
}

export function renderEvaluationReport(run) {
  const escape = (value) => String(value).replace(/[\\`*_{}\[\]()#+.!|<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  const lines = ['# ReVIEW evaluation', '', `Provenance: ${escape(run.provenance)}. ${escape(run.description)}`, '', run.measurement, '', 'Event matches are one-to-one, same type, within ±2 seconds. Undefined precision/recall is reported as unavailable.', '', 'Summary quality and researcher review-time measurements: not collected. Automated event agreement does not establish either.', ''];
  for (const clip of run.results) {
    lines.push(`## ${escape(clip.id)}`, '', `Video SHA-256: ${clip.videoSha256}`, '', `Status: ${clip.status}; elapsed ${clip.durationMs.toFixed(1)} ms.`, '');
    if (clip.status === 'ok') {
      if (clip.result.evaluationTransport) lines.push(`Bridge pipeline: ${escape(clip.result.evaluationTransport.pipeline)}; cache hit: ${clip.result.evaluationTransport.cached ? 'yes' : 'no'}.`, '');
      const percent = (value) => value === null ? 'unavailable' : `${(value * 100).toFixed(1)}%`;
      lines.push(`Events: TP ${clip.metrics.tp}, FP ${clip.metrics.fp}, FN ${clip.metrics.fn}. Precision ${percent(clip.metrics.precision)}, recall ${percent(clip.metrics.recall)}, F1 ${percent(clip.metrics.f1)}.`, '');
      lines.push(`Summary: ${escape(clip.result.summary?.text ?? '')}`, '');
      if (clip.result.meta.audio_skipped) lines.push(`Audio skipped: ${escape(clip.result.meta.audio_skip_reason ?? 'unavailable')}`, '');
      for (const key of ['scene_error', 'ocr_error', 'cleanupWarning']) if (clip.result.meta[key]) lines.push(`${key}: ${escape(clip.result.meta[key])}`, '');
    } else lines.push(`Failure: ${escape(clip.reason)}`, '');
  }
  return lines.join('\n');
}
