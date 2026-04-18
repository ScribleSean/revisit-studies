#!/usr/bin/env python3
"""
MQP Phase 13.4 — multi-signal confusion score from timeline events + OCR frames.

Reads a single JSON object from stdin:
  { "events": [...], "ocr": { "frames": [ { "timestampSec", "text", ... }, ... ] } }

Each timeline event is expected to have: type, timestamp, evidence (strings).

Window score (default 30s, half-open [start, end)):
  hesitation_count * w_hes
  + confusion_word_count * w_conf (per grounded event: * ocr_grounding_mult)
  + confused_transition_count * w_ct
  + scene_change_count * w_sc
  + reading_count * w_read   # (same family; weight 0 by default so formula matches prompt)
  - active_interaction_count * w_ai

Default weights match the Part 3 prompt for the first five terms; `reading` is included
with weight 0 unless overridden so older specs still match.

CLI overrides (optional):
  --window-sec, --w-hesitation, --w-confusion, --w-confused-transition, --w-scene,
  --w-reading, --w-active, --ocr-grounding-mult

Stdout: JSON { windows, totalScore, maxWindow, meta }
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any


def parse_matched_phrases(evidence: str) -> list[str]:
    m = re.search(r"matched:\s*(.+)$", evidence.strip().lower())
    if not m:
        return []
    part = m.group(1)
    return [p.strip() for p in part.split(",") if p.strip()]


def ocr_text_for_window(frames: list[dict], start: float, end: float) -> str:
    parts: list[str] = []
    for fr in frames:
        try:
            ts = float(fr.get("timestampSec", fr.get("timestamp", 0)))
        except (TypeError, ValueError):
            continue
        if start <= ts < end:
            t = fr.get("text")
            if isinstance(t, str) and t.strip():
                parts.append(t)
    return " ".join(parts).lower()


def confusion_weight_for_event(evidence: str, ocr_blob: str, w_conf: float, grounding_mult: float) -> float:
    phrases = parse_matched_phrases(evidence)
    if not phrases:
        return w_conf
    grounded = any(p and p in ocr_blob for p in phrases)
    return w_conf * (grounding_mult if grounded else 1.0)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--window-sec", type=float, default=30.0)
    p.add_argument("--w-hesitation", dest="w_hes", type=float, default=1.0)
    p.add_argument("--w-confusion", dest="w_conf", type=float, default=1.5)
    p.add_argument("--w-confused-transition", dest="w_ct", type=float, default=2.0)
    p.add_argument("--w-scene", dest="w_sc", type=float, default=0.5)
    p.add_argument("--w-reading", dest="w_read", type=float, default=0.0)
    p.add_argument("--w-active", dest="w_ai", type=float, default=0.5)
    p.add_argument("--ocr-grounding-mult", dest="ocr_g", type=float, default=1.5)
    args = p.parse_args()

    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid stdin JSON: {e}", "windows": []}))
        return 2

    events: list[dict[str, Any]] = list(payload.get("events") or [])
    ocr = payload.get("ocr") or {}
    frames: list[dict[str, Any]] = list(ocr.get("frames") or []) if isinstance(ocr, dict) else []

    times: list[float] = []
    for e in events:
        try:
            times.append(float(e.get("timestamp", 0)))
        except (TypeError, ValueError):
            continue
    for fr in frames:
        try:
            times.append(float(fr.get("timestampSec", fr.get("timestamp", 0))))
        except (TypeError, ValueError):
            continue
    duration = max(times + [args.window_sec])

    w = args.window_sec
    windows_out: list[dict[str, Any]] = []
    total = 0.0
    max_win: dict[str, Any] | None = None

    t = 0.0
    while t + w <= duration + 1e-9:
        end = t + w
        ocr_blob = ocr_text_for_window(frames, t, end)

        counts: dict[str, int] = {
            "hesitation": 0,
            "confusion_word": 0,
            "confused_transition": 0,
            "scene_change": 0,
            "reading": 0,
            "active_interaction": 0,
        }
        conf_weight_sum = 0.0
        ocr_grounded_any = False

        for e in events:
            et = e.get("type")
            if not isinstance(et, str):
                continue
            try:
                ts = float(e.get("timestamp", 0))
            except (TypeError, ValueError):
                continue
            if not (t <= ts < end):
                continue
            if et not in counts:
                continue
            if et == "confusion_word":
                ev = e.get("evidence", "")
                evs = ev if isinstance(ev, str) else ""
                cw = confusion_weight_for_event(evs, ocr_blob, args.w_conf, args.ocr_g)
                conf_weight_sum += cw
                if cw > args.w_conf + 1e-9:
                    ocr_grounded_any = True
                counts["confusion_word"] += 1
            else:
                counts[et] += 1

        score = (
            counts["hesitation"] * args.w_hes
            + conf_weight_sum
            + counts["confused_transition"] * args.w_ct
            + counts["scene_change"] * args.w_sc
            + counts["reading"] * args.w_read
            - counts["active_interaction"] * args.w_ai
        )

        win = {
            "startSec": round(t, 3),
            "endSec": round(end, 3),
            "score": round(score, 4),
            "counts": counts,
            "ocrGrounded": ocr_grounded_any,
        }
        windows_out.append(win)
        total += score
        if max_win is None or score > float(max_win.get("score", 0)):
            max_win = win
        t += w

    out = {
        "windows": windows_out,
        "totalScore": round(total, 4),
        "maxWindow": max_win,
        "meta": {
            "windowSec": w,
            "weights": {
                "hesitation": args.w_hes,
                "confusion_word": args.w_conf,
                "confused_transition": args.w_ct,
                "scene_change": args.w_sc,
                "reading": args.w_read,
                "active_interaction": args.w_ai,
                "ocrGroundingMult": args.ocr_g,
            },
        },
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
