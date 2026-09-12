import {
  Alert, Button, Group, Select, Stack, Text, TextInput,
} from '@mantine/core';
import { useState } from 'react';
import type { SavedReviewPrompt } from '../../../storage/reviewArtifacts';
import { saveNamedPrompt } from './promptLibrary';

export function PromptLibraryControls({
  library, prompt, disabled, select, persist,
}: { library: SavedReviewPrompt[]; prompt: string; disabled: boolean; select: (text: string) => void; persist: (next: SavedReviewPrompt[]) => Promise<boolean> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const current = library.find((entry) => entry.id === selected);
  const save = async (update: boolean) => {
    if (busy || disabled) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = saveNamedPrompt(library, name, prompt, update ? current?.id : undefined);
      if (await persist(result.library)) { setSelected(result.id); setNotice('Named prompt saved.'); } else setError('Unable to save the named prompt. Your changes are still available to retry.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!current || busy || disabled) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (await persist(library.filter((entry) => entry.id !== current.id))) { setSelected(null); setName(''); setNotice('Named prompt deleted. Current prompt text is unchanged.'); } else setError('Unable to delete the named prompt. It remains saved.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  return (
    <Stack gap="xs">
      {error && <Alert color="red">{error}</Alert>}
      <Group align="end">
        <Select label="Saved prompts" searchable clearable value={current?.id || null} disabled={disabled || busy} data={[...library].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(id) => { setSelected(id); const entry = library.find((row) => row.id === id); setName(entry?.name || ''); if (entry) select(entry.text); setNotice(''); }} />
        <TextInput label="Prompt name" maxLength={100} value={name} disabled={disabled || busy} onChange={(event) => setName(event.currentTarget.value)} />
        <Button variant="default" disabled={disabled || busy || !name.trim() || library.length >= 100} onClick={() => save(false)}>Save as new prompt</Button>
        <Button variant="default" disabled={disabled || busy || !current || !name.trim()} onClick={() => save(true)}>Update saved prompt</Button>
        <Button variant="subtle" color="red" disabled={disabled || busy || !current} onClick={remove}>Delete saved prompt</Button>
      </Group>
      <Text size="sm" role="status" aria-label="Prompt library status">{notice}</Text>
    </Stack>
  );
}
