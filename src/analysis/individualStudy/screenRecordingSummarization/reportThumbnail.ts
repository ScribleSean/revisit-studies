/** Decode one bounded-size frame at 25% of the recording, releasing media on every path. */
export async function reportThumbnail(blob: Blob, signal: AbortSignal, measuredDuration?: number): Promise<string> {
  signal.throwIfAborted();
  const video = document.createElement('video');
  const url = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('Thumbnail decode timed out')), 15000);
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      video.onerror = () => reject(new Error('Recording could not be decoded'));
      video.onloadedmetadata = () => {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : measuredDuration;
        if (!duration || !Number.isFinite(duration) || duration <= 0) { reject(new Error('Recording duration unavailable for thumbnail')); return; }
        try { video.currentTime = duration * 0.25; } catch (error) { reject(error); }
      };
      video.onseeked = () => {
        try {
          if (!video.videoWidth || !video.videoHeight) throw new Error('Recording has no decodable video frame');
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 320 / video.videoWidth, 240 / video.videoHeight);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas unavailable for thumbnail');
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.75));
        } catch (error) { reject(error); }
      };
      video.src = url;
      video.load();
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    video.onloadedmetadata = null; video.onseeked = null; video.onerror = null;
    video.removeAttribute('src'); video.load();
    URL.revokeObjectURL(url);
  }
}
