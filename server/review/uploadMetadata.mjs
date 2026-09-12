import { AnalysisError } from './process.mjs';

export function reviewMetadataLength(header) {
  if (header === undefined) return 0;
  if (typeof header !== 'string' || !/^[1-9]\d{0,4}$/.test(header) || Number(header) > 65536) throw new AnalysisError('INVALID_OPTIONS', 'Invalid upload metadata length');
  return Number(header);
}

/** The optional UTF-8 JSON prefix is bounded; remaining chunks are unchanged video bytes. */
export async function* reviewVideoChunks(source, length, receiveMetadata) {
  const prefix = Buffer.alloc(length);
  let read = 0;
  for await (const chunk of source) {
    let offset = 0;
    if (read < length) {
      offset = Math.min(length - read, chunk.length);
      chunk.copy(prefix, read, 0, offset); read += offset;
      if (read === length) {
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix)); } catch { throw new AnalysisError('INVALID_OPTIONS', 'Upload metadata must be valid UTF-8 JSON'); }
        if (!value || typeof value.prompt !== 'string' || value.prompt.length > 8000 || typeof value.confusionWords !== 'string' || value.confusionWords.length > 2000) throw new AnalysisError('INVALID_OPTIONS', 'Invalid analysis prompt or confusion phrases');
        receiveMetadata(value);
      }
    }
    if (offset < chunk.length) yield chunk.subarray(offset);
  }
  if (read !== length) throw new AnalysisError('INVALID_OPTIONS', 'Upload ended before its metadata was complete');
}
