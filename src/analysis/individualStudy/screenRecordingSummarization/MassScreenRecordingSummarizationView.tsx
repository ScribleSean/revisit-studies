import {
  Alert,
  Card,
  LoadingOverlay,
  Stack,
  Text,
  Textarea,
  Checkbox,
  Button,
  Progress,
  Group,
  Modal,
  Select,
  TextInput,
} from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';

import { getMassApiBaseUrl } from './massApiBase';
import {
  buildMassApiUrl,
  massApiFetchableMediaUrl,
  MASS_API_FETCHABLE_URL_HELP,
  utf8ToBase64Url,
} from './massApiQuery';

import type { ParticipantData } from '../../../parser/types';
import { useStorageEngine } from '../../../storage/storageEngineHooks';
import type {
  ScreenRecordingPromptLibrary,
  ScreenRecordingSummarizationPipeline,
  StorageEngine,
} from '../../../storage/engines/types';
import type { MassApiHealthSnapshot } from './massApiHealthTypes';
import { INITIAL_MASS_API_HEALTH } from './massApiHealthTypes';

type GeminiAnalyzeResponse = {
  summary?: string;
  raw?: unknown;
};

type RecordingItem = {
  participantId: string;
  participantLabel: string;
  componentName: string;
  trialOrder: string;
  identifier: string; // storage task name: `${componentName}_${trialOrder}`
};

function extractGeminiText(json: unknown): string | null {
  type GeminiPart = { text?: string };
  type GeminiCandidate = { content?: { parts?: GeminiPart[] } };
  type GeminiRestResponse = { candidates?: GeminiCandidate[]; text?: string };

  const data = json as GeminiRestResponse;
  const first = Array.isArray(data.candidates) && data.candidates.length > 0 ? data.candidates[0] : null;
  const parts = first?.content?.parts;
  const textParts = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === 'string' ? p.text : null)).filter((t): t is string => t !== null)
    : [];
  if (textParts.length > 0) return textParts.join('');

  const fallbackText = typeof data.text === 'string' ? data.text : undefined;
  if (typeof fallbackText === 'string') return fallbackText;
  return null;
}

function canBeInlineSummarized(fileSizeBytes: number, maxBytes: number) {
  return fileSizeBytes <= maxBytes;
}

