# Evaluation report — test-01

- Started: 2026-04-25T23:41:46.302Z
- Finished: 2026-04-25T23:41:46.330Z
- Mass API: http://127.0.0.1:3001
- Pipelines: A_gemini_files, B_gpt4o, C_ollama_local, D_heuristic_timeline
- Event tolerance: ±2s (type must match)

> **Pricing note:** Table 3 uses rough token estimates from pipeline `durationMs` (see `evaluation/report.mjs` constants). Treat USD figures as order-of-magnitude placeholders unless you replace them with measured token usage.

## Table 1 — Summary quality (manual 1–3 scores)

| Clip | Pipeline | Accuracy | Completeness | Actionability |
| --- | --- | --- | --- | --- |
| clip-01 | Gemini (Files) | 2 | 2 | 2 |
| clip-01 | GPT-4o vision | 2 | 2 | 2 |
| clip-01 | Ollama / LLaVA | 2 | 1 | 2 |
| clip-01 | Heuristic timeline | 3 | 2 | 2 |
| clip-02 | Gemini (Files) | 2 | 2 | 2 |
| clip-02 | GPT-4o vision | 2 | 2 | 2 |
| clip-02 | Ollama / LLaVA | 1 | 2 | 2 |
| clip-02 | Heuristic timeline | 2 | 3 | 2 |
| clip-03 | Gemini (Files) | 2 | 2 | 2 |
| clip-03 | GPT-4o vision | 2 | 2 | 2 |
| clip-03 | Ollama / LLaVA | 2 | 2 | 1 |
| clip-03 | Heuristic timeline | 2 | 2 | 2 |
| clip-04 | Gemini (Files) | 2 | 1 | 2 |
| clip-04 | GPT-4o vision | 2 | 2 | 2 |
| clip-04 | Ollama / LLaVA | 2 | 2 | 2 |
| clip-04 | Heuristic timeline | 2 | 2 | 3 |
| clip-05 | Gemini (Files) | 2 | 1 | 1 |
| clip-05 | GPT-4o vision | 2 | 2 | 2 |
| clip-05 | Ollama / LLaVA | 2 | 1 | 2 |
| clip-05 | Heuristic timeline | 2 | 2 | 2 |

**Means (finite scores only):**
- Gemini (Files): accuracy=2.00 completeness=1.60 actionability=1.80
- GPT-4o vision: accuracy=2.00 completeness=2.00 actionability=2.00
- Ollama / LLaVA: accuracy=1.80 completeness=1.60 actionability=1.80
- Heuristic timeline: accuracy=2.20 completeness=2.20 actionability=2.20

## Table 2 — Event detection (±2s, type match)

### clip-01

#### Gemini (Files API)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### GPT-4o vision

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### LLaVA / Ollama (local)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### Heuristic (Whisper + PySceneDetect)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

### clip-02

#### Gemini (Files API)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### GPT-4o vision

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### LLaVA / Ollama (local)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### Heuristic (Whisper + PySceneDetect)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

### clip-03

#### Gemini (Files API)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### GPT-4o vision

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### LLaVA / Ollama (local)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### Heuristic (Whisper + PySceneDetect)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

### clip-04

#### Gemini (Files API)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### GPT-4o vision

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### LLaVA / Ollama (local)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### Heuristic (Whisper + PySceneDetect)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

### clip-05

#### Gemini (Files API)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### GPT-4o vision

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### LLaVA / Ollama (local)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

#### Heuristic (Whisper + PySceneDetect)

- Status: **skipped** — Mass API unreachable (start yarn serve:mass-api)

**Aggregate mean F1 (clips where pipeline status=ok):**
- _(No `ok` pipeline runs in this manifest — all skipped or error. Re-run with `yarn serve:mass-api`.)_

## Table 3 — Cost and latency (wall-clock)

| Clip | Pipeline | durationMs | est. cost USD |
| --- | --- | ---: | ---: |
| clip-01 | Gemini (Files API) | — | skipped (skipped) |
| clip-01 | GPT-4o vision | — | skipped (skipped) |
| clip-01 | LLaVA / Ollama (local) | — | skipped (skipped) |
| clip-01 | Heuristic (Whisper + PySceneDetect) | — | skipped (skipped) |
| clip-02 | Gemini (Files API) | — | skipped (skipped) |
| clip-02 | GPT-4o vision | — | skipped (skipped) |
| clip-02 | LLaVA / Ollama (local) | — | skipped (skipped) |
| clip-02 | Heuristic (Whisper + PySceneDetect) | — | skipped (skipped) |
| clip-03 | Gemini (Files API) | — | skipped (skipped) |
| clip-03 | GPT-4o vision | — | skipped (skipped) |
| clip-03 | LLaVA / Ollama (local) | — | skipped (skipped) |
| clip-03 | Heuristic (Whisper + PySceneDetect) | — | skipped (skipped) |
| clip-04 | Gemini (Files API) | — | skipped (skipped) |
| clip-04 | GPT-4o vision | — | skipped (skipped) |
| clip-04 | LLaVA / Ollama (local) | — | skipped (skipped) |
| clip-04 | Heuristic (Whisper + PySceneDetect) | — | skipped (skipped) |
| clip-05 | Gemini (Files API) | — | skipped (skipped) |
| clip-05 | GPT-4o vision | — | skipped (skipped) |
| clip-05 | LLaVA / Ollama (local) | — | skipped (skipped) |
| clip-05 | Heuristic (Whisper + PySceneDetect) | — | skipped (skipped) |

## Table 4 — Confusion score vs human struggle-event density (Pearson r)

Struggle event types: `hesitation`, `confusion_word`, `confused_transition`, `reading`.

- **clip-01:** _(no confusion windows — skipped)._
- **clip-02:** _(no confusion windows — skipped)._
- **clip-03:** _(no confusion windows — skipped)._
- **clip-04:** _(no confusion windows — skipped)._
- **clip-05:** _(no confusion windows — skipped)._

## Time savings (self-reported review timing)

| Clip | Manual (s) | Tool-assisted (s) | Reduction % |
| --- | ---: | ---: | ---: |
| clip-01 | 280 | 42 | 85.0 |
| clip-02 | 240 | 38 | 84.2 |
| clip-03 | 210 | 35 | 83.3 |
| clip-04 | 190 | 33 | 82.6 |
| clip-05 | 165 | 30 | 81.8 |

- **Total manual:** 1085s
- **Total tool-assisted:** 178s
- **Mean per-clip reduction:** 83.4%