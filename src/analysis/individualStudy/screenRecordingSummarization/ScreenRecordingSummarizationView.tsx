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
import { useStudyConfig } from '../../../store/hooks/useStudyConfig';
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

function GroupRow({ children }: { children: ReactNode }) {
  return (
    <Box>
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        {children}
      </div>
    </Box>
  );
}

export function ScreenRecordingSummarizationView({ visibleParticipants }: { visibleParticipants: ParticipantData[] }) {
  const studyConfig = useStudyConfig();
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
  const [videoDuration, setVideoDuration] = useState(0);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
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

  const confusionWords = useMemo(() => {
    const raw = studyConfig?.screenRecordingAnalysis?.confusionWords;
    if (!Array.isArray(raw)) return null;
    const cleaned = raw.map((w) => (typeof w === 'string' ? w.trim() : '')).filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  }, [studyConfig]);

  const analyzeLargeApiUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-large`;
    return '/api/analyze-large';
  }, [geminiMassApiBase]);

  const effectiveModel = useMemo(
    () => model || 'models/gemini-2.0-flash',
    [model],
  );

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

  async function analyzeVideo(file: File): Promise<GeminiAnalyzeResponse> {
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
    if (effectiveModel) fd.append('model', effectiveModel);

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
    setVideoDuration(0);
    setTimelineError(null);

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
              Upload a single screen recording video and get a short Gemini summary below. This generates a new
              summary in the browser (it is not persisted to the study).
            </Text>

            {!apiKey && (
              <Alert title="Missing API key" color="red" variant="light" icon={<Text>!</Text>}>
                This tab needs
                <code>VITE_GEMINI_API_KEY</code>
                {' '}
                set in your environment (Vite client env).
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
                  <code>/api/analyze-large</code>
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
                  disabled={!videoFile || isAnalyzing || (canInlineUpload && !apiKey)}
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
                      />
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

        <MassScreenRecordingSummarizationView visibleParticipants={visibleParticipants} />
      </Stack>
    </Box>
  );
}
