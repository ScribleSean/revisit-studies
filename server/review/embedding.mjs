import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalysisError } from './process.mjs';
import { createJsonWorker } from './jsonWorker.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
export function validateTexts(texts) {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > 32 || texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > 8000)) throw new AnalysisError('INVALID_TEXT', 'Provide 1–32 nonempty texts of at most 8000 characters each');
}

export function createEmbedder({ python, modelDirectory = path.join(root, '.review-models/minilm') }) {
  const worker = createJsonWorker(python, ['-u', path.join(root, 'scripts/review_embed.py'), '--model-directory', modelDirectory, '--worker'], {
    cwd: root, env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  });
  const embedder = async (texts, signal) => {
    validateTexts(texts);
    const result = await worker.request({ texts }, signal);
    if (!Array.isArray(result.vectors) || result.vectors.length !== texts.length || result.vectors.some((vector) => !Array.isArray(vector) || vector.length !== 384 || vector.some((v) => !Number.isFinite(v)) || !vector.some((v) => v !== 0))) throw new AnalysisError('INVALID_RESULT', 'Embedding worker returned invalid vectors');
    return result.vectors.map((vector) => ({ model: EMBEDDING_MODEL, vector }));
  };
  embedder.version = `${EMBEDDING_MODEL}:v1`;
  embedder.close = () => worker.close();
  return embedder;
}

export async function readEmbeddingRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1050000) throw new AnalysisError('UPLOAD_LIMIT', 'Embedding text exceeds the upload limit');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AnalysisError('INVALID_TEXT', 'Embedding input must be JSON'); }
  validateTexts(data?.texts);
  return data.texts;
}
