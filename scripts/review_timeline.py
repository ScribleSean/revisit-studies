"""Local think-aloud analysis. stdout is one JSON result; models stay on disk."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess
from review_ocr import extract_ocr

DEFAULT_PHRASES = ["wait", "hold on", "confused", "unclear", "not sure", "don't understand", "where is", "how do i", "unsure"]


def tokens(text):
    return re.findall(r"[\w]+(?:'\w+)?", str(text).lower())


def is_digital_silence(filename):
    """Skip only an exactly zero decoded track, never low-volume speech."""
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-xerror", "-i", str(filename),
        "-map", "0:a:0", "-af",
        "astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level",
        "-vn", "-sn", "-dn", "-f", "null", "-",
    ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, check=True)
    peaks = re.findall(r"Peak level dB:\s*(\S+)", result.stderr)
    return peaks == ["-inf"]


def transcript_events(segments, cuts, duration, phrases):
    """Extract word-aligned pauses/phrases without running a model."""
    words = []
    for segment in segments:
        for word in segment.get("words", []):
            start, end = word.get("start"), word.get("end")
            if (isinstance(start, (int, float)) and isinstance(end, (int, float))
                    and math.isfinite(start) and math.isfinite(end) and 0 <= start <= end <= duration):
                words.append({"start": start, "end": end, "tokens": tokens(word.get("word", ""))})
    words.sort(key=lambda word: word["start"])
    events = []
    for previous, current in zip(words, words[1:]):
        gap = current["start"] - previous["end"]
        if gap > 2:
            evidence = f"Silence from {previous['end']:.2f}s to {current['start']:.2f}s"
            events.append({"type": "hesitation", "timestamp": previous["end"], "evidence": evidence})
            crossing = any(previous["end"] < cut < current["start"] for cut in cuts)
            if crossing or gap > 3:
                events.append({"type": "confused_transition" if crossing else "reading", "timestamp": previous["end"], "evidence": evidence + (" with a scene change" if crossing else " without a scene change")})
    flattened = [(token, word["start"]) for word in words for token in word["tokens"]]
    for phrase in dict.fromkeys(phrases):
        target = tokens(phrase)
        if not target:
            continue
        for index in range(len(flattened) - len(target) + 1):
            if [item[0] for item in flattened[index:index + len(target)]] == target:
                events.append({"type": "confusion_word", "timestamp": flattened[index][1], "evidence": f"Matched: {phrase}"})
    for start in range(0, math.ceil(duration), 30):
        end = min(start + 30, duration)
        count = sum(start <= word["start"] < end for word in words)
        scene_count = sum(start <= cut < end for cut in cuts)
        if end > start and count * 60 / (end - start) >= 120 and scene_count >= 2:
            events.append({"type": "active_interaction", "timestamp": start, "evidence": f"{count} words and {scene_count} scene changes in {end - start:g}s"})
    return sorted(events, key=lambda event: event["timestamp"])


def analyze(filename, phrases, model_directory, model="base"):
    probe = subprocess.run([os.environ.get("FFPROBE", "ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(filename)], capture_output=True, text=True, timeout=30, check=True)
    metadata = json.loads(probe.stdout)
    if not any(stream.get("codec_type") == "video" for stream in metadata.get("streams", [])):
        raise ValueError("Recording contains no video stream")
    try:
        duration = float(metadata.get("format", {}).get("duration", 0))
    except (ValueError, TypeError):
        duration = 0
    if not math.isfinite(duration) or duration < 0:
        duration = 0
    meta = {"audio_skipped": False, "whisper_model": model}
    cuts = []
    try:
        from scenedetect import ContentDetector, detect
        scenes = detect(str(filename), ContentDetector(threshold=27.0))
        if scenes:
            duration = max(duration, scenes[-1][1].get_seconds())
        cuts = [scene[0].get_seconds() for scene in scenes if scene[0].get_seconds() > 0]
    except Exception as error:
        meta["scene_error"] = str(error)[:300]
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Recording duration could not be determined")
    segments = []
    if not any(stream.get("codec_type") == "audio" for stream in metadata.get("streams", [])):
        meta.update(audio_skipped=True, audio_skip_reason="no_audio_stream")
    else:
        try:
            if is_digital_silence(filename):
                meta.update(audio_skipped=True, audio_skip_reason="digital_silence")
            else:
                model_path = Path(model_directory) / f"{model}.pt"
                if not model_path.is_file():
                    raise RuntimeError(f"Local Whisper model {model} is not installed")
                import torch
                import whisper
                torch.set_num_threads(2)
                transcriber = whisper.load_model(str(model_path))
                segments = transcriber.transcribe(str(filename), word_timestamps=True, fp16=False).get("segments", [])
        except Exception as error:
            meta.update(audio_skipped=True, audio_skip_reason=str(error)[:300])
    events = transcript_events(segments, cuts, duration, phrases)
    events.extend({"type": "scene_change", "timestamp": cut, "evidence": "PySceneDetect content cut"} for cut in cuts if cut <= duration)
    events.sort(key=lambda event: event["timestamp"])
    meta["duration"] = duration
    meta["confusion_words"] = phrases
    ocr = []
    try:
        ocr = extract_ocr(filename, duration, int(os.environ.get("REVIEW_OCR_FRAMES", "8")))
    except Exception as error:
        meta["ocr_error"] = str(error)[:300]
    return {"events": events, "ocr": ocr, "meta": meta}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("filename", type=Path)
    parser.add_argument("--confusion-words", default=",".join(DEFAULT_PHRASES))
    parser.add_argument("--model-directory", default=str(Path(__file__).resolve().parent.parent / ".review-models"))
    parser.add_argument("--model", default="base", choices=["tiny", "base", "small"])
    args = parser.parse_args()
    try:
        print(json.dumps(analyze(args.filename, [p.strip() for p in args.confusion_words.split(",") if p.strip()], args.model_directory, args.model), allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": str(error)[:300]}))
        raise SystemExit(1)
