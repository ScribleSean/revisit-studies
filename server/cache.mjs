import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const MAX_ENTRIES = Number(process.env.MQP_CACHE_MAX_ENTRIES || 500, 10);

export async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

export function sha256Hex(parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    if (Buffer.isBuffer(p)) h.update(p);
    else h.update(String(p));
    h.update('\n');
  }
  return h.digest('hex');
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

export async function readJsonCache(key) {
  await ensureCacheDir();
  const p = cachePath(key);
  try {
    const raw = await readFile(p, 'utf8');
    // touch to keep it "recent" for LRU eviction
    const now = new Date();
    await utimes(p, now, now).catch(() => {});
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeJsonCache(key, value) {
  await ensureCacheDir();
  const p = cachePath(key);
  await writeFile(p, JSON.stringify(value), 'utf8');
  await enforceLruLimit();
}

export async function enforceLruLimit() {
  if (!Number.isFinite(MAX_ENTRIES) || MAX_ENTRIES <= 0) return;
  let entries = [];
  try {
    entries = await readdir(CACHE_DIR);
  } catch {
    return;
  }
  const jsonFiles = entries.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length <= MAX_ENTRIES) return;

  const stats = await Promise.all(
    jsonFiles.map(async (f) => {
      const p = path.join(CACHE_DIR, f);
      try {
        const s = await stat(p);
        return { file: p, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const existing = stats.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toDelete = existing.slice(0, Math.max(0, existing.length - MAX_ENTRIES));
  await Promise.all(toDelete.map((e) => unlink(e.file).catch(() => {})));
}

