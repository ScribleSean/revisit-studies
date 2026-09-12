import {
  Alert, Button, Group, Stack, Text, TextInput,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewClip } from '../../../storage/reviewArtifacts';
import { embedTexts } from './reviewApi';
import { rankClips, type EmbeddedClip } from './semanticSearch';

export function RecordingSearch({
  engine, clips, available, select, initialQuery = '', rememberQuery,
}: { engine: StorageEngine; clips: ReviewClip[]; available: boolean; select: (clip: ReviewClip) => void; initialQuery?: string; rememberQuery?: (query: string) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<ReturnType<typeof rankClips>>([]);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [engine]);

  const run = async (index: boolean) => {
    if (!index) rememberQuery?.(query);
    const controller = new AbortController();
    operation.current?.abort(); operation.current = controller;
    setBusy(true); setError(''); setResults([]);
    const stored: EmbeddedClip[] = [];
    const documents: { clip: ReviewClip; text: string; revision: string }[] = [];
    try {
      // Read one clip at a time; embed/save bounded batches to amortize model startup.
      for (const [position, clip] of clips.entries()) {
        if (controller.signal.aborted) return;
        setMessage(`${index ? 'Indexing' : 'Loading'} ${position + 1} of ${clips.length} recordings`);
        // eslint-disable-next-line no-await-in-loop
        const [analysis, existing] = await Promise.all([engine.getReviewAnalysis(clip), engine.getReviewArtifact('embedding', clip)]);
        if (analysis) {
          const { summary, events, ocr } = analysis.value;
          const text = [summary.text, ...events.map((event) => event.evidence), ...ocr.map((frame) => frame.text)].join('\n').slice(0, 8000);
          const embedding = existing?.value;
          if (text.trim() && index) documents.push({ clip, text, revision: analysis.revision });
          if (embedding?.analysisRevision === analysis.revision) stored.push({ ...clip, text: summary.text, embedding });
        }
      }
      if (controller.signal.aborted) return;
      if (index) {
        for (let offset = 0; offset < documents.length; offset += 32) {
          const batch = documents.slice(offset, offset + 32);
          // eslint-disable-next-line no-await-in-loop
          const embeddings = await embedTexts(batch.map((document) => document.text), controller.signal);
          if (controller.signal.aborted) return;
          // eslint-disable-next-line no-await-in-loop
          const writes = await Promise.allSettled(batch.map((document, position) => engine.saveReviewArtifact('embedding', { ...embeddings[position], analysisRevision: document.revision }, document.clip)));
          // A rejected upload must not release the controls while sibling writes remain active.
          if (controller.signal.aborted) return;
          const failed = writes.find((write) => write.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          setMessage(`Indexed ${Math.min(offset + 32, documents.length)} of ${documents.length} recordings`);
        }
        setMessage(`Indexed ${documents.length} recordings with saved analysis.`);
      } else {
        const [embedding] = await embedTexts([query], controller.signal);
        if (controller.signal.aborted) return;
        setResults(rankClips(embedding, stored));
        setMessage(`Searched ${stored.length} indexed recordings. Showing up to five matches.`);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (operation.current === controller) { setBusy(false); if (controller.signal.aborted) setMessage('Search operation cancelled. Saved embeddings are preserved.'); } }
  };
  return (
    <Stack>
      <Text fw={600}>Search recordings by meaning</Text>
      {error && <Alert color="red">{error}</Alert>}
      <Group align="end">
        <TextInput label="Search recording content" value={query} maxLength={8000} onChange={(event) => setQuery(event.currentTarget.value)} />
        <Button disabled={!available || busy || !query.trim()} onClick={() => run(false)}>Search recordings</Button>
        <Button variant="default" disabled={!available || busy} onClick={() => run(true)}>Index saved recordings</Button>
        {busy && <Button variant="default" onClick={() => operation.current?.abort()}>Cancel search operation</Button>}
      </Group>
      {!available && <Text c="dimmed">Local MiniLM embeddings are unavailable.</Text>}
      {message && <Text role="status">{message}</Text>}
      {results.map((result) => <Button key={JSON.stringify([result.participantId, result.taskId])} variant="light" styles={{ root: { height: 'auto', minHeight: 44 }, label: { whiteSpace: 'normal' } }} onClick={() => select(result)}>{`${result.participantId} · ${result.taskId} · similarity ${result.score.toFixed(3)} · ${result.text}`}</Button>)}
    </Stack>
  );
}
