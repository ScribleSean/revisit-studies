import { spawn } from 'node:child_process';
import { AnalysisError, killProcessTree } from './process.mjs';

/** One warm, serial JSON-lines worker with a bounded queue and restart after failure. */
export function createJsonWorker(executable, args, { cwd, env, timeoutMs = 120000, maxOutputBytes = 2 * 1024 * 1024, maxQueue = 8 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || !Number.isSafeInteger(maxQueue) || maxQueue < 1) throw new RangeError('Invalid worker limits');
  let child;
  let active;
  let stopped = false;
  let failure;
  let buffer = '';
  let stderrBytes = 0;
  const queue = [];
  const complete = (job, error, value) => {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(value);
  };
  const stop = (error) => {
    if (failure) return;
    failure = error;
    if (child) killProcessTree(child);
  };
  const pump = () => {
    if (stopped || active || failure || !queue.length) return;
    active = queue.shift();
    if (!child) {
      buffer = ''; stderrBytes = 0;
      const process = spawn(executable, args, { cwd, env, windowsHide: true, detached: globalThis.process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      child = process;
      process.stdout.setEncoding('utf8');
      process.stdout.on('data', (chunk) => {
        if (failure) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > maxOutputBytes) { stop(new AnalysisError('OUTPUT_LIMIT', 'Worker output exceeds its limit')); return; }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let value;
        try { value = JSON.parse(line); } catch { stop(new AnalysisError('INVALID_RESULT', 'Worker returned malformed JSON')); return; }
        if (!active || buffer.trim()) { stop(new AnalysisError('INVALID_RESULT', 'Worker returned unexpected output')); return; }
        if (value?.error) { stop(new AnalysisError('PROCESS_FAILED', String(value.error))); return; }
        const job = active; active = null; stderrBytes = 0;
        complete(job, null, value);
        pump();
      });
      process.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > maxOutputBytes) stop(new AnalysisError('OUTPUT_LIMIT', 'Worker diagnostics exceed their limit')); });
      process.stdin.on('error', () => stop(new AnalysisError('PROCESS_FAILED', 'Worker input closed')));
      process.on('error', () => { failure = new AnalysisError('UNAVAILABLE', 'Worker executable could not start'); });
      process.on('close', () => {
        if (active) complete(active, failure || new AnalysisError('PROCESS_FAILED', 'Worker exited before returning a result'));
        active = null; child = null; failure = null; buffer = '';
        pump();
      });
    }
    child.stdin.write(`${JSON.stringify(active.payload)}\n`);
  };
  return {
    request(payload, signal) {
      if (stopped) return Promise.reject(new AnalysisError('UNAVAILABLE', 'Worker is closed'));
      if (signal?.aborted) return Promise.reject(new AnalysisError('CANCELLED', 'Request cancelled'));
      if (queue.length >= maxQueue) return Promise.reject(new AnalysisError('BUSY', 'Worker queue is full'));
      return new Promise((resolve, reject) => {
        const job = { payload: structuredClone(payload), signal, resolve, reject };
        const cancel = (error) => {
          if (active === job) stop(error);
          else { const index = queue.indexOf(job); if (index >= 0) { queue.splice(index, 1); complete(job, error); } }
        };
        job.abort = () => cancel(new AnalysisError('CANCELLED', 'Request cancelled'));
        job.timer = setTimeout(() => cancel(new AnalysisError('TIMEOUT', 'Worker request exceeded its time limit')), timeoutMs);
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job);
        if (signal?.aborted) job.abort();
        pump();
      });
    },
    close() {
      stopped = true;
      for (const job of queue.splice(0)) complete(job, new AnalysisError('CANCELLED', 'Worker closed'));
      if (!child) return Promise.resolve();
      const done = new Promise((resolve) => child.once('close', resolve));
      stop(new AnalysisError('CANCELLED', 'Worker closed'));
      return done;
    },
  };
}
