export type ClipId = string;

/** Human / model event types aligned with timeline + Phase 13.3 classifiers. */
export type EventType =
  | 'hesitation'
  | 'confusion_word'
  | 'scene_change'
  | 'reading'
  | 'confused_transition'
  | 'active_interaction'
  | 'tag'
  | string;

export type TimelineEvent = {
  type: EventType;
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
  humanEvents: TimelineEvent[];
  humanTags: HumanTag[];
  raterId: string;
  /** Optional metadata used by reports and the runner. */
  clipDurationSec?: number;
  taskDescription?: string;
};

/** Four thesis pipelines (Phase 14). */
export type PipelineId = 'A_gemini_files' | 'B_gpt4o' | 'C_ollama_local' | 'D_heuristic_timeline';

export type PipelineRunStatus = 'ok' | 'skipped' | 'error';

export type PipelineRunResult = {
  pipeline: PipelineId;
  status: PipelineRunStatus;
  /** Human-readable label for tables. */
  label: string;
  summary?: string;
  events?: TimelineEvent[];
  durationMs?: number;
  /** Rough USD estimate for cloud pipelines (see report constants). */
  estimatedCostUsd?: number;
  modelUsed?: string;
  code?: string;
  reason?: string;
  raw?: unknown;
};

export type OcrRunResult = {
  status: PipelineRunStatus;
  frames?: Array<{ index?: number; timestampSec?: number; text?: string; wordCount?: number }>;
  durationMs?: number;
  reason?: string;
  raw?: unknown;
};

export type ConfusionRunResult = {
  status: PipelineRunStatus;
  windows?: Array<{ startSec: number; endSec: number; score: number; ocrGrounded?: boolean }>;
  totalScore?: number;
  maxWindow?: unknown;
  durationMs?: number;
  reason?: string;
  meta?: unknown;
};

export type ClipResult = {
  clipId: ClipId;
  videoFile?: string;
  /** @deprecated legacy field; prefer `pipelines`. */
  latencyMsByModel?: Record<string, number>;
  /** @deprecated legacy field; prefer `pipelines`. */
  outputs?: unknown[];
  /** @deprecated legacy field; prefer `pipelines[].reason`. */
  errors?: Array<{ modelId: string; error: string }>;
  groundTruthSha256: string;
  pipelines: PipelineRunResult[];
  ocr: OcrRunResult;
  confusionScore: ConfusionRunResult;
};

export type RunManifest = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  massApiBaseUrl: string;
  modelsRun: PipelineId[];
  /** Capabilities observed from GET /api/health when the run started. */
  health?: {
    hasGeminiKey?: boolean;
    hasOpenAiKey?: boolean;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
  };
  errors: Array<{ clipId: ClipId; step: string; message: string }>;
};
