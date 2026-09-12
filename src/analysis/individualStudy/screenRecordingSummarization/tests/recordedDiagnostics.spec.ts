import { expect, test } from 'vitest';
import { recordedDiagnostics, type ReviewDiagnosticMeta } from '../recordedDiagnostics';

test('records independent diagnostics with stable labels and bounded messages', () => {
  expect(recordedDiagnostics({ duration: 4 })).toEqual([]);
  const messages = recordedDiagnostics({
    duration: 4, audio_skipped: true, audio_skip_reason: 'no_audio_stream', scene_error: 'decoder failed', ocr_error: 'x'.repeat(2000), cleanupWarning: 'Remote cleanup queued',
  });
  expect(messages).toHaveLength(4);
  expect(messages[0]).toBe('Audio analysis skipped: no_audio_stream');
  expect(messages[1]).toBe('Scene analysis: decoder failed');
  expect(messages[2]).toHaveLength(2000);
  expect(messages[2].endsWith('…')).toBe(true);
  expect(messages[3]).toBe('Remote cleanup queued');
});

test('rejects malformed service diagnostics before persistence or rendering', () => {
  for (const bad of [{ audio_skipped: 'yes' }, { scene_error: {} }, { cleanupWarning: 'x'.repeat(2001) }, { ocr_error: null }]) {
    expect(() => recordedDiagnostics({ duration: 4, ...bad } as ReviewDiagnosticMeta)).toThrow();
  }
});
