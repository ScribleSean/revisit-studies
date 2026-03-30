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
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { ParticipantData } from '../../../storage/types';
import { useStorageEngine } from '../../../storage/storageEngineHooks';
import type { StudyConfig } from '../../../parser/types';
import { MassScreenRecordingSummarizationView } from './MassScreenRecordingSummarizationView';

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

export function ScreenRecordingSummarizationView({ visibleParticipants, studyConfig }: { visibleParticipants: ParticipantData[]; studyConfig?: StudyConfig }) {
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

  const envVars = import.meta.env as unknown as { VITE_GEMINI_API_KEY?: string; VITE_GEMINI_VIDEO_MODEL?: string };
  const apiKey = envVars.VITE_GEMINI_API_KEY;
  const model = envVars.VITE_GEMINI_VIDEO_MODEL;

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
          return;
        }

        const blob = await (await fetch(summaryObjectUrl)).blob();
        const text = await blob.text();
        const parsed = parsePossibleStoredSummary(text);
        setStoredSummary(parsed);
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
                  File is too large for inline upload (&gt; 20MB). Convert to a smaller clip or implement the Files API server-side.
                </Alert>
              )}

              <GroupRow>
                <Button onClick={handleAnalyze} disabled={!videoFile || !canInlineUpload || !apiKey || isAnalyzing}>
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
                    <video
                      src={storedVideoUrl}
                      controls
                      style={{ width: '100%', borderRadius: 8, background: 'black' }}
                    />
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

        <MassScreenRecordingSummarizationView visibleParticipants={visibleParticipants} studyConfig={studyConfig} />
      </Stack>
    </Box>
  );
}
