import { expect, test } from 'vitest';
import type { StudyReport } from '../buildStudyReport';
import { renderStudyReportMarkdown } from '../renderStudyReportMarkdown';

test('exports evidence and aggregates while escaping source markup and table delimiters', () => {
  const report: StudyReport = {
    studyId: '<study>',
    generatedAt: '2026-09-09',
    aggregates: {
      totalEvents: 1, byTask: { task: { reading: 1 } }, byParticipantTask: { participant: { task: 1 } }, denseWindows: [], pairs: [],
    },
    clips: [{
      participantId: 'participant|two',
      taskId: 'task',
      thumbnail: 'data:image/jpeg;base64,aA==',
      tags: [{ id: '1', timestamp: 2, label: 'A|B\n[link](https://example.com)' }],
      analysis: {
        version: 1,
        revision: 'revision',
        updatedAt: '2026-09-09',
        value: {
          duration: 4,
          prompt: '<Observe> errors',
          diagnostics: ['OCR unavailable: <error>'],
          summary: { text: '<script>alert(1)</script>\n# heading', pipeline: 'heuristic', model: 'test' },
          events: [],
          ocr: [{ timestamp: 1, text: '<img src=x>' }],
          confusion: [{
            start: 0, end: 4, score: -1, evidence: ['A|B'],
          }],
        },
      },
    }],
  };
  const markdown = renderStudyReportMarkdown(report);
  expect(markdown).toContain('![Frame at 25 percent of recording duration](data:image/jpeg;base64,aA==)');
  expect(markdown).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt;\n\\# heading');
  expect(markdown).toContain('A\\|B<br>\\[link\\]');
  expect(markdown).not.toContain('<img');
  expect(markdown).toContain('Measured duration: 4 seconds');
  expect(markdown).toContain('### Researcher prompt used\n\n&lt;Observe&gt; errors');
  expect(markdown).toContain('### Diagnostics recorded with this analysis');
  expect(markdown).toContain('- OCR unavailable: &lt;error&gt;');
  expect(markdown).toContain('## Events by participant and task');
  report.clips[0].thumbnail = 'https://example.com/tracker';
  report.clips[0].analysis = null; report.clips[0].mediaWarning = 'Video missing';
  const missing = renderStudyReportMarkdown(report);
  expect(missing).not.toContain('![Frame');
  expect(missing).toContain('Thumbnail unavailable: Video missing');
  expect(missing).toContain('No analysis saved.');
});
