import {
  Alert, Button, Group, NumberInput, Stack, Text, Title,
} from '@mantine/core';
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewClip } from '../../../storage/reviewArtifacts';
import type { StudyIndexedEvent } from './studyEventsIndexTypes';
import { buildEventsIndex } from './buildEventsIndex';
import {
  coOccurrences, densestTimeWindows, eventsByParticipantTask, eventsByTask,
} from './aggregations';
import { EventCountMatrix } from './EventCountMatrix';
import type { RecordingTarget } from './recordingNavigation';

export function CrossRecordingDashboard({
  engine, clips, revision, select,
}: { engine: StorageEngine; clips: ReviewClip[]; revision: number; select: (clip: RecordingTarget) => void }) {
  const [events, setEvents] = useState<StudyIndexedEvent[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [gap, setGap] = useState(2);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNotice, setRebuildNotice] = useState('');
  const rebuildingController = useRef<AbortController | null>(null);
  const reads = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => () => { rebuildingController.current?.abort(); rebuildingController.current = null; }, [engine]);
  const rebuild = async () => {
    if (rebuilding) return;
    const controller = new AbortController(); rebuildingController.current = controller;
    setRebuilding(true); setRebuildNotice('Rebuilding the saved index for the whole study…');
    try {
      const saved = await engine.rebuildReviewIndex(controller.signal);
      if (rebuildingController.current === controller) {
        setRebuildNotice(`Saved study index rebuilt: ${saved.value.length} events.`);
        setRefresh((value) => value + 1);
      }
    } catch (reason) {
      if (rebuildingController.current === controller) setRebuildNotice(controller.signal.aborted ? 'Index rebuild cancelled. The previous saved index is preserved.' : `Index rebuild failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (rebuildingController.current === controller) { setRebuilding(false); rebuildingController.current = null; }
    }
  };
  // Parent renders do not restart cloud reads unless the actual clip set changes.
  const identity = JSON.stringify(clips);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setEvents([]);
    // Storage adapters cannot abort admitted reads. Drain the previous refresh
    // before starting the next, and skip obsolete refreshes still in the queue.
    reads.current = reads.current.then(() => {
      controller.signal.throwIfAborted();
      return buildEventsIndex(engine, JSON.parse(identity), controller.signal);
    }).then((value) => {
      if (!controller.signal.aborted) setEvents(value);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [engine, identity, revision, refresh]);
  const counts = useMemo(() => eventsByTask(events), [events]);
  const windows = useMemo(() => densestTimeWindows(events), [events]);
  const pairs = useMemo(() => coOccurrences(events, gap), [events, gap]);
  const participantCounts = useMemo(() => eventsByParticipantTask(events), [events]);
  const recordingCount = useMemo(() => Object.values(participantCounts).reduce((total, tasks) => total + Object.keys(tasks).length, 0), [participantCounts]);
  return (
    <Stack component="section" aria-label="Cross-recording evidence" p="md" style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}>
      <Group justify="space-between">
        <Title order={4}>Cross-recording evidence</Title>
        <Button variant="default" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>Refresh event counts</Button>
      </Group>
      <Group>
        <Button variant="default" onClick={rebuild} disabled={rebuilding}>Rebuild saved study index</Button>
        {rebuilding && <Button variant="default" onClick={() => rebuildingController.current?.abort()}>Cancel index rebuild</Button>}
      </Group>
      <Text size="sm">Rebuild repairs the saved index from all participants and tasks in this study, regardless of the current filters.</Text>
      {rebuildNotice && <Text role="status" aria-label="Saved index rebuild status">{rebuildNotice}</Text>}
      <Text size="sm">Counts cover the listed recordings, including automatic events and manual tags. Counts are not duration-normalized rates.</Text>
      {loading && <Text role="status">Loading study events…</Text>}
      {error && <Alert color="red" title="Study events could not be loaded">{error}</Alert>}
      {!loading && !error && <Text role="status" aria-label="Event count status">{`${events.length} events across ${recordingCount} recordings with evidence.`}</Text>}
      {events.length > 0 && (
        <>
          <Title order={5}>Events by task</Title>
          <EventCountMatrix counts={counts} caption="Task and event type counts" rowLabel="Task" />
          <Title order={5}>Events by recording</Title>
          <EventCountMatrix counts={participantCounts} caption="Participant and task event counts" rowLabel="Participant" select={(participantId, taskId) => select({ participantId, taskId })} />
          <Title order={5}>Densest 30-second windows</Title>
          <Text size="sm">Up to ten windows, ranked by event count. Windows can overlap; the end is a search boundary, not the recording duration.</Text>
          {windows.map((window, index) => <Button variant="light" key={`${JSON.stringify([window.participantId, window.taskId, window.start])}:${index}`} onClick={() => select({ participantId: window.participantId, taskId: window.taskId, timestamp: window.start })}>{`${window.participantId} · ${window.taskId} · ${window.start.toFixed(1)}–${window.end.toFixed(1)}s: ${window.count} events`}</Button>)}
          <Title order={5}>Event co-occurrence</Title>
          <NumberInput label="Co-occurrence gap (seconds)" value={gap} min={0} max={120} onChange={(value) => { if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120) setGap(value); }} />
          <Text size="sm">Pairs of different event types within the gap on the same recording.</Text>
          {pairs.length ? pairs.map((pair) => <Text key={JSON.stringify([pair.a, pair.b])}>{`${pair.a.replaceAll('_', ' ')} + ${pair.b.replaceAll('_', ' ')}: ${pair.count}`}</Text>) : <Text>No matching event pairs.</Text>}
        </>
      )}
    </Stack>
  );
}
