import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalysisError, runProcess } from './process.mjs';
import { scoreConfusion } from './confusion.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eventTypes = new Set(['hesitation', 'confusion_word', 'reading', 'confused_transition', 'active_interaction', 'scene_change']);

export function createTimelineAnalyzer({ python, ffprobe = 'ffprobe', ffmpegDirectory = '', modelDirectory = path.join(root, '.review-models'), model = 'base' }) {
  const analyzer = async ({ filename, signal, confusionWords }) => {
    const args = [path.join(root, 'scripts/review_timeline.py'), filename, '--model-directory', modelDirectory, '--model', model];
    if (confusionWords) args.push('--confusion-words', confusionWords);
    const { stdout } = await runProcess(python, args, {
      signal,
      timeoutMs: 15 * 60 * 1000,
      cwd: root,
      env: { ...process.env, FFPROBE: ffprobe, PATH: `${ffmpegDirectory}${path.delimiter}${process.env.PATH || ''}` },
    });
    let result;
    try { result = JSON.parse(stdout); } catch { throw new AnalysisError('INVALID_RESULT', 'Timeline returned malformed JSON'); }
    const duration = result?.meta?.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(result.events) || result.events.some((event) => !eventTypes.has(event.type) || !Number.isFinite(event.timestamp) || event.timestamp < 0 || event.timestamp > duration || typeof event.evidence !== 'string')) {
      throw new AnalysisError('INVALID_RESULT', 'Timeline returned invalid events or duration');
    }
    return {
      ...result,
      confusion: scoreConfusion(result.events, result.ocr || [], duration),
      summary: { text: `${result.events.length} observable timeline events detected.${result.meta.audio_skipped ? ' Audio analysis was skipped; review the diagnostic before interpreting this result.' : ''}`, pipeline: 'heuristic', model: `Whisper ${model} + PySceneDetect` },
    };
  };
  analyzer.version = `timeline-v4:${model}:ocr-${process.env.REVIEW_OCR_FRAMES || 8}`;
  return analyzer;
}
