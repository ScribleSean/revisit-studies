import {
  Alert, Button, Group, Loader, Select, Stack, Text, Textarea, Title,
} from '@mantine/core';
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useSearchParams } from 'react-router';
import type { ParticipantData } from '../../../storage/types';
import { recordingQuery, recordingTarget } from './recordingNavigation';
import type { StorageEngine } from '../../../storage/engines/types';
import type { ReviewArtifacts, ReviewClip } from '../../../storage/reviewArtifacts';
import {
  analyzeRecording, getReviewHealth, type ReviewHealth, type ReviewPipeline,
} from './reviewApi';
import { RecordingEvidence } from './RecordingEvidence';
import { BatchRecordingReview } from './BatchRecordingReview';
import { indexAnalysis } from './reviewJobs';
import { RecordingTimeline } from './RecordingTimeline';
import { RecordingReportExport } from './RecordingReportExport';
import { PromptLibraryControls } from './PromptLibraryControls';
import { LegacyPromptImport } from './LegacyPromptImport';
import { LegacyRecordingImport } from './LegacyRecordingImport';
import { recordedDiagnostics } from './recordedDiagnostics';
import { LegacySettingsImport } from './LegacySettingsImport';

const defaults: ReviewArtifacts['settings'] = { pipeline: 'heuristic', confusionWords: ['wait', 'not sure', 'confused', 'unclear'] };

