import {
  Alert, Button, Group, Stack, Text,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewPipeline } from './reviewApi';

export function LegacySettingsImport({
  engine, disabled, imported, busyChanged,
}: {
  engine: StorageEngine; disabled: boolean; imported: (pipeline: ReviewPipeline) => void; busyChanged: (busy: boolean) => void;
}) {
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
    setBusy(true); busyChanged(true); setError(''); setNotice('Reading legacy pipeline preference…');
    try {
      const result = await engine.importLegacyReviewSettings(operation.signal);
      if (!mounted.current) return;
      if (result.pipeline) imported(result.pipeline);
      setNotice(result.pipeline ? `${result.changed ? 'Imported' : 'Already saved'} pipeline: ${result.pipeline}. Other settings and legacy source preserved.` : 'No legacy pipeline preference found.');
    } catch (reason) {
      if (mounted.current) {
        setNotice(operation.signal.aborted ? 'Import cancelled before saving.' : '');
        if (!operation.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally { if (mounted.current) { setBusy(false); busyChanged(false); } }
  };
  return (
    <Stack gap="xs">
      <Group>
        <Button variant="default" disabled={disabled || busy} onClick={start}>Import legacy pipeline preference</Button>
        {busy && <Button variant="subtle" onClick={() => controller.current?.abort()}>Cancel settings import</Button>}
      </Group>
      <Text size="sm">Replaces the saved pipeline choice with the preference from the old fork. Prompts and confusion phrases are preserved. Importing does not run analysis; the selected provider still needs to be configured.</Text>
      {error && <Alert color="red">{error}</Alert>}
      <Text role="status" aria-label="Legacy settings import status">{notice}</Text>
    </Stack>
  );
}
