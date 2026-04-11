#!/usr/bin/env python3
"""
MQP Phase 4 — emit timeline events JSON for reVISit screen recordings.

Adapted from v1/analyze_revisit_video.py (Whisper + PySceneDetect), without the full report pipeline.

Dependencies (same family as analyze_revisit_video.py):
  yarn setup:timeline-python
  (creates .venv if missing, installs scripts/requirements-timeline.txt — matches .vscode/settings.json interpreter)

Usage:
  python3 scripts/mqp_timeline_events.py /path/to/recording.webm

Stdout: JSON object {"events": [{type, timestamp, evidence}, ...], "meta": {...}}
"""

from __future__ import annotations

import json
import os
import sys
import argparse
from pathlib import Path
import subprocess

DEFAULT_CONFUSION_PHRASES = [
    "confused",
    "unclear",
    "don't understand",
    "not sure",
    "i don't know",
    "what does",
    "not clear",
    "hard to",
    "difficult",
    "struggling",
    "lost",
    "unsure",
]


def has_audio_stream(video_path: Path) -> bool:
    """
    Best-effort check for an audio track.

    Whisper shells out to ffmpeg; some screen recordings are video-only, which
    causes ffmpeg extraction to fail. We detect that case and fall back to
    scene-only events instead of hard-failing.
    """
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index",
                "-of",
                "csv=p=0",
                str(video_path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            return True  # unknown; proceed with Whisper and let it error if needed
        return bool((res.stdout or "").strip())
    except Exception:
        return True  # ffprobe missing/unavailable; proceed


def analyze_audio_events(video_path: Path, model_size: str, confusion_phrases: list[str]) -> tuple[list[dict], dict]:
    import whisper

    model = whisper.load_model(model_size)
    result = model.transcribe(str(video_path), word_timestamps=True)

    events: list[dict] = []

    # Hesitation: pause > 2s between Whisper segments (same rule as analyze_revisit_video.py)
    segments = result.get("segments") or []
    for i in range(len(segments) - 1):
        gap = float(segments[i + 1]["start"]) - float(segments[i]["end"])
        if gap > 2.0:
            ts = float(segments[i]["end"])
            events.append(
                {
                    "type": "hesitation",
                    "timestamp": round(ts, 3),
                    "evidence": f"Pause ~{gap:.1f}s before next speech",
                }
            )

    # Confusion markers: phrase hits tied to segment start (or word time when available)
    for seg in segments:
        text = (seg.get("text") or "").lower()
        if not text.strip():
            continue
        matched: list[str] = []
        for phrase in confusion_phrases:
            if phrase in text:
                matched.append(phrase)
        if not matched:
            continue
        ts = float(seg.get("start", 0))
        words = seg.get("words") or []
        if words:
            ts = float(words[0].get("start", ts))
        events.append(
            {
                "type": "confusion_word",
                "timestamp": round(ts, 3),
                "evidence": f"Matched: {', '.join(matched[:4])}",
            }
        )

    meta = {
        "whisper_model": model_size,
        "segment_count": len(segments),
    }
    return events, meta


def scene_change_events(video_path: Path, threshold: float = 27.0) -> list[dict]:
    from scenedetect import ContentDetector, detect

    scenes = detect(str(video_path), ContentDetector(threshold=threshold))
    out: list[dict] = []
    for scene in scenes:
        start_time = float(scene[0].get_seconds())
        out.append(
            {
                "type": "scene_change",
                "timestamp": round(start_time, 3),
                "evidence": "PySceneDetect content cut",
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("video_path")
    parser.add_argument("--confusion-words", dest="confusion_words", default="")
    args, _unknown = parser.parse_known_args()

    video_path = Path(args.video_path).resolve()
    if not video_path.is_file():
        print(json.dumps({"events": [], "error": f"File not found: {video_path}"}))
        return 1

    model_size = os.environ.get("WHISPER_MODEL", "base")
    confusion_phrases = DEFAULT_CONFUSION_PHRASES
    if isinstance(args.confusion_words, str) and args.confusion_words.strip():
        confusion_phrases = [w.strip().lower() for w in args.confusion_words.split(",") if w.strip()]

    try:
        meta: dict = {"whisper_model": model_size}

        # Scene detection is useful even when audio/Whisper fails; keep it independent.
        scene_events: list[dict] = []
        try:
            scene_events = scene_change_events(video_path)
        except Exception as e:  # noqa: BLE001
            meta["scene_error"] = str(e)[:300]
            scene_events = []

        audio_events: list[dict] = []
        if not has_audio_stream(video_path):
            meta["audio_skipped"] = True
            meta["audio_skip_reason"] = "no_audio_stream_detected"
        else:
            try:
                audio_events, audio_meta = analyze_audio_events(video_path, model_size, confusion_phrases)
                meta.update(audio_meta)
            except Exception as e:  # noqa: BLE001
                # Fall back to scene-only output (and still succeed) when audio analysis fails.
                meta["audio_skipped"] = True
                meta["audio_skip_reason"] = str(e)[:300]
                audio_events = []

        events = audio_events + scene_events
        events.sort(key=lambda e: e["timestamp"])
        meta["confusion_words"] = confusion_phrases
        print(json.dumps({"events": events, "meta": meta}, indent=None))
        return 0
    except Exception as e:  # noqa: BLE001 — return JSON to Node caller
        msg = str(e)
        print(json.dumps({"events": [], "error": msg, "meta": {"whisper_model": model_size}}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
