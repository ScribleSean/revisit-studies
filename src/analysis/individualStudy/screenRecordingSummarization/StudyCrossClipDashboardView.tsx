import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  LoadingOverlay,
  Stack,
  Table,
  Text,
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

export function StudyCrossClipDashboardView({
  visibleParticipants,
}: {
  visibleParticipants: ParticipantData[];
}) {
  const { storageEngine } = useStorageEngine();
  const [index, setIndex] = useState<StudyEventsIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
