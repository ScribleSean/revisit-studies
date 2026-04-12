export type ClipId = string;

export type HumanEventType = 'hesitation' | 'confusion_word' | 'scene_change' | 'tag';

export type HumanEvent = {
  type: HumanEventType;
  timestamp: number;
  evidence?: string;
};

export type HumanTag = {
  id: string;
  timestamp: number;
  label: string;
};

export type GroundTruth = {
  clipId: ClipId;
  humanSummary: string;
  humanEvents: HumanEvent[];
  humanTags: HumanTag[];
  raterId: string;
};

export type ModelId = 'gemini_inline' | 'gemini_files_api' | 'timeline_sidecar';

export type ModelOutput = {
  modelId: ModelId;
  summary?: string;
  events?: Array<{ type: string; timestamp: number; evidence?: string }>;
  tags?: Array<{ id: string; timestamp: number; label: string }>;
  raw?: unknown;
};

export type ClipResult = {
  clipId: ClipId;
  videoFile?: string;
  latencyMsByModel: Partial<Record<ModelId, number>>;
  outputs: ModelOutput[];
  errors: Array<{ modelId: ModelId; error: string }>;
};

export type RunManifest = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  modelsRun: ModelId[];
  errors: Array<{ clipId: ClipId; modelId: ModelId; error: string }>;
};
