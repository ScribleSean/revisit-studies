import {
  Button, Group, Stack, Text,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { StorageEngine } from '../../../storage/engines/types';
import { buildStudyReport } from './buildStudyReport';
import { renderStudyReportMarkdown } from './renderStudyReportMarkdown';
import { buildReviewArtifactExport, serializeReviewArtifactExport } from './buildReviewArtifactExport';

function saveFile(studyId: string, contents: string, extension: 'json' | 'md', type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `recording-review-${studyId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.${extension}`;
    anchor.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function RecordingReportExport({ engine }: { engine: StorageEngine }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, [engine]);
  const download = async (artifacts = false) => {
    if (busy) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setNotice('Preparing study report…');
    try {
      if (artifacts) {
        const archive = await buildReviewArtifactExport(engine, controller.signal, (done, total) => { if (active.current === controller) setNotice(`Preparing artifact export: ${done} of ${total} recordings`); });
        const json = serializeReviewArtifactExport(archive);
        controller.signal.throwIfAborted();
        saveFile(archive.studyId, json, 'json', 'application/json;charset=utf-8');
        if (active.current === controller) setNotice(`Artifacts downloaded: ${archive.clips.length} recordings, all nine categories included.`);
        return;
      }
      const report = await buildStudyReport(engine, controller.signal, (done, total) => { if (active.current === controller) setNotice(`Preparing report: ${done} of ${total} recordings`); });
      controller.signal.throwIfAborted();
      const markdown = renderStudyReportMarkdown(report);
      saveFile(report.studyId, markdown, 'md', 'text/markdown;charset=utf-8');
      if (active.current === controller) setNotice(`Report downloaded: ${report.clips.length} recordings, ${report.clips.filter((clip) => clip.mediaWarning).length} thumbnail warnings.`);
    } catch (error) {
      if (active.current === controller) setNotice(controller.signal.aborted ? 'Report export cancelled.' : `Report export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  return (
    <Stack gap="xs">
      <Group>
        <Button variant="default" disabled={busy} onClick={() => download()}>Export study report (Markdown)</Button>
        <Button variant="default" disabled={busy} onClick={() => download(true)}>Export review artifacts (JSON)</Button>
        {busy && <Button variant="default" onClick={() => active.current?.abort()}>Cancel report export</Button>}
      </Group>
      <Text size="sm">Exports all registered participants and saved tasks, regardless of filters, with 25%-position thumbnails and saved evidence. Video failures are listed in the report.</Text>
      <Text size="sm">JSON includes saved evidence, embeddings, prompts, settings and the study index, without videos. Missing artifacts are marked null.</Text>
      {notice && <Text role="status" aria-label="Report export status">{notice}</Text>}
    </Stack>
  );
}
