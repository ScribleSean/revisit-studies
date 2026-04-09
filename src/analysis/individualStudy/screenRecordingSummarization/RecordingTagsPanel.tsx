import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Stack,
  TextInput,
} from '@mantine/core';
import {
  IconPencil,
  IconPlus,
  IconTag,
  IconTrash,
} from '@tabler/icons-react';
import {
  useCallback,
  useState,
  type RefObject,
} from 'react';

import type { RecordingTag } from './recordingTagTypes';
import { formatRecordingTime } from './recordingTagTypes';

type ModalState = null | 'add' | { mode: 'edit'; tag: RecordingTag };

export function RecordingTagsPanel({
  tags,
  onPersist,
  videoRef,
  disabled,
}: {
  tags: RecordingTag[];
  onPersist: (next: RecordingTag[]) => Promise<void>;
  videoRef: RefObject<HTMLVideoElement | null>;
  disabled: boolean;
}) {
  const [modal, setModal] = useState<ModalState>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const openAdd = useCallback(() => {
    setLabelDraft('');
    setModal('add');
  }, []);

  const openEdit = useCallback((tag: RecordingTag) => {
    setLabelDraft(tag.label);
    setModal({ mode: 'edit', tag });
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
    setLabelDraft('');
  }, []);

  const submit = useCallback(async () => {
    const label = labelDraft.trim();
    if (!label || modal === null) return;
    setSaving(true);
    try {
      if (modal === 'add') {
        const ts = videoRef.current?.currentTime ?? 0;
        const next: RecordingTag[] = [
          ...tags,
          {
            id: crypto.randomUUID(),
            timestamp: ts,
            label,
            createdAt: new Date().toISOString(),
          },
        ].sort((a, b) => a.timestamp - b.timestamp);
        await onPersist(next);
      } else if (modal.mode === 'edit') {
        const next = tags.map((x) => (x.id === modal.tag.id ? { ...x, label } : x));
        await onPersist(next);
      }
      closeModal();
    } finally {
      setSaving(false);
    }
  }, [closeModal, labelDraft, modal, onPersist, tags, videoRef]);

  const remove = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        await onPersist(tags.filter((t) => t.id !== id));
      } finally {
        setSaving(false);
      }
    },
    [onPersist, tags],
  );

  const seek = useCallback(
    (t: number) => {
      const el = videoRef.current;
      if (el) el.currentTime = t;
    },
    [videoRef],
  );

  const sorted = [...tags].sort((a, b) => a.timestamp - b.timestamp);

  return (
    <Stack gap="xs" mt="sm">
      <Group gap="xs">
        <Button
          variant="light"
          size="sm"
          leftSection={<IconPlus size={16} />}
          disabled={disabled}
          onClick={openAdd}
        >
          Add tag
        </Button>
      </Group>

      <Group gap="xs" wrap="wrap" align="center">
        {sorted.length === 0 ? (
          <Box c="dimmed" fz="sm">
            No tags yet. Pause the video where you want a note, then click Add tag.
          </Box>
        ) : (
          sorted.map((t) => (
            <Box
              key={t.id}
              style={{
                border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 8,
                padding: '2px 6px',
              }}
            >
              <Group gap={6} wrap="nowrap">
                <Badge
                  component="button"
                  type="button"
                  variant="light"
                  color={t.color || 'gray'}
                  style={{ cursor: 'pointer', textTransform: 'none' }}
                  onClick={() => seek(t.timestamp)}
                  leftSection={<IconTag size={12} />}
                >
                  {formatRecordingTime(t.timestamp)}
                  {' · '}
                  {t.label}
                </Badge>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  aria-label="Edit tag"
                  disabled={disabled || saving}
                  onClick={() => openEdit(t)}
                >
                  <IconPencil size={14} />
                </ActionIcon>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label="Delete tag"
                  disabled={disabled || saving}
                  onClick={() => {
                    remove(t.id).catch(() => undefined);
                  }}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Box>
          ))
        )}
      </Group>

      <Modal
        opened={modal !== null}
        onClose={closeModal}
        title={modal === 'add' ? 'Add tag at current playhead' : modal ? 'Edit tag label' : ''}
      >
        <Stack gap="md">
          {modal === 'add' && (
            <Box fz="sm" c="dimmed">
              Tag will be saved at
              {' '}
              <strong>{formatRecordingTime(videoRef.current?.currentTime ?? 0)}</strong>
              . Scrub first if you need a different moment.
            </Box>
          )}
          {modal !== null && modal !== 'add' && (
            <Box fz="sm" c="dimmed">
              At
              {' '}
              <strong>{formatRecordingTime(modal.tag.timestamp)}</strong>
            </Box>
          )}
          <TextInput
            label="Label"
            placeholder="Short note for this moment"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.currentTarget.value)}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeModal}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={!labelDraft.trim()}
              onClick={() => {
                submit().catch(() => undefined);
              }}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
