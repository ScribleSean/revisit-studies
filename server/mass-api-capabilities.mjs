/**
 * Lightweight probes for /api/health so the UI can disable OCR/timeline when deps are missing.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function binaryOnPath(name) {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      execSync(`where ${name}`, { stdio: 'ignore', shell: true, timeout: 5000 });
    } else {
      execSync(`command -v ${name}`, { stdio: 'ignore', timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

export function getMassApiCapabilities() {
  const unixVenv = path.join(REPO_ROOT, '.venv', 'bin', 'python');
  const winVenv = path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe');
  const timelineScript = path.join(REPO_ROOT, 'scripts', 'mqp_timeline_events.py');
  const ocrScript = path.join(REPO_ROOT, 'scripts', 'mqp_ocr_events.py');
  const confusionScript = path.join(REPO_ROOT, 'scripts', 'mqp_confusion_score.py');

  const ffmpeg = binaryOnPath('ffmpeg');
  const tesseract = binaryOnPath('tesseract');
  const python3 = binaryOnPath('python3');
  const pythonVenv = existsSync(unixVenv) || existsSync(winVenv);
  /** Timeline script can run with repo .venv or system python3 (Render / Docker often have no .venv). */
  const timelinePythonRuntime = pythonVenv || python3;
  const timelineScriptPresent = existsSync(timelineScript);
  const ocrScriptPresent = existsSync(ocrScript);
  const confusionScriptPresent = existsSync(confusionScript);

  const ocrReady = ffmpeg && tesseract && ocrScriptPresent;
  const timelineReady = ffmpeg && timelineScriptPresent && timelinePythonRuntime;
  const confusionReady = ocrReady && timelineReady && confusionScriptPresent;

  return {
    ffmpeg,
    tesseract,
    python3,
    pythonVenv,
    timelineScriptPresent,
    ocrScriptPresent,
    confusionScriptPresent,
    ocrReady,
    timelineReady,
    confusionReady,
  };
}
