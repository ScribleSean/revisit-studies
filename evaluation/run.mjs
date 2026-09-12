import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createTimelineAnalyzer } from '../server/review/timeline.mjs';
import { evaluate, renderEvaluationReport } from './evaluate.mjs';
import { createBridgeAnalyzer } from './bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { manifest: { type: 'string' }, output: { type: 'string' }, bridge: { type: 'string' }, pipeline: { type: 'string', default: 'heuristic' }, 'allow-cloud': { type: 'boolean', default: false } } });
if (!values.output) throw new Error('Usage: node evaluation/run.mjs --output <new-directory> [--manifest <manifest.json>]');
if (!values.bridge && values.pipeline !== 'heuristic') throw new Error('Non-heuristic evaluation requires --bridge http://127.0.0.1:3001');
const bridgeAnalyzer = values.bridge ? createBridgeAnalyzer({ baseUrl: values.bridge, pipeline: values.pipeline, allowCloud: values['allow-cloud'] }) : null;
const output = path.resolve(values.output);
// Never replace a prior evaluation. Each run receives a new directory.
await mkdir(output);
const controller = new AbortController();
const cancel = () => controller.abort(new Error('Evaluation cancelled'));
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  const analyzer = bridgeAnalyzer || createTimelineAnalyzer({
    python: process.env.REVIEW_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    ffprobe: process.env.FFPROBE || 'ffprobe',
    ffmpegDirectory: process.env.REVIEW_FFMPEG_DIRECTORY || '',
  });
  const run = await evaluate({ manifestPath: path.resolve(values.manifest || path.join(root, 'evaluation/synthetic.json')), analyzer, signal: controller.signal });
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(output, 'report.md'), renderEvaluationReport(run), { flag: 'wx' });
  const failures = run.results.filter((result) => result.status !== 'ok').length;
  console.log(JSON.stringify({ output, clips: run.results.length, failures, provenance: run.provenance }));
  if (failures) process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
