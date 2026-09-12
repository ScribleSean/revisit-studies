import { spawn } from 'node:child_process';

export class AnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

/** Run a trusted executable without a shell, with bounded output and lifetime. */
export function runProcess(executable, args, { signal, timeoutMs = 120000, maxOutputBytes = 8 * 1024 * 1024, input, cwd, env } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new RangeError('Process limits must be positive'));
  }
  if (signal?.aborted) return Promise.reject(new AnalysisError('CANCELLED', 'Analysis cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    let settled = false;
    const stop = (error) => {
      if (failure || settled) return;
      failure = error;
      killProcessTree(child);
    };
    const abort = () => stop(new AnalysisError('CANCELLED', 'Analysis cancelled'));
    const timer = setTimeout(() => stop(new AnalysisError('TIMEOUT', 'Analysis exceeded its time limit')), timeoutMs);
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new AnalysisError('OUTPUT_LIMIT', 'Analysis produced too much output'));
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      cleanup();
      reject(new AnalysisError('UNAVAILABLE', `Analysis executable could not start (${error.code || 'unknown'})`));
    });
    child.on('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new AnalysisError('PROCESS_FAILED', `Analysis process exited with code ${code}`));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.on('error', () => {}); // Early process exit is reported by close.
    child.stdin.end(input);
  });
}
