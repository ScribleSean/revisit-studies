import type { StudyReport } from './buildStudyReport';

// Preserve source text as text, including Markdown punctuation and HTML-like OCR.
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1');
const cell = (value: string | number) => escape(String(value)).replace(/\r\n|\r|\n/g, '<br>');
function table(headers: string[], rows: (string | number)[][]) {
  return [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`), ''];
}

export function renderStudyReportMarkdown(report: StudyReport) {
  const lines = ['# Recording review report', '', `Study: ${cell(report.studyId)}`, '', `Generated: ${cell(report.generatedAt)}`, '', 'Scope: all registered participants and saved task answers, independent of dashboard filters.', '', `${report.clips.length} recordings; ${report.aggregates.totalEvents} automatic events and researcher tags. Counts are not duration-normalized rates.`, '', '## Events by task', ''];
  lines.push(...table(['Task', 'Event type', 'Count'], Object.entries(report.aggregates.byTask).flatMap(([task, counts]) => Object.entries(counts).map(([type, count]) => [task, type, count]))));
  lines.push('## Events by participant and task', '', ...table(['Participant', 'Task', 'Count'], Object.entries(report.aggregates.byParticipantTask).flatMap(([participant, counts]) => Object.entries(counts).map(([task, count]) => [participant, task, count]))));
  lines.push('## Densest 30-second windows', '', 'Windows can overlap; endpoints describe search windows rather than recording duration.', '', ...table(['Participant', 'Task', 'Start (s)', 'End (s)', 'Events'], report.aggregates.denseWindows.map((window) => [window.participantId, window.taskId, window.start, window.end, window.count])));
  lines.push('## Co-occurrence within two seconds', '', ...table(['First type', 'Second type', 'Pairs'], report.aggregates.pairs.map((pair) => [pair.a, pair.b, pair.count])));
  report.clips.forEach((clip, index) => {
    lines.push(`## Recording ${index + 1}`, '', `Participant: ${cell(clip.participantId)}  `, `Task: ${cell(clip.taskId)}`, '');
    if (clip.thumbnail && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(clip.thumbnail)) lines.push(`![Frame at 25 percent of recording duration](${clip.thumbnail})`, '');
    if (clip.mediaWarning) lines.push(`Thumbnail unavailable: ${cell(clip.mediaWarning)}`, '');
    if (clip.analysis) {
      const { value } = clip.analysis;
      lines.push(`Analysis revision: ${cell(clip.analysis.revision)}  `, `Pipeline: ${cell(value.summary.pipeline)}; model: ${cell(value.summary.model)}`, '');
      if (value.duration !== undefined) lines.push(`Measured duration: ${value.duration} seconds`, '');
      if (value.prompt !== undefined) lines.push('### Researcher prompt used', '', escape(value.prompt) || 'No custom prompt.', '');
      if (value.diagnostics?.length) lines.push('### Diagnostics recorded with this analysis', '', 'These describe the analysis run, not current service or remote-file status.', '', ...value.diagnostics.map((message) => `- ${cell(message)}`), '');
      lines.push('### Summary', '', escape(value.summary.text) || 'No summary saved.', '', '### Automatic events', '', ...table(['Time (s)', 'Type', 'Evidence'], value.events.map((event) => [event.timestamp, event.type, event.evidence])));
      lines.push('### On-screen text', '', ...table(['Time (s)', 'Text'], value.ocr.map((frame) => [frame.timestamp, frame.text])));
      lines.push('### Confusion scores', '', 'Raw weighted evidence, not probabilities. Activity can reduce a score.', '', ...table(['Start (s)', 'End (s)', 'Score', 'Evidence'], value.confusion.map((window) => [window.start, window.end, window.score, window.evidence.join('\n')])));
    } else lines.push('No analysis saved.', '');
    lines.push('### Researcher tags', '', ...table(['Time (s)', 'Label'], clip.tags.map((tag) => [tag.timestamp, tag.label])));
  });
  return `${lines.join('\n')}\n`;
}