function ClipReview({
  engine, clip, settings, available, importing, embeddings, onBusyChange, initialTime,
}: { engine: StorageEngine; clip: ReviewClip; settings: ReviewArtifacts['settings']; available: boolean; importing: boolean; embeddings: boolean; onBusyChange: (value: boolean) => void; initialTime: number }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<ReviewArtifacts['events']>([]);
  const [tags, setTags] = useState<ReviewArtifacts['tags']>([]);
  const [summary, setSummary] = useState('');
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [ocr, setOcr] = useState<ReviewArtifacts['ocr']>([]);
  const [confusion, setConfusion] = useState<ReviewArtifacts['confusion']>([]);
  const [savedDuration, setSavedDuration] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingTag, setSavingTag] = useState(false);
  const [tagsReady, setTagsReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const seek = useCallback((time: number) => { if (video.current) video.current.currentTime = time; }, []);
  const pendingSeek = useRef<number | null>(initialTime);
  const readDuration = (element: HTMLVideoElement) => {
    if (Number.isFinite(element.duration) && element.duration > 0) {
      setVideoDuration(element.duration);
      if (pendingSeek.current !== null && element.readyState >= 1) {
        element.currentTime = Math.min(pendingSeek.current, element.duration);
        pendingSeek.current = null;
      }
    }
  };
  const lifetime = useRef(new AbortController());
  const operation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let objectUrl = '';
    Promise.allSettled([
      engine.getReviewRecording(clip, controller.signal),
      engine.getReviewArtifact('tags', clip), engine.getReviewAnalysis(clip),
    ]).then(([recording, storedTags, storedAnalysis]) => {
      if (controller.signal.aborted) return;
      if (recording.status === 'fulfilled') {
        if (recording.value) { objectUrl = URL.createObjectURL(recording.value); setUrl(objectUrl); setBlob(recording.value); } else setNotice('No screen recording was saved for this task.');
      }
      if (storedTags.status === 'fulfilled') { setTags(storedTags.value?.value || []); setTagsReady(true); }
      if (storedAnalysis.status === 'fulfilled') {
        const value = storedAnalysis.value?.value;
        setSummary(value?.summary.text || ''); setDiagnostics(value?.diagnostics || []); setEvents(value?.events || []);
        setOcr(value?.ocr || []); setConfusion(value?.confusion || []);
        setSavedDuration(value?.duration || 0);
      }
      const failures = [recording, storedTags, storedAnalysis].filter((result) => result.status === 'rejected');
      if (failures.length) setError(failures.map((result) => String(result.reason?.message || result.reason)).join('; '));
    }).catch((reason) => { if (!controller.signal.aborted) setError(String(reason.message || reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); operation.current?.abort(); onBusyChange(false); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [engine, clip, onBusyChange]);

  const analyze = async () => {
    if (!blob || busy || savingTag || !available) return;
    const controller = new AbortController();
    operation.current?.abort(); operation.current = controller;
    setBusy(true); onBusyChange(true); setError(''); setNotice('Analyzing recording…');
    try {
      const result = await analyzeRecording(blob, settings, controller.signal);
      if (controller.signal.aborted || lifetime.current.signal.aborted) return;
      const analysis = await engine.saveReviewAnalysis({
        summary: result.summary, events: result.events, ocr: result.ocr, confusion: result.confusion, duration: result.meta.duration, prompt: settings.prompt || '', diagnostics: recordedDiagnostics(result.meta),
      }, clip);
      if (lifetime.current.signal.aborted) return;
      setEvents(result.events); setSummary(result.summary.text);
      setOcr(result.ocr || []); setConfusion(result.confusion || []);
      setSavedDuration(result.meta.duration);
      setDiagnostics(recordedDiagnostics(result.meta)); setNotice('Analysis saved.');
      if (analysis.indexWarning) setNotice((message) => `${message} ${analysis.indexWarning}`);
      if (embeddings) {
        indexAnalysis(engine, clip, analysis, controller.signal).then(() => {
          if (!controller.signal.aborted) setNotice((message) => `${message} Search index updated.`);
        }).catch((reason) => {
          if (!controller.signal.aborted) setNotice((message) => `${message} Analysis saved; search indexing failed: ${String(reason.message || reason)}`);
        });
      }
    } catch (reason) {
      if (!lifetime.current.signal.aborted) {
        if (controller.signal.aborted) setNotice('Analysis cancelled. Previously saved results are preserved.');
        else { setError(reason instanceof Error ? reason.message : String(reason)); setNotice(''); }
      }
    } finally { if (!lifetime.current.signal.aborted) { setBusy(false); onBusyChange(false); } }
  };

  const saveTags = async (next: ReviewArtifacts['tags']) => {
    if (savingTag || busy || !tagsReady || importing) return false;
    setSavingTag(true); onBusyChange(true); setError('');
    try {
      const saved = await engine.saveReviewArtifact('tags', next, clip);
      if (!lifetime.current.signal.aborted) setNotice(saved.indexWarning || 'Tags saved.');
      if (!lifetime.current.signal.aborted) setTags(next);
      return true;
    } catch (reason) {
      if (!lifetime.current.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally { if (!lifetime.current.signal.aborted) { setSavingTag(false); onBusyChange(false); } }
  };

  if (loading) {
    return (
      <Group role="status">
        <Loader size="sm" />
        <Text>Loading recording…</Text>
      </Group>
    );
  }
  return (
    <Stack>
      {error && <Alert color="red" title="Recording review failed">{error}</Alert>}
      {notice && <Text role="status">{notice}</Text>}
      {!!diagnostics.length && (
      <Alert color="yellow" title="Diagnostics recorded with this analysis">
        <Text size="sm">These describe the analysis run, not current service or remote-file status.</Text>
        {diagnostics.map((message, index) => <Text key={`${index}:${message}`} size="sm">{message}</Text>)}
      </Alert>
      )}
      {url && <video ref={video} src={url} controls preload="metadata" aria-label="Study recording" onLoadedMetadata={(event) => readDuration(event.currentTarget)} onDurationChange={(event) => readDuration(event.currentTarget)} style={{ width: '100%', maxHeight: 480 }}><track kind="captions" /></video>}
      {url && <RecordingTimeline duration={videoDuration || savedDuration} video={video} events={events} tags={tags} ocr={ocr} confusion={confusion} seek={seek} />}
      <Group>
        <Button onClick={analyze} disabled={!blob || !available || busy || savingTag}>Analyze recording</Button>
        {busy && <Button variant="default" onClick={() => operation.current?.abort()}>Cancel analysis</Button>}
      </Group>
      <Title order={4}>Summary</Title>
      <Text style={{ whiteSpace: 'pre-wrap' }}>{summary || 'No summary saved yet.'}</Text>
      {blob && <RecordingEvidence events={events} tags={tags} ocr={ocr} confusion={confusion} busy={busy || savingTag || !tagsReady || importing} seek={seek} addTag={(label) => saveTags([...tags, { id: crypto.randomUUID(), timestamp: video.current?.currentTime || 0, label }])} removeTag={(id) => saveTags(tags.filter((tag) => tag.id !== id))} />}
    </Stack>
  );
}

export function RecordingReview({ engine, participants }: { engine: StorageEngine; participants: ParticipantData[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const target = recordingTarget(searchParams);
  const selected = target ? JSON.stringify([target.participantId, target.taskId]) : null;
  const setSelected = (value: string | null) => {
    if (!value) return;
    const [participantId, taskId] = JSON.parse(value);
    setSearchParams(recordingQuery({ participantId, taskId }));
  };
  const [settings, setSettings] = useState(defaults);
  const [phrases, setPhrases] = useState(defaults.confusionWords.join(', '));
  const [health, setHealth] = useState<ReviewHealth | null>(null);
  const [error, setError] = useState('');
  const [settingsReady, setSettingsReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [singleBusy, setSingleBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const effectiveSettings = useMemo(() => ({ ...settings, confusionWords: phrases.split(',').map((word) => word.trim()).filter(Boolean) }), [settings, phrases]);
  const options = useMemo(() => participants.flatMap((participant) => Object.values(participant.answers).filter((answer) => answer.endTime > 0).map((answer) => ({ value: JSON.stringify([participant.participantId, answer.identifier]), label: `${participant.participantId} · ${answer.componentName} (${answer.trialOrder})` }))), [participants]);
  const selection = options.find((option) => option.value === selected)?.value || options[0]?.value;
  const initialTime = selection === selected ? target?.timestamp || 0 : 0;
  useEffect(() => {
    if (selection && selection !== selected) {
      const [participantId, taskId] = JSON.parse(selection);
      setSearchParams(recordingQuery({ participantId, taskId }), { replace: true });
    }
  }, [selection, selected, setSearchParams]);
  const clip = useMemo(() => { if (!selection) return null; const [participantId, taskId] = JSON.parse(selection); return { participantId, taskId }; }, [selection]);
  useEffect(() => {
    const controller = new AbortController();
    engine.getReviewArtifact('settings').then((stored) => { if (!controller.signal.aborted) { setSettings(stored?.value || defaults); setPhrases((stored?.value || defaults).confusionWords.join(', ')); setSettingsReady(true); } }).catch((reason) => { if (!controller.signal.aborted) setError(String(reason)); });
    getReviewHealth(controller.signal).then((value) => { if (!controller.signal.aborted) setHealth(value); }).catch(() => { if (!controller.signal.aborted) setHealth(null); });
    return () => controller.abort();
  }, [engine]);
  const saveSettings = async (next = effectiveSettings) => {
    setSaving(true); setError(''); setSettingsNotice('Saving analysis settings…');
    try { await engine.saveReviewArtifact('settings', next); setSettings(next); setSettingsNotice('Analysis settings saved.'); return true; } catch (reason) { setSettingsNotice('Analysis settings were not saved.'); setError(reason instanceof Error ? reason.message : String(reason)); return false; } finally { setSaving(false); }
  };
  return (
    <Stack p="md">
      <Title order={3}>Recording review</Title>

      {!health && <Alert title="Analysis service unavailable">Start the local ReVIEW analysis service, then reopen this tab. Saved recordings and annotations remain available.</Alert>}
      {error && <Alert color="red">{error}</Alert>}
      <Select label="Participant and recording" searchable allowDeselect={false} data={options} value={selection || null} onChange={setSelected} placeholder="No completed task recordings" />
      {clip ? <ClipReview key={`${selection}:${generation}:${initialTime}`} engine={engine} clip={clip} onBusyChange={setSingleBusy} initialTime={initialTime} importing={importBusy} settings={effectiveSettings} embeddings={health?.embeddings === true} available={!saving && !batchBusy && !importBusy && settingsReady && !!health?.pipelines.some((p) => p.id === settings.pipeline && p.available)} /> : <Text c="dimmed">Complete a study task with screen recording enabled to review its recording here.</Text>}
      <RecordingReportExport engine={engine} />
      <Group align="end">
        <Select label="Analysis pipeline" value={settings.pipeline} disabled={!settingsReady || saving} data={['heuristic', 'gemini', 'gpt4o', 'local'].map((id) => ({ value: id, label: id === 'heuristic' ? 'Local timeline' : id, disabled: !health?.pipelines.some((p) => p.id === id && p.available) }))} onChange={(value) => { if (value) setSettings({ ...settings, pipeline: value as ReviewPipeline }); }} />
        <Textarea label="Confusion phrases (comma separated)" value={phrases} disabled={!settingsReady || saving} onChange={(event) => setPhrases(event.currentTarget.value)} />
        <Textarea label="Researcher prompt" description="Used for model summaries in single and batch analysis. Local timeline ignores this text. Save settings to retain it after reload." value={settings.prompt || ''} maxLength={8000} autosize minRows={3} disabled={!settingsReady || saving || singleBusy || batchBusy || importBusy} onChange={(event) => setSettings({ ...settings, prompt: event.currentTarget.value })} />
        <Button variant="default" loading={saving} disabled={!settingsReady || saving} onClick={() => saveSettings()}>Save analysis settings</Button>
      </Group>
      {settingsNotice && <Text role="status" aria-label="Analysis settings save status">{settingsNotice}</Text>}
      <PromptLibraryControls library={settings.promptLibrary || []} prompt={settings.prompt || ''} disabled={!settingsReady || saving || singleBusy || batchBusy || importBusy} select={(prompt) => setSettings({ ...settings, prompt })} persist={(promptLibrary) => saveSettings({ ...effectiveSettings, promptLibrary })} />
      <LegacyPromptImport engine={engine} disabled={!settingsReady || saving || singleBusy || batchBusy || importBusy} busyChanged={setSaving} imported={(promptLibrary) => setSettings((current) => ({ ...current, promptLibrary }))} />
      <LegacySettingsImport engine={engine} disabled={!settingsReady || saving || singleBusy || batchBusy || importBusy} busyChanged={setSaving} imported={(pipeline) => setSettings((current) => ({ ...current, pipeline }))} />
      <BatchRecordingReview engine={engine} clips={options.map((option) => { const [participantId, taskId] = JSON.parse(option.value); return { participantId, taskId }; })} settings={effectiveSettings} available={!saving && !singleBusy && !importBusy && settingsReady && !!health?.pipelines.some((p) => p.id === settings.pipeline && p.available)} embeddings={health?.embeddings === true} busy={batchBusy} setBusy={(value) => { setBatchBusy(value); if (value) setGeneration((current) => current + 1); }} completed={() => { setGeneration((value) => value + 1); }} />
      {clip && <LegacyRecordingImport key={selection} engine={engine} clip={clip} disabled={singleBusy || batchBusy || saving || importBusy} busyChanged={setImportBusy} imported={() => { setGeneration((value) => value + 1); }} />}
    </Stack>
  );
}