async function fetchBlobFromObjectUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch recording bytes (status ${res.status})`);
  }
  return res.blob();
}

const SUMMARY_PREVIEW_CHARS = 150;

function getDefaultPrompt() {
  return [
    'Provide a high-level summary of the screen recording in 3-5 sentences.',
    'Include key events and, when possible, reference moments using MM:SS timestamps (e.g., 01:15).',
    'If you detect the participant struggling or changing strategy, mention that explicitly.',
  ].join(' ');
}

async function persistSummaryEmbeddingBestEffort(params: {
  embedApiUrl: string;
  storageEngine: StorageEngine;
  summaryText: string;
  identifier: string;
  participantId: string;
}) {
  const text = params.summaryText.trim();
  if (!text) return;
  try {
    const embedUrl = buildMassApiUrl(params.embedApiUrl, {
      textUtf8Base64: utf8ToBase64Url(text),
    });
    const res = await fetch(embedUrl, { method: 'GET' });
    const json = (await res.json().catch(() => ({}))) as {
      embedding?: number[];
      model?: string;
      durationMs?: number;
    };
    if (!res.ok || !Array.isArray(json.embedding)) return;
    const payload = JSON.stringify(
      {
        embedding: json.embedding,
        model: json.model,
        embedDurationMs: json.durationMs,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    await params.storageEngine.saveScreenRecordingEmbedding(
      new Blob([payload], { type: 'application/json' }),
      params.identifier,
      params.participantId,
    );
  } catch {
    /* optional enrichment */
  }
}

export function MassScreenRecordingSummarizationView({
  visibleParticipants,
  summarizationPipeline = 'gemini',
  openAiAvailable = false,
  massApiHealth = INITIAL_MASS_API_HEALTH,
}: {
  visibleParticipants: ParticipantData[];
  summarizationPipeline?: ScreenRecordingSummarizationPipeline;
  openAiAvailable?: boolean;
  massApiHealth?: MassApiHealthSnapshot;
}) {
  const { storageEngine } = useStorageEngine();

  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const apiKey = env.VITE_GEMINI_API_KEY;
  const model = env.VITE_GEMINI_VIDEO_MODEL;
  const effectiveModel = model || 'models/gemini-2.0-flash';

  const [prompt, setPrompt] = useState<string>(getDefaultPrompt());
  const [skipIfExists, setSkipIfExists] = useState<boolean>(true);
  const [persistResults, setPersistResults] = useState<boolean>(true);

  const [promptLibrary, setPromptLibrary] = useState<ScreenRecordingPromptLibrary>({ prompts: [] });
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [promptLibraryLoading, setPromptLibraryLoading] = useState(false);
  const [promptLibraryError, setPromptLibraryError] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveNameDraft, setSaveNameDraft] = useState('');

  const maxInlineBytes = 20 * 1024 * 1024;

  const embedApiUrl = useMemo(() => {
    const base = getMassApiBaseUrl();
    if (base) return `${base}/api/embed-summary`;
    return '/api/embed-summary';
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!storageEngine) return () => { cancelled = true; };

    setPromptLibraryLoading(true);
    setPromptLibraryError(null);
    (async () => {
      try {
        const lib = await storageEngine.getScreenRecordingPrompts();
        if (!cancelled) {
          setPromptLibrary(lib);
        }
      } catch (e) {
        if (!cancelled) {
          setPromptLibraryError(e instanceof Error ? e.message : 'Failed to load prompt library');
        }
      } finally {
        if (!cancelled) {
          setPromptLibraryLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [storageEngine]);

  const recordings = useMemo(() => {
    const items: RecordingItem[] = [];
    for (const participant of visibleParticipants) {
      const answers = Object.values(participant.answers);
      for (const a of answers) {
        if (
          a.endTime > 0
        ) {
          items.push({
            participantId: participant.participantId,
            participantLabel: participant.participantId,
            componentName: a.componentName,
            trialOrder: a.trialOrder,
            identifier: `${a.componentName}_${a.trialOrder}`,
          });
        }
      }
    }

    // De-dupe identical clips across participants/answers.
    const seen = new Set<string>();
    return items.filter((i) => {
      const key = `${i.participantId}::${i.identifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [visibleParticipants]);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  const selectedCount = selectedKeys.size;

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, {
    summary?: string;
    status: 'ok' | 'skipped' | 'failed' | 'too_large';
    error?: string;
  }>>({});
  const [expandedSummaryKeys, setExpandedSummaryKeys] = useState<Record<string, boolean>>({});
  const [batchCompleteBanner, setBatchCompleteBanner] = useState<{
    saved: number;
    skipped: number;
    failed: number;
  } | null>(null);

  const geminiServerFallback = Boolean(massApiHealth.loaded && massApiHealth.hasGeminiServerKey);

  const participantIdsForBulk = useMemo(
    () => [...new Set(recordings.map((r) => r.participantId))].sort(),
    [recordings],
  );
  const [bulkParticipantId, setBulkParticipantId] = useState<string | null>(null);

  const geminiMassApiBase = useMemo(() => getMassApiBaseUrl(), []);
  const massApiAnalyzeUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-large`;
    return '/api/analyze-large';
  }, [geminiMassApiBase]);

  const massApiAnalyzeLocalUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-local`;
    return '/api/analyze-local';
  }, [geminiMassApiBase]);

  const massApiAnalyzeGpt4vUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-gpt4v`;
    return '/api/analyze-gpt4v';
  }, [geminiMassApiBase]);

  const selectionToggle = (key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedKeys(new Set(recordings.map((r) => `${r.participantId}::${r.identifier}`)));
  };

  const clearSelection = () => setSelectedKeys(new Set());

  const analyzeInline = async (file: File, massVideoUrl: string | null) => {
    if (summarizationPipeline === 'local') {
      if (!massVideoUrl) {
        return { summary: undefined, raw: { error: MASS_API_FETCHABLE_URL_HELP } } as GeminiAnalyzeResponse;
      }
      const url = buildMassApiUrl(massApiAnalyzeLocalUrl, {
        videoUrl: massVideoUrl,
        prompt,
        mimeType: file.type || 'video/webm',
      });
      const res = await fetch(url, { method: 'GET' });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { summary: undefined, raw: { status: res.status, json } } as GeminiAnalyzeResponse;
      }
      const summary = typeof json.summary === 'string' ? json.summary : undefined;
      return { summary, raw: json } as GeminiAnalyzeResponse;
    }
    if (summarizationPipeline === 'gpt4o') {
      if (!massVideoUrl) {
        return { summary: undefined, raw: { error: MASS_API_FETCHABLE_URL_HELP } } as GeminiAnalyzeResponse;
      }
      const url = buildMassApiUrl(massApiAnalyzeGpt4vUrl, {
        videoUrl: massVideoUrl,
        prompt,
        mimeType: file.type || 'video/webm',
      });
      const res = await fetch(url, { method: 'GET' });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return { summary: undefined, raw: { status: res.status, json } } as GeminiAnalyzeResponse;
      }
      const summary = typeof json.summary === 'string' ? json.summary : undefined;
      return { summary, raw: json } as GeminiAnalyzeResponse;
    }
    if (!apiKey) throw new Error('Missing VITE_GEMINI_API_KEY');

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read video file'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });

    const dataMatch = dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!dataMatch) {
      throw new Error('Invalid base64 data URL');
    }

    const mimeType = dataMatch[1];
    const base64Data = dataMatch[2];

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
      return { summary: undefined, raw: { status: res.status, json } } as GeminiAnalyzeResponse;
    }

    const text = extractGeminiText(json);
    return { summary: text ?? undefined, raw: json } as GeminiAnalyzeResponse;
  };

  type LargeAnalyzeOk = { summary: string; modelUsed: string; durationMs?: number };
  type LargeAnalyzeErr = { error: string; code?: string; durationMs?: number };

  const analyzeViaFilesApi = async (
    videoUrl: string,
    mimeType: string,
  ): Promise<LargeAnalyzeOk | LargeAnalyzeErr> => {
    const endpointUrl = summarizationPipeline === 'local'
      ? massApiAnalyzeLocalUrl
      : summarizationPipeline === 'gpt4o'
        ? massApiAnalyzeGpt4vUrl
        : massApiAnalyzeUrl;
    const params: Record<string, string> = {
      videoUrl,
      prompt,
      mimeType: mimeType || 'video/webm',
    };
    if (summarizationPipeline === 'gemini') {
      params.model = effectiveModel;
    }
    const reqUrl = buildMassApiUrl(endpointUrl, params);
    let res: Response;
    try {
      res = await fetch(reqUrl, { method: 'GET' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error';
      return {
        error: `${msg}. Start the local API with \`yarn serve:mass-api\` (same machine as \`yarn serve\`).`,
        code: 'NETWORK',
      };
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errMsg = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
      const code = typeof json.code === 'string' ? json.code : undefined;
      return { error: errMsg, code };
    }
    const summary = typeof json.summary === 'string' ? json.summary : '';
    if (!summary) {
      return { error: 'Empty summary from server', code: 'EMPTY_SUMMARY' };
    }
    const modelUsed = typeof json.modelUsed === 'string' ? json.modelUsed : effectiveModel;
    const durationMs = typeof json.durationMs === 'number' ? json.durationMs : undefined;
    return { summary, modelUsed, durationMs };
  };

  const analyzeSelected = async () => {
    if (!storageEngine) return;
    if (summarizationPipeline === 'gemini' && !apiKey && !geminiServerFallback) {
      setError('Missing Gemini client key and mass API reports no server Gemini key.');
      return;
    }
    if (summarizationPipeline === 'gpt4o' && !openAiAvailable) {
      setError('GPT-4o vision requires OPENAI_API_KEY on the mass-api server (.env for yarn serve:mass-api).');
      return;
    }
    if (selectedCount === 0) return;

    setIsRunning(true);
    setError(null);
    setBatchCompleteBanner(null);
    setProgress({ done: 0, total: selectedCount });

    const selectedItems = recordings.filter((r) => selectedKeys.has(`${r.participantId}::${r.identifier}`));

    setResults((prev) => {
      const next = { ...prev };
      selectedItems.forEach((i) => {
        delete next[`${i.participantId}::${i.identifier}`];
      });
      return next;
    });

    try {
      type RunOutcome = 'saved' | 'skipped' | 'failed';
      const processOne = async (item: RecordingItem): Promise<RunOutcome> => {
        const itemKey = `${item.participantId}::${item.identifier}`;

        try {
          if (skipIfExists) {
            const existingSummaryUrl = await storageEngine.getScreenRecordingSummary(item.identifier, item.participantId);
            if (existingSummaryUrl) {
              URL.revokeObjectURL(existingSummaryUrl);
              setResults((prev) => ({ ...prev, [itemKey]: { status: 'skipped' } }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return 'skipped';
            }
          }

          const massVideoUrl = massApiFetchableMediaUrl(
            await storageEngine.getScreenRecordingUrl(item.identifier, item.participantId),
          );

          const videoObjectUrl = await storageEngine.getScreenRecording(item.identifier, item.participantId);
          if (!videoObjectUrl) {
            setResults((prev) => ({
              ...prev,
              [itemKey]: {
                status: 'skipped',
                error: `ScreenRecording for task ${item.identifier} and participant ${item.participantId} not found`,
              },
            }));
            setProgress((p) => ({ ...p, done: p.done + 1 }));
            return 'skipped';
          }

          const blob = await fetchBlobFromObjectUrl(videoObjectUrl);
          URL.revokeObjectURL(videoObjectUrl);

          const file = new File([blob], `${item.identifier}.webm`, { type: blob.type || 'video/webm' });

          let summaryText: string | undefined;
          let persistedModel = effectiveModel;

          const forceServerGemini = summarizationPipeline === 'gemini' && !apiKey && geminiServerFallback;
          if (!canBeInlineSummarized(blob.size, maxInlineBytes) || forceServerGemini) {
            if (!massVideoUrl) {
              setResults((prev) => ({
                ...prev,
                [itemKey]: { status: 'failed', error: MASS_API_FETCHABLE_URL_HELP },
              }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return 'failed';
            }
            const large = await analyzeViaFilesApi(massVideoUrl, file.type || 'video/webm');
            if ('error' in large) {
              setResults((prev) => ({
                ...prev,
                [itemKey]: { status: 'failed', error: large.error },
              }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return 'failed';
            }
            summaryText = large.summary;
            persistedModel = large.modelUsed;
          } else {
            const result = await analyzeInline(file, massVideoUrl);
            if (result.summary) {
              summaryText = result.summary;
            } else if (summarizationPipeline === 'gemini') {
              if (!massVideoUrl) {
                setResults((prev) => ({
                  ...prev,
                  [itemKey]: { status: 'failed', error: MASS_API_FETCHABLE_URL_HELP },
                }));
                setProgress((p) => ({ ...p, done: p.done + 1 }));
                return 'failed';
              }
              const large = await analyzeViaFilesApi(massVideoUrl, file.type || 'video/webm');
              if ('error' in large) {
                const raw = result.raw as { status?: unknown; json?: { error?: { message?: string } | string } } | undefined;
                const status = raw?.status;
                const nested = raw?.json?.error;
                const apiMsg = nested && typeof nested === 'object' && nested !== null && 'message' in nested
                  ? String((nested as { message?: string }).message)
                  : typeof nested === 'string' ? nested : '';
                const inlineHint = apiMsg || (status ? `inline Gemini HTTP ${status}` : 'inline Gemini failed');
                setResults((prev) => ({
                  ...prev,
                  [itemKey]: {
                    status: 'failed',
                    error: `${large.error} (${inlineHint})`,
                  },
                }));
                setProgress((p) => ({ ...p, done: p.done + 1 }));
                return 'failed';
              }
              summaryText = large.summary;
              persistedModel = large.modelUsed;
            } else {
              const raw = result.raw as { status?: unknown; json?: unknown } | undefined;
              const status = raw?.status;
              const json = raw?.json as { error?: unknown; code?: unknown } | undefined;
              const errMsg = typeof json?.error === 'string'
                ? json.error
                : status
                  ? `Request failed (HTTP ${status})`
                  : 'No summary text returned for this clip';
              setResults((prev) => ({
                ...prev,
                [itemKey]: { status: 'failed', error: errMsg },
              }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return 'failed';
            }
          }

          if (!summaryText?.trim()) {
            setResults((prev) => ({
              ...prev,
              [itemKey]: { status: 'failed', error: 'Empty summary returned for this clip' },
            }));
            setProgress((p) => ({ ...p, done: p.done + 1 }));
            return 'failed';
          }

          setResults((prev) => ({
            ...prev,
            [itemKey]: { status: 'ok', summary: summaryText },
          }));

          if (persistResults && summaryText) {
            const summaryBlob = new Blob([JSON.stringify({
              summary: summaryText,
              prompt,
              model: persistedModel,
            }, null, 2)], { type: 'application/json' });
            await storageEngine.saveScreenRecordingSummary(summaryBlob, item.identifier, item.participantId);
            persistSummaryEmbeddingBestEffort({
              embedApiUrl,
              storageEngine,
              summaryText,
              identifier: item.identifier,
              participantId: item.participantId,
            }).catch(() => undefined);
          }

          setProgress((p) => ({ ...p, done: p.done + 1 }));
          return 'saved';
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Failed to summarize clip';
          setResults((prev) => ({ ...prev, [itemKey]: { status: 'failed', error: msg } }));
          setProgress((p) => ({ ...p, done: p.done + 1 }));
          return 'failed';
        }
      };

      let saved = 0;
      let skipped = 0;
      let failed = 0;

      await selectedItems.reduce(
        (prevPromise, item) => prevPromise.then(async () => {
          const o = await processOne(item);
          if (o === 'saved') saved += 1;
          else if (o === 'skipped') skipped += 1;
          else failed += 1;
        }),
        Promise.resolve(),
      );

      setBatchCompleteBanner({ saved, skipped, failed });
    } finally {
      setIsRunning(false);
    }
  };

  const persistPromptLibrary = async (next: ScreenRecordingPromptLibrary) => {
    if (!storageEngine) return;
    await storageEngine.saveScreenRecordingPrompts(next);
    setPromptLibrary(next);
  };

  return (
    <Card withBorder shadow="sm" padding="md">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Text fw={700}>Mass screen recording summarization</Text>
            <Text size="sm" color="dimmed">
              Select multiple stored clips across the study, edit the prompt, then summarize them in bulk. The mass API fetches each recording via HTTPS
              {' '}
              <code>videoUrl</code>
              {' '}
              (GET
              {' '}
              <code>/api/analyze-large</code>
              ,
              {' '}
              <code>/api/analyze-local</code>
              ,
              {' '}
              <code>/api/analyze-gpt4v</code>
              ).
            </Text>
          </div>
          <Group gap="xs" align="flex-end" wrap="wrap">
            <Button variant="default" onClick={selectAll} disabled={recordings.length === 0 || isRunning}>Select all</Button>
            <Button variant="default" onClick={clearSelection} disabled={isRunning}>Clear</Button>
            <Select
              placeholder="Participant (all trials)"
              data={participantIdsForBulk.map((id) => ({ value: id, label: id }))}
              value={bulkParticipantId}
              onChange={(v) => setBulkParticipantId(v)}
              clearable
              disabled={isRunning || participantIdsForBulk.length === 0}
              w={260}
            />
            <Button
              variant="light"
              disabled={!bulkParticipantId || isRunning}
              onClick={() => {
                if (!bulkParticipantId) return;
                setSelectedKeys((prev) => {
                  const next = new Set(prev);
                  recordings
                    .filter((r) => r.participantId === bulkParticipantId)
                    .forEach((r) => next.add(`${r.participantId}::${r.identifier}`));
                  return next;
                });
              }}
            >
              Add all clips for participant
            </Button>
            <Text size="xs" c="dimmed" style={{ flexBasis: '100%', maxWidth: 420 }}>
              Adds that participant’s clips to the current selection (does not clear other participants’ selections).
            </Text>
          </Group>
        </Group>

        {summarizationPipeline === 'gemini' && !apiKey && massApiHealth.loaded && !geminiServerFallback && (
          <Alert title="Missing Gemini credentials" color="red" variant="light">
            Set
            {' '}
            <code>VITE_GEMINI_API_KEY</code>
            {' '}
            for this build, or configure
            {' '}
            <code>GEMINI_API_KEY</code>
            {' '}
            on the mass API so all clip sizes can use
            {' '}
            <code>/api/analyze-large</code>
            .
          </Alert>
        )}

        {summarizationPipeline === 'gpt4o' && !openAiAvailable && (
          <Alert title="GPT-4o unavailable" color="orange" variant="light">
            The mass API reports no OpenAI key. Set
            {' '}
            <code>OPENAI_API_KEY</code>
            {' '}
            or
            {' '}
            <code>VITE_OPENAI_API_KEY</code>
            {' '}
            on the server and restart the service.
          </Alert>
        )}

        <Stack gap="xs">
          {promptLibraryError && (
            <Alert color="red" variant="light">
              Prompt library:
              {' '}
              {promptLibraryError}
            </Alert>
          )}

          <Group justify="space-between" align="flex-end">
            <Select
              label="Saved prompts"
              placeholder={promptLibraryLoading ? 'Loading…' : 'Select a prompt'}
              value={selectedPromptId}
              onChange={(v) => {
                setSelectedPromptId(v || null);
                const match = promptLibrary.prompts.find((p) => p.id === v);
                if (match) setPrompt(match.prompt);
              }}
              data={promptLibrary.prompts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => ({ value: p.id, label: p.name }))}
              disabled={isRunning || promptLibraryLoading || !storageEngine}
              style={{ flex: 1 }}
              searchable
              clearable
            />
            <Group gap="xs">
              <Button
                variant="light"
                disabled={!storageEngine || isRunning}
                onClick={() => {
                  setSaveNameDraft('');
                  setSaveModalOpen(true);
                }}
              >
                Save current
              </Button>
              <Button
                variant="default"
                color="red"
                disabled={!storageEngine || isRunning || !selectedPromptId}
                onClick={() => {
                  const next = {
                    prompts: promptLibrary.prompts.filter((p) => p.id !== selectedPromptId),
                  };
                  persistPromptLibrary(next).catch((e) => {
                    setPromptLibraryError(e instanceof Error ? e.message : 'Failed to delete prompt');
                  });
                  setSelectedPromptId(null);
                }}
              >
                Delete
              </Button>
            </Group>
          </Group>

          <Textarea
            minRows={3}
            autosize
            label="Prompt (applied to every selected recording)"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            disabled={isRunning}
          />

          <Group>
            <Checkbox
              label="Skip clips that already have a stored summary"
              checked={skipIfExists}
              onChange={(e) => setSkipIfExists(e.currentTarget.checked)}
              disabled={isRunning}
            />
            <Checkbox
              label="Persist new summaries back into the study"
              checked={persistResults}
              onChange={(e) => setPersistResults(e.currentTarget.checked)}
              disabled={isRunning}
            />
          </Group>
        </Stack>

        <Stack gap="sm">
          {batchCompleteBanner && (
            <Alert color="green" variant="light" title="Batch complete">
              <Text size="sm">
                Batch complete —
                {' '}
                {batchCompleteBanner.saved}
                {' '}
                summaries saved,
                {' '}
                {batchCompleteBanner.skipped}
                {' '}
                skipped,
                {' '}
                {batchCompleteBanner.failed}
                {' '}
                failed.
              </Text>
            </Alert>
          )}

          <Group justify="space-between">
            <Text size="sm" color="dimmed">
              Clips found:
              {' '}
              {recordings.length}
              .
              {' '}
              Selected:
              {' '}
              {selectedCount}
              .
            </Text>
            {selectedCount > 0 && (
              <Button
                onClick={analyzeSelected}
                loading={isRunning}
                disabled={
                  isRunning
                  || storageEngine === undefined
                  || (summarizationPipeline === 'gemini' && !apiKey && !geminiServerFallback)
                  || (summarizationPipeline === 'gpt4o' && !openAiAvailable)
                }
              >
                Analyze selected
                {' '}
                (
                {selectedCount}
                )
              </Button>
            )}
          </Group>

          <LoadingOverlay visible={isRunning} overlayProps={{ blur: 2 }} />

          <Stack gap="xs" style={{ maxHeight: 360, overflow: 'auto' }}>
            {recordings.length === 0 ? (
              <Alert color="yellow" variant="light">
                No screen-recorded clips were found for the selected participants.
              </Alert>
            ) : (
              recordings.map((r) => {
                const key = `${r.participantId}::${r.identifier}`;
                const isChecked = selectedKeys.has(key);
                const result = results[key];
                const summaryExpanded = Boolean(expandedSummaryKeys[key]);
                const summaryFull = result?.summary ?? '';
                const summaryNeedsTruncate = summaryFull.length > SUMMARY_PREVIEW_CHARS;

                return (
                  <Card
                    key={key}
                    withBorder
                    shadow="xs"
                    padding="sm"
                    bg={
                      result?.status === 'ok'
                        ? 'green.0'
                        : isChecked
                          ? 'gray.0'
                          : undefined
                    }
                  >
                    <Group justify="space-between">
                      <Checkbox
                        checked={isChecked}
                        onChange={(e) => selectionToggle(key, e.currentTarget.checked)}
                        disabled={isRunning}
                        label={`${r.componentName} (trial ${r.trialOrder})`}
                      />
                      <Text size="xs" color="dimmed">
                        {r.participantLabel}
                      </Text>
                    </Group>

                    {result?.status && (
                      <Stack gap={2} mt={4}>
                        <Text size="xs" fw={600} color={result.status === 'ok' ? 'green.9' : result.status === 'skipped' ? 'blue' : 'red'}>
                          {result.status === 'ok' ? 'Summarized' : result.status === 'skipped' ? 'Skipped' : result.status === 'too_large' ? `Too large (> ${maxInlineBytes / (1024 * 1024)}MB)` : 'Failed'}
                          {result.status === 'failed' && result.error ? `: ${result.error}` : ''}
                        </Text>
                        {result.status === 'skipped' && result.error && (
                          <Text size="xs" c="dimmed">{result.error}</Text>
                        )}
                      </Stack>
                    )}

                    {result?.summary && (
                      <Stack gap={6} mt="xs">
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {summaryNeedsTruncate && !summaryExpanded
                            ? `${summaryFull.slice(0, SUMMARY_PREVIEW_CHARS)}…`
                            : summaryFull}
                        </Text>
                        {summaryNeedsTruncate && (
                          <Button
                            variant="light"
                            color="green"
                            size="compact-xs"
                            onClick={() => setExpandedSummaryKeys((prev) => ({ ...prev, [key]: !prev[key] }))}
                          >
                            {summaryExpanded ? 'Show less' : 'Show more'}
                          </Button>
                        )}
                      </Stack>
                    )}
                  </Card>
                );
              })
            )}
          </Stack>
        </Stack>

        {isRunning && progress.total > 0 && (
          <>
            <Progress value={(progress.done / progress.total) * 100} />
            <Text size="sm" color="dimmed">
              {progress.done}
              {' '}
              /
              {' '}
              {progress.total}
              {' '}
              summarized
            </Text>
          </>
        )}

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Modal opened={saveModalOpen} onClose={() => setSaveModalOpen(false)} title="Save prompt">
          <Stack gap="md">
            <TextInput
              label="Name"
              placeholder="e.g. Strategy + friction summary"
              value={saveNameDraft}
              onChange={(e) => setSaveNameDraft(e.currentTarget.value)}
              data-autofocus
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setSaveModalOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={!saveNameDraft.trim() || !storageEngine}
                onClick={() => {
                  const name = saveNameDraft.trim();
                  const now = new Date().toISOString();
                  const existingByName = promptLibrary.prompts.find(
                    (p) => p.name.toLowerCase() === name.toLowerCase(),
                  );
                  const nextPrompts = existingByName
                    ? promptLibrary.prompts.map((p) => (p.id === existingByName.id
                      ? {
                        ...p,
                        prompt,
                        updatedAt: now,
                        name,
                      }
                      : p))
                    : [
                      ...promptLibrary.prompts,
                      {
                        id: crypto.randomUUID(),
                        name,
                        prompt,
                        updatedAt: now,
                      },
                    ];
                  persistPromptLibrary({ prompts: nextPrompts }).catch((e) => {
                    setPromptLibraryError(e instanceof Error ? e.message : 'Failed to save prompt');
                  });
                  setSaveModalOpen(false);
                }}
              >
                Save
              </Button>
            </Group>
          </Stack>
        </Modal>
      </Stack>
    </Card>
  );
}
