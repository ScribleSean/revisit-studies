/**
 * Phase 14 evaluation runner: four pipelines + OCR + confusion score per corpus clip.
 *
 * Usage:
 *   node evaluation/run.mjs --dry-run
 *   node evaluation/run.mjs --runId test-01
 *   node evaluation/run.mjs --runId test-01 --mass-api-url http://127.0.0.1:3001
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const EVAL_DIR = path.join(REPO_ROOT, 'evaluation');
const CORPUS_DIR = path.join(EVAL_DIR, 'corpus');
const GT_DIR = path.join(EVAL_DIR, 'ground_truth');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

const DEFAULT_MASS_API = process.env.MQP_EVAL_MASS_API_URL || 'http://127.0.0.1:3001';

const EVAL_PROMPT = [
  'Provide a high-level summary of the video in 3-5 sentences.',
  'Include key events and, when possible, reference moments using MM:SS timestamps (e.g., 01:15).',
  'If you detect the participant struggling or changing strategy, mention that explicitly.',
].join(' ');

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const out = {
    runId: `run-${Date.now()}`,
    dryRun: false,
    massApiUrl: DEFAULT_MASS_API,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--runId') out.runId = argv[i + 1] || out.runId;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--mass-api-url') out.massApiUrl = argv[i + 1] || out.massApiUrl;
  }
  return out;
}

async function listGroundTruthClipIds() {
  const files = await readdir(GT_DIR).catch(() => []);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

async function loadGroundTruth(clipId) {
  const raw = await readFile(path.join(GT_DIR, `${clipId}.json`), 'utf8');
  return JSON.parse(raw);
}

async function findVideoFileForClipId(clipId) {
  const exts = ['.webm', '.mp4', '.mov', '.m4a'];
  for (const ext of exts) {
    const p = path.join(CORPUS_DIR, `${clipId}${ext}`);
    try {
      await readFile(p);
      return p;
    } catch {
      // keep searching
    }
  }
  return null;
}

function heuristicSummaryFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const counts = {};
  for (const e of list) {
    const t = String(e?.type || 'unknown');
    counts[t] = (counts[t] || 0) + 1;
  }
  const summaryParts = Object.entries(counts).map(([k, v]) => `${v}× ${k.replace(/_/g, ' ')}`);
  const head = summaryParts.length > 0 ? summaryParts.join(', ') : 'no typed events';
  return `Heuristic timeline summary: ${head}. Total events: ${list.length}.`;
}

function normalizeTimelineEvents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      type: String(e?.type || ''),
      timestamp: Number(e?.timestamp),
      evidence: typeof e?.evidence === 'string' ? e.evidence : undefined,
    }))
    .filter((e) => e.type && Number.isFinite(e.timestamp));
}

async function fetchJson(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(600_000) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, json: {}, networkError: msg };
  }
}

async function postMultipartVideo(baseUrl, pathname, videoPath, fields) {
  const buf = await readFile(videoPath);
  const filename = path.basename(videoPath);
  const form = new FormData();
  form.append('video', new Blob([buf]), filename);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  const url = `${baseUrl.replace(/\/$/, '')}${pathname}`;
  return fetchJson(url, { method: 'POST', body: form });
}

async function tryOllamaReachable(baseUrl) {
  const u = `${baseUrl.replace(/\/$/, '')}/api/tags`;
  const r = await fetchJson(u, { method: 'GET' });
  return r.ok;
}

async function fetchHealth(baseUrl) {
  const r = await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/health`, { method: 'GET' });
  if (!r.ok) return null;
  return r.json;
}

async function main() {
  const { runId, dryRun, massApiUrl } = parseArgs(process.argv);
  const startedAt = nowIso();

  const clipIds = await listGroundTruthClipIds();
  if (clipIds.length === 0) {
    throw new Error('No ground truth files found in evaluation/ground_truth/');
  }

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log('[evaluation] --dry-run');
    // eslint-disable-next-line no-console
    console.log(`[evaluation] ground_truth clips (${clipIds.length}): ${clipIds.join(', ')}`);
    for (const id of clipIds) {
      const vp = await findVideoFileForClipId(id);
      // eslint-disable-next-line no-console
      console.log(`[evaluation]   ${id}: video=${vp ? path.basename(vp) : 'MISSING'}`);
    }
    const health = await fetchHealth(massApiUrl);
    // eslint-disable-next-line no-console
    console.log(`[evaluation] mass API ${massApiUrl} health: ${health ? 'reachable' : 'unreachable'}`);
    if (health) {
      // eslint-disable-next-line no-console
      console.log(`[evaluation]   hasKey(Gemini)=${Boolean(health.hasKey)} hasOpenAiKey=${Boolean(health.hasOpenAiKey)}`);
    }
    return;
  }

  const runDir = path.join(RESULTS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  const health = await fetchHealth(massApiUrl);
  const ollamaBase = typeof health?.ollamaBaseUrl === 'string' ? health.ollamaBaseUrl : 'http://127.0.0.1:11434';
  const ollamaUp = health ? await tryOllamaReachable(ollamaBase) : false;

  const manifest = {
    runId,
    startedAt,
    finishedAt: startedAt,
    massApiBaseUrl: massApiUrl,
    health: health
      ? {
          hasGeminiKey: Boolean(health.hasKey),
          hasOpenAiKey: Boolean(health.hasOpenAiKey),
          ollamaBaseUrl: ollamaBase,
          ollamaModel: health.ollamaModel,
          ollamaReachable: ollamaUp,
        }
      : undefined,
    modelsRun: ['A_gemini_files', 'B_gpt4o', 'C_ollama_local', 'D_heuristic_timeline'],
    errors: [],
  };

  const massUnreachable = !health;

  for (const clipId of clipIds) {
    const gt = await loadGroundTruth(clipId);
    const videoPath = await findVideoFileForClipId(clipId);

    const clipResult = {
      clipId,
      videoFile: videoPath ? path.relative(REPO_ROOT, videoPath) : undefined,
      groundTruthSha256: sha256Hex(Buffer.from(JSON.stringify(gt))),
      pipelines: [],
      ocr: { status: 'skipped', reason: 'not run' },
      confusionScore: { status: 'skipped', reason: 'not run' },
    };

    const pushPipeline = (p) => clipResult.pipelines.push(p);

    if (!videoPath) {
      manifest.errors.push({ clipId, step: 'corpus', message: 'Missing corpus video file for this clipId.' });
      pushPipeline({
        pipeline: 'A_gemini_files',
        label: 'Gemini (Files API)',
        status: 'skipped',
        reason: 'Missing corpus video file',
      });
      pushPipeline({
        pipeline: 'B_gpt4o',
        label: 'GPT-4o vision',
        status: 'skipped',
        reason: 'Missing corpus video file',
      });
      pushPipeline({
        pipeline: 'C_ollama_local',
        label: 'LLaVA / Ollama (local)',
        status: 'skipped',
        reason: 'Missing corpus video file',
      });
      pushPipeline({
        pipeline: 'D_heuristic_timeline',
        label: 'Heuristic (Whisper + PySceneDetect)',
        status: 'skipped',
        reason: 'Missing corpus video file',
      });
      await writeFile(path.join(runDir, `${clipId}.json`), JSON.stringify(clipResult, null, 2));
      continue;
    }

    // --- Pipeline A: Gemini Files API ---
    if (massUnreachable) {
      pushPipeline({
        pipeline: 'A_gemini_files',
        label: 'Gemini (Files API)',
        status: 'skipped',
        reason: 'Mass API unreachable (start yarn serve:mass-api)',
      });
    } else if (!health?.hasKey) {
      pushPipeline({
        pipeline: 'A_gemini_files',
        label: 'Gemini (Files API)',
        status: 'skipped',
        reason: 'GEMINI_API_KEY / VITE_GEMINI_API_KEY not set on mass API',
      });
    } else {
      const r = await postMultipartVideo(massApiUrl, '/api/analyze-large', videoPath, {
        prompt: EVAL_PROMPT,
        model: 'gemini-2.0-flash',
      });
      if (r.ok && typeof r.json?.summary === 'string') {
        pushPipeline({
          pipeline: 'A_gemini_files',
          label: 'Gemini (Files API)',
          status: 'ok',
          summary: r.json.summary,
          durationMs: r.json.durationMs,
          modelUsed: r.json.modelUsed,
          events: [],
        });
      } else {
        pushPipeline({
          pipeline: 'A_gemini_files',
          label: 'Gemini (Files API)',
          status: 'error',
          reason: r.json?.error || r.json?.code || r.networkError || `HTTP ${r.status}`,
          code: r.json?.code,
          durationMs: r.json?.durationMs,
        });
      }
    }

    // --- Pipeline B: GPT-4o ---
    if (massUnreachable) {
      pushPipeline({
        pipeline: 'B_gpt4o',
        label: 'GPT-4o vision',
        status: 'skipped',
        reason: 'Mass API unreachable (start yarn serve:mass-api)',
      });
    } else if (!health?.hasOpenAiKey) {
      pushPipeline({
        pipeline: 'B_gpt4o',
        label: 'GPT-4o vision',
        status: 'skipped',
        reason: 'OPENAI_API_KEY not set',
      });
    } else {
      const r = await postMultipartVideo(massApiUrl, '/api/analyze-gpt4v', videoPath, { prompt: EVAL_PROMPT });
      if (r.ok && typeof r.json?.summary === 'string') {
        pushPipeline({
          pipeline: 'B_gpt4o',
          label: 'GPT-4o vision',
          status: 'ok',
          summary: r.json.summary,
          durationMs: r.json.durationMs,
          modelUsed: r.json.modelUsed,
          events: [],
        });
      } else {
        pushPipeline({
          pipeline: 'B_gpt4o',
          label: 'GPT-4o vision',
          status: 'error',
          reason: r.json?.error || r.json?.code || r.networkError || `HTTP ${r.status}`,
          code: r.json?.code,
          durationMs: r.json?.durationMs,
        });
      }
    }

    // --- Pipeline C: Ollama local ---
    if (massUnreachable) {
      pushPipeline({
        pipeline: 'C_ollama_local',
        label: 'LLaVA / Ollama (local)',
        status: 'skipped',
        reason: 'Mass API unreachable (start yarn serve:mass-api)',
      });
    } else if (!ollamaUp) {
      pushPipeline({
        pipeline: 'C_ollama_local',
        label: 'LLaVA / Ollama (local)',
        status: 'skipped',
        reason: 'Ollama not reachable (daemon off or wrong OLLAMA_BASE_URL)',
      });
    } else {
      const r = await postMultipartVideo(massApiUrl, '/api/analyze-local', videoPath, { prompt: EVAL_PROMPT });
      if (r.ok && typeof r.json?.summary === 'string') {
        pushPipeline({
          pipeline: 'C_ollama_local',
          label: 'LLaVA / Ollama (local)',
          status: 'ok',
          summary: r.json.summary,
          durationMs: r.json.durationMs,
          events: [],
        });
      } else {
        pushPipeline({
          pipeline: 'C_ollama_local',
          label: 'LLaVA / Ollama (local)',
          status: 'error',
          reason: r.json?.error || r.json?.code || r.networkError || `HTTP ${r.status}`,
          code: r.json?.code,
          durationMs: r.json?.durationMs,
        });
      }
    }

    // --- Pipeline D: Heuristic timeline ---
    if (massUnreachable) {
      pushPipeline({
        pipeline: 'D_heuristic_timeline',
        label: 'Heuristic (Whisper + PySceneDetect)',
        status: 'skipped',
        reason: 'Mass API unreachable (start yarn serve:mass-api)',
      });
    } else {
      const r = await postMultipartVideo(massApiUrl, '/api/analyze-timeline', videoPath, {});
      const events = normalizeTimelineEvents(r.json?.events);
      if (r.ok && Array.isArray(r.json?.events)) {
        pushPipeline({
          pipeline: 'D_heuristic_timeline',
          label: 'Heuristic (Whisper + PySceneDetect)',
          status: 'ok',
          summary: heuristicSummaryFromEvents(events),
          events,
          durationMs: r.json?.durationMs,
          raw: r.json?.meta,
        });
      } else {
        pushPipeline({
          pipeline: 'D_heuristic_timeline',
          label: 'Heuristic (Whisper + PySceneDetect)',
          status: 'error',
          reason: r.json?.error || r.json?.code || r.networkError || `HTTP ${r.status}`,
          events,
          durationMs: r.json?.durationMs,
        });
      }
    }

    // --- OCR (always when mass API up) ---
    if (massUnreachable) {
      clipResult.ocr = { status: 'skipped', reason: 'Mass API unreachable' };
    } else {
      const r = await postMultipartVideo(massApiUrl, '/api/extract-ocr', videoPath, {});
      if (r.ok && Array.isArray(r.json?.frames)) {
        clipResult.ocr = {
          status: 'ok',
          frames: r.json.frames,
          durationMs: r.json.durationMs,
          raw: r.json.meta,
        };
      } else {
        clipResult.ocr = {
          status: 'error',
          reason: r.json?.error || r.json?.code || r.networkError || `HTTP ${r.status}`,
          durationMs: r.json?.durationMs,
        };
      }
    }

    // --- Confusion score fusion ---
    if (massUnreachable) {
      clipResult.confusionScore = { status: 'skipped', reason: 'Mass API unreachable' };
    } else {
      const r = await postMultipartVideo(massApiUrl, '/api/confusion-score', videoPath, {});
      if (r.ok && Array.isArray(r.json?.windows)) {
        clipResult.confusionScore = {
          status: 'ok',
          windows: r.json.windows,
          totalScore: r.json.totalScore,
          maxWindow: r.json.maxWindow,
          durationMs: r.json.durationMs,
          meta: r.json.meta,
        };
      } else {
        clipResult.confusionScore = {
          status: 'error',
          reason: r.json?.error || r.json?.code || r.networkError || `HTTP ${r.status}`,
          durationMs: r.json?.durationMs,
        };
      }
    }

    await writeFile(path.join(runDir, `${clipId}.json`), JSON.stringify(clipResult, null, 2));
  }

  manifest.finishedAt = nowIso();
  await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[evaluation] wrote results to ${path.relative(REPO_ROOT, runDir)}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`[evaluation] failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
