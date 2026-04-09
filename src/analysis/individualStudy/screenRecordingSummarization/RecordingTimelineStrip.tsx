import { Box, Stack, Tooltip } from '@mantine/core';

import type { RecordingTag } from './recordingTagTypes';
import { formatRecordingTime } from './recordingTagTypes';
import type { TimelineEvent, TimelineEventType } from './timelineEventTypes';

function markerColor(t: TimelineEventType): string {
  if (t === 'hesitation') return '#fd7e14';
  if (t === 'confusion_word') return '#fa5252';
  return '#228be6';
}

const TRACK_STYLE = {
  position: 'relative' as const,
  height: 28,
  background: 'rgba(0,0,0,0.06)',
  borderRadius: 6,
};

export function RecordingTimelineStrip({
  events,
  tags,
  durationSeconds,
  onSeek,
}: {
  events: TimelineEvent[];
  tags?: RecordingTag[];
  durationSeconds: number;
  onSeek: (seconds: number) => void;
}) {
  if (durationSeconds <= 0) {
    return null;
  }

  const tagList = tags ?? [];
  const showEvents = events.length > 0;
  const showTags = tagList.length > 0;
  if (!showEvents && !showTags) {
    return null;
  }

  return (
    <Stack gap={6} mt="xs">
      {showEvents && (
        <Box style={TRACK_STYLE}>
          {events.map((e, i) => {
            const leftPct = Math.min(100, Math.max(0, (e.timestamp / durationSeconds) * 100));
            return (
              <Tooltip key={`${e.type}-${i}-${e.timestamp}`} label={`${e.type}: ${e.evidence}`} withArrow>
                <button
                  type="button"
                  aria-label={`Seek to ${e.type} at ${e.timestamp.toFixed(1)}s`}
                  onClick={() => onSeek(e.timestamp)}
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    transform: 'translateX(-50%)',
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: markerColor(e.type),
                    border: '2px solid #fff',
                    padding: 0,
                    cursor: 'pointer',
                    top: 8,
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.15)',
                  }}
                />
              </Tooltip>
            );
          })}
        </Box>
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
    </Stack>
  );
}
