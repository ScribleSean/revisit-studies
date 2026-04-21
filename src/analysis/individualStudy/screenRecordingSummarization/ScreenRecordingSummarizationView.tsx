import {
  Alert,
  Box,
  Button,
  Card,
  FileInput,
  LoadingOverlay,
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

function GroupRow({ children }: { children: ReactNode }) {
  return (
    <Box>
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        {children}
      </div>
    </Box>
  );
}
export function ScreenRecordingSummarizationView({
  visibleParticipants,
  studyConfig,
  summarizationPipeline = 'gemini',
  openAiAvailable = false,
  preferredStoredSelection = null,
  onPreferredStoredSelectionApplied,
}: {
  visibleParticipants: ParticipantData[];
  studyConfig?: StudyConfig;
  summarizationPipeline?: ScreenRecordingSummarizationPipeline;
  openAiAvailable?: boolean;
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

  const envVars = import.meta.env as unknown as {
    VITE_GEMINI_API_KEY?: string;
    VITE_GEMINI_VIDEO_MODEL?: string;
    VITE_GEMINI_MASS_API_URL?: string;
  };
  const apiKey = envVars.VITE_GEMINI_API_KEY;
  const model = envVars.VITE_GEMINI_VIDEO_MODEL;
  const geminiMassApiBase = envVars.VITE_GEMINI_MASS_API_URL;

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

  const analyzeLargeApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-large`;
    return '/api/analyze-large';
  }, [geminiMassApiBase]);

  const analyzeLocalApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-local`;
    return '/api/analyze-local';
  }, [geminiMassApiBase]);

  const analyzeGpt4vApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-gpt4v`;
    return '/api/analyze-gpt4v';
  }, [geminiMassApiBase]);

  const effectiveModel = useMemo(
    () => model || 'models/gemini-2.0-flash',
    [model],
  );

  const largeUploadEndpointLabel = useMemo(() => {
    if (summarizationPipeline === 'local') return '/api/analyze-local';
    if (summarizationPipeline === 'gpt4o') return '/api/analyze-gpt4v';
    return '/api/analyze-large';
  }, [summarizationPipeline]);

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

  const analyzeSingleClipDisabled = useMemo(() => {
    if (!videoFile || isAnalyzing) return true;
    if (summarizationPipeline === 'gemini' && canInlineUpload && !apiKey) return true;
    if (summarizationPipeline === 'gpt4o' && !openAiAvailable) return true;
    return false;
  }, [apiKey, canInlineUpload, isAnalyzing, openAiAvailable, summarizationPipeline, videoFile]);

  async function analyzeVideo(file: File): Promise<GeminiAnalyzeResponse> {
    if (summarizationPipeline === 'local') {
      const fd = new FormData();
      fd.append('video', file);
      fd.append('prompt', prompt);
      const res = await fetch(analyzeLocalApiUrl, { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
      if (!res.ok) {
        return { summary: undefined, raw: { status: res.status, json } };
      }
      return { summary: typeof json.summary === 'string' ? json.summary : undefined, raw: json };
    }
    if (summarizationPipeline === 'gpt4o') {
      const fd = new FormData();
      fd.append('video', file);
      fd.append('prompt', prompt);
      const res = await fetch(analyzeGpt4vApiUrl, { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
      if (!res.ok) {
        return { summary: undefined, raw: { status: res.status, json } };
      }
      return { summary: typeof json.summary === 'string' ? json.summary : undefined, raw: json };
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
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
              { text: prompt },
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

  async function analyzeVideoLarge(file: File): Promise<GeminiAnalyzeResponse> {
    const fd = new FormData();
    fd.append('video', file);
    fd.append('prompt', prompt);
    if (summarizationPipeline === 'gemini' && effectiveModel) fd.append('model', effectiveModel);

    if (summarizationPipeline === 'local') {
      const res = await fetch(analyzeLocalApiUrl, { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
      if (!res.ok) {
        return { summary: undefined, raw: { status: res.status, json } };
      }
      return { summary: typeof json.summary === 'string' ? json.summary : undefined, raw: json };
    }

    if (summarizationPipeline === 'gpt4o') {
      const res = await fetch(analyzeGpt4vApiUrl, { method: 'POST', body: fd });
      const json = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
      if (!res.ok) {
        return { summary: undefined, raw: { status: res.status, json } };
      }
      return { summary: typeof json.summary === 'string' ? json.summary : undefined, raw: json };
    }

    const res = await fetch(analyzeLargeApiUrl, { method: 'POST', body: fd });
    const json = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
    if (!res.ok) {
      return { summary: undefined, raw: { status: res.status, json } };
    }
    return { summary: typeof json.summary === 'string' ? json.summary : undefined, raw: json };
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
      const result = canInlineUpload
        ? await analyzeVideo(videoFile)
        : await analyzeVideoLarge(videoFile);
      if (!result.summary) {
        const raw = result.raw as { error?: unknown; status?: unknown } | undefined;
        const rawErr = raw?.error;
        const status = raw?.status;
        const message = rawErr
          ? String(rawErr)
          : status
            ? `Gemini request failed with status ${status}`
            : 'Gemini returned no summary.';
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
      const recordingUrl = await storageEngine.getScreenRecording(storedRecordingIdentifier, storedParticipantId);
      if (!recordingUrl) {
        setTimelineError('No screen recording found for this selection.');
        return;
      }
      const blob = await (await fetch(recordingUrl)).blob();
      URL.revokeObjectURL(recordingUrl);

      const file = new File([blob], `${storedRecordingIdentifier}.webm`, { type: blob.type || 'video/webm' });
      const fd = new FormData();
      fd.append('video', file);
      if (confusionWords) {
        fd.append('confusionWords', confusionWords.join(','));
      }

      const res = await fetch(timelineApiUrl, { method: 'POST', body: fd });
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
        const audioSkipped = Boolean(json.meta && (json.meta as Record<string, unknown>).audio_skipped);
        setTimelineError(
          audioSkipped
            ? 'Timeline generated, but 0 events were detected (this recording appears to have no audio track, so only scene changes can be detected).'
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
      const recordingUrl = await storageEngine.getScreenRecording(storedRecordingIdentifier, storedParticipantId);
      if (!recordingUrl) {
        setOcrError('No screen recording found for this selection.');
        return;
      }
      const blob = await (await fetch(recordingUrl)).blob();
      URL.revokeObjectURL(recordingUrl);

      const file = new File([blob], `${storedRecordingIdentifier}.webm`, { type: blob.type || 'video/webm' });
      const fd = new FormData();
      fd.append('video', file);

      const res = await fetch(ocrApiUrl, { method: 'POST', body: fd });
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
      const recordingUrl = await storageEngine.getScreenRecording(storedRecordingIdentifier, storedParticipantId);
      if (!recordingUrl) {
        setConfusionScoreError('No screen recording found for this selection.');
        return;
      }
      const blob = await (await fetch(recordingUrl)).blob();
      URL.revokeObjectURL(recordingUrl);

      const file = new File([blob], `${storedRecordingIdentifier}.webm`, { type: blob.type || 'video/webm' });
      const fd = new FormData();
      fd.append('video', file);
      if (confusionWords) {
        fd.append('confusionWords', confusionWords.join(','));
      }

      const res = await fetch(confusionScoreApiUrl, { method: 'POST', body: fd });
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
            <Text size="sm" color="dimmed">
              Upload a single screen recording and get a short summary below (pipeline is chosen in the header:
              Gemini, GPT-4o vision, or local Ollama). This one-off run is not persisted to the study.
            </Text>

            {summarizationPipeline === 'gemini' && !apiKey && (
              <Alert title="Missing API key" color="red" variant="light" icon={<Text>!</Text>}>
                Gemini inline mode needs
                <code>VITE_GEMINI_API_KEY</code>
                {' '}
                set in your environment (Vite client env).
              </Alert>
            )}

            {summarizationPipeline === 'gpt4o' && !openAiAvailable && (
              <Alert title="GPT-4o unavailable" color="orange" variant="light" icon={<Text>!</Text>}>
                The mass API server reports no
                {' '}
                <code>OPENAI_API_KEY</code>
                . Add it to
                {' '}
                <code>.env</code>
                {' '}
                for
                {' '}
                <code>yarn serve:mass-api</code>
                , then refresh this page.
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
                  <video src={videoUrl} controls style={{ width: '100%', borderRadius: 8, background: 'black' }} />
                  <Text size="sm" color="dimmed" mt="xs">
                    {videoFile?.name}
                  </Text>
                </Box>
              )}

              {videoFile && !canInlineUpload && (
                <Alert color="orange" variant="light">
                  File is too large for inline upload (&gt; 20MB). This tab will send the clip to
                  {' '}
                  <code>{largeUploadEndpointLabel}</code>
                  {' '}
                  (run
                  {' '}
                  <code>yarn serve:mass-api</code>
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
                      />
                      <RecordingTimelineStrip
                        events={storedTimelineEvents}
                        tags={storedTags}
                        durationSeconds={videoDuration}
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
                              const scores = storedConfusionScore.windows.map((w) => w.score);
                              const maxAbs = Math.max(0.01, ...scores.map((s) => Math.abs(s)));
                              return storedConfusionScore.windows.map((w, i) => {
                                const hPct = (Math.abs(w.score) / maxAbs) * 100;
                                const neg = w.score < 0;
                                return (
                                  <button
                                    type="button"
                                    key={`${w.startSec}-${i}`}
                                    title={`${w.startSec.toFixed(0)}s–${w.endSec.toFixed(0)}s: score ${w.score}`}
                                    onClick={() => {
                                      const el = storedVideoRef.current;
                                      if (el) el.currentTime = w.startSec;
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
                          <Text size="xs" color="dimmed" mt={4}>
                            Each bar is one fusion window (default 30s). Click a bar to seek. Red = positive confusion
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
                          disabled={!storageEngine || timelineLoading || !storedVideoUrl}
                          onClick={handleGenerateTimeline}
                        >
                          Generate timeline
                        </Button>
                        <Button
                          variant="light"
                          loading={ocrLoading}
                          disabled={!storageEngine || ocrLoading || !storedVideoUrl}
                          onClick={handleExtractOcr}
                        >
                          Extract OCR
                        </Button>
                        <Button
                          variant="light"
                          loading={confusionScoreLoading}
                          disabled={!storageEngine || confusionScoreLoading || !storedVideoUrl}
                          onClick={handleComputeConfusionScore}
                        >
                          Compute confusion score
                        </Button>
                        <Text size="xs" color="dimmed" style={{ alignSelf: 'center' }}>
                          Whisper + scene detection (run
                          {' '}
                          <code>yarn serve:mass-api</code>
                          ). Requires Python:
                          {' '}
                          <code>openai-whisper</code>
                          ,
                          {' '}
                          <code>scenedetect[opencv]</code>
                          .
                        </Text>
                      </GroupRow>
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
        />
      </Stack>
    </Box>
  );
}
