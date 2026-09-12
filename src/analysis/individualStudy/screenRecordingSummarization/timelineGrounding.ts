import type { ReviewArtifacts } from '../../../storage/reviewArtifacts';

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:'\p{L}+)?/gu) || [];

/** Same exact-phrase, three-second-bin rule used by the local confusion scorer. */
export function timelineGrounding(events: ReviewArtifacts['events'], ocr: ReviewArtifacts['ocr']) {
  const frames = new Map<number, { index: number; words: string[] }[]>();
  ocr.forEach((frame, index) => {
    if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0) return;
    const bin = Math.floor(frame.timestamp / 3);
    const rows = frames.get(bin) || [];
    rows.push({ index, words: tokens(frame.text) }); frames.set(bin, rows);
  });
  const eventIndices = new Set<number>();
  const frameIndices = new Set<number>();
  events.forEach((event, index) => {
    if (event.type !== 'confusion_word' || !Number.isFinite(event.timestamp) || event.timestamp < 0) return;
    const phrase = event.evidence.match(/^Matched:\s*(.+)$/i)?.[1];
    if (!phrase) return;
    const target = tokens(phrase);
    if (!target.length) return;
    (frames.get(Math.floor(event.timestamp / 3)) || []).forEach((frame) => {
      if (frame.words.some((_, offset) => target.every((word, position) => frame.words[offset + position] === word))) {
        eventIndices.add(index); frameIndices.add(frame.index);
      }
    });
  });
  return { eventIndices, frameIndices };
}
