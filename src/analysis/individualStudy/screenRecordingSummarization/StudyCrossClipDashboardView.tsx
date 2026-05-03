import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  LoadingOverlay,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ParticipantData } from '../../../storage/types';
import { useStorageEngine } from '../../../storage/storageEngineHooks';
import {
  coOccurrences,
  densestTimeWindows,
  eventsByParticipant,
  eventsByTask,
} from './aggregations';
import { getMassApiBaseUrl } from './massApiBase';
import { buildMassApiUrl, utf8ToBase64Url } from './massApiQuery';
import { buildStudyReport } from './buildStudyReport';
import { rebuildStudyEventsIndex } from './rebuildStudyEventsIndex';
import { renderStudyReportMarkdown } from './renderStudyReportMarkdown';
import type { StudyEventsIndex, StudyIndexedEvent } from './studyEventsIndexTypes';

function clipKey(e: StudyIndexedEvent) {
  return `${e.participantId}::${e.taskId}`;
}

function maxCount(v: Record<string, Record<string, number>>) {
  let m = 0;
  for (const inner of Object.values(v)) {
    for (const c of Object.values(inner)) m = Math.max(m, c);
  }
  return m;
}

type RecordingListItem = { participantId: string; identifier: string; label: string };

function cosineSimilarity(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function firstTwoSentences(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  return `${parts[0]} ${parts[1]}`.trim();
}

export function StudyCrossClipDashboardView({
  visibleParticipants,
  studyId,
  onOpenClipInSummarizationTab,
}: {
  visibleParticipants: ParticipantData[];
  studyId: string;
  onOpenClipInSummarizationTab: (participantId: string, taskId: string) => void;
}) {
  const { storageEngine } = useStorageEngine();
  const [index, setIndex] = useState<StudyEventsIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticErr, setSemanticErr] = useState<string | null>(null);
  const [semanticHits, setSemanticHits] = useState<
    Array<{ participantId: string; identifier: string; similarity: number; preview: string }>
  >([]);
  const [semanticHasRun, setSemanticHasRun] = useState(false);

  const embedApiUrl = useMemo(() => {
    const base = getMassApiBaseUrl();
    if (base) return `${base}/api/embed-summary`;
    return '/api/embed-summary';
  }, []);

  const recordingItems = useMemo(() => {
    const items: RecordingListItem[] = [];
    for (const participant of visibleParticipants) {
      for (const a of Object.values(participant.answers)) {
        if (a.endTime > 0) {
          items.push({
            participantId: participant.participantId,
            identifier: `${a.componentName}_${a.trialOrder}`,
            label: `${participant.participantId} · ${a.componentName} (trial ${a.trialOrder})`,
          });
        }
      }
    }
    const seen = new Set<string>();
    return items.filter((i) => {
      const k = `${i.participantId}::${i.identifier}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [visibleParticipants]);

  const [preview, setPreview] = useState<{ participantId: string; taskId: string; seek: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const loadIndex = useCallback(async () => {
    if (!storageEngine) return;
    setLoading(true);
    setErr(null);
    try {
      const idx = await storageEngine.getStudyEventsIndex();
      setIndex(idx);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load events index');
    } finally {
      setLoading(false);
    }
  }, [storageEngine]);

  useEffect(() => {
    loadIndex().catch(() => undefined);
  }, [loadIndex]);

  const rebuild = useCallback(async () => {
    if (!storageEngine) return;
    setLoading(true);
    setErr(null);
    try {
      const idx = await rebuildStudyEventsIndex(storageEngine, visibleParticipants);
      await storageEngine.saveStudyEventsIndex(idx);
      setIndex(idx);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to rebuild index');
    } finally {
      setLoading(false);
    }
  }, [storageEngine, visibleParticipants]);

  const runSemanticSearch = useCallback(async () => {
    if (!storageEngine || !semanticQuery.trim()) return;
    setSemanticLoading(true);
    setSemanticErr(null);
    setSemanticHits([]);
    setSemanticHasRun(true);
    try {
      const qEmbedUrl = buildMassApiUrl(embedApiUrl, {
        textUtf8Base64: utf8ToBase64Url(semanticQuery.trim()),
      });
      const qRes = await fetch(qEmbedUrl, { method: 'GET' });
      const qJson = (await qRes.json().catch(() => ({}))) as { embedding?: number[]; error?: string };
      if (!qRes.ok || !Array.isArray(qJson.embedding)) {
        const detail = typeof qJson.error === 'string' ? qJson.error.trim() : '';
        if (qRes.status === 422) {
          setSemanticErr(
            detail
              || 'Embedding service returned HTTP 422 (often missing Python embed deps on the mass API). On the Render host, run yarn setup:embed-python (see repo docs) and redeploy.',
          );
          return;
        }
        setSemanticErr(detail || `Embedding failed (HTTP ${qRes.status})`);
        return;
      }
      const qEmb = qJson.embedding;

      const rows = await Promise.all(
        recordingItems.map(async (item) => {
          const embUrl = await storageEngine.getScreenRecordingEmbedding(item.identifier, item.participantId);
          if (!embUrl) return null;
          const embRes = await fetch(embUrl);
          const embBlob = await embRes.blob();
          URL.revokeObjectURL(embUrl);
          let parsed: { embedding?: number[] };
          try {
            parsed = JSON.parse(await embBlob.text()) as { embedding?: number[] };
          } catch {
            return null;
          }
          if (!Array.isArray(parsed.embedding)) return null;

          let summaryPreview = '';
          const summaryUrl = await storageEngine.getScreenRecordingSummary(item.identifier, item.participantId);
          if (summaryUrl) {
            const sBlob = await (await fetch(summaryUrl)).blob();
            URL.revokeObjectURL(summaryUrl);
            const sText = await sBlob.text();
            try {
              const o = JSON.parse(sText) as { summary?: string };
              summaryPreview = firstTwoSentences(typeof o.summary === 'string' ? o.summary : sText);
            } catch {
              summaryPreview = firstTwoSentences(sText);
            }
          }

          return {
            participantId: item.participantId,
            identifier: item.identifier,
            similarity: cosineSimilarity(qEmb, parsed.embedding),
            preview: summaryPreview || '(no saved summary)',
          };
        }),
      );
      const scored = rows.filter((r): r is NonNullable<(typeof rows)[number]> => r !== null);

      scored.sort((a, b) => b.similarity - a.similarity);
      setSemanticHits(scored.slice(0, 5));
    } catch (e) {
      setSemanticErr(e instanceof Error ? e.message : 'Semantic search failed');
    } finally {
      setSemanticLoading(false);
    }
  }, [storageEngine, semanticQuery, embedApiUrl, recordingItems]);

  const exportMarkdown = useCallback(async () => {
    if (!storageEngine) return;
    setLoading(true);
    setErr(null);
    try {
      const report = await buildStudyReport(storageEngine, visibleParticipants);
      const md = renderStudyReportMarkdown(report);
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `study_report_${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to export report');
    } finally {
      setLoading(false);
    }
  }, [storageEngine, visibleParticipants]);

  const events = useMemo(() => index?.events ?? [], [index]);
  const byTask = useMemo(() => eventsByTask(events), [events]);
  const byParticipant = useMemo(() => eventsByParticipant(events), [events]);
  const densest = useMemo(() => densestTimeWindows(events, 30, 10), [events]);
  const pairs = useMemo(() => coOccurrences(events, 2, 10), [events]);

  const tasks = useMemo(() => Object.keys(byTask).sort(), [byTask]);
  const participants = useMemo(() => Object.keys(byParticipant).sort(), [byParticipant]);

  const taskMax = maxCount(byTask) || 1;
  const participantMax = maxCount(byParticipant) || 1;

  // Build heatmap counts: participant x task -> total count
  const heat = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[clipKey(e)] = (counts[clipKey(e)] || 0) + 1;
    }
    return counts;
  }, [events]);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      if (!storageEngine || !preview) return;
      setPreviewUrl(null);
      const url = await storageEngine.getScreenRecording(preview.taskId, preview.participantId);
      if (cancelled) return;
      setPreviewUrl(url);
    }
    loadPreview().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [storageEngine, preview]);

  useEffect(() => {
    const el = previewVideoRef.current;
    if (!el || !preview) return undefined;
    const { seek } = preview;
    const handler = () => {
      try {
        el.currentTime = seek;
      } catch {
        // ignore
      }
    };
    el.addEventListener('loadedmetadata', handler);
    el.addEventListener('loadeddata', handler);
    return () => {
      el.removeEventListener('loadedmetadata', handler);
      el.removeEventListener('loadeddata', handler);
    };
  }, [preview]);

  return (
    <Box pos="relative">
      <LoadingOverlay visible={loading} overlayProps={{ blur: 2 }} />
      <Stack gap="md">
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={4}>Study analysis (cross-clip)</Title>
            <Text size="sm" c="dimmed">
              Aggregates auto timeline events and researcher tags across participants/tasks.
            </Text>
          </div>
          <Group>
            <Button
              variant="default"
              disabled={!storageEngine || loading}
              onClick={() => {
                loadIndex().catch(() => undefined);
              }}
            >
              Refresh
            </Button>
            <Button
              disabled={!storageEngine || loading}
              onClick={() => {
                rebuild().catch(() => undefined);
              }}
            >
              Rebuild index
            </Button>
            <Button
              variant="light"
              disabled={!storageEngine || loading}
              onClick={() => {
                exportMarkdown().catch(() => undefined);
              }}
            >
              Export Markdown report
            </Button>
          </Group>
        </Group>

        {err && (
          <Alert color="red" variant="light">
            {err}
          </Alert>
        )}

        <Card withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Text fw={700}>Semantic search (summary embeddings)</Text>
            <Text size="sm" c="dimmed">
              Requires
              {' '}
              <code>yarn serve:mass-api</code>
              {' '}
              with Python
              {' '}
              <code>sentence-transformers</code>
              {' '}
              (
              <code>pip install -r scripts/requirements-embed.txt</code>
              ). Clips need a saved summary and a background embedding (saved after mass summarization).
            </Text>
            <Group align="flex-end" wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                label="Query"
                placeholder="e.g. participant struggled with the filter"
                value={semanticQuery}
                onChange={(e) => setSemanticQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runSemanticSearch().catch(() => undefined);
                  }
                }}
                disabled={!storageEngine || semanticLoading}
              />
              <Button
                loading={semanticLoading}
                disabled={!storageEngine || !semanticQuery.trim()}
                onClick={() => runSemanticSearch().catch(() => undefined)}
              >
                Search
              </Button>
            </Group>
            {semanticErr && (
              <Alert color="red" variant="light">
                {semanticErr}
              </Alert>
            )}
            {semanticHasRun && !semanticLoading && !semanticErr && semanticHits.length === 0 && (
              <Text size="sm" c="dimmed">
                No embeddings matched (run mass summarization with persistence on, or install embed dependencies on the mass API host).
              </Text>
            )}
            {semanticHits.length > 0 && (
              <Stack gap="xs">
                {semanticHits.map((h) => (
                  <Paper key={`${h.participantId}::${h.identifier}`} withBorder p="sm" shadow="xs">
                    <Group justify="space-between" align="flex-start">
                      <Box style={{ flex: 1 }}>
                        <Text size="sm" fw={600}>
                          {h.participantId}
                          {' '}
                          ·
                          {' '}
                          {h.identifier}
                        </Text>
                        <Text size="xs" c="dimmed">
                          similarity
                          {' '}
                          {h.similarity.toFixed(3)}
                        </Text>
                        <Text size="sm" mt={6}>
                          {h.preview}
                        </Text>
                      </Box>
                      <Button
                        size="xs"
                        variant="light"
                        disabled={!studyId}
                        onClick={() => onOpenClipInSummarizationTab(h.participantId, h.identifier)}
                      >
                        Open clip
                      </Button>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            )}
          </Stack>
        </Card>

        {!index && (
          <Alert color="blue" variant="light">
            No study events index found yet. Click
            {' '}
            <strong>Rebuild index</strong>
            {' '}
            to generate it.
          </Alert>
        )}

        {index && (
          <Text size="xs" c="dimmed">
            Index last updated:
            {' '}
            {index.lastUpdatedAt}
            {' '}
            • Events:
            {' '}
            {events.length}
          </Text>
        )}

        {index && (
          <>
            <Card withBorder shadow="sm" padding="md">
              <Stack gap="xs">
                <Text fw={700}>Events per task (stacked)</Text>
                {tasks.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No events available.
                  </Text>
                ) : (
                  tasks.map((taskId) => {
                    const counts = byTask[taskId] || {};
                    const total = Object.values(counts).reduce((a, b) => a + b, 0);
                    const pct = Math.min(100, (total / taskMax) * 100);
                    return (
                      <Box key={taskId}>
                        <Group justify="space-between" gap="xs">
                          <Text size="sm">{taskId}</Text>
                          <Badge variant="light">{total}</Badge>
                        </Group>
                        <Box
                          mt={4}
                          style={{
                            height: 10,
                            background: 'rgba(0,0,0,0.08)',
                            borderRadius: 6,
                            overflow: 'hidden',
                          }}
                        >
                          <Box style={{ height: 10, width: `${pct}%`, background: '#228be6' }} />
                        </Box>
                      </Box>
                    );
                  })
                )}
              </Stack>
            </Card>

            <Card withBorder shadow="sm" padding="md">
              <Stack gap="xs">
                <Text fw={700}>Participant × task heatmap (event count)</Text>
                <Box style={{ overflowX: 'auto' }}>
                  <Table withColumnBorders withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Participant</Table.Th>
                        {tasks.map((t) => (
                          <Table.Th key={t}>{t}</Table.Th>
                        ))}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {participants.map((p) => (
                        <Table.Tr key={p}>
                          <Table.Td>{p}</Table.Td>
                          {tasks.map((t) => {
                            const c = heat[`${p}::${t}`] || 0;
                            const alpha = c === 0 ? 0 : Math.min(0.85, 0.15 + (c / participantMax) * 0.7);
                            return (
                              <Table.Td key={`${p}::${t}`}>
                                <Tooltip label={`${c} events`} withArrow>
                                  <button
                                    type="button"
                                    style={{
                                      width: '100%',
                                      height: 22,
                                      borderRadius: 6,
                                      border: '1px solid rgba(0,0,0,0.12)',
                                      background: `rgba(34, 139, 230, ${alpha})`,
                                      cursor: c > 0 ? 'pointer' : 'default',
                                    }}
                                    onClick={() => {
                                      if (c > 0) {
                                        setPreview({ participantId: p, taskId: t, seek: 0 });
                                      }
                                    }}
                                  />
                                </Tooltip>
                              </Table.Td>
                            );
                          })}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Box>
              </Stack>
            </Card>

            <Card withBorder shadow="sm" padding="md">
              <Stack gap="xs">
                <Text fw={700}>Densest moments (top 10 windows, 30s)</Text>
                {densest.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No dense windows found.
                  </Text>
                ) : (
                  densest.map((w, i) => (
                    <Group key={`${w.participantId}::${w.taskId}::${w.start}::${i}`} justify="space-between">
                      <Text size="sm">
                        {w.participantId}
                        {' '}
                        •
                        {' '}
                        {w.taskId}
                        {' '}
                        •
                        {' '}
                        {w.count}
                        {' '}
                        events @
                        {' '}
                        {w.start.toFixed(1)}
                        s
                      </Text>
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => setPreview({ participantId: w.participantId, taskId: w.taskId, seek: w.start })}
                      >
                        Preview
                      </Button>
                    </Group>
                  ))
                )}
              </Stack>
            </Card>

            <Card withBorder shadow="sm" padding="md">
              <Stack gap="xs">
                <Text fw={700}>Co-occurrence pairs (top 10, within 2s)</Text>
                {pairs.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    No co-occurrences found.
                  </Text>
                ) : (
                  pairs.map((p) => (
                    <Group key={`${p.a}::${p.b}`} justify="space-between">
                      <Text size="sm">
                        {p.a}
                        {' '}
                        +
                        {' '}
                        {p.b}
                      </Text>
                      <Badge variant="light">{p.count}</Badge>
                    </Group>
                  ))
                )}
              </Stack>
            </Card>

            <Card withBorder shadow="sm" padding="md">
              <Stack gap="xs">
                <Text fw={700}>Clip preview</Text>
                {!preview ? (
                  <Text size="sm" c="dimmed">
                    Click a heatmap cell or a densest window to preview a clip.
                  </Text>
                ) : previewUrl ? (
                  <Box>
                    <Text size="sm" c="dimmed">
                      {preview.participantId}
                      {' '}
                      •
                      {' '}
                      {preview.taskId}
                      {' '}
                      • seek
                      {' '}
                      {preview.seek.toFixed(1)}
                      s
                    </Text>
                    <video
                      ref={previewVideoRef}
                      src={previewUrl}
                      controls
                      style={{
                        width: '100%',
                        borderRadius: 8,
                        background: 'black',
                        marginTop: 6,
                      }}
                    />
                  </Box>
                ) : (
                  <Text size="sm" c="dimmed">
                    Loading clip…
                  </Text>
                )}
              </Stack>
            </Card>
          </>
        )}
      </Stack>
    </Box>
  );
}
