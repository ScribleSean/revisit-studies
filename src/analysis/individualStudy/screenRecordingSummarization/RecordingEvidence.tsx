import {
  Button, Group, Pagination, Stack, Text, TextInput,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';
import type { ReviewArtifacts } from '../../../storage/reviewArtifacts';

const PAGE_SIZE = 50;

/** Bound mounted controls while retaining access to every saved evidence item. */
function EvidencePages<T>({ name, items, children }: { name: string; items: T[]; children: (items: T[]) => ReactNode }) {
  const [requestedPage, setPage] = useState(1);
  const total = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(requestedPage, total);
  const start = (page - 1) * PAGE_SIZE;
  return (
    <Stack gap="xs" component="section" aria-label={`${name} list`}>
      {items.length > PAGE_SIZE && (
        <>
          <Text size="sm" role="status">{`${name}: ${start + 1}–${Math.min(start + PAGE_SIZE, items.length)} of ${items.length}`}</Text>
          <Pagination total={total} value={page} onChange={setPage} withEdges aria-label={`${name} pages`} getControlProps={(control) => ({ 'aria-label': `${name} ${control} page` })} getItemProps={(item) => ({ 'aria-label': `${name} page ${item}` })} />
        </>
      )}
      {children(items.slice(start, start + PAGE_SIZE))}
    </Stack>
  );
}

export function RecordingEvidence({
  events, tags, ocr, confusion, seek, addTag, removeTag, busy,
}: {
  events: ReviewArtifacts['events']; tags: ReviewArtifacts['tags']; seek: (time: number) => void;
  ocr: ReviewArtifacts['ocr']; confusion: ReviewArtifacts['confusion'];
  addTag: (label: string) => Promise<boolean>; removeTag: (id: string) => Promise<boolean>; busy: boolean;
}) {
  const [label, setLabel] = useState('');
  const maximum = confusion.reduce((max, window) => Math.max(max, Math.abs(window.score)), 1);
  return (
    <Stack gap="sm">
      <Text fw={600}>Evidence timeline</Text>
      {events.length === 0 && <Text c="dimmed">No automatic events saved. You can still inspect the recording and add tags.</Text>}
      <EvidencePages name="Events" items={events}>
        {(visible) => visible.map((event, index) => (
          <Button key={`${event.type}:${event.timestamp}:${index}`} variant="light" styles={{ root: { height: 'auto', minHeight: 44, padding: 12 }, label: { whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere' } }} onClick={() => seek(event.timestamp)} title={event.evidence}>
            {`${event.timestamp.toFixed(1)}s · ${event.type.replaceAll('_', ' ')} · ${event.evidence}`}
          </Button>
        ))}
      </EvidencePages>
      <Text fw={600}>On-screen text</Text>
      {ocr.length === 0 && <Text c="dimmed">No OCR frames saved.</Text>}
      <EvidencePages name="OCR" items={ocr}>{(visible) => visible.map((frame, index) => <Button key={`${frame.timestamp}:${index}`} variant="light" color="gray" styles={{ root: { height: 'auto', minHeight: 44 }, label: { whiteSpace: 'pre-wrap', textAlign: 'left' } }} onClick={() => seek(frame.timestamp)}>{`${frame.timestamp.toFixed(1)}s · ${frame.text || 'No text detected'}`}</Button>)}</EvidencePages>
      <Text fw={600}>Confusion scores</Text>
      <Text size="sm" c="dimmed">Weighted evidence per time window. These scores are not probabilities; activity can reduce the score.</Text>
      {confusion.length === 0 && <Text c="dimmed">No confusion scores saved.</Text>}
      <EvidencePages name="Scores" items={confusion}>{(visible) => visible.map((window) => <Button key={window.start} variant="light" color={window.score < 0 ? 'teal' : 'orange'} title={window.evidence.join('\n')} aria-label={`Confusion score ${window.score} from ${window.start} to ${window.end} seconds`} style={{ minHeight: 44, background: `linear-gradient(to right, ${window.score < 0 ? 'var(--mantine-color-teal-1)' : 'var(--mantine-color-orange-1)'} ${(Math.abs(window.score) / maximum) * 100}%, transparent 0)` }} onClick={() => seek(window.start)}>{`${window.start.toFixed(1)}–${window.end.toFixed(1)}s · score ${window.score.toFixed(2)}`}</Button>)}</EvidencePages>
      <Text fw={600}>Researcher tags</Text>
      <Group align="end">
        <TextInput label="Tag at current video time" value={label} onChange={(event) => setLabel(event.currentTarget.value)} maxLength={300} />
        <Button disabled={busy || !label.trim()} onClick={async () => { if (await addTag(label.trim())) setLabel(''); }}>Add tag</Button>
      </Group>
      <EvidencePages name="Tags" items={tags}>
        {(visible) => visible.map((tag) => (
          <Group key={tag.id}>
            <Button variant="subtle" color="grape" onClick={() => seek(tag.timestamp)}>
              {tag.timestamp.toFixed(1)}
              s ·
              {' '}
              {tag.label}
            </Button>
            <Button variant="subtle" color="red" disabled={busy} aria-label={`Delete tag ${tag.label}`} onClick={() => removeTag(tag.id)}>Delete</Button>
          </Group>
        ))}
      </EvidencePages>
    </Stack>
  );
}
