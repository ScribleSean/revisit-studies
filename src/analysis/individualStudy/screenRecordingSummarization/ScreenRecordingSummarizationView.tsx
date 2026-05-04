import {
  Alert,
  Box,
  Button,
  Card,
  Divider,
  FileInput,
  Group,
  LoadingOverlay,
  Progress,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ParticipantData } from '../../../storage/types';
import { useStorageEngine } from '../../../storage/storageEngineHooks';
import type { StudyConfig } from '../../../parser/types';
import type { ScreenRecordingSummarizationPipeline } from '../../../storage/engines/types';
import { MassScreenRecordingSummarizationView } from './MassScreenRecordingSummarizationView';
import type { MassApiHealthSnapshot } from './massApiHealthTypes';
import { INITIAL_MASS_API_HEALTH } from './massApiHealthTypes';
import { getMassApiBaseUrl } from './massApiBase';
import {
  buildMassApiUrl,
  massApiFetchableMediaUrl,
  MASS_API_FETCHABLE_URL_HELP,
} from './massApiQuery';
import { RecordingTagsPanel } from './RecordingTagsPanel';
import { RecordingTimelineStrip } from './RecordingTimelineStrip';
import type { RecordingTag } from './recordingTagTypes';
import { parseRecordingTagsJson } from './recordingTagTypes';
import type { TimelineEvent } from './timelineEventTypes';
import { parseTimelineEventsJson } from './timelineEventTypes';

type GeminiAnalyzeResponse = {
  summary?: string;
  raw?: unknown;
};

type GeminiRestResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  text?: string;
};

function extractGeminiText(json: unknown): string | null {
  const candidates = (json as GeminiRestResponse | undefined)?.candidates;
  const first = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null;
  const parts = first?.content?.parts;

  if (Array.isArray(parts)) {
    const textParts = parts
      .map((p) => (typeof p?.text === 'string' ? p.text : null))
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('');
  }

  // Fallbacks
  const fallbackText = (json as GeminiRestResponse | undefined)?.text;
  if (typeof fallbackText === 'string') return fallbackText;
  return null;
}

type ConfusionScoreWindow = {
  startSec: number;
  endSec: number;
  score: number;
};

type StoredConfusionScore = {
  windows: ConfusionScoreWindow[];
  totalScore: number;
  maxWindow: ConfusionScoreWindow | null;
  meta?: unknown;
  generatedAt?: string;
};

function parseStoredConfusionScoreJson(text: string): StoredConfusionScore | null {
  try {
    const parsed = JSON.parse(text || '{}') as Record<string, unknown>;
    const rawWindows = parsed.windows;
    if (!Array.isArray(rawWindows)) return null;
    const windows: ConfusionScoreWindow[] = rawWindows
      .map((w) => {
        const o = w as Record<string, unknown>;
        return {
          startSec: Number(o.startSec ?? 0),
          endSec: Number(o.endSec ?? 0),
          score: Number(o.score ?? 0),
        };
      })
      .filter((w) => Number.isFinite(w.startSec) && Number.isFinite(w.endSec) && Number.isFinite(w.score));
    const maxW = parsed.maxWindow;
    let maxWindow: ConfusionScoreWindow | null = null;
    if (maxW && typeof maxW === 'object') {
      const o = maxW as Record<string, unknown>;
      const mw: ConfusionScoreWindow = {
        startSec: Number(o.startSec ?? 0),
        endSec: Number(o.endSec ?? 0),
        score: Number(o.score ?? 0),
      };
      if (Number.isFinite(mw.startSec) && Number.isFinite(mw.endSec) && Number.isFinite(mw.score)) {
        maxWindow = mw;
      }
    }
    return {
      windows,
      totalScore: typeof parsed.totalScore === 'number' ? parsed.totalScore : Number(parsed.totalScore) || 0,
      maxWindow,
      meta: parsed.meta,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : undefined,
    };
  } catch {
    return null;
  }
}

function parsePossibleStoredSummary(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.summary === 'string') return parsed.summary;
    if (typeof parsed?.analysis === 'string') return parsed.analysis;
    // Some pipelines may store the raw text under a different key.
    if (typeof parsed?.text === 'string') return parsed.text;
    return null;
  } catch {
    // Not JSON; treat it as plain text.
    return trimmed;
  }
}

function parseMatchedPhrasesFromEvidence(evidence: string): string[] {
  const m = evidence.trim().toLowerCase().match(/matched:\s*(.+)$/i);
  if (!m) return [];
  return m[1].split(',').map((p) => p.trim()).filter(Boolean);
}

function computeOcrGroundingMask(
  events: TimelineEvent[],
  ocrFrames: Array<{ timestampSec: number; text: string }>,
): { eventGrounded: boolean[]; ocrGrounded: boolean[] } {
  const eventGrounded = events.map((e) => {
    if (e.type !== 'confusion_word') return false;
    const phrases = parseMatchedPhrasesFromEvidence(e.evidence || '');
    if (phrases.length === 0) return false;
    for (const fr of ocrFrames) {
      if (Math.abs(fr.timestampSec - e.timestamp) <= 3) {
        const blob = (fr.text || '').toLowerCase();
        if (phrases.some((p) => p && blob.includes(p.toLowerCase()))) return true;
      }
    }
    return false;
  });
  const ocrGrounded = ocrFrames.map((fr) => {
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e.type === 'confusion_word' && Math.abs(fr.timestampSec - e.timestamp) <= 3) {
        const phrases = parseMatchedPhrasesFromEvidence(e.evidence || '');
        const blob = (fr.text || '').toLowerCase();
        if (phrases.some((p) => p && blob.includes(p.toLowerCase()))) return true;
      }
    }
    return false;
  });
  return { eventGrounded, ocrGrounded };
}

async function clipDurationFromPlayUrl(playUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const d = v.duration;
      v.removeAttribute('src');
      v.load();
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    v.onerror = () => reject(new Error('Could not read video duration'));
    v.src = playUrl;
  });
}

/** Mic audio URL for GET mass-api (same storage path as think-aloud: audio/{participant}_{task}). */
async function companionMassApiAudioQuery(
  storageEngine: { getAudioUrl: (task: string, participantId: string) => Promise<string | null> },
  taskIdentifier: string,
  participantId: string,
): Promise<{ companionAudioUrl?: string; companionMimeType?: string }> {
  let raw: string | null = null;
  try {
    raw = await storageEngine.getAudioUrl(taskIdentifier, participantId);
  } catch {
    return {};
  }
  const u = massApiFetchableMediaUrl(raw);
  if (!u) return {};
  return { companionAudioUrl: u, companionMimeType: 'audio/webm' };
}

function globalTimeToClipAndLocal(
  clips: Array<{ offsetSec: number; durationSec: number }>,
  t: number,
): { clipIndex: number; localT: number } | null {
  if (clips.length === 0) return null;
  const x = Number.isFinite(t) ? Math.max(0, t) : 0;
  for (let i = 0; i < clips.length; i += 1) {
    const { offsetSec, durationSec } = clips[i];
    const end = offsetSec + durationSec;
    if (x < end + 1e-3) {
      const localT = Math.min(Math.max(0, x - offsetSec), Math.max(0, durationSec - 0.05));
      return { clipIndex: i, localT };
    }
  }
  const last = clips[clips.length - 1];
  return {
    clipIndex: clips.length - 1,
    localT: Math.max(0, last.durationSec - 0.05),
  };
}

