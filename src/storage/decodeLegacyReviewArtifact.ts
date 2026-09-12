const MAX_BYTES = 32 * 1024 * 1024;

/** Storage engines return old artifacts as decoded objects, raw strings or Blobs. */
export async function decodeLegacyReviewArtifact(value: unknown, plainSummary = false, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (value === null || value === undefined) return null;
  let text: string;
  if (value instanceof Blob) {
    if (value.size > MAX_BYTES) throw new Error('Legacy artifact exceeds the 32 MiB decode limit');
    text = await value.text();
    signal?.throwIfAborted();
  } else if (typeof value === 'string') text = value;
  else {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Invalid legacy artifact');
    text = encoded;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('Legacy artifact exceeds the 32 MiB decode limit');
  try { return JSON.parse(text); } catch {
    if (plainSummary) return text;
    throw new Error('Legacy artifact is not valid JSON');
  }
}
