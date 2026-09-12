import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchEvents } from '../../../evaluation/metrics.mjs';
import { evaluate, renderEvaluationReport } from '../../../evaluation/evaluate.mjs';

const events = (times) => times.map((timestamp) => ({ type: 'scene_change', timestamp }));
test('matching is order-independent, one-to-one and avoids nearest-first undercounting', () => {
  assert.equal(matchEvents(events([0, 2]), events([1, 0]), 4, 1).tp, 2);
  assert.equal(matchEvents(events([0]), events([0, 0]), 4).fp, 1);
  assert.equal(matchEvents(events([0]), [{ type: 'hesitation', timestamp: 0 }], 4).tp, 0);
  assert.equal(matchEvents([], [], 4).precision, null);
  assert.throws(() => matchEvents(events([-1]), [], 4));
});

test('timestamp matching agrees with exhaustive assignment for small multisets', () => {
  const lists = [[]];
  for (let a = 0; a < 3; a += 1) { lists.push([a]); for (let b = 0; b < 3; b += 1) lists.push([a, b]); }
  const oracle = (truth, observed) => {
    if (!truth.length) return 0;
    let best = oracle(truth.slice(1), observed);
    observed.forEach((time, index) => { if (Math.abs(time - truth[0]) <= 1) best = Math.max(best, 1 + oracle(truth.slice(1), observed.filter((_, position) => position !== index))); });
    return best;
  };
  for (const truth of lists) for (const observed of lists) assert.equal(matchEvents(events(truth), events(observed), 4, 1).tp, oracle(truth, observed));
});

test('evaluation fingerprints inputs, reports errors without inventing ratings, and rejects stale duration labels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-eval-'));
  try {
    await writeFile(path.join(directory, 'clip.webm'), 'synthetic test bytes');
    const manifest = { version: 1, provenance: 'synthetic', description: 'Fixture <only>', clips: [{ id: 'a', file: 'clip.webm', duration: 4, events: events([2]) }, { id: 'b', file: 'clip.webm', duration: 8, events: [] }] };
    const manifestPath = path.join(directory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    const analyzer = async () => ({ meta: { duration: 4, audio_skipped: true }, summary: { text: '<synthetic>' }, events: events([2]) });
    const result = await evaluate({ manifestPath, analyzer });
    assert.equal(result.results[0].metrics.f1, 1);
    assert.equal(result.results[1].status, 'error');
    assert.match(result.results[1].reason, /duration/);
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.results[0].videoSha256, result.results[1].videoSha256);
    assert.equal(result.summaryQualityRatings, null); assert.equal(result.humanReviewTimeMeasurements, null);
    assert.match(renderEvaluationReport(result), /\\<synthetic\\>/);
    assert.match(renderEvaluationReport(result), /not collected/);
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).clips[1].duration, 8);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(evaluate({ manifestPath, analyzer, signal: controller.signal }));
    manifest.clips[1].id = 'a'; await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(evaluate({ manifestPath, analyzer: () => assert.fail('invalid manifest must not invoke analyzer') }), /duplicate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
