export type IndexedEventSource = 'auto' | 'tag';

export type StudyIndexedEvent = {
  participantId: string;
  taskId: string;
  type: string;
  timestamp: number;
  evidence?: string;
  source: IndexedEventSource;
};

export type StudyEventsIndex = {
  events: StudyIndexedEvent[];
  lastUpdatedAt: string;
};
