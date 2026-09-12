import {
  Alert, Button, Group, Stack, Text,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewClip } from '../../../storage/reviewArtifacts';

export function LegacyRecordingImport({
  engine, clip, disabled, imported, busyChanged,
}: { engine: StorageEngine; clip: ReviewClip; disabled: boolean; imported: () => void; busyChanged: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); busyChanged(false); };
  }, [busyChanged]);
  const start = async () => {
    if (disabled || busy) return;
    const operation = new AbortController(); controller.current = operation;
    setBusy(true); busyChanged(true); setError(''); setNotice('Reading legacy recording results…');
    try {
      const result = await engine.importLegacyReviewRecording(clip, operation.signal);
      if (!mounted.current) return;
      imported();
      setNotice(`${result.cancelled ? 'Import stopped. ' : ''}Imported: ${result.imported.join(', ') || 'none'}. Existing results preserved: ${result.preserved.join(', ') || 'none'}. Legacy source preserved.`);
      if (result.errors.length) setError(`${result.errors.join('; ')}. Some results may already be saved. Retry import to fill missing results and repair the index.`);
    } catch (reason) {
      if (mounted.current) {
        setNotice('');
        if (operation.signal.aborted) setNotice('Import cancelled. Any completed saves remain available.');
        else setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally { if (mounted.current) { setBusy(false); busyChanged(false); } }
  };
  return (
    <Stack gap="xs">
      <Group>
        <Button variant="default" disabled={disabled || busy} onClick={start}>Import legacy recording results</Button>
        {busy && <Button variant="subtle" onClick={() => controller.current?.abort()}>Cancel recording import</Button>}
      </Group>
      <Text size="sm">Copies saved results for this recording from the old fork. Existing results take precedence. Imported embeddings need reindexing before search can use them.</Text>
      {error && <Alert color="red" title="Recording import needs attention">{error}</Alert>}
      <Text role="status" aria-label="Legacy recording import status">{notice}</Text>
    </Stack>
  );
}
