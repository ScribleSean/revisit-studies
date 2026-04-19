/**
 * Phase 14 evaluation report: four tables + time savings.
 * Usage: node evaluation/report.mjs <runId>
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const EVAL_DIR = path.join(REPO_ROOT, 'evaluation');
const GT_DIR = path.join(EVAL_DIR, 'ground_truth');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

const EVENT_TOLERANCE_SECONDS = 2;

/** Illustrative USD per 1M input tokens (April 2026; verify against current vendor pricing). */
const PRICE_GEMINI_2_FLASH_INPUT_PER_1M = 0.10;
const PRICE_GPT4O_INPUT_PER_1M = 5.0;

function estimateTokensFromDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const sec = durationMs / 1000;
  // Very rough placeholder: treat as ~2k tokens per minute of pipeline wall time for table footnotes.
  return Math.round((sec / 60) * 2000);
}

function estimateCostUsd(pipeline, durationMs) {
  const tokens = estimateTokensFromDurationMs(durationMs);
  const tM = tokens / 1_000_000;
  if (pipeline === 'A_gemini_files') return tM * PRICE_GEMINI_2_FLASH_INPUT_PER_1M;
  if (pipeline === 'B_gpt4o') return tM * PRICE_GPT4O_INPUT_PER_1M;
  return null;
}

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
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function matchEventsByType(humanEvents, modelEvents) {
  const types = new Set([
    ...humanEvents.map((h) => String(h.type)),
    ...modelEvents.map((m) => String(m.type)),
  ]);
  const rows = [];
  for (const t of types) {
    const hSub = humanEvents.filter((h) => String(h.type) === t);
    const mSub = modelEvents.filter((m) => String(m.type) === t);
    const m = matchEvents(hSub, mSub);
    rows.push({ type: t, ...m });
  }
  return rows.sort((a, b) => a.type.localeCompare(b.type));
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const a = xs.slice(0, n);
  const b = ys.slice(0, n);
  const mx = a.reduce((s, v) => s + v, 0) / n;
  const my = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = a[i] - mx;
    const dy = b[i] - my;
    num += dx * dy;
    denA += dx * dx;
    denB += dy * dy;
  }
  const den = Math.sqrt(denA) * Math.sqrt(denB);
  if (den === 0) return null;
  return num / den;
}

function humanStruggleEventDensityInWindows(humanEvents, windows) {
  const struggleTypes = new Set(['hesitation', 'confusion_word', 'confused_transition', 'reading']);
  const densities = windows.map((w) => {
    const start = Number(w.startSec);
    const end = Number(w.endSec);
    let c = 0;
    for (const e of humanEvents) {
      if (!struggleTypes.has(String(e.type))) continue;
      const ts = Number(e.timestamp);
      if (ts >= start && ts < end) c += 1;
    }
    return c;
  });
  const scores = windows.map((w) => Number(w.score) || 0);
  return { scores, densities };
}

