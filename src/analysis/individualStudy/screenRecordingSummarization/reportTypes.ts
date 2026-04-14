import type { StudyIndexedEvent } from './studyEventsIndexTypes';

export type StudyReportPerClip = {
  participantId: string;
  taskId: string;
  thumbnailDataUrl: string | null;
  summary: string | null;
  tags: Array<{ id: string; timestamp: number; label: string }>;
  events: Array<{ type: string; timestamp: number; evidence?: string }>;
};

export type StudyReport = {
  studyId: string | null;
  generatedAt: string;
  generatedBy?: string;
  perClip: StudyReportPerClip[];
  studyAggregates: {
    byTask: Record<string, Record<string, number>>;
    byParticipant: Record<string, Record<string, number>>;
    densestMoments: Array<{
      participantId: string;
      taskId: string;
      start: number;
      end: number;
      count: number;
    }>;
    coOccurrences: Array<{ a: string; b: string; count: number }>;
    totalEvents: number;
    flattenedEvents: StudyIndexedEvent[];
  };
};
