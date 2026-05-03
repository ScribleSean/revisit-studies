/**
 * Resolve GET query params to temp video (and optional companion audio) paths.
 *
 * - videoUrl / companionAudioUrl: HTTPS fetch into tmp (see fetch-video-url.mjs).
 * - localPath / companionLocalPath: only when MQP_ALLOW_LOCAL_VIDEO_PATH=true and path stays under process.cwd().
 */
import path from 'node:path';
import { downloadMediaUrlToTempFile, safeUnlink } from './fetch-video-url.mjs';
import { extFromMime } from './frame-sampler.mjs';

function assertLocalPathAllowed(absPath) {
  const cwd = process.cwd();
  if (!absPath.startsWith(cwd)) {
    throw new Error(`localPath must resolve under server cwd (${cwd})`);
  }
}

/**
 * @returns {Promise<{ path: string, mimeType: string, unlinkAfter: boolean }>}
 */
export async function resolveVideoQueryToTemp(req) {
  const mimeType = typeof req.query.mimeType === 'string' && req.query.mimeType.trim()
    ? req.query.mimeType.trim()
    : 'video/webm';
  const ext = extFromMime(mimeType);

  const localRaw = typeof req.query.localPath === 'string' ? req.query.localPath.trim() : '';
  if (localRaw && process.env.MQP_ALLOW_LOCAL_VIDEO_PATH === 'true') {
    const resolved = path.resolve(localRaw);
    assertLocalPathAllowed(resolved);
    return { path: resolved, mimeType, unlinkAfter: false };
  }

  const videoUrl = typeof req.query.videoUrl === 'string' ? req.query.videoUrl.trim() : '';
  if (!videoUrl) {
    throw new Error(
      'Missing query parameter videoUrl (https storage URL). For local files on the server only, set MQP_ALLOW_LOCAL_VIDEO_PATH=true and pass localPath=… under cwd.',
    );
  }
  const tmp = await downloadMediaUrlToTempFile(videoUrl, ext);
  return { path: tmp, mimeType, unlinkAfter: true };
}

function companionExtFromMime(mime) {
  if (!mime || typeof mime !== 'string') return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * @returns {Promise<{ path: string, mimeType: string, unlinkAfter: boolean } | null>}
 */
export async function resolveCompanionAudioQueryToTemp(req) {
  const mimeType = typeof req.query.companionMimeType === 'string' && req.query.companionMimeType.trim()
    ? req.query.companionMimeType.trim()
    : 'audio/webm';

  const localRaw = typeof req.query.companionLocalPath === 'string' ? req.query.companionLocalPath.trim() : '';
  if (localRaw && process.env.MQP_ALLOW_LOCAL_VIDEO_PATH === 'true') {
    const resolved = path.resolve(localRaw);
    assertLocalPathAllowed(resolved);
    return { path: resolved, mimeType, unlinkAfter: false };
  }

  const url = typeof req.query.companionAudioUrl === 'string' ? req.query.companionAudioUrl.trim() : '';
  if (!url) return null;

  const tmp = await downloadMediaUrlToTempFile(url, companionExtFromMime(mimeType));
  return { path: tmp, mimeType, unlinkAfter: true };
}

export { safeUnlink };
