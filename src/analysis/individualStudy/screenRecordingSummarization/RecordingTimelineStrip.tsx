import type { CSSProperties } from 'react';
import {
  Box, Group, Stack, Text, Tooltip,
} from '@mantine/core';

import type { RecordingTag } from './recordingTagTypes';
import { formatRecordingTime } from './recordingTagTypes';
import type { TimelineEvent, TimelineEventType } from './timelineEventTypes';

const LEGEND: ReadonlyArray<{ type: TimelineEventType; label: string }> = [
  { type: 'hesitation', label: 'Hesitation' },
  { type: 'confusion_word', label: 'Confusion phrase' },
  { type: 'scene_change', label: 'Scene change' },
  { type: 'reading', label: 'Reading / stable screen' },
  { type: 'confused_transition', label: 'Confused transition' },
  { type: 'active_interaction', label: 'Active interaction' },
];

function markerColor(t: TimelineEventType): string {
  if (t === 'hesitation') return '#fd7e14';
  if (t === 'confusion_word') return '#fa5252';
  if (t === 'scene_change') return '#228be6';
  if (t === 'reading') return '#12b886';
  if (t === 'confused_transition') return '#ae3ec9';
  return '#fab005';
}

function autoEventMarkerStyle(
  t: TimelineEventType,
  leftPct: number,
  grounded?: boolean,
): CSSProperties {
  const common: CSSProperties = {
    position: 'absolute',
    left: `${leftPct}%`,
    background: markerColor(t),
    border: grounded ? '2px solid #e67700' : '2px solid #fff',
    padding: 0,
    cursor: 'pointer',
    boxShadow: grounded ? '0 0 0 2px rgba(230,119,0,0.85)' : '0 0 0 1px rgba(0,0,0,0.15)',
  };
  if (t === 'reading') {
    return {
      ...common, width: 10, height: 14, borderRadius: 4, transform: 'translateX(-50%)', top: 7,
    };
  }
  if (t === 'confused_transition') {
    return {
      ...common, width: 10, height: 10, borderRadius: 2, transform: 'translateX(-50%) rotate(45deg)', top: 9,
    };
  }
  if (t === 'active_interaction') {
    return {
      ...common, width: 11, height: 11, borderRadius: 2, transform: 'translateX(-50%)', top: 8,
    };
  }
  return {
    ...common, width: 12, height: 12, borderRadius: '50%', transform: 'translateX(-50%)', top: 8,
  };
}

function legendSwatchStyle(t: TimelineEventType): CSSProperties {
  const bg = markerColor(t);
  if (t === 'reading') {
    return {
      width: 8, height: 12, borderRadius: 3, background: bg, flexShrink: 0,
    };
  }
  if (t === 'confused_transition') {
    return {
      width: 9,
      height: 9,
      borderRadius: 2,
      background: bg,
      transform: 'rotate(45deg)',
      flexShrink: 0,
    };
  }
  if (t === 'active_interaction') {
    return {
      width: 10, height: 10, borderRadius: 2, background: bg, flexShrink: 0,
    };
  }
  return {
    width: 10, height: 10, borderRadius: '50%', background: bg, flexShrink: 0,
  };
}

const TRACK_STYLE = {
  position: 'relative' as const,
  height: 28,
  background: 'rgba(0,0,0,0.06)',
  borderRadius: 6,
};

export type OcrFrameStrip = { timestampSec: number; text: string };

