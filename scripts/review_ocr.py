"""Bounded local keyframe OCR. Empty frames are evidence and remain in the output."""
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def sample_times(duration, count=8):
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 64:
        raise ValueError("OCR frame count must be between 1 and 64")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("OCR requires a positive recording duration")
    # Exclude the exact endpoint: seeking to EOF cannot yield a decodable frame.
    return [index * duration / count for index in range(count)]


def extract_ocr(filename, duration, count=8, runner=subprocess.run):
    times = sample_times(duration, count)
    tesseract = os.environ.get("REVIEW_TESSERACT", "tesseract")
    ffmpeg = os.environ.get("REVIEW_FFMPEG", "ffmpeg")
    if not shutil.which(tesseract):
        raise RuntimeError("Tesseract is not installed; set REVIEW_TESSERACT to its executable")
    frames = []
    with tempfile.TemporaryDirectory(prefix="review-ocr-") as temporary:
        image = Path(temporary) / "frame.png"
        for index, timestamp in enumerate(times):
            runner([ffmpeg, "-nostdin", "-v", "error", "-y", "-ss", str(timestamp), "-i", str(filename),
                    "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", str(image)],
                   capture_output=True, timeout=30, check=True)
            if not image.is_file():
                raise RuntimeError(f"Could not decode OCR frame at {timestamp:.2f}s")
            result = runner([tesseract, str(image), "stdout", "-l", "eng"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=True)
            text = result.stdout.strip()
            if len(text) > 200000:
                raise RuntimeError("OCR frame text exceeds the output limit")
            frames.append({"index": index, "timestamp": timestamp, "text": text, "wordCount": len(text.split())})
            image.unlink()  # A failed later decode cannot reuse an earlier frame.
    return frames
