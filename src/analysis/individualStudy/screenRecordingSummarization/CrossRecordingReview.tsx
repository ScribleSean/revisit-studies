import { Stack, Title } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ParticipantData } from '../../../storage/types';
import { getReviewHealth } from './reviewApi';
import { RecordingSearch } from './RecordingSearch';
import { CrossRecordingDashboard } from './CrossRecordingDashboard';
import { RecordingReportExport } from './RecordingReportExport';
import type { RecordingTarget } from './recordingNavigation';

export function CrossRecordingReview({
  engine, participants, select, initialQuery, rememberQuery,
}: { engine: StorageEngine; participants: ParticipantData[]; select: (clip: RecordingTarget) => void; initialQuery: string; rememberQuery: (query: string) => void }) {
  const [embeddings, setEmbeddings] = useState(false);
  const clips = useMemo(() => participants.flatMap((participant) => Object.values(participant.answers).filter((answer) => answer.endTime > 0).map((answer) => ({ participantId: participant.participantId, taskId: answer.identifier }))), [participants]);
  useEffect(() => {
    const controller = new AbortController();
    getReviewHealth(controller.signal).then((health) => { if (!controller.signal.aborted) setEmbeddings(health.embeddings === true); }).catch(() => { if (!controller.signal.aborted) setEmbeddings(false); });
    return () => controller.abort();
  }, [engine]);
  return (
    <Stack p="md">
      <Title order={3}>Study analysis (cross-clip)</Title>
      <RecordingReportExport engine={engine} />
      <RecordingSearch engine={engine} clips={clips} available={embeddings} select={select} initialQuery={initialQuery} rememberQuery={rememberQuery} />
      <CrossRecordingDashboard engine={engine} clips={clips} revision={0} select={select} />
    </Stack>
  );
}
