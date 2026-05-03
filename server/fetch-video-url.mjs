/**
 * Download HTTPS media into a temp file for ffmpeg/Python pipelines (GET-only mass API).
 */
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_ALLOW_HOST_SUFFIXES = [
  'firebasestorage.googleapis.com',
  'firebasestorage.app',
  'googleapis.com',
  'supabase.co',
];

function hostnameAllowed(hostname) {
  const raw = process.env.MQP_VIDEO_URL_ALLOW_HOSTS;
  if (raw === '*') return true;
  const rules = (raw || DEFAULT_ALLOW_HOST_SUFFIXES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return rules.some((rule) => {
    if (rule === hostname) return true;
    if (hostname.endsWith(`.${rule}`)) return true;
    return hostname === rule;
  });
}

/**
 * @param {string} urlString
 * @param {string} extWithoutDot e.g. webm, mp4, wav
 */
export async function downloadMediaUrlToTempFile(urlString, extWithoutDot) {
  const u = new URL(urlString);
  if (u.protocol === 'https:') {
    if (!hostnameAllowed(u.hostname)) {
      throw new Error(
        `URL host not allowed: ${u.hostname}. Set MQP_VIDEO_URL_ALLOW_HOSTS=* or extend the allowlist.`,
      );
    }
  } else if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) {
    /* dev */
  } else {
    throw new Error('videoUrl / companionAudioUrl must be https:// or http://localhost|127.0.0.1');
  }

  const res = await fetch(urlString, { redirect: 'follow', headers: { Accept: '*/*' } });
  if (!res.ok) {
    throw new Error(`Media fetch failed HTTP ${res.status} for ${u.hostname}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw new Error('Media fetch returned empty body');
  }
  const safeExt = (extWithoutDot || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  const tmp = path.join(tmpdir(), `mqp-media-${randomUUID()}.${safeExt}`);
  await writeFile(tmp, buf);
  return tmp;
}

export async function safeUnlink(p) {
  if (!p) return;
  await unlink(p).catch(() => {});
}
