/**
 * POST /api/embed-summary — JSON body { text } → sentence-transformers embedding (CPU).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'mqp_embed.py');

function defaultPythonExecutable() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (existsSync(unixVenv)) return unixVenv;
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  if (existsSync(winVenv)) return winVenv;
  return 'python3';
}

export function registerEmbedSummaryRoutes(app, jsonParser) {
  app.post('/api/embed-summary', jsonParser, async (req, res) => {
    const started = Date.now();
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) {
      res.status(400).json({
        error: 'Missing JSON field "text" (non-empty string).',
        code: 'MISSING_TEXT',
        durationMs: Date.now() - started,
      });
      return;
    }

    const py = process.env.MQP_EMBED_PYTHON || defaultPythonExecutable();
    const scriptPath = process.env.MQP_EMBED_SCRIPT || DEFAULT_SCRIPT;
    const stdinPayload = JSON.stringify({ text });

    const result = await new Promise((resolve, reject) => {
      const child = spawn(py, [scriptPath], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => err.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      });
      child.stdin.write(stdinPayload);
      child.stdin.end();
    });

    if (result.code !== 0) {
      res.status(422).json({
        error: result.stderr?.trim() || `Embed script exited with code ${result.code}`,
        code: 'EMBED_SCRIPT_FAILED',
        durationMs: Date.now() - started,
      });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim() || '{}');
    } catch {
      res.status(422).json({
        error: 'Invalid JSON from embed script',
        code: 'BAD_JSON',
        durationMs: Date.now() - started,
      });
      return;
    }

    if (parsed.error) {
      res.status(422).json({
        error: String(parsed.error),
        code: 'EMBED_ERROR',
        durationMs: Date.now() - started,
      });
      return;
    }

    if (!Array.isArray(parsed.embedding)) {
      res.status(422).json({
        error: 'Embed script returned no embedding array',
        code: 'MISSING_EMBEDDING',
        durationMs: Date.now() - started,
      });
      return;
    }

    res.json({
      embedding: parsed.embedding,
      model: parsed.model || 'unknown',
      durationMs: parsed.durationMs ?? Date.now() - started,
    });
  });
}
