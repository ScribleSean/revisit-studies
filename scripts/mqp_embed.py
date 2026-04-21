#!/usr/bin/env python3
"""
Embed text with sentence-transformers (default: all-MiniLM-L6-v2, ~384 dims).

Reads one JSON object from stdin: { "text": "<string>" }
Writes JSON to stdout: { "embedding": [...], "model": "<id>", "durationMs": <int> }

Env:
  MQP_EMBED_MODEL — HuggingFace model id (default: all-MiniLM-L6-v2)
"""
from __future__ import annotations

import json
import os
import sys
import time


def main() -> int:
    started = time.time()
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid stdin JSON: {e}"}))
        return 2

    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        print(json.dumps({"error": 'Missing or empty "text" string'}))
        return 2

    model_id = payload.get("model") or os.environ.get("MQP_EMBED_MODEL") or "sentence-transformers/all-MiniLM-L6-v2"

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "sentence-transformers not installed. "
                    "pip install -r scripts/requirements-embed.txt",
                },
            ),
        )
        return 3

    st = SentenceTransformer(model_id)
    vec = st.encode(text.strip(), normalize_embeddings=False)
    emb = [float(x) for x in vec.tolist()]
    duration_ms = int((time.time() - started) * 1000)
    out = {
        "embedding": emb,
        "model": model_id,
        "durationMs": duration_ms,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
