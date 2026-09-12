import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Cache settings must be JSON data');
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw new TypeError('Cache settings must be JSON data');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Cache settings must contain finite numbers');
  return value;
}

/** Include pipeline/model/version/settings and content bytes in every key. */
export function analysisKey(bytes, settings) {
  const serialized = JSON.stringify(canonical(settings));
  if (!serialized) throw new TypeError('Cache settings are required');
  return createHash('sha256').update(String(Buffer.byteLength(serialized))).update(':').update(serialized).update(bytes).digest('hex');
}

/** Task-local disk cache. Serial writes and atomic rename avoid torn entries. */
export function createAnalysisCache(directory, { maxEntries = 500, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Cache limits must be positive integers');
  }
  const root = path.resolve(directory);
  let chain = Promise.resolve();
  let touchedAt = Date.now();
  const touch = async (file) => {
    touchedAt = Math.max(Date.now(), touchedAt + 1);
    await utimes(file, touchedAt / 1000, touchedAt / 1000);
  };
  const filename = (key) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError('Invalid cache key');
    return path.join(root, `${key}.json`);
  };
  const remove = (file) => unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });

  async function trim() {
    const names = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const entries = await Promise.all(names.map(async (name) => ({ file: path.join(root, name), ...await stat(path.join(root, name)) })));
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length > maxEntries || total > maxBytes) {
      const entry = entries.shift();
      total -= entry.size;
      await remove(entry.file);
    }
  }

  return {
    get(key) {
      // Sequence touches with writes so a hit cannot race local LRU eviction.
      const operation = chain.then(async () => {
      const file = filename(key);
      try {
        if ((await stat(file)).size > maxBytes) return null;
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data.version !== 1 || !Object.hasOwn(data, 'result')) return null;
        await touch(file);
        return data.result;
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
      });
      chain = operation.catch(() => {});
      return operation;
    },
    set(key, result) {
      const file = filename(key);
      const encoded = JSON.stringify({ version: 1, result });
      if (Buffer.byteLength(encoded) > maxBytes) return Promise.resolve(false);
      const operation = chain.then(async () => {
        await mkdir(root, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx' });
          await rename(temporary, file);
          await touch(file);
          await trim();
          return true;
        } finally {
          await remove(temporary);
        }
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
}