function GroupRow({ children }: { children: ReactNode }) {
  return (
    <Box>
      <Group gap="xs" wrap="wrap" justify="flex-start">
        {children}
      </Group>
    </Box>
  );
}
export function ScreenRecordingSummarizationView({
  visibleParticipants,
  studyConfig,
  summarizationPipeline = 'gemini',
  openAiAvailable = false,
  massApiHealth = INITIAL_MASS_API_HEALTH,
  preferredStoredSelection = null,
  onPreferredStoredSelectionApplied,
}: {
  visibleParticipants: ParticipantData[];
  studyConfig?: StudyConfig;
  summarizationPipeline?: ScreenRecordingSummarizationPipeline;
  openAiAvailable?: boolean;
  massApiHealth?: MassApiHealthSnapshot;
  /** When set, selects this participant + recording once (e.g. jump from cross-clip dashboard). */
  preferredStoredSelection?: { participantId: string; identifier: string } | null;
  onPreferredStoredSelectionApplied?: () => void;
}) {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string>('');

  const { storageEngine } = useStorageEngine();

  type StoredRecording = { identifier: string; label: string };
  const recordingsByParticipantId = useMemo(() => {
    const map = new Map<string, StoredRecording[]>();
    for (const participant of visibleParticipants) {
      const identifiers = Object.values(participant.answers)
        .filter((a) => a.endTime > 0)
        .map((a) => ({
          identifier: `${a.componentName}_${a.trialOrder}`,
          label: `${a.componentName} (trial ${a.trialOrder})`,
        }));

      const unique = new Map<string, StoredRecording>();
      for (const rec of identifiers) unique.set(rec.identifier, rec);

      map.set(participant.participantId, Array.from(unique.values()).sort((a, b) => a.label.localeCompare(b.label)));
    }
    return map;
  }, [visibleParticipants]);

  const storedParticipantIds = useMemo(() => visibleParticipants.map((p) => p.participantId), [visibleParticipants]);

  const [storedParticipantId, setStoredParticipantId] = useState<string | null>(visibleParticipants[0]?.participantId ?? null);
  const [storedRecordingIdentifier, setStoredRecordingIdentifier] = useState<string | null>(null);
  const [storedVideoUrl, setStoredVideoUrl] = useState<string | null>(null);
  const [storedSummary, setStoredSummary] = useState<string | null>(null);
  const [storedIsLoading, setStoredIsLoading] = useState(false);
  const [storedError, setStoredError] = useState<string | null>(null);
  const [storedTimelineEvents, setStoredTimelineEvents] = useState<TimelineEvent[]>([]);
  const [storedTags, setStoredTags] = useState<RecordingTag[]>([]);
  const [storedOcrFrames, setStoredOcrFrames] = useState<Array<{ index: number; timestampSec: number; text: string; wordCount: number }>>([]);
  const [videoDuration, setVideoDuration] = useState(0);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [storedConfusionScore, setStoredConfusionScore] = useState<StoredConfusionScore | null>(null);
  const [confusionScoreLoading, setConfusionScoreLoading] = useState(false);
  const [confusionScoreError, setConfusionScoreError] = useState<string | null>(null);
  const storedVideoRef = useRef<HTMLVideoElement | null>(null);
  const sessionMergedVideoRef = useRef<HTMLVideoElement | null>(null);

  type ParticipantSessionClip = {
    identifier: string;
    label: string;
    offsetSec: number;
    durationSec: number;
    playUrl: string;
  };

  type ParticipantSessionViewState = {
    clips: ParticipantSessionClip[];
    totalSec: number;
    mergedEvents: TimelineEvent[];
    mergedOcrFrames: Array<{ index: number; timestampSec: number; text: string; wordCount: number }>;
    mergedConfusion: StoredConfusionScore;
  };

  const [participantSessionView, setParticipantSessionView] = useState<ParticipantSessionViewState | null>(null);
  const [participantSessionLoading, setParticipantSessionLoading] = useState(false);
  const [participantSessionError, setParticipantSessionError] = useState<string | null>(null);
  const [participantSessionProgress, setParticipantSessionProgress] = useState<{
    label: string;
    done: number;
    total: number;
  } | null>(null);

  const participantSessionViewRef = useRef(participantSessionView);
  participantSessionViewRef.current = participantSessionView;

  useEffect(() => () => {
    const v = participantSessionViewRef.current;
    if (v) v.clips.forEach((c) => URL.revokeObjectURL(c.playUrl));
  }, []);

  // Keep selected participant valid if the visible participants list changes.
  useEffect(() => {
    if (!storedParticipantId) {
      setStoredParticipantId(storedParticipantIds[0] ?? null);
      return;
    }
    if (!storedParticipantIds.includes(storedParticipantId)) {
      setStoredParticipantId(storedParticipantIds[0] ?? null);
    }
  }, [storedParticipantId, storedParticipantIds]);

  useEffect(() => {
    if (!preferredStoredSelection) return;
    setStoredParticipantId(preferredStoredSelection.participantId);
    setStoredRecordingIdentifier(preferredStoredSelection.identifier);
    onPreferredStoredSelectionApplied?.();
  }, [preferredStoredSelection, onPreferredStoredSelectionApplied]);

  useEffect(() => {
    setParticipantSessionView((prev) => {
      if (prev) {
        prev.clips.forEach((c) => URL.revokeObjectURL(c.playUrl));
      }
      return null;
    });
    setParticipantSessionError(null);
    setParticipantSessionProgress(null);
  }, [storedParticipantId]);

  const envVars = import.meta.env as unknown as {
    VITE_GEMINI_API_KEY?: string;
    VITE_GEMINI_VIDEO_MODEL?: string;
  };
  const apiKey = envVars.VITE_GEMINI_API_KEY;
  const model = envVars.VITE_GEMINI_VIDEO_MODEL;
  const geminiMassApiBase = useMemo(() => getMassApiBaseUrl(), []);

  const timelineApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-timeline`;
    return '/api/analyze-timeline';
  }, [geminiMassApiBase]);

  const ocrApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/extract-ocr`;
    return '/api/extract-ocr';
  }, [geminiMassApiBase]);

  const confusionScoreApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/confusion-score`;
    return '/api/confusion-score';
  }, [geminiMassApiBase]);

  const confusionWords = useMemo(() => {
    const raw = studyConfig?.screenRecordingAnalysis?.confusionWords;
    if (!Array.isArray(raw)) return null;
    const cleaned = raw.map((w) => (typeof w === 'string' ? w.trim() : '')).filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  }, [studyConfig]);

  const ocrStripFrames = useMemo(
    () => storedOcrFrames.map((f) => ({ timestampSec: f.timestampSec, text: f.text })),
    [storedOcrFrames],
  );

  const { ocrEventGrounded, ocrFrameGrounded } = useMemo(() => {
    if (storedOcrFrames.length === 0 || storedTimelineEvents.length === 0) {
      return {
        ocrEventGrounded: undefined as boolean[] | undefined,
        ocrFrameGrounded: undefined as boolean[] | undefined,
      };
    }
    const frames = storedOcrFrames.map((f) => ({ timestampSec: f.timestampSec, text: f.text }));
    const m = computeOcrGroundingMask(storedTimelineEvents, frames);
    return { ocrEventGrounded: m.eventGrounded, ocrFrameGrounded: m.ocrGrounded };
  }, [storedTimelineEvents, storedOcrFrames]);

  /** WebM metadata often leaves `<video>.duration` at 0 — use timeline / OCR / confusion extent so strips and bars lay out correctly. */
  const storedRecordingEffectiveDuration = useMemo(() => {
    if (Number.isFinite(videoDuration) && videoDuration > 0) {
      return videoDuration;
    }
    if (storedTimelineEvents.length > 0) {
      const maxT = Math.max(...storedTimelineEvents.map((e) => e.timestamp));
      if (Number.isFinite(maxT) && maxT > 0) return maxT * 1.1;
    }
    if (ocrStripFrames.length > 0) {
      const maxO = Math.max(...ocrStripFrames.map((f) => f.timestampSec));
      if (Number.isFinite(maxO) && maxO > 0) return maxO * 1.1;
    }
    if (storedConfusionScore?.windows?.length) {
      const maxW = Math.max(...storedConfusionScore.windows.map((w) => w.endSec));
      if (Number.isFinite(maxW) && maxW > 0) return maxW * 1.1;
    }
    return 0;
  }, [videoDuration, storedTimelineEvents, ocrStripFrames, storedConfusionScore]);

  const sessionOcrStripFrames = useMemo(
    () => (participantSessionView?.mergedOcrFrames ?? []).map((f) => ({ timestampSec: f.timestampSec, text: f.text })),
    [participantSessionView?.mergedOcrFrames],
  );

  const { sessionOcrEventGrounded, sessionOcrFrameGrounded } = useMemo(() => {
    if (!participantSessionView || sessionOcrStripFrames.length === 0 || participantSessionView.mergedEvents.length === 0) {
      return {
        sessionOcrEventGrounded: undefined as boolean[] | undefined,
        sessionOcrFrameGrounded: undefined as boolean[] | undefined,
      };
    }
    const m = computeOcrGroundingMask(participantSessionView.mergedEvents, sessionOcrStripFrames);
    return { sessionOcrEventGrounded: m.eventGrounded, sessionOcrFrameGrounded: m.ocrGrounded };
  }, [participantSessionView, sessionOcrStripFrames]);

  const effectiveModel = useMemo(
    () => model || 'models/gemini-2.0-flash',
    [model],
  );

  const caps = massApiHealth.capabilities;
  /** Only disable when /api/health explicitly reports false — unknown/empty caps stay enabled so GitHub Pages still tries the API. */
  const timelineServerBlocked = massApiHealth.loaded && caps != null && caps.timelineReady === false;
  const ocrServerBlocked = massApiHealth.loaded && caps != null && caps.ocrReady === false;
  const confusionServerBlocked = massApiHealth.loaded && caps != null && caps.confusionReady === false;
  const massApiBaseConfigured = Boolean((geminiMassApiBase || '').trim());
  /** When using a remote mass API, wait for /api/health before enabling media tooling. */
  const waitForMassApiHealth = massApiBaseConfigured && !massApiHealth.loaded;

  const massApiMediaMissingParts = useMemo(() => {
    const c = massApiHealth.capabilities;
    if (!massApiHealth.loaded || !c) return [];
    const parts: string[] = [];
    if (c.ffmpeg === false) parts.push('ffmpeg');
    if (c.tesseract === false) parts.push('Tesseract');
    if (c.timelineReady === false) parts.push('timeline (Python + Whisper + scenedetect)');
    if (c.ocrReady === false) parts.push('OCR stack');
    if (c.confusionReady === false) parts.push('confusion script');
    return parts;
  }, [massApiHealth.capabilities, massApiHealth.loaded]);

  useEffect(() => {
    if (!videoFile) return undefined;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const prompt = useMemo(
    () => [
      'Provide a high-level summary of the video in 3-5 sentences.',
      'Include key events and, when possible, reference moments using MM:SS timestamps (e.g., 01:15).',
      'If you detect the participant struggling or changing strategy, mention that explicitly.',
    ].join(' '),
    [],
  );

  const canInlineUpload = useMemo(() => {
    // Gemini "Pass video data inline" works for smaller files (<20MB request size).
    // We enforce a conservative size check before base64 encoding in the browser.
    if (!videoFile) return false;
    return videoFile.size <= 20 * 1024 * 1024;
  }, [videoFile]);

  const uploadClipGeminiInlineOnly = useMemo(() => {
    if (summarizationPipeline !== 'gemini') return true;
    if (!apiKey) return true;
    return false;
  }, [apiKey, summarizationPipeline]);

  const analyzeSingleClipDisabled = useMemo(() => {
    if (!videoFile || isAnalyzing) return true;
    if (uploadClipGeminiInlineOnly) return true;
    if (!canInlineUpload) return true;
    if (summarizationPipeline === 'gpt4o' && !openAiAvailable) return true;
    return false;
  }, [
    canInlineUpload,
    isAnalyzing,
    openAiAvailable,
    summarizationPipeline,
    uploadClipGeminiInlineOnly,
    videoFile,
  ]);

  async function analyzeVideo(file: File): Promise<GeminiAnalyzeResponse> {
    if (summarizationPipeline !== 'gemini') {
      return {
        summary: undefined,
        raw: {
          error:
            'One-off upload uses browser Gemini only. For Ollama/GPT-4o or Files API summaries, use Mass summarization with stored HTTPS recordings.',
        },
      };
    }
    if (!apiKey) {
      return { summary: undefined, raw: { error: 'Missing VITE_GEMINI_API_KEY' } };
    }

    if (file.size > 20 * 1024 * 1024) {
      return { summary: undefined, raw: { error: 'Video too large for inline upload (>20MB)' } };
    }

    // Read and convert to base64 (inline video input)
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read video file'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });

    // dataUrl: "data:<mimeType>;base64,<base64data>"
    const match = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!match) return { summary: undefined, raw: { error: 'Invalid dataUrl format' } };

    const mimeType = match[1];
    const base64Data = match[2];

    const url = `https://generativelanguage.googleapis.com/v1beta/${effectiveModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { summary: undefined, raw: { status: res.status, json } };
    }

    const text = extractGeminiText(json);
    return { summary: text ?? undefined, raw: json };
  }

  useEffect(() => {
    if (!storedParticipantId) return;
    const options = recordingsByParticipantId.get(storedParticipantId) ?? [];
    const currentAvailable = storedRecordingIdentifier && options.some((o) => o.identifier === storedRecordingIdentifier);
    if (currentAvailable) return;
    setStoredRecordingIdentifier(options[0]?.identifier ?? null);
  }, [storedParticipantId, recordingsByParticipantId, storedRecordingIdentifier]);

  useEffect(() => {
    let cancelled = false;

    if (!storageEngine || !storedParticipantId || !storedRecordingIdentifier) {
      return () => {
        cancelled = true;
      };
    }

    setStoredIsLoading(true);
    setStoredError(null);
    setStoredSummary(null);
    setStoredVideoUrl(null);
    setStoredTimelineEvents([]);
    setStoredTags([]);
    setStoredOcrFrames([]);
    setStoredConfusionScore(null);
    setVideoDuration(0);
    setTimelineError(null);
    setOcrError(null);
    setConfusionScoreError(null);

    (async () => {
      try {
        const [videoUrlForRecording, summaryObjectUrl] = await Promise.all([
          storageEngine.getScreenRecording(storedRecordingIdentifier, storedParticipantId),
          storageEngine.getScreenRecordingSummary(storedRecordingIdentifier, storedParticipantId),
        ]);

        if (cancelled) return;

        setStoredVideoUrl(videoUrlForRecording);

        if (!summaryObjectUrl) {
          setStoredSummary(null);
        } else {
          const blob = await (await fetch(summaryObjectUrl)).blob();
          const text = await blob.text();
          const parsed = parsePossibleStoredSummary(text);
          setStoredSummary(parsed);
        }

        let eventsObjectUrl: string | null = null;
        try {
          eventsObjectUrl = await storageEngine.getScreenRecordingEvents(
            storedRecordingIdentifier,
            storedParticipantId,
          );
          if (eventsObjectUrl && !cancelled) {
            const evBlob = await (await fetch(eventsObjectUrl)).blob();
            const evText = await evBlob.text();
            setStoredTimelineEvents(parseTimelineEventsJson(evText));
          } else if (!cancelled) {
            setStoredTimelineEvents([]);
          }
        } finally {
          if (eventsObjectUrl) {
            URL.revokeObjectURL(eventsObjectUrl);
          }
        }

        let tagsObjectUrl: string | null = null;
        try {
          tagsObjectUrl = await storageEngine.getScreenRecordingTags(
            storedRecordingIdentifier,
            storedParticipantId,
          );
          if (tagsObjectUrl && !cancelled) {
            const tagBlob = await (await fetch(tagsObjectUrl)).blob();
            const tagText = await tagBlob.text();
            setStoredTags(parseRecordingTagsJson(tagText));
          } else if (!cancelled) {
            setStoredTags([]);
          }
        } finally {
          if (tagsObjectUrl) {
            URL.revokeObjectURL(tagsObjectUrl);
          }
        }

        let ocrObjectUrl: string | null = null;
        try {
          ocrObjectUrl = await storageEngine.getScreenRecordingOcrFrames(
            storedRecordingIdentifier,
            storedParticipantId,
          );
          if (ocrObjectUrl && !cancelled) {
            const ocrBlob = await (await fetch(ocrObjectUrl)).blob();
            const ocrText = await ocrBlob.text();
            const parsed = JSON.parse(ocrText || '{}') as { frames?: unknown };
            const frames = Array.isArray((parsed as { frames?: unknown }).frames) ? (parsed as { frames: unknown[] }).frames : [];
            setStoredOcrFrames(
              frames
                .map((f) => {
                  const obj = f as Record<string, unknown>;
                  return {
                    index: Number(obj.index || 0),
                    timestampSec: Number(obj.timestampSec || 0),
                    text: typeof obj.text === 'string' ? obj.text : '',
                    wordCount: Number(obj.wordCount || 0),
                  };
                })
                .filter((f) => Number.isFinite(f.timestampSec)),
            );
          } else if (!cancelled) {
            setStoredOcrFrames([]);
          }
        } catch {
          if (!cancelled) setStoredOcrFrames([]);
        } finally {
          if (ocrObjectUrl) {
            URL.revokeObjectURL(ocrObjectUrl);
          }
        }

        let confusionObjectUrl: string | null = null;
        try {
          confusionObjectUrl = await storageEngine.getScreenRecordingConfusionScore(
            storedRecordingIdentifier,
            storedParticipantId,
          );
          if (confusionObjectUrl && !cancelled) {
            const cBlob = await (await fetch(confusionObjectUrl)).blob();
            const cText = await cBlob.text();
            const parsedConfusion = parseStoredConfusionScoreJson(cText);
            setStoredConfusionScore(parsedConfusion);
          } else if (!cancelled) {
            setStoredConfusionScore(null);
          }
        } catch {
          if (!cancelled) setStoredConfusionScore(null);
        } finally {
          if (confusionObjectUrl) {
            URL.revokeObjectURL(confusionObjectUrl);
          }
        }
      } catch (e) {
        if (cancelled) return;
        setStoredError(e instanceof Error ? e.message : 'Failed to load stored summary');
      } finally {
        if (!cancelled) {
          setStoredIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [storageEngine, storedParticipantId, storedRecordingIdentifier]);

  const handleAnalyze = async () => {
    if (!videoFile) return;
    setError(null);
    setSummary('');
    setIsAnalyzing(true);

    try {
      const result = await analyzeVideo(videoFile);
      if (!result.summary) {
        const raw = result.raw as { error?: unknown; status?: unknown; json?: { error?: { message?: string } } } | undefined;
        const apiMsg = raw?.json && typeof raw.json === 'object' && raw.json !== null && 'error' in raw.json
          ? (raw.json as { error?: { message?: string } }).error?.message
          : undefined;
        const rawErr = raw?.error;
        const status = raw?.status;
        const message = apiMsg
          || (rawErr ? String(rawErr) : status
            ? `Gemini request failed with status ${status}`
            : 'Gemini returned no summary.');
        setError(message);
        return;
      }

      setSummary(result.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to analyze video');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleGenerateTimeline = async () => {
    if (!storageEngine || !storedParticipantId || !storedRecordingIdentifier) return;
    setTimelineError(null);
    setTimelineLoading(true);
    try {
      const rawVideoUrl = await storageEngine.getScreenRecordingUrl(storedRecordingIdentifier, storedParticipantId);
      const fetchableVideoUrl = massApiFetchableMediaUrl(rawVideoUrl);
      if (!fetchableVideoUrl) {
        setTimelineError(rawVideoUrl ? MASS_API_FETCHABLE_URL_HELP : 'No screen recording found for this selection.');
        return;
      }

      const companion = await companionMassApiAudioQuery(storageEngine, storedRecordingIdentifier, storedParticipantId);
      const qs: Record<string, string> = {
        videoUrl: fetchableVideoUrl,
        mimeType: 'video/webm',
      };
      if (confusionWords?.length) {
        qs.confusionWords = confusionWords.join(',');
      }
      if (companion.companionAudioUrl) {
        qs.companionAudioUrl = companion.companionAudioUrl;
        qs.companionMimeType = companion.companionMimeType || 'audio/webm';
      }

      const res = await fetch(buildMassApiUrl(timelineApiUrl, qs), { method: 'GET' });
      const json = (await res.json().catch(() => ({}))) as {
        events?: TimelineEvent[];
        error?: string;
        meta?: Record<string, unknown>;
      };
      if (!res.ok) {
        setTimelineError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
        return;
      }
      const normalized = parseTimelineEventsJson(JSON.stringify({ events: json.events }));
      setStoredTimelineEvents(normalized);
      if (normalized.length === 0) {
        const m = (json.meta || {}) as Record<string, unknown>;
        const usedCompanionMic = m.whisper_source === 'companion_audio';
        const audioSkipped = Boolean(m.audio_skipped);
        const noMuxedAndNoCompanionPath = audioSkipped && !usedCompanionMic;
        setTimelineError(
          noMuxedAndNoCompanionPath
            ? 'Timeline generated, but 0 events were detected (screen WebM has no muxed audio). Study microphone audio is sent automatically when present at audio/{participant}_{task} (same task id as this recording).'
            : 'Timeline generated, but 0 events were detected for this recording.',
        );
      }

      const payload = JSON.stringify(
        { events: normalized, generatedAt: new Date().toISOString() },
        null,
        2,
      );
      await storageEngine.saveScreenRecordingEvents(
        new Blob([payload], { type: 'application/json' }),
        storedRecordingIdentifier,
        storedParticipantId,
      );
    } catch (e) {
      setTimelineError(e instanceof Error ? e.message : 'Timeline generation failed');
    } finally {
      setTimelineLoading(false);
    }
  };

  const handleExtractOcr = async () => {
    if (!storageEngine || !storedParticipantId || !storedRecordingIdentifier) return;
    setOcrError(null);
    setOcrLoading(true);
    try {
      const rawVideoUrl = await storageEngine.getScreenRecordingUrl(storedRecordingIdentifier, storedParticipantId);
      const fetchableVideoUrl = massApiFetchableMediaUrl(rawVideoUrl);
      if (!fetchableVideoUrl) {
        setOcrError(rawVideoUrl ? MASS_API_FETCHABLE_URL_HELP : 'No screen recording found for this selection.');
        return;
      }

      const res = await fetch(buildMassApiUrl(ocrApiUrl, { videoUrl: fetchableVideoUrl, mimeType: 'video/webm' }), { method: 'GET' });
      const json = (await res.json().catch(() => ({}))) as { frames?: unknown; error?: string };
      if (!res.ok) {
        setOcrError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
        return;
      }

      const frames = Array.isArray(json.frames) ? json.frames : [];
      const normalized = frames
        .map((f) => {
          const obj = f as Record<string, unknown>;
          return {
            index: Number(obj.index || 0),
            timestampSec: Number(obj.timestampSec || 0),
            text: typeof obj.text === 'string' ? obj.text : '',
            wordCount: Number(obj.wordCount || 0),
          };
        })
        .filter((f) => Number.isFinite(f.timestampSec));

      setStoredOcrFrames(normalized);
      const payload = JSON.stringify({ frames: normalized, generatedAt: new Date().toISOString() }, null, 2);
      await storageEngine.saveScreenRecordingOcrFrames(
        new Blob([payload], { type: 'application/json' }),
        storedRecordingIdentifier,
        storedParticipantId,
      );
    } catch (e) {
      setOcrError(e instanceof Error ? e.message : 'OCR extraction failed');
    } finally {
      setOcrLoading(false);
    }
  };

  const handleComputeConfusionScore = async () => {
    if (!storageEngine || !storedParticipantId || !storedRecordingIdentifier) return;
    setConfusionScoreError(null);
    setConfusionScoreLoading(true);
    try {
      const rawVideoUrl = await storageEngine.getScreenRecordingUrl(storedRecordingIdentifier, storedParticipantId);
      const fetchableVideoUrl = massApiFetchableMediaUrl(rawVideoUrl);
      if (!fetchableVideoUrl) {
        setConfusionScoreError(rawVideoUrl ? MASS_API_FETCHABLE_URL_HELP : 'No screen recording found for this selection.');
        return;
      }

      const companion = await companionMassApiAudioQuery(storageEngine, storedRecordingIdentifier, storedParticipantId);
      const qs: Record<string, string> = {
        videoUrl: fetchableVideoUrl,
        mimeType: 'video/webm',
      };
      if (confusionWords?.length) {
        qs.confusionWords = confusionWords.join(',');
      }
      if (companion.companionAudioUrl) {
        qs.companionAudioUrl = companion.companionAudioUrl;
        qs.companionMimeType = companion.companionMimeType || 'audio/webm';
      }

      const res = await fetch(buildMassApiUrl(confusionScoreApiUrl, qs), { method: 'GET' });
      const json = (await res.json().catch(() => ({}))) as {
        windows?: unknown;
        totalScore?: unknown;
        maxWindow?: unknown;
        meta?: unknown;
        error?: string;
      };
      if (!res.ok) {
        setConfusionScoreError(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`);
        return;
      }

      const parsed = parseStoredConfusionScoreJson(
        JSON.stringify({
          windows: json.windows,
          totalScore: json.totalScore,
          maxWindow: json.maxWindow,
          meta: json.meta,
        }),
      );
      if (!parsed || parsed.windows.length === 0) {
        setConfusionScoreError('Confusion score returned no windows (is the recording very short or missing timeline signals?).');
        return;
      }

      const payload = JSON.stringify(
        {
          ...parsed,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      await storageEngine.saveScreenRecordingConfusionScore(
        new Blob([payload], { type: 'application/json' }),
        storedRecordingIdentifier,
        storedParticipantId,
      );
      setStoredConfusionScore({
        ...parsed,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setConfusionScoreError(e instanceof Error ? e.message : 'Confusion score computation failed');
    } finally {
      setConfusionScoreLoading(false);
    }
  };

  const handleParticipantAllTrialsMedia = async () => {
    if (!storageEngine || !storedParticipantId) return;
    const recs = recordingsByParticipantId.get(storedParticipantId) ?? [];
    if (recs.length === 0) return;

    setParticipantSessionView((prev) => {
      if (prev) prev.clips.forEach((c) => URL.revokeObjectURL(c.playUrl));
      return null;
    });
    setParticipantSessionError(null);
    setParticipantSessionLoading(true);
    const totalSteps = recs.length * 3;
    let stepDone = 0;
    setParticipantSessionProgress({ label: 'Starting', done: 0, total: totalSteps });

    const mergedEvents: TimelineEvent[] = [];
    const mergedOcr: Array<{ index: number; timestampSec: number; text: string; wordCount: number }> = [];
    const mergedWindows: ConfusionScoreWindow[] = [];
    const clips: ParticipantSessionClip[] = [];
    let offsetSec = 0;
    let ocrGlobalIndex = 0;
    let totalConfScore = 0;

    /* eslint-disable no-await-in-loop -- process clips sequentially to avoid overloading the mass API */
    try {
      for (const rec of recs) {
        const rawVid = await storageEngine.getScreenRecordingUrl(rec.identifier, storedParticipantId);
        const massVideoUrl = massApiFetchableMediaUrl(rawVid);
        if (!massVideoUrl) {
          throw new Error(rawVid ? MASS_API_FETCHABLE_URL_HELP : `No recording for ${rec.label}`);
        }

        const recordingUrl = await storageEngine.getScreenRecording(rec.identifier, storedParticipantId);
        if (!recordingUrl) {
          throw new Error(`No recording for ${rec.label}`);
        }
        const blob = await (await fetch(recordingUrl)).blob();
        URL.revokeObjectURL(recordingUrl);
        const playUrl = URL.createObjectURL(blob);
        const durationSec = await clipDurationFromPlayUrl(playUrl);

        setParticipantSessionProgress({ label: `Timeline · ${rec.label}`, done: stepDone, total: totalSteps });
        const batchCompanion = await companionMassApiAudioQuery(storageEngine, rec.identifier, storedParticipantId);
        const tQs: Record<string, string> = {
          videoUrl: massVideoUrl,
          mimeType: 'video/webm',
        };
        if (confusionWords?.length) {
          tQs.confusionWords = confusionWords.join(',');
        }
        if (batchCompanion.companionAudioUrl) {
          tQs.companionAudioUrl = batchCompanion.companionAudioUrl;
          tQs.companionMimeType = batchCompanion.companionMimeType || 'audio/webm';
        }
        const resT = await fetch(buildMassApiUrl(timelineApiUrl, tQs), { method: 'GET' });
        const jsonT = (await resT.json().catch(() => ({}))) as { events?: TimelineEvent[]; error?: string };
        if (!resT.ok) {
          throw new Error(typeof jsonT.error === 'string' ? jsonT.error : `Timeline HTTP ${resT.status} (${rec.label})`);
        }
        const evLocal = parseTimelineEventsJson(JSON.stringify({ events: jsonT.events }));
        for (let ei = 0; ei < evLocal.length; ei += 1) {
          const e = evLocal[ei];
          mergedEvents.push({
            type: e.type,
            timestamp: e.timestamp + offsetSec,
            evidence: e.evidence,
          });
        }
        await storageEngine.saveScreenRecordingEvents(
          new Blob([JSON.stringify({ events: evLocal, generatedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }),
          rec.identifier,
          storedParticipantId,
        );
        stepDone += 1;
        setParticipantSessionProgress({ label: `OCR · ${rec.label}`, done: stepDone, total: totalSteps });

        const resO = await fetch(
          buildMassApiUrl(ocrApiUrl, { videoUrl: massVideoUrl, mimeType: 'video/webm' }),
          { method: 'GET' },
        );
        const jsonO = (await resO.json().catch(() => ({}))) as { frames?: unknown[]; error?: string };
        if (!resO.ok) {
          throw new Error(typeof jsonO.error === 'string' ? jsonO.error : `OCR HTTP ${resO.status} (${rec.label})`);
        }
        const framesRaw = Array.isArray(jsonO.frames) ? jsonO.frames : [];
        const ocrLocal = framesRaw
          .map((f) => {
            const obj = f as Record<string, unknown>;
            return {
              index: Number(obj.index || 0),
              timestampSec: Number(obj.timestampSec || 0),
              text: typeof obj.text === 'string' ? obj.text : '',
              wordCount: Number(obj.wordCount || 0),
            };
          })
          .filter((f) => Number.isFinite(f.timestampSec));
        await storageEngine.saveScreenRecordingOcrFrames(
          new Blob([JSON.stringify({ frames: ocrLocal, generatedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }),
          rec.identifier,
          storedParticipantId,
        );
        for (let oi = 0; oi < ocrLocal.length; oi += 1) {
          const f = ocrLocal[oi];
          mergedOcr.push({
            index: ocrGlobalIndex,
            timestampSec: f.timestampSec + offsetSec,
            text: f.text,
            wordCount: f.wordCount,
          });
          ocrGlobalIndex += 1;
        }
        stepDone += 1;
        setParticipantSessionProgress({ label: `Confusion · ${rec.label}`, done: stepDone, total: totalSteps });

        const cQs: Record<string, string> = {
          videoUrl: massVideoUrl,
          mimeType: 'video/webm',
        };
        if (confusionWords?.length) {
          cQs.confusionWords = confusionWords.join(',');
        }
        if (batchCompanion.companionAudioUrl) {
          cQs.companionAudioUrl = batchCompanion.companionAudioUrl;
          cQs.companionMimeType = batchCompanion.companionMimeType || 'audio/webm';
        }
        const resC = await fetch(buildMassApiUrl(confusionScoreApiUrl, cQs), { method: 'GET' });
        const jsonC = (await resC.json().catch(() => ({}))) as {
          windows?: unknown;
          totalScore?: unknown;
          maxWindow?: unknown;
          meta?: unknown;
          error?: string;
        };
        if (!resC.ok) {
          throw new Error(typeof jsonC.error === 'string' ? jsonC.error : `Confusion HTTP ${resC.status} (${rec.label})`);
        }
        const parsed = parseStoredConfusionScoreJson(
          JSON.stringify({
            windows: jsonC.windows,
            totalScore: jsonC.totalScore,
            maxWindow: jsonC.maxWindow,
            meta: jsonC.meta,
          }),
        );
        if (!parsed || parsed.windows.length === 0) {
          throw new Error(`Confusion score returned no windows for ${rec.label}`);
        }
        totalConfScore += parsed.totalScore;
        for (let wi = 0; wi < parsed.windows.length; wi += 1) {
          const w = parsed.windows[wi];
          mergedWindows.push({
            startSec: w.startSec + offsetSec,
            endSec: w.endSec + offsetSec,
            score: w.score,
          });
        }
        await storageEngine.saveScreenRecordingConfusionScore(
          new Blob([JSON.stringify({ ...parsed, generatedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }),
          rec.identifier,
          storedParticipantId,
        );
        stepDone += 1;

        clips.push({
          identifier: rec.identifier,
          label: rec.label,
          offsetSec,
          durationSec,
          playUrl,
        });
        offsetSec += durationSec;
      }

      const maxWindow = mergedWindows.reduce<ConfusionScoreWindow | null>((best, w) => {
        if (!best || Math.abs(w.score) > Math.abs(best.score)) return w;
        return best;
      }, null);

      setParticipantSessionView({
        clips,
        totalSec: offsetSec,
        mergedEvents,
        mergedOcrFrames: mergedOcr,
        mergedConfusion: {
          windows: mergedWindows,
          totalScore: totalConfScore,
          maxWindow,
          generatedAt: new Date().toISOString(),
        },
      });
      setParticipantSessionProgress({ label: 'Done', done: totalSteps, total: totalSteps });
    } catch (e) {
      for (let ci = 0; ci < clips.length; ci += 1) {
        URL.revokeObjectURL(clips[ci].playUrl);
      }
      setParticipantSessionError(e instanceof Error ? e.message : 'Batch media pipeline failed');
    } finally {
      setParticipantSessionLoading(false);
    }
    /* eslint-enable no-await-in-loop */
  };

  const persistRecordingTags = useCallback(
    async (next: RecordingTag[]) => {
      if (!storageEngine || !storedParticipantId || !storedRecordingIdentifier) return;
      const payload = JSON.stringify(
        { tags: next, updatedAt: new Date().toISOString() },
        null,
        2,
      );
      await storageEngine.saveScreenRecordingTags(
        new Blob([payload], { type: 'application/json' }),
        storedRecordingIdentifier,
        storedParticipantId,
      );
      setStoredTags(next);
    },
    [storageEngine, storedParticipantId, storedRecordingIdentifier],
  );

  return (
    <Box pos="relative">
      <LoadingOverlay visible={isAnalyzing} overlayProps={{ blur: 2 }} />

      <Stack gap="md">
        <Title order={4}>Screen recording summarization</Title>

        <Card withBorder shadow="sm" padding="md">
          <Stack gap="sm">
            <Title order={5}>Existing summaries for saved recordings</Title>

            {visibleParticipants.length === 0 ? (
              <Alert color="yellow" variant="light">
                No participants are available to load stored screen recording summaries.
              </Alert>
            ) : (
              <>
                <Stack gap="sm">
                  <Select
                    label="Participant"
                    data={storedParticipantIds.map((id) => ({ value: id, label: id }))}
                    value={storedParticipantId}
                    onChange={(v) => setStoredParticipantId(v || null)}
                    disabled={!storageEngine || storedParticipantIds.length === 0}
                  />

                  {storedParticipantId && (
                    <Select
                      label="Screen recording"
                      data={(recordingsByParticipantId.get(storedParticipantId) ?? []).map((r) => ({
                        value: r.identifier,
                        label: r.label,
                      }))}
                      value={storedRecordingIdentifier}
                      onChange={(v) => setStoredRecordingIdentifier(v || null)}
                      disabled={!storageEngine}
                    />
                  )}
                </Stack>

                {storedParticipantId && (recordingsByParticipantId.get(storedParticipantId) ?? []).length > 0 && (
                  <Box mt="md">
                    <Text fw={600} size="sm">
                      All trials for this participant
                    </Text>
                    <Text size="xs" c="dimmed" mb="xs">
                      Run timeline, OCR, and confusion for every saved trial below, then review one continuous session
                      strip and stacked videos (trial order).
                    </Text>
                    <Group gap="xs" wrap="wrap">
                      <Button
                        variant="light"
                        loading={participantSessionLoading}
                        disabled={
                          !storageEngine
                          || participantSessionLoading
                          || waitForMassApiHealth
                          || (timelineServerBlocked || ocrServerBlocked || confusionServerBlocked)
                          || timelineLoading
                          || ocrLoading
                          || confusionScoreLoading
                        }
                        onClick={() => {
                          handleParticipantAllTrialsMedia().catch(() => undefined);
                        }}
                      >
                        Run timeline, OCR, and confusion for all trials
                      </Button>
                    </Group>
                    {participantSessionProgress && (
                      <Box mt="xs">
                        <Text size="xs" c="dimmed" mb={4}>
                          {participantSessionProgress.label}
                          {' '}
                          (
                          {participantSessionProgress.done}
                          /
                          {participantSessionProgress.total}
                          )
                        </Text>
                        <Progress
                          value={(participantSessionProgress.done / Math.max(1, participantSessionProgress.total)) * 100}
                        />
                      </Box>
                    )}
                    {participantSessionError && (
                      <Alert color="red" variant="light" mt="xs">
                        {participantSessionError}
                      </Alert>
                    )}
                  </Box>
                )}

                <Divider my="md" />

                <Box pos="relative">
                  <LoadingOverlay visible={storedIsLoading} overlayProps={{ blur: 2 }} />

                  {storedError && (
                    <Alert color="red" variant="light">
                      {storedError}
                    </Alert>
                  )}

                  {storedVideoUrl && (
                    <Box>
                      <video
                        ref={storedVideoRef}
                        src={storedVideoUrl}
                        controls
                        style={{ width: '100%', borderRadius: 8, background: 'black' }}
                        onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                        onLoadedData={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                        onDurationChange={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                      />
                      <RecordingTimelineStrip
                        events={storedTimelineEvents}
                        tags={storedTags}
                        durationSeconds={storedRecordingEffectiveDuration}
                        onSeek={(t) => {
                          const el = storedVideoRef.current;
                          if (el) {
                            el.currentTime = t;
                          }
                        }}
                        ocrFrames={ocrStripFrames.length > 0 ? ocrStripFrames : undefined}
                        eventGrounded={ocrEventGrounded}
                        ocrFrameGrounded={ocrFrameGrounded}
                      />
                      {storedConfusionScore && storedConfusionScore.windows.length > 0 && (
                        <Box mt="sm">
                          <Text size="sm" fw={600}>
                            Confusion score by window
                          </Text>
                          <Text size="xs" color="dimmed">
                            Total score
                            {' '}
                            {typeof storedConfusionScore.totalScore === 'number'
                              ? storedConfusionScore.totalScore.toFixed(2)
                              : String(storedConfusionScore.totalScore)}
                            {storedConfusionScore.generatedAt
                              ? ` · computed ${new Date(storedConfusionScore.generatedAt).toLocaleString()}`
                              : ''}
                          </Text>
                          <div
                            role="img"
                            aria-label="Confusion score bar chart by time window"
                            style={{
                              position: 'relative',
                              height: 72,
                              marginTop: 8,
                              paddingBottom: 2,
                              borderBottom: '1px solid var(--mantine-color-gray-3)',
                              background: 'rgba(0,0,0,0.03)',
                              borderRadius: 6,
                              overflow: 'hidden',
                            }}
                          >
                            {(() => {
                              const scores = storedConfusionScore.windows.map((w) => w.score);
                              const maxAbs = Math.max(0.01, ...scores.map((s) => Math.abs(s)));
                              const d = Math.max(0.01, storedRecordingEffectiveDuration || 0);
                              return storedConfusionScore.windows.map((w, i) => {
                                const hPct = (Math.abs(w.score) / maxAbs) * 100;
                                const neg = w.score < 0;
                                const leftPct = Math.min(100, Math.max(0, (w.startSec / d) * 100));
                                const widthPct = Math.min(100 - leftPct, Math.max(0.4, ((w.endSec - w.startSec) / d) * 100));
                                return (
                                  <button
                                    type="button"
                                    key={`${w.startSec}-${w.endSec}-${i}`}
                                    title={`${w.startSec.toFixed(1)}s–${w.endSec.toFixed(1)}s: score ${w.score}`}
                                    onClick={() => {
                                      const el = storedVideoRef.current;
                                      if (el) el.currentTime = w.startSec;
                                    }}
                                    style={{
                                      position: 'absolute',
                                      left: `${leftPct}%`,
                                      width: `${widthPct}%`,
                                      bottom: 0,
                                      height: `${hPct}%`,
                                      padding: 0,
                                      border: 'none',
                                      cursor: 'pointer',
                                      background: neg ? 'var(--mantine-color-blue-3)' : 'var(--mantine-color-red-4)',
                                      opacity: 0.75,
                                      borderRadius: 2,
                                    }}
                                  />
                                );
                              });
                            })()}
                          </div>
                          <Text size="xs" color="dimmed" mt={4}>
                            Each bar is one fusion window. Click a bar to seek. Red = positive confusion
                            signal; blue = net negative (e.g. active interaction).
                          </Text>
                        </Box>
                      )}
                      <RecordingTagsPanel
                        tags={storedTags}
                        onPersist={persistRecordingTags}
                        videoRef={storedVideoRef}
                        disabled={!storageEngine || storedIsLoading}
                      />
                      <GroupRow>
                        <Button
                          variant="light"
                          loading={timelineLoading}
                          disabled={
                            !storageEngine
                            || timelineLoading
                            || !storedVideoUrl
                            || waitForMassApiHealth
                            || timelineServerBlocked
                          }
                          onClick={handleGenerateTimeline}
                        >
                          Generate timeline
                        </Button>
                        <Button
                          variant="light"
                          loading={ocrLoading}
                          disabled={
                            !storageEngine
                            || ocrLoading
                            || !storedVideoUrl
                            || waitForMassApiHealth
                            || ocrServerBlocked
                          }
                          onClick={handleExtractOcr}
                        >
                          Extract OCR
                        </Button>
                        <Button
                          variant="light"
                          loading={confusionScoreLoading}
                          disabled={
                            !storageEngine
                            || confusionScoreLoading
                            || !storedVideoUrl
                            || waitForMassApiHealth
                            || confusionServerBlocked
                          }
                          onClick={handleComputeConfusionScore}
                        >
                          Compute confusion score
                        </Button>
                        <Text size="xs" color="dimmed" style={{ alignSelf: 'center' }}>
                          Whisper + scene detection (run
                          {' '}
                          <code>yarn serve:mass-api</code>
                          {' '}
                          on port 3001; dev uses the Vite proxy). Python:
                          {' '}
                          <code>yarn setup:mass-api-python</code>
                          {' '}
                          (timeline + embeddings).
                        </Text>
                      </GroupRow>
                      {massApiHealth.loaded && massApiBaseConfigured && massApiMediaMissingParts.length > 0 && (
                        <Text size="xs" c="dimmed" mt="xs">
                          Mass API host is missing
                          {' '}
                          {massApiMediaMissingParts.join(', ')}
                          . Install those on the server (e.g.
                          {' '}
                          <code>yarn setup:timeline-python</code>
                          ,
                          {' '}
                          <code>tesseract</code>
                          , or
                          {' '}
                          <code>server/Dockerfile</code>
                          ).
                        </Text>
                      )}
                      {timelineError && (
                        <Alert color="red" variant="light" mt="xs">
                          {timelineError}
                        </Alert>
                      )}
                      {ocrError && (
                        <Alert color="red" variant="light" mt="xs">
                          {ocrError}
                        </Alert>
                      )}
                      {confusionScoreError && (
                        <Alert color="red" variant="light" mt="xs">
                          {confusionScoreError}
                        </Alert>
                      )}
                      {storedOcrFrames.length > 0 && (
                        <Alert color="gray" variant="light" mt="xs">
                          Loaded OCR frames:
                          {' '}
                          <b>{storedOcrFrames.length}</b>
                          {' '}
                          (sample excerpt:
                          {' '}
                          {storedOcrFrames.find((f) => f.text.trim())?.text.slice(0, 80) || 'no text'}
                          )
                        </Alert>
                      )}
                    </Box>
                  )}

                  {participantSessionView && (
                    <Card withBorder shadow="sm" padding="md" mt="md">
                      <Stack gap="sm">
                        <Text fw={600}>Participant session (all trials)</Text>
                        <Text size="xs" c="dimmed">
                          Merged timeline length
                          {' '}
                          {participantSessionView.totalSec.toFixed(1)}
                          s. Seeking the strip loads the matching trial clip in the player above; scroll down for every
                          trial back-to-back.
                        </Text>
                        <video
                          ref={sessionMergedVideoRef}
                          controls
                          src={participantSessionView.clips[0]?.playUrl}
                          style={{ width: '100%', borderRadius: 8, background: 'black' }}
                        />
                        <RecordingTimelineStrip
                          events={participantSessionView.mergedEvents}
                          tags={[]}
                          durationSeconds={participantSessionView.totalSec}
                          onSeek={(t) => {
                            const el = sessionMergedVideoRef.current;
                            if (!el) return;
                            const hit = globalTimeToClipAndLocal(participantSessionView.clips, t);
                            if (!hit) return;
                            const clip = participantSessionView.clips[hit.clipIndex];
                            const applyTime = () => {
                              el.currentTime = hit.localT;
                            };
                            if (el.src !== clip.playUrl) {
                              el.src = clip.playUrl;
                              el.addEventListener('loadeddata', applyTime, { once: true });
                            } else {
                              applyTime();
                            }
                          }}
                          ocrFrames={sessionOcrStripFrames.length > 0 ? sessionOcrStripFrames : undefined}
                          eventGrounded={sessionOcrEventGrounded}
                          ocrFrameGrounded={sessionOcrFrameGrounded}
                        />
                        {participantSessionView.mergedConfusion.windows.length > 0 && (
                          <Box mt="sm">
                            <Text size="sm" fw={600}>
                              Session confusion (merged windows)
                            </Text>
                            <Text size="xs" c="dimmed">
                              Total score
                              {' '}
                              {typeof participantSessionView.mergedConfusion.totalScore === 'number'
                                ? participantSessionView.mergedConfusion.totalScore.toFixed(2)
                                : String(participantSessionView.mergedConfusion.totalScore)}
                            </Text>
                            <div
                              role="img"
                              aria-label="Session confusion score by time window"
                              style={{
                                display: 'flex',
                                alignItems: 'flex-end',
                                gap: 2,
                                height: 72,
                                marginTop: 8,
                                paddingBottom: 2,
                                borderBottom: '1px solid var(--mantine-color-gray-3)',
                              }}
                            >
                              {(() => {
                                const wins = participantSessionView.mergedConfusion.windows;
                                const scores = wins.map((w) => w.score);
                                const maxAbs = Math.max(0.01, ...scores.map((s) => Math.abs(s)));
                                return wins.map((w, i) => {
                                  const hPct = (Math.abs(w.score) / maxAbs) * 100;
                                  const neg = w.score < 0;
                                  return (
                                    <button
                                      type="button"
                                      key={`sess-${w.startSec}-${i}`}
                                      title={`${w.startSec.toFixed(0)}s–${w.endSec.toFixed(0)}s: score ${w.score}`}
                                      onClick={() => {
                                        const el = sessionMergedVideoRef.current;
                                        if (!el) return;
                                        const mid = (w.startSec + w.endSec) / 2;
                                        const hit = globalTimeToClipAndLocal(participantSessionView.clips, mid);
                                        if (!hit) return;
                                        const clip = participantSessionView.clips[hit.clipIndex];
                                        const applyTime = () => {
                                          el.currentTime = hit.localT;
                                        };
                                        if (el.src !== clip.playUrl) {
                                          el.src = clip.playUrl;
                                          el.addEventListener('loadeddata', applyTime, { once: true });
                                        } else {
                                          applyTime();
                                        }
                                      }}
                                      style={{
                                        flex: 1,
                                        minWidth: 2,
                                        height: `${hPct}%`,
                                        padding: 0,
                                        border: 'none',
                                        cursor: 'pointer',
                                        background: neg ? 'var(--mantine-color-blue-3)' : 'var(--mantine-color-red-4)',
                                        borderRadius: '3px 3px 0 0',
                                      }}
                                    />
                                  );
                                });
                              })()}
                            </div>
                          </Box>
                        )}
                        <Text size="sm" fw={500} mt="sm">
                          All trial videos (continuous scroll)
                        </Text>
                        {participantSessionView.clips.map((c) => (
                          <Box key={c.identifier}>
                            <Text size="xs" c="dimmed" mb={4}>
                              {c.label}
                              {' '}
                              (
                              {c.durationSec.toFixed(1)}
                              s)
                            </Text>
                            <video src={c.playUrl} controls style={{ width: '100%', borderRadius: 8, background: 'black' }} />
                          </Box>
                        ))}
                      </Stack>
                    </Card>
                  )}

                  <Box mt="sm">
                    {storedSummary ? (
                      <Card withBorder shadow="sm" padding="md">
                        <Stack gap="xs">
                          <Text fw={600}>Stored Gemini summary</Text>
                          <Text style={{ whiteSpace: 'pre-wrap' }}>{storedSummary}</Text>
                        </Stack>
                      </Card>
                    ) : (
                      <Alert color="blue" variant="light">
                        No stored summary found for the selected recording yet. Upload a clip above to generate a new one.
                      </Alert>
                    )}
                  </Box>
                </Box>
              </>
            )}
          </Stack>
        </Card>

        <Card withBorder shadow="sm" padding="md">
          <Stack gap="sm">
            <Text size="sm" color="dimmed">
              Upload a small screen recording for a one-off summary with browser Gemini only (≤20MB, requires
              {' '}
              <code>VITE_GEMINI_API_KEY</code>
              ). For GPT-4o, Ollama, or Files API routes, use Mass summarization on stored recordings with HTTPS URLs.
            </Text>

            {summarizationPipeline === 'gemini' && !apiKey && (
              <Alert title="Missing Gemini credentials" color="red" variant="light" icon={<Text>!</Text>}>
                Set
                {' '}
                <code>VITE_GEMINI_API_KEY</code>
                {' '}
                for one-off uploads here. For server-side Files API summaries on stored recordings, use Mass summarization (HTTPS URLs only).
              </Alert>
            )}

            {summarizationPipeline === 'gpt4o' && !openAiAvailable && (
              <Alert title="GPT-4o unavailable" color="orange" variant="light" icon={<Text>!</Text>}>
                The mass API server reports no OpenAI key. Set
                {' '}
                <code>OPENAI_API_KEY</code>
                {' '}
                or
                {' '}
                <code>VITE_OPENAI_API_KEY</code>
                {' '}
                in the server environment and restart the service.
              </Alert>
            )}

            <Stack gap="sm">
              <FileInput
                accept="video/*"
                disabled={isAnalyzing}
                placeholder="Choose a video file"
                onChange={(selected) => {
                  const s = selected as unknown;
                  let file: File | null = null;
                  if (s instanceof File) file = s;
                  else if (Array.isArray(s) && s[0] instanceof File) file = s[0];
                  else file = null;
                  setVideoFile(file);
                }}
              />

              {videoUrl && (
                <Box>
                  <video
                    src={videoUrl}
                    controls
                    style={{ width: '100%', borderRadius: 8, background: 'black' }}
                    onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                    onLoadedData={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                    onDurationChange={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                  />
                  <Text size="sm" color="dimmed" mt="xs">
                    {videoFile?.name}
                  </Text>
                </Box>
              )}

              {videoFile && !canInlineUpload && (
                <Alert color="orange" variant="light">
                  File is over 20MB — browser inline Gemini cannot run here. Use Mass summarization on stored recordings (GET
                  {' '}
                  <code>/api/analyze-large</code>
                  {' '}
                  with HTTPS
                  {' '}
                  <code>videoUrl</code>
                  ).
                </Alert>
              )}

              <GroupRow>
                <Button
                  onClick={handleAnalyze}
                  disabled={analyzeSingleClipDisabled}
                >
                  Analyze video
                </Button>
              </GroupRow>
            </Stack>
          </Stack>
        </Card>

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {summary && (
          <Card withBorder shadow="sm" padding="md">
            <Stack gap="xs">
              <Text fw={600}>Gemini analysis</Text>
              <Text style={{ whiteSpace: 'pre-wrap' }}>{summary}</Text>
            </Stack>
          </Card>
        )}

        <MassScreenRecordingSummarizationView
          visibleParticipants={visibleParticipants}
          summarizationPipeline={summarizationPipeline}
          openAiAvailable={openAiAvailable}
          massApiHealth={massApiHealth}
        />
      </Stack>
    </Box>
  );
}
