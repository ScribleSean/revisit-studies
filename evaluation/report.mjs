import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EVAL_DIR = path.join(REPO_ROOT, 'evaluation');
const GT_DIR = path.join(EVAL_DIR, 'ground_truth');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

const EVENT_TOLERANCE_SECONDS = 2;

async function loadJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

function fmt(n) {
  return Number.isFinite(n) ? String(n) : '0';
}

function matchEvents(humanEvents, modelEvents) {
  const used = new Set();
  let tp = 0;

  for (let i = 0; i < modelEvents.length; i += 1) {
    const m = modelEvents[i];
    const mt = Number(m.timestamp);
    const type = String(m.type);
    let matchedIdx = -1;
    let bestDelta = Infinity;
    for (let j = 0; j < humanEvents.length; j += 1) {
      if (used.has(j)) continue;
      const h = humanEvents[j];
      if (String(h.type) !== type) continue;
      const dt = Math.abs(Number(h.timestamp) - mt);
      if (dt <= EVENT_TOLERANCE_SECONDS && dt < bestDelta) {
        bestDelta = dt;
        matchedIdx = j;
      }
    }
    if (matchedIdx >= 0) {
      used.add(matchedIdx);
      tp += 1;
    }
  }

  const fp = modelEvents.length - tp;
  const fn = humanEvents.length - tp;
  const precision = modelEvents.length === 0 ? 0 : tp / modelEvents.length;
  const recall = humanEvents.length === 0 ? 0 : tp / humanEvents.length;
  return { tp, fp, fn, precision, recall };
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    throw new Error('Usage: node evaluation/report.mjs <runId>');
  }

  const runDir = path.join(RESULTS_DIR, runId);
  const files = (await readdir(runDir)).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();

  const manifest = await loadJson(path.join(runDir, 'manifest.json'));
  const lines = [];
  lines.push(`# Evaluation report — ${runId}`);
  lines.push('');
  lines.push(`- Started: ${manifest.startedAt}`);
  lines.push(`- Finished: ${manifest.finishedAt}`);
  lines.push(`- Models: ${(manifest.modelsRun || []).join(', ')}`);
  lines.push(`- Event tolerance: ±${EVENT_TOLERANCE_SECONDS}s`);
  lines.push('');

  for (const f of files) {
    const clipId = f.replace(/\.json$/, '');
    const gt = await loadJson(path.join(GT_DIR, `${clipId}.json`));
    const result = await loadJson(path.join(runDir, f));

    const humanSummary = String(gt.humanSummary || '');
    const humanEvents = safeArray(gt.humanEvents).map((e) => ({ type: String(e.type), timestamp: Number(e.timestamp), evidence: e.evidence }));

    lines.push(`## ${clipId}`);
    lines.push('');
    lines.push(`**Human summary:** ${humanSummary}`);
    lines.push('');

    const outputs = safeArray(result.outputs);
    for (const out of outputs) {
      const modelId = String(out.modelId || 'unknown');
      const modelEvents = safeArray(out.events).map((e) => ({ type: String(e.type), timestamp: Number(e.timestamp) }));
      const metrics = matchEvents(humanEvents, modelEvents);
      lines.push(`### ${modelId}`);
      lines.push('');
      lines.push(`- Events: TP=${fmt(metrics.tp)} FP=${fmt(metrics.fp)} FN=${fmt(metrics.fn)}`);
      lines.push(`- Precision: ${metrics.precision.toFixed(2)}  Recall: ${metrics.recall.toFixed(2)}`);
      if (typeof out.summary === 'string') {
        lines.push(`- Summary: ${out.summary}`);
      }
      lines.push('');
    }
  }

  const outPath = path.join(runDir, 'report.md');
  await writeFile(outPath, lines.join('\n'), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[evaluation] wrote ${path.relative(REPO_ROOT, outPath)}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`[evaluation] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

