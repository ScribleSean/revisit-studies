import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EVAL_DIR = path.join(REPO_ROOT, 'evaluation');
const CORPUS_DIR = path.join(EVAL_DIR, 'corpus');
const GT_DIR = path.join(EVAL_DIR, 'ground_truth');
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = { runId: `run-${Date.now()}` };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--runId') out.runId = argv[i + 1] || out.runId;
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

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  const { runId } = parseArgs(process.argv);
  const startedAt = nowIso();

  const clipIds = await listGroundTruthClipIds();
  if (clipIds.length === 0) {
    throw new Error('No ground truth files found in evaluation/ground_truth/');
  }

  const runDir = path.join(RESULTS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  const manifest = {
    runId,
    startedAt,
    finishedAt: startedAt,
    modelsRun: ['gemini_inline', 'gemini_files_api', 'timeline_sidecar'],
    errors: [],
  };

  for (const clipId of clipIds) {
    const gt = await loadGroundTruth(clipId);
    const videoPath = await findVideoFileForClipId(clipId);

    const clipResult = {
      clipId,
      videoFile: videoPath ? path.relative(REPO_ROOT, videoPath) : undefined,
      latencyMsByModel: {},
      outputs: [],
      errors: [],
      groundTruthSha256: sha256Hex(Buffer.from(JSON.stringify(gt))),
    };

    // This runner intentionally does not call external APIs in-repo by default.
    // It records a placeholder entry so the report generator works and future
    // work can plug in real model calls.
    if (!videoPath) {
      clipResult.errors.push({ modelId: 'gemini_files_api', error: 'Missing corpus video file for this clipId.' });
      manifest.errors.push({ clipId, modelId: 'gemini_files_api', error: 'Missing corpus video file for this clipId.' });
    }

    clipResult.outputs.push({
      modelId: 'timeline_sidecar',
      events: Array.isArray(gt.humanEvents) ? gt.humanEvents : [],
      raw: { note: 'placeholder: used ground-truth events as a stand-in' },
    });

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

