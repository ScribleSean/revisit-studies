import {
  Alert, Button, Group, Stack, Text,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import type { SavedReviewPrompt } from '../../../storage/reviewArtifacts';
import type { LegacyPromptConflict } from '../../../storage/legacyReviewPrompts';

export function LegacyPromptImport({
  engine, disabled, imported, busyChanged,
}: { engine: StorageEngine; disabled: boolean; imported: (library: SavedReviewPrompt[]) => void; busyChanged: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState<LegacyPromptConflict[]>([]);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); busyChanged(false); };
  }, [busyChanged]);
  const start = async () => {
    if (disabled || busy) return;
    const operation = new AbortController(); controller.current = operation;
    setBusy(true); busyChanged(true); setError(''); setNotice('Reading legacy prompts…'); setConflicts([]);
    try {
      const result = await engine.importLegacyReviewPrompts(operation.signal);
      if (!mounted.current) return;
      imported(result.library); setConflicts(result.conflicts);
      setNotice(`Imported ${result.imported}; already present ${result.identical}; conflicts ${result.conflicts.length}. Legacy source preserved.`);
    } catch (reason) {
      if (mounted.current) {
        setNotice('');
        if (operation.signal.aborted) setNotice('Import cancelled before saving.');
        else setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally { if (mounted.current) { setBusy(false); busyChanged(false); } }
  };
  return (
    <Stack gap="xs">
      <Group>
        <Button variant="default" disabled={disabled || busy} onClick={start}>Import legacy prompts</Button>
        {busy && <Button variant="subtle" onClick={() => controller.current?.abort()}>Cancel prompt import</Button>}
      </Group>
      <Text size="sm">Copies old-fork named prompts into this study. Existing conflicting prompts and the legacy source are preserved.</Text>
      {error && <Alert color="red">{error}</Alert>}
      <Text role="status" aria-label="Legacy prompt import status">{notice}</Text>
      {conflicts.map((conflict) => <Text key={conflict.id} size="sm">{`Skipped ${conflict.name}: ${conflict.reason} conflict. The original remains in legacy storage.`}</Text>)}
    </Stack>
  );
}
