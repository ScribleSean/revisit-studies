import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const validName = (name) => typeof name === 'string' && /^files\/review-[a-f0-9]{32}$/.test(name);

/** One bridge owns this directory. Upload intent is committed before any remote request. */
export function createCleanupJournal(directory, { leaseMs = 660000, maxEntries = 1000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid cleanup journal limits');
  const root = path.resolve(directory);
  const locks = new Map(); let admissions = Promise.resolve();
  const filePath = (name) => {
    if (!validName(name)) throw new TypeError('Invalid cleanup file identity');
    return path.join(root, `${name.slice(6)}.json`);
  };
  const withEntry = (name, action) => {
    const pending = (locks.get(name) || Promise.resolve()).then(action);
    const settled = pending.catch(() => {});
    locks.set(name, settled);
    settled.finally(() => { if (locks.get(name) === settled) locks.delete(name); });
    return pending;
  };
  async function entries() {
    await mkdir(root, { recursive: true });
    return (await readdir(root)).filter((name) => /^review-[a-f0-9]{32}\.json$/.test(name));
  }
  async function read(name) {
    const filename = filePath(name);
    try {
      if ((await stat(filename)).size > 2048) throw new Error('Cleanup journal entry exceeds its size limit');
      const entry = JSON.parse(await readFile(filename, 'utf8'));
      if (entry.version !== 1 || entry.name !== name || ![entry.createdAt, entry.settleAfter, entry.nextAttemptAt, entry.attempts].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid cleanup journal entry');
      return entry;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function write(entry) {
    const target = filePath(entry.name); const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(JSON.stringify(entry)); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function settle(entry, removed) {
    if (typeof removed !== 'boolean') throw new TypeError('Cleanup requires an explicit deletion result');
    // An early 404 can race a provider still finishing an interrupted upload.
    if (removed || now() >= entry.settleAfter) {
      await unlink(filePath(entry.name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    } else await write({ ...entry, nextAttemptAt: entry.settleAfter });
  }
  async function defer(entry) {
    const attempts = Math.min(entry.attempts + 1, 1000000);
    await write({ ...entry, attempts, nextAttemptAt: now() + Math.min(3600000, 60000 * (2 ** Math.min(attempts - 1, 6))) });
  }
  return {
    begin(name, requestedLeaseMs = leaseMs) {
      filePath(name);
      if (!Number.isSafeInteger(requestedLeaseMs) || requestedLeaseMs < 1) throw new RangeError('Invalid cleanup lease');
      const pending = admissions.then(() => withEntry(name, async () => {
        const names = await entries();
        if (await read(name)) throw new Error('Cleanup identity already exists');
        if (names.length >= maxEntries) throw new Error('Cleanup journal is full; recover pending files before uploading');
        const createdAt = now();
        await write({ version: 1, name, createdAt, settleAfter: createdAt + requestedLeaseMs, nextAttemptAt: createdAt + requestedLeaseMs, attempts: 0 });
      }));
      admissions = pending.catch(() => {});
      return pending;
    },
    settled(name, removed) {
      return withEntry(name, async () => { const entry = await read(name); if (entry) await settle(entry, removed); });
    },
    failed(name) {
      return withEntry(name, async () => { const entry = await read(name); if (entry) await defer(entry); });
    },
    async recover(removeRemote, signal = new AbortController().signal, maxPerRun = 10) {
      if (!Number.isSafeInteger(maxPerRun) || maxPerRun < 1) throw new RangeError('Invalid cleanup recovery limit');
      const names = await entries(); let attempted = 0; let removed = 0; let failed = 0;
      for (const filename of names) {
        signal.throwIfAborted();
        if (attempted >= maxPerRun) break;
        const name = `files/${filename.slice(0, -5)}`;
        await withEntry(name, async () => {
          let entry;
          try { entry = await read(name); } catch { failed += 1; return; }
          if (!entry || entry.nextAttemptAt > now()) return;
          attempted += 1;
          try {
            const deleted = await removeRemote(name, signal);
            await settle(entry, deleted);
            if (deleted || now() >= entry.settleAfter) removed += 1;
          } catch {
            failed += 1;
            await defer(entry);
          }
        });
      }
      return { attempted, removed, failed, pending: (await entries()).length };
    },
  };
}
