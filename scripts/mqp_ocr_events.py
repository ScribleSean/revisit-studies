#!/usr/bin/env python3
"""
MQP Phase 13.1 — OCR keyframe extractor for reVISit screen recordings.

This script expects JSON on stdin:
{
  "frames": [{ "index": 0, "timestampSec": 12.3, "imagePath": "/tmp/frame.jpg" }, ...],
  "meta": { ... }
}

Stdout: JSON object {"frames": [{index, timestampSec, text, wordCount}], "meta": {...}}
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


def _word_count(text: str) -> int:
    parts = re.findall(r"\b\w+\b", text or "")
    return len(parts)


def _ocr_with_pytesseract(image_path: Path) -> str | None:
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except Exception:
        return None

    try:
        img = Image.open(str(image_path))
        text = pytesseract.image_to_string(img)
        return (text or "").strip()
    except Exception:
        return ""


def _ocr_with_tesseract_cli(image_path: Path) -> str:
    cmd = os.environ.get("TESSERACT_CMD", "tesseract")
    try:
        res = subprocess.run(
            [cmd, str(image_path), "stdout", "-l", os.environ.get("TESSERACT_LANG", "eng")],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        raise RuntimeError("tesseract not found on PATH (install tesseract or add pytesseract+Pillow to the python env)")

    if res.returncode != 0:
        # If tesseract errors, surface stderr; caller treats this as a hard failure.
        err = (res.stderr or "").strip()
        raise RuntimeError(err or f"tesseract failed (exit={res.returncode})")

    return (res.stdout or "").strip()


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception:
        print(json.dumps({"frames": [], "error": "Invalid JSON on stdin"}))
        return 2

    frames = payload.get("frames") or []
    meta_in = payload.get("meta") or {}
    out_frames = []

    mode = "unknown"
    for f in frames:
        idx = int(f.get("index", 0))
        ts = float(f.get("timestampSec", 0.0))
        img_path = Path(str(f.get("imagePath", "")))

        text = _ocr_with_pytesseract(img_path)
        if text is not None:
            mode = "pytesseract"
        else:
            mode = "tesseract-cli"
            text = _ocr_with_tesseract_cli(img_path)

        out_frames.append(
            {
                "index": idx,
                "timestampSec": ts,
                "text": text,
                "wordCount": _word_count(text),
            }
        )

    meta_out = {
        **meta_in,
        "ocrMode": mode,
        "framesProcessed": len(out_frames),
    }

    print(json.dumps({"frames": out_frames, "meta": meta_out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

