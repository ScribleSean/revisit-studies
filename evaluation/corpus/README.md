# Evaluation corpus

Committed **`clip-01.webm` … `clip-05.webm`** are tiny synthetic clips (ffmpeg lavfi) so `node evaluation/run.mjs --dry-run` and CI-style checks work without study PII.

For real recordings, add more `clip-*.webm` (or `.mp4`) files **and** matching `evaluation/ground_truth/<id>.json` files. Keep large proprietary videos out of git; use local filenames or Git LFS if you need them in a private fork.
