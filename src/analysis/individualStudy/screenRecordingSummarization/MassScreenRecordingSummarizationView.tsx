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
} from '@mantine/core';
import { useMemo, useState } from 'react';

import type { ParticipantData } from '../../../parser/types';
import { useStorageEngine } from '../../../storage/storageEngineHooks';

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

function getDefaultPrompt() {
  return [
    'Provide a high-level summary of the screen recording in 3-5 sentences.',
    'Include key events and, when possible, reference moments using MM:SS timestamps (e.g., 01:15).',
    'If you detect the participant struggling or changing strategy, mention that explicitly.',
  ].join(' ');
}

export function MassScreenRecordingSummarizationView({
  visibleParticipants,
}: {
  visibleParticipants: ParticipantData[];
}) {
  const { storageEngine } = useStorageEngine();

  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const apiKey = env.VITE_GEMINI_API_KEY;
  const model = env.VITE_GEMINI_VIDEO_MODEL;
  const effectiveModel = model || 'models/gemini-2.0-flash';

  const [prompt, setPrompt] = useState<string>(getDefaultPrompt());
  const [skipIfExists, setSkipIfExists] = useState<boolean>(true);
  const [persistResults, setPersistResults] = useState<boolean>(true);

  const maxInlineBytes = 20 * 1024 * 1024;

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

  const geminiMassApiBase = env.VITE_GEMINI_MASS_API_URL;
  const massApiAnalyzeUrl = useMemo(() => {
    const base = (geminiMassApiBase || '').replace(/\/$/, '');
    if (base) return `${base}/api/analyze-large`;
    return '/api/analyze-large';
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

  const analyzeInline = async (file: File) => {
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
      return { summary: undefined, raw: { status: res.status, json } } as GeminiAnalyzeResponse;
    }

    const text = extractGeminiText(json);
    return { summary: text ?? undefined, raw: json } as GeminiAnalyzeResponse;
  };

  type LargeAnalyzeOk = { summary: string; modelUsed: string; durationMs?: number };
  type LargeAnalyzeErr = { error: string; code?: string; durationMs?: number };

  const analyzeViaFilesApi = async (file: File): Promise<LargeAnalyzeOk | LargeAnalyzeErr> => {
    const fd = new FormData();
    fd.append('video', file, file.name);
    fd.append('prompt', prompt);
    fd.append('model', effectiveModel);
    let res: Response;
    try {
      res = await fetch(massApiAnalyzeUrl, { method: 'POST', body: fd });
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
    if (!apiKey) {
      setError('Missing VITE_GEMINI_API_KEY');
      return;
    }
    if (selectedCount === 0) return;

    setIsRunning(true);
    setError(null);
    setProgress({ done: 0, total: selectedCount });

    const selectedItems = recordings.filter((r) => selectedKeys.has(`${r.participantId}::${r.identifier}`));

    // Clear only "failed/ok" results for this run; keep older ones so user can re-run with overwrite if desired later.
    setResults((prev) => {
      const entries = selectedItems.map((i) => [`${i.participantId}::${i.identifier}`, { status: 'ok' as const }]);
      return { ...prev, ...Object.fromEntries(entries) };
    });

    try {
      const processOne = async (item: RecordingItem) => {
        const itemKey = `${item.participantId}::${item.identifier}`;

        try {
          if (skipIfExists) {
            const existingSummaryUrl = await storageEngine.getScreenRecordingSummary(item.identifier, item.participantId);
            if (existingSummaryUrl) {
              URL.revokeObjectURL(existingSummaryUrl);
              setResults((prev) => ({ ...prev, [itemKey]: { status: 'skipped' } }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return;
            }
          }

          const videoObjectUrl = await storageEngine.getScreenRecording(item.identifier, item.participantId);
          if (!videoObjectUrl) {
            setResults((prev) => ({ ...prev, [itemKey]: { status: 'failed' } }));
            setProgress((p) => ({ ...p, done: p.done + 1 }));
            return;
          }

          const blob = await fetchBlobFromObjectUrl(videoObjectUrl);
          URL.revokeObjectURL(videoObjectUrl);

          const file = new File([blob], `${item.identifier}.webm`, { type: blob.type || 'video/webm' });

          let summaryText: string | undefined;
          let persistedModel = effectiveModel;

          if (!canBeInlineSummarized(blob.size, maxInlineBytes)) {
            const large = await analyzeViaFilesApi(file);
            if ('error' in large) {
              setResults((prev) => ({
                ...prev,
                [itemKey]: { status: 'failed', error: large.error },
              }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return;
            }
            summaryText = large.summary;
            persistedModel = large.modelUsed;
          } else {
            const result = await analyzeInline(file);
            if (!result.summary) {
              setResults((prev) => ({ ...prev, [itemKey]: { status: 'failed', error: 'No summary text from Gemini' } }));
              setProgress((p) => ({ ...p, done: p.done + 1 }));
              return;
            }
            summaryText = result.summary;
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
          }

          setProgress((p) => ({ ...p, done: p.done + 1 }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Failed to summarize clip';
          setResults((prev) => ({ ...prev, [itemKey]: { status: 'failed', error: msg } }));
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        }
      };

      // Sequential processing (avoids rate-limit spikes) without eslint "no-await-in-loop" violations.
      await selectedItems.reduce(
        (prevPromise, item) => prevPromise.then(() => processOne(item)),
        Promise.resolve(),
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Card withBorder shadow="sm" padding="md">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Text fw={700}>Mass screen recording summarization</Text>
            <Text size="sm" color="dimmed">
              Select multiple stored clips across the study, edit the prompt, then summarize them in bulk. Clips over 20MB use the Gemini Files API via
              {' '}
              <code>yarn serve:mass-api</code>
              {' '}
              (proxied as
              {' '}
              <code>/api/analyze-large</code>
              {' '}
              during
              {' '}
              <code>yarn serve</code>
              ).
            </Text>
          </div>
          <Group gap="xs">
            <Button variant="default" onClick={selectAll} disabled={recordings.length === 0 || isRunning}>Select all</Button>
            <Button variant="default" onClick={clearSelection} disabled={isRunning}>Clear</Button>
          </Group>
        </Group>

        {!apiKey && (
          <Alert title="Missing API key" color="red" variant="light">
            This needs
            <code>VITE_GEMINI_API_KEY</code>
            {' '}
            set in your environment (Vite client env).
          </Alert>
        )}

        <Stack gap="xs">
          <Textarea
            minRows={3}
            autosize
            label="Gemini prompt (applied to every selected recording)"
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
                disabled={!apiKey || isRunning || storageEngine === undefined}
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
                return (
                  <Card
                    key={key}
                    withBorder
                    shadow="xs"
                    padding="sm"
                    style={{ background: isChecked ? 'rgba(0, 0, 0, 0.02)' : undefined }}
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
                      <Text size="xs" mt={4} color={result.status === 'ok' ? 'green' : result.status === 'skipped' ? 'blue' : 'red'}>
                        {result.status === 'ok' ? 'Ready' : result.status === 'skipped' ? 'Skipped (already summarized)' : result.status === 'too_large' ? `Too large (> ${maxInlineBytes / (1024 * 1024)}MB)` : 'Failed'}
                        {result.status === 'failed' && result.error ? `: ${result.error}` : ''}
                      </Text>
                    )}

                    {result?.summary && (
                      <Text size="sm" mt="xs" style={{ whiteSpace: 'pre-wrap' }}>
                        {result.summary}
                      </Text>
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
      </Stack>
    </Card>
  );
}
