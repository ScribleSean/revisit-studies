import { Group, Stack, Text } from '@mantine/core';
import {
  useCallback, useEffect, useId, useMemo, useState, type RefObject,
} from 'react';
import type { ReviewArtifacts } from '../../../storage/reviewArtifacts';
import { timelineGrounding } from './timelineGrounding';

const styles = {
  hesitation: { color: '#e67700', symbol: '●' },
  confusion_word: { color: '#c92a2a', symbol: '▲' },
  scene_change: { color: '#1971c2', symbol: '■' },
  reading: { color: '#2b8a3e', symbol: '◆' },
  confused_transition: { color: '#9c36b5', symbol: '✚' },
  active_interaction: { color: '#087f8c', symbol: '★' },
};

export function RecordingTimeline({
  duration, video, events, tags, ocr, confusion, seek,
}: { duration: number; video: RefObject<HTMLVideoElement | null>; events: ReviewArtifacts['events']; tags: ReviewArtifacts['tags']; ocr: ReviewArtifacts['ocr']; confusion: ReviewArtifacts['confusion']; seek: (time: number) => void }) {
  const sliderId = useId();
  const [currentTime, setCurrentTime] = useState(0);
  const [activeEvidence, setActiveEvidence] = useState('');
  useEffect(() => setActiveEvidence(''), [events, tags, ocr, confusion]);
  const seekTo = useCallback((time: number) => { seek(time); setCurrentTime(time); }, [seek]);
  useEffect(() => {
    const element = video.current;
    if (!element) return undefined;
    const update = () => setCurrentTime(element.currentTime);
    element.addEventListener('timeupdate', update);
    element.addEventListener('seeking', update);
    update();
    return () => { element.removeEventListener('timeupdate', update); element.removeEventListener('seeking', update); };
  }, [video]);
  const validDuration = Number.isFinite(duration) && duration > 0;
  const shapes = useMemo(() => {
    if (!validDuration) return null;
    const x = (time: number) => 145 + (Math.min(duration, Math.max(0, time)) / duration) * 830;
    const grounding = timelineGrounding(events, ocr);
    const marker = (key: string, time: number, y: number, color: string, symbol: string, label: string, grounded = false) => (
      <g key={key} role="button" tabIndex={0} aria-label={label} onFocus={() => setActiveEvidence(label)} onMouseEnter={() => setActiveEvidence(label)} onClick={() => seekTo(time)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seekTo(time); } }} style={{ cursor: 'pointer' }}>
        <title>{label}</title>
        <rect x={x(time) - 22} y={y - 22} width={44} height={44} fill="transparent" />
        {grounded && <circle data-grounded="true" cx={x(time)} cy={y} r={16} fill="none" stroke="#f59f00" strokeWidth={3} />}
        <text x={x(time)} y={y + 7} textAnchor="middle" fill={color} fontSize={24} aria-hidden="true">{symbol}</text>
      </g>
    );
    const maximum = confusion.reduce((value, window) => Math.max(value, Math.abs(window.score)), 1);
    return (
      <>
        {events.map((event, index) => event.timestamp <= duration && marker(`event:${index}`, event.timestamp, 35, styles[event.type].color, styles[event.type].symbol, `Timeline event at ${event.timestamp.toFixed(1)} seconds: ${event.type.replaceAll('_', ' ')}. ${event.evidence}${grounding.eventIndices.has(index) ? '. OCR grounded' : ''}`, grounding.eventIndices.has(index)))}
        {tags.filter((tag) => tag.timestamp <= duration).map((tag) => marker(`tag:${tag.id}`, tag.timestamp, 85, '#9c36b5', '■', `Timeline tag at ${tag.timestamp.toFixed(1)} seconds: ${tag.label}`))}
        {ocr.map((frame, index) => frame.timestamp <= duration && marker(`ocr:${index}`, frame.timestamp, 135, '#868e96', '│', `Timeline OCR at ${frame.timestamp.toFixed(1)} seconds: ${frame.text || 'No text detected'}${grounding.frameIndices.has(index) ? '. OCR grounded' : ''}`, grounding.frameIndices.has(index)))}
        {confusion.filter((window) => window.start < duration).map((window) => {
          const height = (Math.abs(window.score) / maximum) * 35;
          const label = `Timeline score ${window.score} from ${window.start} to ${window.end} seconds. ${window.evidence.join('; ')}`;
          return (
            <g key={`score:${window.start}`} role="button" tabIndex={0} aria-label={label} onFocus={() => setActiveEvidence(label)} onMouseEnter={() => setActiveEvidence(label)} onClick={() => seekTo(window.start)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seekTo(window.start); } }} style={{ cursor: 'pointer' }}>
              <title>{label}</title>
              <rect x={x(window.start)} y={175} width={Math.max(2, x(window.end) - x(window.start))} height={82} fill="transparent" />
              <rect x={x(window.start)} y={window.score < 0 ? 220 : 220 - height} width={Math.max(2, x(window.end) - x(window.start) - 2)} height={Math.max(1, height)} fill={window.score < 0 ? '#099268' : '#e67700'} />
            </g>
          );
        })}
      </>
    );
  }, [validDuration, duration, events, tags, ocr, confusion, seekTo]);
  if (!validDuration) return <Text c="dimmed">Timeline scale will appear when recording duration is available. Evidence links remain available below.</Text>;
  const time = Math.min(duration, Math.max(0, currentTime));
  return (
    <Stack gap="xs" component="section" aria-label="Synchronized recording timeline">
      <Text fw={600}>Synchronized timeline</Text>
      <Group gap="sm">{Object.entries(styles).map(([type, style]) => <Text key={type} size="sm" c={style.color}>{`${style.symbol} ${type.replaceAll('_', ' ')}`}</Text>)}</Group>
      <Text size="sm">Gold rings mark matching spoken phrases and OCR in the same three-second bin. Hover or focus a marker for its evidence; click or press Enter to seek. Overlapping markers remain available in the evidence lists below.</Text>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox="0 0 1000 285" style={{ width: '100%', minWidth: 1000, display: 'block' }} aria-label="Automatic events, tags, OCR and confusion score aligned to video time">
          {[35, 85, 135, 220].map((y, index) => (
            <g key={y}>
              <text x={4} y={y + 5} fill="currentColor" fontSize={14}>{['Auto events', 'Researcher tags', 'OCR frames', 'Confusion score'][index]}</text>
              <line x1={145} x2={975} y1={y} y2={y} stroke="var(--mantine-color-gray-4)" />
            </g>
          ))}
          {shapes}
          <line x1={145 + (time / duration) * 830} x2={145 + (time / duration) * 830} y1={10} y2={258} stroke="#e03131" strokeWidth={2} pointerEvents="none" aria-hidden="true" />
          {[0, duration / 2, duration].map((tick) => <text key={tick} x={145 + (tick / duration) * 830} y={280} fill="currentColor" textAnchor="middle" fontSize={12}>{`${tick.toFixed(1)}s`}</text>)}
        </svg>
      </div>
      <Text size="sm" aria-live="polite" style={{ maxHeight: 100, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{activeEvidence || 'Focus or hover a marker to inspect its evidence.'}</Text>
      <label htmlFor={sliderId}>{`Video time: ${time.toFixed(1)} of ${duration.toFixed(1)} seconds`}</label>
      <input id={sliderId} aria-label="Timeline seek" type="range" min={0} max={duration} step={0.1} value={time} onChange={(event) => seekTo(Number(event.currentTarget.value))} />
    </Stack>
  );
}