export function RecordingTimelineStrip({
  events,
  tags,
  durationSeconds,
  onSeek,
  ocrFrames,
  eventGrounded,
  ocrFrameGrounded,
}: {
  events: TimelineEvent[];
  tags?: RecordingTag[];
  durationSeconds: number;
  onSeek: (seconds: number) => void;
  ocrFrames?: OcrFrameStrip[];
  /** Parallel to `events`: OCR–transcript grounding (same 3s window + phrase in OCR text). */
  eventGrounded?: boolean[];
  /** Parallel to `ocrFrames`. */
  ocrFrameGrounded?: boolean[];
}) {
  if (durationSeconds <= 0) {
    return null;
  }

  const tagList = tags ?? [];
  const ocrList = ocrFrames ?? [];
  const showEvents = events.length > 0;
  const showTags = tagList.length > 0;
  const showOcr = ocrList.length > 0;
  if (!showEvents && !showTags && !showOcr) {
    return null;
  }

  return (
    <Stack gap={6} mt="xs">
      {showEvents && (
        <Stack gap={4}>
          <Box style={TRACK_STYLE}>
            {events.map((e, i) => {
              const leftPct = Math.min(100, Math.max(0, (e.timestamp / durationSeconds) * 100));
              const g = Boolean(eventGrounded?.[i]);
              const tip = `${e.type}: ${e.evidence || ''}${g ? ' · grounded on OCR' : ''}`;
              return (
                <Tooltip key={`${e.type}-${i}-${e.timestamp}`} label={tip} withArrow>
                  <button
                    type="button"
                    aria-label={`Seek to ${e.type} at ${e.timestamp.toFixed(1)}s`}
                    onClick={() => onSeek(e.timestamp)}
                    style={autoEventMarkerStyle(e.type, leftPct, g)}
                  />
                </Tooltip>
              );
            })}
          </Box>
          <Group gap="md" wrap="wrap">
            {LEGEND.map((row) => (
              <Group key={row.type} gap={6} wrap="nowrap">
                <Box style={{ boxShadow: '0 0 0 1px rgba(0,0,0,0.12)', ...legendSwatchStyle(row.type) }} />
                <Text size="xs" c="dimmed">
                  {row.label}
                </Text>
              </Group>
            ))}
            <Group gap={6} wrap="nowrap">
              <Box
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: '#868e96',
                  border: '2px solid #e67700',
                }}
              />
              <Text size="xs" c="dimmed">
                Gold ring = OCR-grounded confusion phrase
              </Text>
            </Group>
          </Group>
        </Stack>
      )}

      {showTags && (
        <Box style={TRACK_STYLE}>
          {tagList.map((t) => {
            const leftPct = Math.min(100, Math.max(0, (t.timestamp / durationSeconds) * 100));
            const tip = `${formatRecordingTime(t.timestamp)} — ${t.label}`;
            return (
              <Tooltip key={t.id} label={tip} withArrow>
                <button
                  type="button"
                  aria-label={`Seek to tag at ${t.timestamp.toFixed(1)}s: ${t.label}`}
                  onClick={() => onSeek(t.timestamp)}
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    transform: 'translateX(-50%) rotate(45deg)',
                    width: 10,
                    height: 10,
                    background: t.color || '#7048e8',
                    border: '2px solid #fff',
                    padding: 0,
                    cursor: 'pointer',
                    top: 9,
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
      )}

      {showOcr && (
        <Stack gap={4}>
          <Text size="xs" fw={600}>
            On-screen text timeline
          </Text>
          <Box style={TRACK_STYLE}>
            {ocrList.map((fr, i) => {
              const leftPct = Math.min(100, Math.max(0, (fr.timestampSec / durationSeconds) * 100));
              const g = Boolean(ocrFrameGrounded?.[i]);
              const preview = (fr.text || '').slice(0, 100);
              const tip = preview ? `${preview}${fr.text.length > 100 ? '…' : ''}${g ? ' · grounded' : ''}` : '(no text)';
              return (
                <Tooltip key={`ocr-${i}-${fr.timestampSec}`} label={tip} withArrow multiline w={320}>
                  <button
                    type="button"
                    aria-label={`Seek to OCR sample at ${fr.timestampSec.toFixed(1)}s`}
                    onClick={() => onSeek(fr.timestampSec)}
                    style={{
                      position: 'absolute',
                      left: `${leftPct}%`,
                      transform: 'translateX(-50%)',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: '#495057',
                      border: g ? '2px solid #e67700' : '2px solid #fff',
                      padding: 0,
                      cursor: 'pointer',
                      top: 10,
                      boxShadow: g ? '0 0 0 2px rgba(230,119,0,0.85)' : '0 0 0 1px rgba(0,0,0,0.15)',
                    }}
                  />
                </Tooltip>
              );
            })}
          </Box>
        </Stack>
      )}
    </Stack>
  );
}
