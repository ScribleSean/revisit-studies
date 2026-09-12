import {
  Button, Group, Progress, Stack, Text,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewArtifacts, ReviewClip } from '../../../storage/reviewArtifacts';
import { runReviewBatch, type ReviewJob } from './reviewJobs';

export function BatchRecordingReview({
  engine, clips, settings, available, embeddings, busy, setBusy, completed,
}: { engine: StorageEngine; clips: ReviewClip[]; settings: ReviewArtifacts['settings']; available: boolean; embeddings: boolean; busy: boolean; setBusy: (value: boolean) => void; completed: () => void }) {
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const start = async (targets: ReviewClip[]) => {
    const operation = new AbortController(); controller.current = operation;
    setBusy(true);
    try { await runReviewBatch(engine, targets, settings, operation.signal, embeddings, (rows) => { if (mounted.current) setJobs(rows); }); } finally {
      if (mounted.current) { setBusy(false); completed(); }
    }
  };
  const finished = jobs.filter((job) => job.state !== 'pending' && job.state !== 'analyzing').length;
  const failed = jobs.filter((job) => job.state === 'failed' || job.state === 'cancelled');
  return (
    <Stack>
      <Group>
        <Button disabled={busy || !available || !clips.length} onClick={() => start(clips)}>Analyze listed recordings</Button>
        {busy && controller.current && <Button variant="default" onClick={() => controller.current?.abort()}>Cancel batch</Button>}
        {!!failed.length && <Button variant="default" disabled={busy || !available} onClick={() => start(failed.map((job) => job.clip))}>Retry unfinished recordings</Button>}
      </Group>
      {!!jobs.length && (
      <>
        <Progress value={(finished / jobs.length) * 100} aria-label="Batch analysis progress" />
        <Text role="status">{`Batch: ${finished} of ${jobs.length} processed${busy ? '' : ' · finished'}`}</Text>
      </>
      )}
      {jobs.map((job) => <Text key={JSON.stringify(job.clip)} size="sm">{`${job.clip.participantId} · ${job.clip.taskId}: ${job.state}${job.indexing ? ` · indexing ${job.indexing}` : ''}${job.error ? ` · ${job.error}` : ''}`}</Text>)}
    </Stack>
  );
}
