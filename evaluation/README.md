## Evaluation harness

Head-to-head comparison of four analysis pipelines (Phase 14), plus OCR and confusion-score fusion on every clip.

### Folder layout

- `evaluation/corpus/`: video files named `clip-01.webm`, … (committed synthetic clips; add your own locally if needed).
- `evaluation/ground_truth/`: one JSON file per clip id (committed).
- `evaluation/human_scores.json`: manual 1–3 ratings for Table 1 (committed template).
- `evaluation/time_study.json`: manual vs tool-assisted review times (Phase 14.4).
- `evaluation/results/<runId>/`: generated per-clip JSON + `manifest.json` (see `.gitignore`; `test-01` is committed as a fixture when present).

### Ground truth format

Each `evaluation/ground_truth/<clip-id>.json` includes:

- `humanSummary`, `humanEvents` (`type`, `timestamp`, `evidence?`), `humanTags`, `raterId`
- Optional: `clipDurationSec`, `taskDescription`

### Commands

```bash
# List corpus + health (no API calls to pipelines)
node evaluation/run.mjs --dry-run

# Full run (requires `yarn serve:mass-api`; pipelines skip cleanly if keys/services missing)
node evaluation/run.mjs --runId "my-run-01"
node evaluation/run.mjs --runId "my-run-01" --mass-api-url http://127.0.0.1:3001

# Markdown report (four tables + time savings)
node evaluation/report.mjs "my-run-01"
```

Event matching in reports uses **±2 seconds** and **type equality**, consistent with earlier phases.

### Semantic embeddings (dashboard)

Cross-clip semantic search calls **`POST /api/embed-summary`** on the mass API. Install **`sentence-transformers`** into the repo **`.venv`** (`yarn setup:embed-python` or `pip install -r scripts/requirements-embed.txt`), then run **`yarn serve:mass-api`**. Embeddings are stored per clip after **mass** summarization with persistence enabled.