function extractLegacyOutputs(clipResult) {
  const outs = safeArray(clipResult.outputs);
  return outs.map((o) => ({
    pipeline: String(o.modelId || ''),
    events: safeArray(o.events).map((e) => ({
      type: String(e.type),
      timestamp: Number(e.timestamp),
      evidence: e.evidence,
    })),
  }));
}

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    throw new Error('Usage: node evaluation/report.mjs <runId>');
  }

  const runDir = path.join(RESULTS_DIR, runId);
  const files = (await readdir(runDir)).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();

  const manifest = await loadJson(path.join(runDir, 'manifest.json'));

  let humanScores = { entries: [] };
  try {
    humanScores = await loadJson(path.join(EVAL_DIR, 'human_scores.json'));
  } catch {
    /* optional */
  }

  let timeStudy = { clips: [] };
  try {
    timeStudy = await loadJson(path.join(EVAL_DIR, 'time_study.json'));
  } catch {
    /* optional */
  }

  const lines = [];
  lines.push(`# Evaluation report — ${runId}`);
  lines.push('');
  lines.push(`- Started: ${manifest.startedAt}`);
  lines.push(`- Finished: ${manifest.finishedAt}`);
  lines.push(`- Mass API: ${manifest.massApiBaseUrl || '(unknown)'}`);
  lines.push(`- Pipelines: ${(manifest.modelsRun || []).join(', ')}`);
  lines.push(`- Event tolerance: ±${EVENT_TOLERANCE_SECONDS}s (type must match)`);
  lines.push('');
  lines.push('> **Pricing note:** Table 3 uses rough token estimates from pipeline `durationMs` (see `evaluation/report.mjs` constants). Treat USD figures as order-of-magnitude placeholders unless you replace them with measured token usage.');
  lines.push('');

  // --- Table 1: human summary quality ---
  lines.push('## Table 1 — Summary quality (manual 1–3 scores)');
  lines.push('');
  lines.push('| Clip | Pipeline | Accuracy | Completeness | Actionability |');
  lines.push('| --- | --- | --- | --- | --- |');
  const entries = safeArray(humanScores.entries);
  const pipelineLabels = {
    A_gemini_files: 'Gemini (Files)',
    B_gpt4o: 'GPT-4o vision',
    C_ollama_local: 'Ollama / LLaVA',
    D_heuristic_timeline: 'Heuristic timeline',
  };
  for (const e of entries) {
    const cid = String(e.clipId || '');
    const pid = String(e.pipeline || '');
    const lab = pipelineLabels[pid] || pid;
    lines.push(
      `| ${cid} | ${lab} | ${e.accuracy ?? '—'} | ${e.completeness ?? '—'} | ${e.actionability ?? '—'} |`,
    );
  }
  if (entries.length === 0) {
    lines.push('| _(no `evaluation/human_scores.json` entries)_ | | | | |');
  }
  lines.push('');
  const meansByPipeline = {};
  for (const e of entries) {
    const pid = String(e.pipeline || '');
    if (!meansByPipeline[pid]) meansByPipeline[pid] = { acc: [], comp: [], act: [] };
    if (Number.isFinite(Number(e.accuracy))) meansByPipeline[pid].acc.push(Number(e.accuracy));
    if (Number.isFinite(Number(e.completeness))) meansByPipeline[pid].comp.push(Number(e.completeness));
    if (Number.isFinite(Number(e.actionability))) meansByPipeline[pid].act.push(Number(e.actionability));
  }
  lines.push('**Means (finite scores only):**');
  for (const [pid, obj] of Object.entries(meansByPipeline)) {
    const mean = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : '—');
    lines.push(
      `- ${pipelineLabels[pid] || pid}: accuracy=${mean(obj.acc)} completeness=${mean(obj.comp)} actionability=${mean(obj.act)}`,
    );
  }
  lines.push('');

  // --- Table 2: event detection ---
  lines.push('## Table 2 — Event detection (±2s, type match)');
  lines.push('');
  const aggregateByPipeline = {};
  for (const f of files) {
    const clipId = f.replace(/\.json$/, '');
    const gt = await loadJson(path.join(GT_DIR, `${clipId}.json`));
    const clipResult = await loadJson(path.join(runDir, f));
    const humanEvents = safeArray(gt.humanEvents).map((e) => ({
      type: String(e.type),
      timestamp: Number(e.timestamp),
      evidence: e.evidence,
    }));

    lines.push(`### ${clipId}`);
    lines.push('');

    const pipelines = safeArray(clipResult.pipelines);
    if (pipelines.length > 0) {
      for (const pr of pipelines) {
        const pid = String(pr.pipeline || '');
        const label = String(pr.label || pid);
        if (pr.status !== 'ok') {
          lines.push(`#### ${label}`);
          lines.push('');
          lines.push(`- Status: **${pr.status}** — ${pr.reason || pr.code || ''}`);
          lines.push('');
          continue;
        }
        const modelEvents = safeArray(pr.events).map((e) => ({
          type: String(e.type),
          timestamp: Number(e.timestamp),
        }));
        const metrics = matchEvents(humanEvents, modelEvents);
        if (!aggregateByPipeline[pid]) {
          aggregateByPipeline[pid] = { precision: [], recall: [], f1: [] };
        }
        aggregateByPipeline[pid].precision.push(metrics.precision);
        aggregateByPipeline[pid].recall.push(metrics.recall);
        aggregateByPipeline[pid].f1.push(metrics.f1);
        lines.push(`#### ${label}`);
        lines.push('');
        lines.push(`- Events: TP=${fmt(metrics.tp)} FP=${fmt(metrics.fp)} FN=${fmt(metrics.fn)}`);
        lines.push(`- Precision: ${metrics.precision.toFixed(2)}  Recall: ${metrics.recall.toFixed(2)}  F1: ${metrics.f1.toFixed(2)}`);
        if (pid === 'D_heuristic_timeline' && modelEvents.length > 0) {
          lines.push('- Per-type (same tolerance):');
          for (const row of matchEventsByType(humanEvents, modelEvents)) {
            lines.push(`  - \`${row.type}\`: P=${row.precision.toFixed(2)} R=${row.recall.toFixed(2)} F1=${row.f1.toFixed(2)}`);
          }
        }
        if (typeof pr.summary === 'string' && pr.summary && pid !== 'D_heuristic_timeline') {
          const short = pr.summary.length > 220 ? `${pr.summary.slice(0, 220)}…` : pr.summary;
          lines.push(`- Summary excerpt: ${short.replace(/\|/g, '\\|')}`);
        }
        lines.push('');
      }
    } else {
      const legacy = extractLegacyOutputs(clipResult);
      for (const block of legacy) {
        const modelEvents = block.events.map((e) => ({ type: e.type, timestamp: e.timestamp }));
        const metrics = matchEvents(humanEvents, modelEvents);
        lines.push(`#### ${block.pipeline} (legacy output)`);
        lines.push('');
        lines.push(`- Precision: ${metrics.precision.toFixed(2)}  Recall: ${metrics.recall.toFixed(2)}  F1: ${metrics.f1.toFixed(2)}`);
        lines.push('');
      }
    }
  }

  lines.push('**Aggregate mean F1 (clips where pipeline status=ok):**');
  if (Object.keys(aggregateByPipeline).length === 0) {
    lines.push('- _(No `ok` pipeline runs in this manifest — all skipped or error. Re-run with `yarn serve:mass-api`.)_');
  } else {
    for (const [pid, agg] of Object.entries(aggregateByPipeline)) {
      const m = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : '—');
      lines.push(`- ${pipelineLabels[pid] || pid}: mean F1=${m(agg.f1)} (P=${m(agg.precision)} R=${m(agg.recall)})`);
    }
  }
  lines.push('');

  // --- Table 3: cost & latency ---
  lines.push('## Table 3 — Cost and latency (wall-clock)');
  lines.push('');
  lines.push('| Clip | Pipeline | durationMs | est. cost USD |');
  lines.push('| --- | --- | ---: | ---: |');
  for (const f of files) {
    const clipId = f.replace(/\.json$/, '');
    const clipResult = await loadJson(path.join(runDir, f));
    const pipelines = safeArray(clipResult.pipelines);
    for (const pr of pipelines) {
      const pid = String(pr.pipeline || '');
      const label = String(pr.label || pid);
      const dm = pr.durationMs;
      const cost = estimateCostUsd(pid, dm);
      const costCell = cost == null ? 'N/A' : cost.toFixed(4);
      const dmCell = Number.isFinite(dm) ? String(dm) : '—';
      if (pr.status !== 'ok') {
        lines.push(`| ${clipId} | ${label} | ${dmCell} | skipped (${pr.status}) |`);
      } else {
        lines.push(`| ${clipId} | ${label} | ${dmCell} | ${costCell} |`);
      }
    }
  }
  lines.push('');

  // --- Table 4: confusion vs human density ---
  lines.push('## Table 4 — Confusion score vs human struggle-event density (Pearson r)');
  lines.push('');
  lines.push('Struggle event types: `hesitation`, `confusion_word`, `confused_transition`, `reading`.');
  lines.push('');
  for (const f of files) {
    const clipId = f.replace(/\.json$/, '');
    const gt = await loadJson(path.join(GT_DIR, `${clipId}.json`));
    const clipResult = await loadJson(path.join(runDir, f));
    const humanEvents = safeArray(gt.humanEvents);
    const cs = clipResult.confusionScore;
    if (!cs || cs.status !== 'ok' || !Array.isArray(cs.windows)) {
      lines.push(`- **${clipId}:** _(no confusion windows — ${cs?.status || 'missing'})._`);
      continue;
    }
    const { scores, densities } = humanStruggleEventDensityInWindows(humanEvents, cs.windows);
    const r = pearson(scores, densities);
    lines.push(`- **${clipId}:** Pearson r = ${r == null ? 'N/A (insufficient variance)' : r.toFixed(3)} (n=${scores.length} windows)`);
  }
  lines.push('');

  // --- Time savings ---
  lines.push('## Time savings (self-reported review timing)');
  lines.push('');
  const tClips = safeArray(timeStudy.clips);
  if (tClips.length === 0) {
    lines.push('_(No `evaluation/time_study.json`.)_');
  } else {
    let totalManual = 0;
    let totalTool = 0;
    for (const c of tClips) {
      const m = Number(c.manualReviewSec) || 0;
      const t = Number(c.toolAssistedSec) || 0;
      totalManual += m;
      totalTool += t;
    }
    lines.push(`| Clip | Manual (s) | Tool-assisted (s) | Reduction % |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    for (const c of tClips) {
      const m = Number(c.manualReviewSec) || 0;
      const t = Number(c.toolAssistedSec) || 0;
      const red = m > 0 ? (((m - t) / m) * 100).toFixed(1) : '—';
      lines.push(`| ${c.clipId} | ${m} | ${t} | ${red} |`);
    }
    const meanRed =
      tClips.length > 0
        ? (
            tClips.reduce((s, c) => {
              const m = Number(c.manualReviewSec) || 0;
              const t = Number(c.toolAssistedSec) || 0;
              return s + (m > 0 ? ((m - t) / m) * 100 : 0);
            }, 0) / tClips.length
          ).toFixed(1)
        : '—';
    lines.push('');
    lines.push(`- **Total manual:** ${totalManual}s`);
    lines.push(`- **Total tool-assisted:** ${totalTool}s`);
    lines.push(`- **Mean per-clip reduction:** ${meanRed}%`);
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
