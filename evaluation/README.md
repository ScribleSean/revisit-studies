## Evaluation harness

This folder holds a lightweight evaluation workflow for screen-recording analysis.

### Folder layout

- `evaluation/corpus/`: raw video files (`.webm`, `.mp4`, etc). **Not committed**.
- `evaluation/ground_truth/`: one JSON file per clip id (committed).
- `evaluation/results/<runId>/`: generated outputs (mostly ignored by git).
  - `manifest.json`: metadata about a run (**committed**).
  - `report.md`: human-readable report (**committed**).

### Ground truth format

Create `evaluation/ground_truth/<clip-id>.json` shaped like:

- `humanSummary`: 1–3 sentences
- `humanEvents`: array of `{ type, timestamp, evidence? }`
- `humanTags`: array of `{ id, timestamp, label }`
- `raterId`: string

See `evaluation/ground_truth/sample-clip.json` for an example.

### Running

1. Add videos under `evaluation/corpus/` (e.g. `evaluation/corpus/sample-clip.webm`).
2. Add matching ground-truth JSON under `evaluation/ground_truth/`.
3. Run the harness:

```bash
node evaluation/run.mjs --runId "<run-id>"
node evaluation/report.mjs "<run-id>"
```

The runner records per-clip outputs and latency. The report generator compares outputs vs ground truth and computes event precision/recall with a ±2s tolerance.

