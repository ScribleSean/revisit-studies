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

import bisect
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


def whisper_segments(video_path: Path, model_size: str) -> tuple[list[dict], dict]:
    import whisper

    model = whisper.load_model(model_size)
    result = model.transcribe(str(video_path), word_timestamps=True)
    segments = result.get("segments") or []
    meta = {
        "whisper_model": model_size,
        "segment_count": len(segments),
    }
    return segments, meta


def hesitation_confusion_events(segments: list[dict], confusion_phrases: list[str]) -> list[dict]:
    """Hesitation + confusion_word from Whisper segments (no model load)."""
    events: list[dict] = []

    # Hesitation: pause > 2s between Whisper segments (same rule as analyze_revisit_video.py)
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

    return events


def scene_timestamps_sorted(scene_events: list[dict]) -> list[float]:
    return sorted(float(e["timestamp"]) for e in scene_events if "timestamp" in e)


def _scene_in_open_interval(lo: float, hi: float, scene_ts: list[float]) -> bool:
    """True if any scene cut with lo < t < hi (strict interior)."""
    if hi <= lo or not scene_ts:
        return False
    i = bisect.bisect_right(scene_ts, lo)
    return i < len(scene_ts) and scene_ts[i] < hi


def reading_and_confused_transition_events(segments: list[dict], scene_ts: list[float]) -> list[dict]:
    """
    MQP Phase 13.3 — silence / screen-stability heuristics.

    - reading: gap > 3s between speech segments AND no PySceneDetect cut inside the gap.
    - confused_transition: gap > 2s AND at least one scene cut inside the gap.
    (If gap > 3 with a scene cut, only confused_transition fires — not reading.)
    """
    out: list[dict] = []
    for i in range(len(segments) - 1):
        end_i = float(segments[i]["end"])
        start_n = float(segments[i + 1]["start"])
        gap = start_n - end_i
        if gap <= 0:
            continue
        lo, hi = end_i, start_n
        has_scene = _scene_in_open_interval(lo, hi, scene_ts)
        if gap > 2.0 and has_scene:
            out.append(
                {
                    "type": "confused_transition",
                    "timestamp": round(end_i + min(0.5, gap / 2), 3),
                    "evidence": f"Silence ~{gap:.1f}s with scene change in window",
                }
            )
        elif gap > 3.0 and not has_scene:
            out.append(
                {
                    "type": "reading",
                    "timestamp": round(end_i + min(0.5, gap / 2), 3),
                    "evidence": f"Silence ~{gap:.1f}s, stable screen (no scene cut)",
                }
            )
    return out


def _word_starts_from_segments(segments: list[dict]) -> list[float]:
    times: list[float] = []
    for seg in segments:
        for w in seg.get("words") or []:
            try:
                times.append(float(w.get("start", 0)))
            except (TypeError, ValueError):
                continue
    times.sort()
    return times


def _scenes_in_half_open(t0: float, t1: float, scene_ts: list[float]) -> int:
    """Count scene timestamps in [t0, t1)."""
    if t1 <= t0:
        return 0
    lo = bisect.bisect_left(scene_ts, t0)
    hi = bisect.bisect_left(scene_ts, t1)
    return max(0, hi - lo)


def active_interaction_events(
    segments: list[dict],
    scene_ts: list[float],
    duration_sec: float,
    window_sec: float = 30.0,
) -> list[dict]:
    """
    MQP Phase 13.3 — high speech rate + high scene-change rate in the same window.

    Tunable via env (defaults chosen to fire on genuinely busy navigation, not noise):
      MQP_ACTIVE_MIN_WORDS_PER_MIN (default 90)
      MQP_ACTIVE_MIN_SCENES_PER_MIN (default 2.5)
    """
    word_starts = _word_starts_from_segments(segments)
    if not word_starts:
        return []

    min_wpm = float(os.environ.get("MQP_ACTIVE_MIN_WORDS_PER_MIN", "90"))
    min_scpm = float(os.environ.get("MQP_ACTIVE_MIN_SCENES_PER_MIN", "2.5"))

    out: list[dict] = []
    t = 0.0
    while t + window_sec <= duration_sec + 1e-6:
        t1 = t + window_sec
        wc = bisect.bisect_left(word_starts, t1) - bisect.bisect_left(word_starts, t)
        sc = _scenes_in_half_open(t, t1, scene_ts)
        wpm = (wc / window_sec) * 60.0
        scpm = (sc / window_sec) * 60.0
        if wpm > min_wpm and scpm > min_scpm:
            out.append(
                {
                    "type": "active_interaction",
                    "timestamp": round(t + window_sec / 2.0, 3),
                    "evidence": f"~{wpm:.0f} wpm, ~{scpm:.1f} scene cuts/min in {window_sec:.0f}s window",
                }
            )
        t += window_sec
    return out


def media_duration_seconds(video_path: Path, segments: list[dict], scene_ts: list[float]) -> float:
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if res.returncode == 0 and (res.stdout or "").strip():
            d = float((res.stdout or "").strip())
            if d > 0 and d < 1e7:
                return d
    except Exception:
        pass
    seg_end = max((float(s.get("end", 0)) for s in segments), default=0.0)
    sc_max = max(scene_ts, default=0.0)
    return max(seg_end, sc_max, 1.0)


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
        segments: list[dict] = []
        if not has_audio_stream(video_path):
            meta["audio_skipped"] = True
            meta["audio_skip_reason"] = "no_audio_stream_detected"
        else:
            try:
                segments, audio_meta = whisper_segments(video_path, model_size)
                meta.update(audio_meta)
                audio_events = hesitation_confusion_events(segments, confusion_phrases)
            except Exception as e:  # noqa: BLE001
                # Fall back to scene-only output (and still succeed) when audio analysis fails.
                meta["audio_skipped"] = True
                meta["audio_skip_reason"] = str(e)[:300]
                audio_events = []
                segments = []

        scene_ts = scene_timestamps_sorted(scene_events)
        duration_sec = media_duration_seconds(video_path, segments, scene_ts)

        phase13_events: list[dict] = []
        if segments:
            phase13_events.extend(reading_and_confused_transition_events(segments, scene_ts))
            phase13_events.extend(active_interaction_events(segments, scene_ts, duration_sec))

        events = audio_events + scene_events + phase13_events
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
