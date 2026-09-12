const pending = new Map<string, Promise<void>>();

/** Serialize index read/modify/write, including other tabs where Web Locks exist. */
export async function queueReviewIndexUpdate(key: string, update: () => Promise<void>) {
  const run = (pending.get(key) || Promise.resolve()).then(async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(`revisit-review-index:${key}`, update);
    } else await update();
  });
  const settled = run.catch(() => {});
  pending.set(key, settled);
  try { await run; } finally { if (pending.get(key) === settled) pending.delete(key); }
}
