import type { ParticipantData } from '../../../storage/types';
import type { StorageEngine } from '../../../storage/engines/types';
import {
  coOccurrences,
  densestTimeWindows,
  eventsByParticipant,
  eventsByTask,
} from './aggregations';
import { parseRecordingTagsJson } from './recordingTagTypes';
import { parseTimelineEventsJson } from './timelineEventTypes';
import type { StudyReport } from './reportTypes';
import type { StudyIndexedEvent } from './studyEventsIndexTypes';

async function fetchText(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob (HTTP ${res.status})`);
  return (await res.blob()).text();
}

async function fetchBlob(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob (HTTP ${res.status})`);
  return res.blob();
}

async function captureThumbnailDataUrl(videoBlob: Blob): Promise<string | null> {
  // Offscreen video element to decode one frame and paint to canvas.
  const url = URL.createObjectURL(videoBlob);
  try {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video metadata'));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = duration > 0 ? duration * 0.25 : 0;
    try {
      video.currentTime = target;
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.onseeked = done;
      video.onloadeddata = done;
      // in case seek never fires, loadeddata should.
    });

    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    if (w <= 0 || h <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(w / 4));
    canvas.height = Math.max(1, Math.floor(h / 4));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function recordingsForParticipant(p: ParticipantData) {
  const ids = Object.values(p.answers)
    .filter((a) => a.endTime > 0)
    .map((a) => `${a.componentName}_${a.trialOrder}`);
  return Array.from(new Set(ids)).sort();
}

async function buildClipReport(
  storageEngine: StorageEngine,
  participantId: string,
  taskId: string,
): Promise<{
  perClip: StudyReport['perClip'][number];
  flattened: StudyIndexedEvent[];
}> {
  const flattened: StudyIndexedEvent[] = [];

  // summary
  let summary: string | null = null;
  let summaryUrl: string | null = null;
  try {
    summaryUrl = await storageEngine.getScreenRecordingSummary(taskId, participantId);
    if (summaryUrl) {
      const text = await fetchText(summaryUrl);
      try {
        const parsed = JSON.parse(text);
        summary = typeof parsed?.summary === 'string' ? parsed.summary : text.trim();
      } catch {
        summary = text.trim();
      }
    }
  } finally {
    if (summaryUrl) URL.revokeObjectURL(summaryUrl);
  }

  // events
  const events: Array<{ type: string; timestamp: number; evidence?: string }> = [];
  let eventsUrl: string | null = null;
  try {
    eventsUrl = await storageEngine.getScreenRecordingEvents(taskId, participantId);
    if (eventsUrl) {
      const text = await fetchText(eventsUrl);
      const parsed = parseTimelineEventsJson(text);
      for (const e of parsed) {
        events.push({ type: e.type, timestamp: e.timestamp, evidence: e.evidence });
        flattened.push({
          participantId,
          taskId,
          type: e.type,
          timestamp: e.timestamp,
          evidence: e.evidence,
          source: 'auto',
        });
      }
    }
  } finally {
    if (eventsUrl) URL.revokeObjectURL(eventsUrl);
  }

  // tags
  const tags: Array<{ id: string; timestamp: number; label: string }> = [];
  let tagsUrl: string | null = null;
  try {
    tagsUrl = await storageEngine.getScreenRecordingTags(taskId, participantId);
    if (tagsUrl) {
      const text = await fetchText(tagsUrl);
      const parsed = parseRecordingTagsJson(text);
      for (const t of parsed) {
        tags.push({ id: t.id, timestamp: t.timestamp, label: t.label });
        flattened.push({
          participantId,
          taskId,
          type: 'tag',
          timestamp: t.timestamp,
          evidence: t.label,
          source: 'tag',
        });
      }
    }
  } finally {
    if (tagsUrl) URL.revokeObjectURL(tagsUrl);
  }

  // thumbnail
  let thumbnailDataUrl: string | null = null;
  let recordingUrl: string | null = null;
  try {
    recordingUrl = await storageEngine.getScreenRecording(taskId, participantId);
    if (recordingUrl) {
      const blob = await fetchBlob(recordingUrl);
      thumbnailDataUrl = await captureThumbnailDataUrl(blob);
    }
  } finally {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }

  return {
    perClip: {
      participantId,
      taskId,
      thumbnailDataUrl,
      summary,
      tags,
      events,
    },
    flattened,
  };
}

export async function buildStudyReport(
  storageEngine: StorageEngine,
  visibleParticipants: ParticipantData[],
): Promise<StudyReport> {
  const clipRequests = visibleParticipants.flatMap((p) => {
    const { participantId } = p;
    return recordingsForParticipant(p).map((taskId) => ({
      participantId,
      taskId,
    }));
  });

  const clipResults = await Promise.all(
    clipRequests.map(({ participantId, taskId }) => buildClipReport(storageEngine, participantId, taskId)),
  );

  const perClip = clipResults.map((r) => r.perClip);
  const flattenedEvents = clipResults.flatMap((r) => r.flattened);

  const byTask = eventsByTask(flattenedEvents);
  const byParticipant = eventsByParticipant(flattenedEvents);
  const densest = densestTimeWindows(flattenedEvents, 30, 10).map((w) => ({
    participantId: w.participantId,
    taskId: w.taskId,
    start: w.start,
    end: w.end,
    count: w.count,
  }));
  const pairs = coOccurrences(flattenedEvents, 2, 10);

  return {
    studyId: null,
    generatedAt: new Date().toISOString(),
    perClip,
    studyAggregates: {
      byTask,
      byParticipant,
      densestMoments: densest,
      coOccurrences: pairs,
      totalEvents: flattenedEvents.length,
      flattenedEvents,
    },
  };
}
