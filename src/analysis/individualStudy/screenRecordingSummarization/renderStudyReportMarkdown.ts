import type { StudyReport } from './reportTypes';

function esc(s: string) {
  return s.replace(/\r?\n/g, ' ').trim();
}

export function renderStudyReportMarkdown(report: StudyReport): string {
  const lines: string[] = [];
  lines.push('# Study report');
  lines.push('');
  lines.push(`- Generated at: ${report.generatedAt}`);
  if (report.studyId) lines.push(`- Study: ${report.studyId}`);
  lines.push(`- Total events indexed: ${report.studyAggregates.totalEvents}`);
  lines.push('');

  lines.push('## Aggregates');
  lines.push('');
  lines.push('### Densest moments (30s windows)');
  for (const w of report.studyAggregates.densestMoments) {
    lines.push(`- ${w.participantId} • ${w.taskId} • ${w.count} events @ ${w.start.toFixed(1)}s`);
  }
  lines.push('');
  lines.push('### Co-occurrences (≤2s)');
  for (const p of report.studyAggregates.coOccurrences) {
    lines.push(`- ${p.a} + ${p.b}: ${p.count}`);
  }
  lines.push('');

  lines.push('## Per-clip');
  lines.push('');
  for (const clip of report.perClip) {
    lines.push(`### ${clip.participantId} — ${clip.taskId}`);
    lines.push('');
    if (clip.thumbnailDataUrl) {
      lines.push(`![thumbnail](${clip.thumbnailDataUrl})`);
      lines.push('');
    }
    lines.push(`**Summary:** ${clip.summary ? esc(clip.summary) : '_none_'}`);
    lines.push('');
    if (clip.tags.length > 0) {
      lines.push('**Tags:**');
      for (const t of clip.tags) {
        lines.push(`- ${t.timestamp.toFixed(1)}s — ${esc(t.label)}`);
      }
      lines.push('');
    }
    if (clip.events.length > 0) {
      lines.push('**Events:**');
      for (const e of clip.events) {
        lines.push(`- ${e.type} @ ${e.timestamp.toFixed(1)}s${e.evidence ? ` — ${esc(e.evidence)}` : ''}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}
