import type { ParticipantData } from '../../../storage/types';
import type { StorageEngine } from '../../../storage/engines/types';
import { parseRecordingTagsJson } from './recordingTagTypes';
import { parseTimelineEventsJson } from './timelineEventTypes';
import type { StudyEventsIndex, StudyIndexedEvent } from './studyEventsIndexTypes';

async function fetchTextFromObjectUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob (HTTP ${res.status})`);
  return (await res.blob()).text();
}

type StoredRecording = { identifier: string };

function recordingsForParticipant(p: ParticipantData): StoredRecording[] {
  const identifiers = Object.values(p.answers)
    .filter((a) => a.endTime > 0)
    .map((a) => `${a.componentName}_${a.trialOrder}`);
  return Array.from(new Set(identifiers)).map((identifier) => ({ identifier }));
}

export async function rebuildStudyEventsIndex(
  storageEngine: StorageEngine,
  visibleParticipants: ParticipantData[],
): Promise<StudyEventsIndex> {
  const flattened: StudyIndexedEvent[] = [];

  // Sequential async processing without eslint no-await-in-loop violations.
  await visibleParticipants.reduce(async (prevP, participant) => {
    await prevP;
    const { participantId } = participant;
    const recs = recordingsForParticipant(participant);

    await recs.reduce(async (prevR, rec) => {
      await prevR;
      const taskId = rec.identifier;

      // Auto events
      let eventsUrl: string | null = null;
      try {
        eventsUrl = await storageEngine.getScreenRecordingEvents(taskId, participantId);
        if (eventsUrl) {
          const text = await fetchTextFromObjectUrl(eventsUrl);
          const parsed = parseTimelineEventsJson(text);
          for (const e of parsed) {
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

      // Researcher tags
      let tagsUrl: string | null = null;
      try {
        tagsUrl = await storageEngine.getScreenRecordingTags(taskId, participantId);
        if (tagsUrl) {
          const text = await fetchTextFromObjectUrl(tagsUrl);
          const tags = parseRecordingTagsJson(text);
          for (const t of tags) {
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
    }, Promise.resolve());
  }, Promise.resolve());

  flattened.sort((a, b) => a.timestamp - b.timestamp);
  return { events: flattened, lastUpdatedAt: new Date().toISOString() };
}
