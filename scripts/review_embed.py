"""Offline MiniLM embedding worker. Reads one bounded JSON batch from stdin."""
import argparse
import json
from pathlib import Path
import sys


def validate_texts(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 32:
        raise ValueError("Provide between 1 and 32 texts")
    if any(not isinstance(text, str) or not text.strip() or len(text) > 8000 for text in value):
        raise ValueError("Each text must contain 1 to 8000 characters")
    return value


def load_model(directory):
    if not (Path(directory) / "config.json").is_file():
        raise ValueError("Local MiniLM model is not installed")
    import torch
    from sentence_transformers import SentenceTransformer
    torch.set_num_threads(2)
    return SentenceTransformer(str(directory), local_files_only=True, device="cpu")


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-directory", required=True)
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    try:
        model = None
        while True:
            raw = sys.stdin.readline(1100000) if args.worker else sys.stdin.read(1100000)
            if not raw:
                break
            if len(raw) > 1090000:
                raise ValueError("Embedding input exceeds the limit")
            texts = validate_texts(json.loads(raw)["texts"])
            if model is None:
                model = load_model(args.model_directory)
            vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False).tolist()
            print(json.dumps({"vectors": vectors}, allow_nan=False), flush=True)
            if not args.worker:
                break
    except Exception as error:
        print(json.dumps({"error": str(error)[:300]}))
        raise SystemExit(1)
