# ReVISit study – Interactive, Web-Based User Studies.

ReVISit introduces reVISit.spec, a DSL for specifying study setups (consent forms, training, trials, etc.) for interactive web-based studies. You describe your experimental setup in reVISit.spec, add your stimuli as images, forms, HTML pages, or React components, build and deploy — and you're ready to run your study. For tutorials and documentation, see the [reVISit website](https://revisit.dev).

Create your own interactive, web-based data visualization by starting from the [template repository](https://github.com/revisit-studies/template) that tracks the stable version of this repository but removes unnecessary code baggage. Check out the [installation documentation](https://revisit.dev/docs/getting-started/installation/) for details.

## ReVIEW rebuild and browser demo

This rebuild includes upstream `revisit-studies/study` through commit `8969435bcef7117b96f204b3442ed601b5573b10`, fetched September 12, 2026. It uses the current upstream architecture and dependencies, with ReVIEW recording analysis added on top. The deployed application does not depend on the old fork implementation. Report parity remains subject to the verification limits below.

### Try it now

Open the [GitHub Pages demo](https://scriblesean.github.io/revisit-studies/review-demo), then select **Load simulated recordings**. This adds six explicitly labeled participants to each of two existing studies, with 18 saved recordings in total. The examples reuse three small, scripted chart animations: fluent, hesitant, and reconsidering. They include saved summaries, all six event types across the examples, OCR, confusion scores, and researcher tags.

Choose **Review recordings** to play a clip, seek from evidence, add tags, and export Markdown or JSON. Choose **Compare recordings** to explore event counts, co-occurrence, and dense time windows. **All studies** opens the existing upstream study collection. **Try the actual study** runs the original example; simulated recordings are illustrative animations, not recordings of those actual sessions.

Demo data stays in this browser's IndexedDB. Loading is atomic and repeatable: existing participant IDs and reviewer edits are preserved, and failed downloads do not leave a partial import. It does not upload anything or require a login. Clearing site data removes local data. The assets can be regenerated with `node scripts/generate-review-demo.mjs` after installing Playwright Chromium.

**GitHub Pages supports saved analysis, playback, tags, exports, and dashboards. New AI analysis, batch processing, and semantic queries require the local Node/Python bridge.** The sample evidence is scripted, not AI output, and cannot establish accuracy or time savings. The local setup below enables fresh analysis of your own recordings.

The Pages workflow builds with Node 24, the frozen Yarn 1 lockfile, `VITE_BASE_PATH=/revisit-studies/`, and `VITE_STORAGE_ENGINE=localStorage`, then publishes `gh-pages`. The existing SPA fallback supports bookmarked analysis routes. Vite preview now respects the production base path, so the same deployment can be verified locally.

The recording view now puts playback and timeline evidence before export, pipeline setup, and legacy-import controls. Browser test helpers accept `REVIEW_TEST_STORAGE_PREFIX=prod` when checking a production build instead of accidentally reading the development database. The focused demo test also accepts `REVIEW_DEMO_BASE_PATH=/revisit-studies/` to exercise the real Pages route prefix.

### Comparison with the MQP report

| Report capability | Rebuild status | What the Pages demo proves |
| --- | --- | --- |
| Recording review and cross-clip analysis tabs | Implemented on current upstream storage and routing | Navigation, saved playback, evidence, and comparisons |
| Six timestamped events, OCR grounding, confusion scoring | Implemented; real local speech/OCR extraction tested separately | Scripted examples and seeking; not detection accuracy |
| Gemini, GPT, local VLM, and deterministic pipelines | Adapters and failure/cancellation contracts tested; deterministic local pipeline exercised with real tools | Saved output only; no live model execution |
| Researcher tags, prompts, batch analysis, cache | Implemented with cancellation, atomic saves, and retained successful results | Tags and saved review; batch/model operations need the bridge |
| MiniLM semantic search | Real local embeddings verified; stale revisions excluded | Semantic queries need the local bridge; synthetic examples do not claim search quality |
| Nine artifact categories, snapshots, Markdown/JSON exports | Storage lifecycle and export tests cover the rebuilt schema and legacy imports | Browser-local exports; cloud service lifecycle coverage uses tests, not a production cloud deployment |
| Reproducible evaluation and review-time improvement | Evaluation tooling and synthetic checks exist | No reproduction of the report's human review-time or model-quality results |

The rebuild adds stronger save consistency, cancellation, bounded queues, cache validation, local dependency reuse, and regression coverage. Those changes improve reliability; they do not establish that the rebuild matches the report's claimed model quality or 83.4% researcher time reduction. A labeled participant corpus and a new human review study remain necessary for those claims. Unlike the report's browser/cloud fallback, model calls in this rebuild go through the local bridge so credentials stay out of the browser.

### Improvements implemented

The rebuild has seven main parts you can trace in order:

1. **Study recordings:** the existing storage engine supplies participant/task identities and media.
2. **Review controls:** the React view captures the chosen pipeline, phrases, and prompt, then starts a cancellable request.
3. **Local bridge:** Node accepts a bounded upload, checks its cache, and runs the selected analyzer.
4. **Evidence extraction:** Python/media tools produce timestamped events and OCR; Node combines them into confusion windows. Optional model adapters add a summary.
5. **Atomic analysis storage:** one revision saves the summary and evidence together. Tags remain independently editable.
6. **Search and comparison:** background embeddings reference that revision; the dashboard reads saved evidence and groups it by recording identity.
7. **Exports:** Markdown presents the study results; JSON preserves the nine logical artifact categories for inspection.

The key rule is that saving analysis does not depend on successful search indexing. A recording can be reviewed and exported even when its embedding fails; stale embeddings are excluded until indexing succeeds.

- **Bulk analysis and automatic embeddings:** use **Analyze listed recordings** to process the recordings currently listed by the analysis filters. Each recording saves atomically, shows progress, and continues past failed/missing media. **Cancel batch** preserves completed results; **Retry unfinished recordings** retries failed/cancelled analysis jobs. Single analyses update embeddings in the background after saving. Batches overlap one indexing job with later analysis, and indexing failures preserve the analysis. Leaving the view cancels its work; jobs are not resumable across a page reload. Manual **Index saved recordings** remains available for indexing recovery. Starting a batch closes the selected clip's earlier background work to keep concurrency bounded.

- **Atomic analysis saves:** summary, events, OCR, and confusion scores now occupy one versioned `review-analysis` object with a unique revision. A failed upload leaves the previous complete result available; the UI reads one coherent object. The four public artifact categories remain accessible through `getReviewArtifact`, while new writes use `saveReviewAnalysis` and coherent reads use `getReviewAnalysis`. Individual writes/deletes for these four categories are rejected once a bundle exists to avoid silently shadowed edits. Older individual artifacts remain readable. Snapshot restore preserves the analysis revision, and embeddings store `analysisRevision` so stale indexing results are excluded. Local tests cover interrupted writes, study switching, legacy fallback, and snapshot restore. Chromium verifies reanalysis exclusion and reindex recovery. The combined storage/analysis suite now passes 384 tests across 33 files, including persisted diagnostics; current browser verification is described below.

- **Recording review:** the analysis screen now has a Recording review tab for completed participant tasks. Play recordings, run local timeline analysis, inspect saved summaries/events, seek to evidence, add/delete timestamped tags, and save study-specific confusion phrases. Saved work remains accessible when the analysis service is unavailable. Failed tag saves retain text; failed tag reads disable edits to protect existing annotations. Evidence controls have a minimum 44px height and wrap long text.
- **Typed artifact storage:** nine versioned categories cover summaries, events, tags, OCR, confusion scores, embeddings, prompts, the study event index, and settings. Local/Firebase/Supabase adapters support them, including snapshot operations. Capturing the originating study and payload prevents an in-flight save from being redirected by a study switch. Invalid timestamps, sparse arrays, and invalid embeddings are rejected. Cloud permission and copy errors are surfaced instead of reported as missing/successful data.
- **Local processing:** a native Node bridge streams bounded video uploads to temporary files, limits concurrent jobs, supports cancellation, and cleans up. Its content/configuration cache survives restarts and bounds disk use. Degraded audio/scene/OCR results are retried so repaired dependencies can take effect. Windows process cancellation falls back to direct child termination when `taskkill` fails.
- **Timeline extraction:** ffprobe, PySceneDetect, and installed Whisper weights provide six event types, word-aligned phrase matches, pauses, and scene changes. Missing audio or dependencies produce diagnostics. Analysis never downloads models automatically.
- **Confusion scoring:** the bridge computes raw weighted scores across the full recording in fixed 30-second windows, including empty windows. OCR grounding uses exact phrases in the same three-second bin. These are evidence weights, not probabilities. The report's rendered formula omits operators: the implementation uses the old code's subtractive activity term with the report's magnitude of 0.5; default weights are hesitation +1, confusion phrase +1.5, confused transition +2, scene change +0.5, reading 0, activity -0.5, and grounded-phrase multiplier 1.5. The scoring function accepts weight/window overrides. OCR text and scores are saved with the analysis and displayed as seekable controls. Score bars show relative magnitude; their labels preserve raw values.
- **Aggregation correctness/performance:** tuple identities prevent clip-key collisions; null-prototype grouping handles special keys safely. Dense-window queries materialize only returned slices, and co-occurrence counting avoids enumerating every event pair. An independent fixture verifies 100,000,000 expected pairs from 20,000 events.
- **MVNV replay fix:** saved selection is reapplied after asynchronous matrix rendering, fixing the initially empty replay selection without weakening its browser test.
- **Supabase snapshots:** file listings now paginate in name order instead of stopping at the default first page. Copies run in batches of 16; deletion first collects the complete file list, then removes batches of 100 so changing offsets cannot skip files. Nested directory entries remain handled by the snapshot caller. Listing/download/upload/deletion failures propagate. A 250-file mocked regression verifies complete copy/deletion and source preservation; live cloud verification remains pending.

### Run recording analysis locally

**Semantic search:** install the public `sentence-transformers/all-MiniLM-L6-v2` model once and save it to `.review-models/minilm` using `SentenceTransformer(...).save(...)`. Runtime embedding requests are offline. In Recording review, use **Index saved recordings**, then enter a query in **Search recording content**. Indexing combines saved summary, event evidence, and OCR text (up to 8,000 characters) and batches up to 32 clips per model invocation. Search shows up to five cosine-ranked results and opens their participant/task recording. Incompatible model/dimension vectors are excluded. Embeddings record their source analysis revision. Search excludes an embedding when reanalysis changes that revision, including an older indexing job that finishes later. Successful analyses request background indexing when MiniLM is available; use manual indexing to recover failed/cancelled indexing. The embedding worker now retains MiniLM in memory across requests. A real run measured 14.4s for first load, 21.4ms for a different uncached query on the warm worker, and 20.0ms for a disk-cache hit. Before reuse, an uncached batch took 56.7s in an earlier run. These are individual local observations, not distribution benchmarks; first-load delay remains. The worker serializes jobs with a bounded queue, cancels queued requests independently, restarts after active cancellation/crash/timeout, and stops when the HTTP server closes.

**OCR setup:** install Tesseract with English language data, or point `REVIEW_TESSERACT` to an unpacked executable. The [Tesseract installation documentation](https://tesseract-ocr.github.io/tessdoc/Installation.html) links supported Windows builds. `REVIEW_OCR_FRAMES` controls the number of evenly sampled frames (default 8; allowed 1–64). Empty-text frames are retained. Missing Tesseract or a failed frame produces an OCR diagnostic while timeline-only scoring still completes. Temporary images are removed, and a failed decode cannot reuse a previous image.

The local verification used the [5.5.0 Windows release asset](https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.0), unpacked without running its installer, and English `tessdata_fast` at revision `87416418657359cb625c412a48b6e1d6d41c29bd`. A synthetic audiovisual test recognized text in eight frames and all three spoken phrases. The matching on-screen phrase raised its event weight from 1.5 to 2.25, yielding total score 5.25. This checks actual offline OCR/speech/fusion; it does not measure accuracy on participant recordings.

Use Node 24 and Yarn 1 for this checkout. Install locked frontend dependencies with `yarn install --frozen-lockfile`, then create a Python virtual environment:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements-review-lock.txt
```

On macOS/Linux, use `.venv/bin/python` instead. Install FFmpeg/ffprobe locally and either add their directory to PATH or set `FFPROBE` to the ffprobe executable and `REVIEW_FFMPEG_DIRECTORY` to their directory. `REVIEW_PYTHON` can override the default virtual-environment interpreter. For speech analysis, download the public Whisper base weights once, explicitly:

```powershell
.\.venv\Scripts\python.exe -c "import whisper; whisper.load_model('base', download_root='.review-models')"
```

Run `yarn serve:review-api` in one terminal and `yarn serve` in another. Vite proxies `/api/review` to the bridge at `127.0.0.1:3001`. Open the analysis screen for a study with a saved screen recording, then choose **Recording review**. Local timeline runs without provider credentials. Gemini, GPT, and local VLM selections are enabled when their server configuration and startup checks succeed, as described below. For a silent video, scene analysis still works. `.venv`, model weights, upload files, and the analysis cache are ignored by Git. No provider credential is required for this local pipeline.

### Verification and limits

Latest local checkpoint, September 12, 2026, after integrating current upstream: **2,193 frontend unit tests passed, one existing skip, 177 files** (68.01 seconds). Full source ESLint and TypeScript passed. Native bridge tests: **70 passed**. Python extraction tests: **11 passed**. Production build passed (2.65 seconds), retaining upstream plugin/dynamic-import warnings. **All 49 Chromium tests passed against the production build** (3.0 minutes), including the existing external website, Svelte, Vega, replay, MVNV, recording review, and skip-logic studies. Network access was available for the external study resources. The two demo tests also passed separately at the actual `/revisit-studies/` Pages prefix, covering import/retry, preserved edits, playback/seek, reload, JSON export, and cross-recording totals. A real Markdown export of the six simulated screen recordings completed with zero thumbnail warnings. Other counts and blocked-network notes below describe earlier September 9 checkpoints. This checkpoint does not claim a Safari/WebKit run or live cloud-model accuracy.

**Synchronized recording timeline:** four rows align automatic events, purple researcher tags, gray OCR ticks, and signed confusion bars to video time. The six automatic types have distinct colors/shapes and a legend. Markers support mouse and Enter/Space seeking; the slider and red cursor follow video playback. Focus/hover displays raw evidence in a scrollable readout. Gold rings pair exact spoken confusion phrases with matching OCR in the same three-second bin. Evidence lists remain available for overlapping markers. The timeline scrolls horizontally on narrow screens to retain marker hit areas. Cursor updates are isolated from the surrounding evidence lists and dashboard.

New analyses persist measured duration in the atomic bundle, including bulk jobs. The timeline uses finite video metadata with saved measured duration as a fallback; old bundles without duration still load. Storage rejects nonpositive/nonfinite durations and evidence outside the recording, including OCR at EOF. If no duration is available, the timeline explains the missing scale while evidence links remain usable.

Timeline verification: 338 storage/analysis tests passed across 21 files; the final duration/grounding checks passed 20 tests after tightening the EOF boundary. Chromium passed (one test, 20.2s total), verifying click/keyboard seeks, two-way slider/video synchronization, paired gold markers, visible focus evidence, tags, and saved duration. The complete four-row screenshot was inspected. Typecheck, changed-source lint, and production build passed (78.01s total for the build). Dense overlapping recordings and broader runtime performance still need evaluation.

**Saved study event index:** analysis/event/tag saves and event/tag deletions now update the versioned `review-index` artifact. Each update replaces only its recording/source entries, preserving other recordings and the other source. Updates serialize within the runtime and use Web Locks where available to coordinate same-origin tabs; the locked operation rereads the current source so delayed notifications cannot restore superseded events. An index failure returns `indexWarning` after the source commit, which single-recording, tag, and batch controls display without claiming that the recording save failed. Snapshot restore preserves the stored index. This index is derived data: the dashboard continues to read source artifacts. Automatic detection/recovery after interruption and cross-device cloud concurrency remain unfinished.

**Index recovery:** use **Rebuild saved study index** to reconstruct the index from every registered participant's saved task answers, independently of dashboard filters. It includes automatic events and tags, including earlier separately stored event artifacts. Participant and evidence reads are bounded to four participants/clips at a time. The replacement writes once, after all reads succeed, under the same index lock. Missing, empty, or malformed derived indexes can be replaced; malformed source records and failed reads stop the rebuild and preserve the prior index. **Cancel index rebuild** stops before the final write and drains admitted reads. If the final write has already started it may finish, and the UI reports that successful save. Leaving the view cancels outstanding rebuild work. This is explicit recovery, not automatic crash detection.

Rebuild verification: seven new tests cover malformed-index replacement, full study scope, failed reads, cancellation, bounded admitted work, originating-study capture, and an overlapping save. The combined storage/analysis suite passed all 335 tests in 20 files (19.07s).

Chromium recovery verification passed on the final source (one test, 18.7s total): it corrupts the saved index, adds a registered legacy recording outside the displayed clip list, rebuilds through the UI, and verifies all three entries persist across reload while the visible counts stay filtered. Typecheck and changed-source lint passed.

Index-maintenance verification: all 328 storage/analysis tests passed across 19 files (13.86s), including concurrent saves, superseded revisions, failure/recovery, study switching, and snapshot restoration. Chromium passed on the final source (one test, 17.4s total), checking the actual saved index after analysis, tag creation/deletion, batch completion and reload. Typecheck, changed-source lint, and whitespace checks passed. Cloud adapters are still tested with mocks; this does not prove cross-device concurrency.

**Cross-recording evidence:** the Recording review tab now shows task/event and participant/task count heatmaps, the ten densest 30-second windows, and co-occurrence pairs with an adjustable gap. Numeric cell labels make counts readable independently of color; participant/task cells open their exact recording. Heatmaps render at most 25 rows and 12 columns per page, using a consistent color scale across all pages. Counts cover the listed recordings, including manual tags, and are not duration-normalized rates. Tag edits, reanalysis, and batch completion refresh the dashboard; **Refresh event counts** picks up changes made elsewhere. Reads are bounded to four clips at a time, refreshes drain preceding reads, and errors clear results rather than presenting incomplete counts. The underlying builder deduplicates exact participant/task identities. Filtered dashboard data never replaces the saved study-wide index.

The latest focused analysis suite passed 25 tests across six files, including index identity preservation, missing versus failed reads, bounded cancellation, draining a paired read before reporting failure, and participant/task counts with unusual IDs. Typecheck and changed-source lint passed after heatmap integration.

The heatmap Chromium extension passed (one test, 24.8s total). A fixture with 26 additional participants and 13 task IDs checks both pagination axes, exact recording selection from page two, and returning to the original cell. The production build passed in 91.14s; warnings remain for plugin deprecation, browser module externalization, and mixed static/dynamic imports. This is a build check, not a final complete regression audit.

The extended Chromium recording-review flow passed on the final dashboard source (one test, 21.4s total). It checks count refresh after analysis, tag addition/deletion and batch completion, task counts, dense windows, adjustable co-occurrence, and exact recording navigation. The dashboard screenshot was visually inspected. These tests use real browser storage and synthetic media with mocked analysis/embedding HTTP responses.

Earlier checkpoints (historical; current totals appear above):

- Unchanged upstream baseline: typecheck, lint, production build, and 2,071 unit tests passed (one skipped). Chromium baseline was 45 passed/one failed; the MVNV failure subsequently passed unchanged after its fix. The current full-suite results are listed at the start of Verification and limits.
- Latest full storage regression run: 294 tests passed across 12 files after snapshot pagination/failure fixes. Supabase mocks now reproduce pagination and null IDs for folder entries. Cloud tests use mocks; live cloud services are unverified.
- After atomic storage changes, the combined storage/analysis suite passed 313 tests across 16 files. The latest focused analysis suite passed 20 tests across five files, including bulk cancellation, continuing after a failed recording, preserving analysis when indexing fails, and overlapping indexing with later analysis. Typecheck and changed-source lint passed.
- Recording-review Chromium flow: one passed in 20.8 seconds, including real IndexedDB persistence, a valid synthetic WebM, seeking, tags, phrase settings, OCR/score artifacts, reload, and offline saved review. It verifies semantic search, automatic reindexing, two-recording batch completion, and retrying only a failed recording while preserving the successful recording's revision. Only analysis/embedding HTTP responses are mocked. The synthetic config hash produces an unrelated config-filter warning; this fixture does not verify that filter.
- Native bridge/scoring/cache/process suite: all 22 tests passed together (3.69s). Python timeline/OCR unit suite: eight passed.
- Real pipeline smoke checks: a four-second synthetic black/white video produced the expected 2s cut; an 11.8-second synthesized speech recording yielded word-aligned `not sure`, `confused`, and `wait` events. Offline MiniLM produced 384-dimensional embeddings and passed a small ranking check. These are synthetic setup checks, not human evaluation or evidence for the report's historical review-time claims.

Useful focused commands:

```bash
yarn test:review-api
yarn unittest run src/storage/tests/reviewArtifacts.spec.ts src/analysis/individualStudy/screenRecordingSummarization/tests --maxWorkers=2
yarn playwright test tests/recording-review.spec.ts --project=chromium --workers=1
python -m unittest discover -s scripts/tests
yarn typecheck
yarn lint
```

**Markdown report export:** **Export study report (Markdown)** downloads evidence for every registered participant/task, independently of dashboard filters. It includes summaries, analysis revisions and settings metadata, events, OCR, raw confusion scores, tags, aggregate counts, dense windows, and co-occurrences. Each available video contributes an embedded JPEG from 25% of its duration, bounded to 320 by 240 pixels. Videos are downloaded and decoded one at a time; missing or unreadable media produces a per-recording warning while retaining its saved evidence. Source-artifact read failures stop the export rather than silently omitting data. Cancel or leave the view to stop outstanding work. Thumbnail decoding times out after 15 seconds; accumulated clip data is limited to 50 million characters. The report contains per-recording saved revisions, not a transactional snapshot across simultaneous edits.

Export verification: all 346 storage/analysis tests passed across 24 files (22.41s), including source failures, cancellation, study switching, safe Markdown rendering, thumbnail dimensions, timeout and cleanup. Typecheck and changed-source lint passed. Chromium passed one extended flow (18.5s total), downloading the actual report for three recordings, including a legacy recording outside the visible dashboard. It verifies evidence and missing-media warnings, then decodes an embedded JPEG and checks its dimensions and expected dark quarter-frame pixels. Analysis/embedding HTTP responses remain mocked; browser storage, report download and thumbnail decoding are real.

The export production build passed (18.95s total); existing module externalization and mixed-import warnings remain. Browser-test formatting was corrected by ESLint after its successful run, without changing assertions or behavior.

**VLM frame-sampling foundation:** `server/review/frames.mjs` decodes and consumes one JPEG at a time instead of launching every frame extraction together. Sampling supports 1–20 frames, excludes EOF, caps image width at 1280 pixels and each JPEG at 4 MiB, and bounds each decoder to 30 seconds. Cancellation and failures release temporary files, including cancellation during the last frame. The local adapter is connected when configured as described below; the GPT adapter is connected as described below. All 27 native bridge tests pass (3.65s), including five sampling tests. A real FFmpeg check extracted JPEGs at 0s and 2s from the four-second synthetic fixture.

**Local VLM adapter:** set server-side `OLLAMA_VLM_MODEL` to an installed vision model and restart the bridge. `OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434` and accepts loopback HTTP origins only. Startup checks model vision capabilities and FFmpeg before enabling the local pipeline. `REVIEW_LOCAL_FRAMES` selects 1–20 frames (default 6). It retains the local timeline/OCR/confusion evidence, describes frames sequentially, then synthesizes a short summary. Requests have 120-second and 1-MiB response limits, propagate cancellation, and reject empty/incomplete responses. Model failures do not replace saved analysis with a partial result. Four adapter tests pass with mocked provider responses; live Ollama inference and end-to-end local-model UI verification remain outstanding. No model download or provider spending is automatic.

Local-model transport verification now uses a real loopback HTTP server: stalled responses time out, cancellation after response headers closes the connection, and oversized bodies stop reading before the server finishes. Transport failures map to actionable timeout/cancellation/unavailable bridge errors. All 34 native tests passed together (3.22s). No Ollama service responded on the default local port during verification; these tests do not establish live inference quality.

Production build after the metadata transport change passed in 23.86s total. Existing mixed-import and externalization warnings remain. All 349 storage/analysis tests passed (17.90s). Final HTTP checks passed nine tests, including equivalent cache behavior across old/new upload formats. Windows test teardown uses bounded retries for transient directory handles after aborted requests.

Final metadata Chromium verification passed (20.6s total), with typecheck: every upload's video suffix exactly matches the fixture, normal single/batch/retry prompts retain their text, and an 8,000-character Unicode prompt survives save, upload, atomic analysis storage and reload. UTF-8 byte length is checked separately from character count. Analysis responses are mocked; upload construction, browser storage and UI are real.

**Researcher prompts:** the Recording review settings now include editable prompt text for single and batch model summaries. **Save analysis settings** retains it across reloads; a running batch captures its initial text. Each new atomic analysis stores the prompt used, and Markdown export includes it. The local timeline does not interpret prompts. Old settings and analyses without a prompt remain compatible. Text is capped at 8,000 characters. Named prompt-library controls are described below.

Analysis uploads now carry UTF-8 JSON metadata before the binary video, with its byte length in `x-review-metadata-length`. Only the pipeline remains in the URL. The bridge buffers at most 64 KiB of metadata, validates prompt/phrase lengths, and streams the remaining video unchanged. The video size limit excludes metadata. Existing raw-video requests with URL options remain supported. Cache identity includes the parsed options and video bytes, so transport format does not change the meaning of a cached result. All 39 native tests passed (3.19s), including an actual HTTP upload containing 8,000 Unicode characters, repeated cache retrieval, binary-byte preservation, arbitrary chunk splits and malformed/truncated metadata. Five frontend API tests pass; final browser verification is recorded below.

Prompt verification: the combined storage/analysis suite passed 348 tests (17.52s). After adding validation and export coverage, the focused suite passed 56 tests (6.76s), including batch settings capture, Unicode/newline request fidelity, old-artifact compatibility and invalid prompt rejection. Typecheck and changed-source lint passed. All eight HTTP bridge tests passed (0.89s), including exact prompt forwarding and cache separation when prompt text changes. Chromium passed the extended review flow (19.8s total), verifying prompt settings reload, single/batch request text, atomic saved prompts and exported Markdown text. Provider responses are mocked; persistence and downloads use the real browser.

**Named prompt library:** use **Prompt name** and **Save as new prompt** to store the current text in study settings. **Saved prompts** selects a saved entry; **Update saved prompt** changes that entry while preserving its ID. **Delete saved prompt** removes the named entry and retains the current working text. Saving a library change also saves the current analysis settings. Failed saves preserve the visible library. Names are unique ignoring case and surrounding spaces. Limits are 100 entries, 100 characters per name, and 8,000 characters per prompt. Old settings without a library remain compatible; migration of the old fork's separate library artifact is still pending.

Library unit/storage verification: all 351 tests passed across 25 files (17.79s), including immutable updates, exact IDs, duplicate names, invalid limits and missing update targets. The artifact fixture now includes a named library; all 19 artifact tests passed (1.46s), including snapshot copy and public restoration of the saved settings. Typecheck and changed-source lint passed. Chromium passed the extended flow (27.1s total), covering create, reload/select, update, duplicate rejection without mutation, delete, retained current text and persisted library contents. Storage-write failure was not injected in this browser run.

Prompt-library failure handling now has focused component tests using the real Mantine controls. Failed creation/update preserves entered names and selection, deletion rejection displays an error and allows retry, and pending saves disable repeated mutations. Fixed an unhandled deletion rejection and added explicit retry messages for unsuccessful saves. All 354 storage/analysis tests passed across 26 files (20.22s), with typecheck and changed-source lint. These injected failures complement the preceding normal-persistence Chromium run.

**Import legacy prompts** copies the old fork's root `screenRecordingPrompts` artifact into the current named library. It preserves IDs/dates/text, skips identical entries, reports ID/name conflicts, rejects malformed data and enforces combined limits. Conflicts remain in the untouched legacy source and do not replace current edits. Imports read the latest committed settings under the same queue as settings writes, then save once if there are new entries. Unrelated saved settings are retained. Current unsaved prompt text stays in the editor. Same-origin tabs coordinate through Web Locks where available; cross-device writes remain outside that lock.

**Cancel prompt import** stops before the write; once a write begins it can finish and report success. Leaving the view aborts outstanding work. Import captures the originating study so switching studies cannot redirect its data. Five conversion tests and five storage import tests pass, covering concurrent repeat imports, source preservation, failed writes, cancellation during reads and study switching. This migrates named prompts only; old recording summaries/events/OCR/scores/tags/embeddings remain separate migration work.

Prompt import verification: all 364 storage/analysis tests passed in 28 files (21.89s). Chromium passed (36.2s total), importing one prompt from the actual historical root key, preserving settings/source, reporting both ID/name conflicts, repeating without duplicate writes, and selecting the imported prompt after reload. Typecheck and changed-source lint passed; final test-only formatting was fixed after the browser run. Failure/cancellation are covered by storage tests, not injected in Chromium.

Legacy recording conversion foundation: `src/storage/legacyReviewRecording.ts` maps decoded old summary/event/OCR/score/tag/embedding artifacts into current values. It accepts the historical summary aliases and numeric timestamps, preserves raw scores and tag metadata, rejects malformed rows, and does not infer duration or missing score evidence. Embeddings retain model/vector data without claiming a current analysis revision. Four focused tests passed (1.12s). The reader, durable import and recording-level UI described below now use this converter.

Legacy read preparation: Firebase and Supabase now distinguish missing legacy review artifacts from permission/read errors, including the old named-prompt root artifact. Firebase also preserves historical plain-text summaries. Cloud primitive tests passed 36 cases with mocks; live cloud services remain unverified. The decoder accepts old objects/strings/blobs, rejects malformed JSON outside plain summaries, caps decoding at 32 MiB per artifact, and checks cancellation after blob reads. This cap applies to decoding, not a streaming download limit. All 372 storage/analysis tests passed in 30 files (23.20s). The durable import described below builds on these reads.

The storage API now exposes `readLegacyReviewRecording`: it reads all six old artifact paths sequentially, captures the originating study/clip, decodes and validates the complete result, and performs no migration writes. Three focused tests passed (1.39s), covering actual historical paths, failed reads, cancellation and caller identity mutation. The durable import below uses this reader.

Durable recording import API: `importLegacyReviewRecording` copies missing analysis, tags and embedding categories while preserving current artifacts and every historical source. Analysis saves as one coherent bundle; categories commit independently. Results identify imported/preserved categories and errors. Retry fills missing categories and repairs derived index failures without replacing successful analysis revisions. Normal clip saves/deletes and import writes share a same-origin per-clip queue; cross-device concurrency remains unverified. Cancellation stops before the next category, leaving completed writes intact. Use **Import legacy recording results** below the batch controls for the selected recording. It refreshes the timeline, summary, tags and dashboard after import, reports imported/preserved categories, and offers cancellation. Partial failures explain how to retry; completed saves stay available. Imported historical embeddings require reindexing before semantic search uses them. Import, single analysis, batch analysis and tag saving cannot overlap on this selected recording through these controls.

Import verification: 377 storage/analysis tests passed across 31 files (24.52s). A subsequent focused run passed six tests (1.37s), including partial write failure/retry and derived-index recovery. Typecheck passed on the connected UI. The next storage/analysis run passed all 378 pre-existing cases; three new UI cases initially failed because the test environment lacked matchMedia. After adding the test-only browser stub, all three passed (2.77s), covering partial failure/retry, cancellation retaining completed writes, and late completion after unmount. Production build passed (3.77s); delegated Chromium passed against the production build (one extended workflow, 19.1s total). In this restricted Windows environment, the default esbuild config loader cannot enumerate an ancestor directory; verification uses Vite/Vitest `--configLoader runner` without changing production configuration.

Browser import verification: the fixture begins with historical summary/events/tags and no current analysis, imports through the actual control, checks converted values and index entries, reloads, retries, and confirms the analysis revision and historical sources remain unchanged. It then separately corrupts and explicitly rebuilds the study index. Analysis/embedding HTTP responses are mocked; browser storage and the UI are real. The existing reanalysis assertion now waits for the committed revision instead of treating a sent request as a completed save. For production preview, build with `VITE_BASE_PATH=/` and run this test with `REVIEW_TEST_STORAGE_PREFIX=prod`; the default fixture uses the development prefix. The restricted environment still stalls the dev server, so this run verifies the built application.

Full regression checkpoint: 2,174 Vitest tests passed across 171 files, with one existing skipped test (193.92s). The first full run exposed an outdated analysis-tab child mock and accidental collection of native Node tests by Vitest. The tab tests now isolate RecordingReview consistently with other children and assert that participant selection reaches it; Vite excludes the native suite, which runs separately with `yarn test:review-api`. All 39 native tests passed (2.13s). Full source lint and TypeScript checks passed. This is a unit/API checkpoint, not completion of the report acceptance checklist.

GPT frame analysis: the bridge now registers `gpt4o` when `REVIEW_ENABLE_CLOUD=1`, `OPENAI_API_KEY`, the local timeline and ffmpeg are configured. `OPENAI_VISION_MODEL` defaults to the report's `gpt-4o`; `REVIEW_OPENAI_FRAMES` defaults to 10 and accepts 1�20. Availability means configured locally, not verified provider entitlement. No provider request runs during startup. Selecting this pipeline sends sampled JPEG frames and the researcher prompt to OpenAI; keys stay in server environment variables. The request format follows the [official image-input documentation](https://developers.openai.com/api/docs/guides/images-vision).

Frames carry their sampling timestamps and share a 16 MiB aggregate JPEG limit before base64 encoding. The adapter makes one summary request with a 1,200-token output cap, 120-second request timeout and 1 MiB response cap. Redirects and automatic model fallback/retries are disabled. Refused, truncated, empty, malformed or oversized responses reject the job, preserving previously saved analysis through the existing save-after-success workflow. Successful summaries retain the locally derived events, OCR, raw confusion scores and duration. The cache version includes model, frame count and local analyzer version; cache keys already include video and effective prompt/settings.

GPT verification: all 46 native tests passed (2.03s), including seven new cases for request shape, failure redaction/no retry, response limits, real loopback timeout/cancellation, timestamped frame ordering, aggregate limits, and actual bridge HTTP/cache behavior. Provider HTTP is mocked or redirected to a loopback fixture with a dummy key. A final seven-test rerun passed (0.33s) after strengthening cancellation checks to wait for response headers and verify closed connections. No billable requests were made; live provider access, model quality and performance remain unverified. The Gemini upload implementation is described below.

Gemini video analysis: with `REVIEW_ENABLE_CLOUD=1`, server-only `GEMINI_API_KEY`, an explicit `GEMINI_MODEL`, and the local timeline available, the bridge registers `gemini`. Model access is not probed at startup. This pipeline streams the recording and sends the researcher prompt through Google's [video/Files API](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding). It accepts WebM and MP4, up to the bridge's 256 MiB limit, and never creates a whole-video base64 copy. MIME type is now forwarded to analyzers and included in cache keys.

Each upload gets a unique file name before any request. The client starts a resumable upload, streams/finalizes it, waits for ACTIVE processing state and then requests a summary. Unexpected upload destinations, file identities/URIs, processing failures, malformed/oversized responses, blocked or truncated summaries reject. Requests have a 120-second limit, processing/upload/generation together have a ten-minute limit, polling waits two seconds, JSON responses are capped at 1 MiB, and output is capped at 1,200 tokens. There are no automatic model fallbacks or paid retries.

Remote deletion is attempted on success, error and cancellation with a separate 15-second cleanup limit; missing files count as already removed. A successful summary is retained if deletion fails, with the file name shown in single/batch status for manual cleanup. Cleanup diagnostics are persisted with the saved analysis and included in exports. They describe the analysis run, not the current remote-file state. Cancellation stops the local wait but does not guarantee that provider processing or billing has stopped. Process termination or an ambiguous upload/deletion race can leave a remote file; the durable journal below now retries tracked files after restart. Keys and provider error bodies are not returned to the browser.

Gemini verification: all 53 native tests passed (2.21s), including original-byte streaming through real loopback HTTP, processing polling, cancellation/timeout cleanup, destination checks, incomplete/malformed/oversized results, cleanup failures and preserved local evidence. All provider calls used dummy keys and local responses. Live Google access, model quality and long-video performance remain unverified; 46 frontend analysis tests passed (13.07s), including saved batch status with a cleanup warning; TypeScript and changed-source lint passed. A subsequent ten-test HTTP run passed (0.90s), verifying MIME forwarding and cache separation. Chromium passed the extended workflow (22.8s total), verifying visible cleanup diagnostics in both single and saved batch results without losing successful analysis. This used root-base production preview and local mocked analysis responses.

Durable Gemini cleanup: `.review-cleanup/` is ignored by Git. Before upload, the bridge atomically writes and flushes a small record containing only the generated remote name, timestamps and retry count. A one-way key fingerprint scopes the directory so recovery never uses a different configured key; no API key, recording, prompt or provider response is stored there. Rotating the key preserves the old directory, but its records require the original key or manual provider cleanup. Keep the journal local and run one bridge per journal directory.

The bridge checks pending records at startup and every minute, without overlapping passes. Each pass attempts at most ten deletions, each bounded by the existing 15-second cleanup limit. Failed deletions back off from one minute up to one hour. Active uploads retain a lease covering the configured processing deadline, cleanup deadline and an extra minute. An early 404 stays tracked until that lease expires; confirmed deletion clears the record immediately. Corrupt records are preserved and reported. A full journal (1,000 entries) or failed write prevents new cloud uploads rather than creating untracked files. Recovery performs deletion only, never another summary request.

Cleanup recovery verification: the final full native suite passed all 62 tests (2.03s). After binding the journal lease to the configured analysis deadline, 15 focused tests passed (0.43s), including restart recovery, early-404 retention, longer leases, backoff, capacity, cancellation, corrupt-record preservation, prevention of untracked uploads, and recovery without another upload/generation request. These use local files and simulated provider responses. Power-loss durability, external filesystem interference, live deletion semantics, key-rotation recovery and multiple bridge processes remain outside this verification. Diagnostics in already-cached results describe the original cleanup failure and can remain after successful recovery; current retry results appear in service logs.

Remaining work includes automatic index recovery and cross-device concurrency, cloud/local VLM live verification and cleanup status persistence in saved analyses, legacy analysis-settings migration, snapshot pagination/recovery edge cases, larger usability/performance measurements, and a final complete regression audit. Each stored analysis remains internally consistent. Cross-client optimistic conflict detection remains future work.

### Saved analysis diagnostics

Audio, scene, OCR and remote-cleanup warnings now travel with the versioned analysis bundle. Recording review shows them after reload, batch saves retain them, snapshot copies preserve them, and Markdown exports include them. Older bundles without diagnostics remain valid. Each saved message is bounded to 2,000 characters, with at most eight messages accepted. The displayed warning describes the original run and does not claim that a remote cleanup is still pending.

Verification: 384 storage/analysis tests passed across 33 files (31.40s), including validation, persistence/snapshot preservation, batch saves and escaped export text. TypeScript and changed-source lint passed. Chromium verified persisted warnings after reload and in exported Markdown (25.9s total, including the dense baseline fixture).

### Legacy pipeline preference and dense evidence lists

Use **Import legacy pipeline preference** to copy the old root screenRecordingAnalysisSettings pipeline choice into current study settings. Both the named pipeline and older boolean local-model format are supported. The explicit import replaces only the pipeline, preserves prompts/phrases and the legacy source, shares the settings write queue with prompt imports, and does not run analysis. Missing settings do not create a provider preference; malformed preferences fail visibly. Cancellation before writing and study switching preserve the correct destination. Analysis is disabled while settings are being saved or imported.

Evidence events, OCR frames, scores and tags now use independent pages of 50 entries. Counts and named first/last/page controls keep every entry accessible while bounding rendered controls. Score normalization still uses the entire recording. A shrinking list clamps the current page to a valid page. This targets a measured synthetic case: 2,000 events, 64 OCR frames and 120 scores previously rendered 2,241 buttons and about 31,000 Chrome-reported nodes, with 2.20s from navigation start to evidence readiness and 106.3MB used JavaScript heap. Those are individual browser observations, not participant-study benchmarks. After paging, the same fixture reached readiness in 1.25s with 231 buttons, 18,578 Chrome-reported nodes and 57.6MB used JavaScript heap. Chrome node/heap metrics can include retained objects from earlier interactions and vary with garbage collection; these are not exact mounted-DOM counts. The four-second media limited the SVG timeline to 88 in-range markers, so this experiment measures evidence lists rather than a dense full-duration timeline. A separate 120-second, 3,616-byte synthetic fixture now supports a full-timeline stress check; its generation command and hash are in tests/fixtures/README.md. The full-duration results appear in the timeline stress-check section below. Ordinary browser regressions now save metrics under their own test output directory instead of overwriting shared baseline files; an external metrics path requires explicit REVIEW_PERFORMANCE_OUTPUT.

Verification: the combined storage/analysis suite passed 390 tests across 34 files (31.33s) after settings migration. Seven focused tests then passed (3.48s), including final-event access and page clamping plus migration source preservation, concurrent imports, cancellation, study switching and failed writes. Final TypeScript and changed-source lint passed. Delegated Chromium passed (24.2s), including settings import/reload/idempotence and access to the final event, OCR frame and score page. Production build, test-file lint, final typecheck and whitespace checks passed.

### Reproducible local evaluation

Run `yarn evaluate:review --output <new-directory>` after configuring the local Python, FFmpeg and OCR dependencies above. The command directly invokes the offline timeline analyzer on `evaluation/synthetic.json`, produces `results.json` plus `report.md`, and refuses to replace an existing output directory. It does not require a running HTTP bridge or call cloud providers. Use `--manifest <file>` for an explicitly supplied corpus: version 1, provenance (`synthetic` or `human-labeled`), description, and clips with unique ID, file path relative to the manifest, expected duration and typed timestamped events. Human-labeled manifests require a rater ID.

Each run records manifest/video SHA-256, analyzer/Node versions, timings, observed results, diagnostics and errors. Clips run sequentially without the HTTP cache; timing includes startup/model loading when needed. A duration mismatch over 0.25 seconds fails the clip instead of trusting stale ground-truth metadata. Event agreement uses maximum one-to-one same-type matching within two seconds; sorting avoids the old nearest-first algorithm's order-dependent undercount. Precision or recall with an empty denominator is unavailable. Summary quality and researcher review-time ratings remain explicitly uncollected; event agreement is not a substitute for human evaluation.

Verification: 65 native tests passed (2.12s), including exhaustive small-event matching comparisons, source fingerprints, duration mismatch, malformed corpus rejection, cancellation and escaped reports. A real offline run of the included four-second synthetic transition took 9.90s and found one expected scene-change event with zero false positives/negatives. Audio was correctly skipped because the fixture has no audio stream. This one fixture does not establish accuracy on participant recordings. A broader corpus, multi-pipeline evaluation and independent human ratings remain outstanding.

### Evaluate configured bridge pipelines

Start the local analysis bridge, then run `yarn evaluate:review --bridge http://127.0.0.1:3001 --pipeline heuristic --output <new-directory>`. Select `local`, `gpt4o`, or `gemini` to evaluate another configured pipeline in its own run directory against the same manifest. Cloud pipeline selection additionally requires `--allow-cloud` and may incur provider charges; it never happens by default. No actual cloud requests were used for development verification.

Bridge evaluation streams WebM/MP4 bytes, uses a 15-minute request limit and 16MiB response limit, follows no redirects, and accepts only loopback HTTP origins. Cancellation closes the upload/response. Unconfigured pipelines are recorded as skipped; skipped/error runs exit nonzero rather than appearing fully successful. Outputs retain per-result pipeline, server analyzer version when reported, cache status and server processing time when available. Client elapsed time includes upload and cache lookup. Compare uncached results separately from cache hits; do not combine them as model inference timings.

Verification: all 69 native tests passed (2.16s), including real loopback uploads/cache hits, unavailable pipelines, destination restrictions, explicit cloud opt-in, response limits, redirects and cancellation. A real offline timeline run through the evaluation CLI/bridge found the synthetic transition in 6.49s; a second run found the same result in 33.6ms with `cached: true`. These are individual local observations. The owned server was stopped afterward. Live cloud/local-VLM evaluation and broader corpus coverage remain unverified.

### Browser startup compatibility and regression checkpoint

Vite now resolves Hjson to the browser bundle already shipped with the dependency. Its Node entry reads `os.EOL`, which caused a blank page in the development-environment browser build because Vite rejects Node-only modules in client code. The change uses the existing parser dependency and leaves storage configuration syntax unchanged. The focused storage-configuration/Firebase suite passed 100 tests across three files (3.57s); both unchanged Chromium routing tests passed (3.9s), confirming redirect and empty-state rendering. The full Chromium rerun is in progress.

The second full unit checkpoint passed 2,184 tests with one existing skip across 174 files (181.99s), before the Hjson alias change. All eight Python tests and full source lint passed. The full Chromium run was stopped after repeated startup failures exposed the Hjson issue; no full-browser pass is claimed yet. Local verification uses a development-environment build at the root URL so the original browser fixtures retain their development storage naming. Production build verification remains separate.

### Separate cross-recording analysis

The upstream analysis navigation now has **Recording review** and **Study analysis (cross-clip)** tabs. Single/batch analysis, settings, player and annotations stay in Recording review. The cross-clip tab contains semantic search/indexing, event matrices, dense moments and co-occurrence, using the same participant filters. It reads saved artifacts without loading recording videos. Leaving either tab cancels that view's in-flight work.

Cross-clip recording cells and search results open the matching recording. Dense-moment rows are now buttons that also carry their starting timestamp. Recording selection and optional seek time live in the URL, so reload restores the selected clip and seeks after metadata loads; malformed times are ignored, and times beyond the actual media duration are clamped. Ordinary playback/seeking is not reset on later duration events. The default recording is also written into the URL; clicking the selected option or active tab no longer clears its identity and silently falls back to another recording. Switching analysis tabs retains the query so returning to Recording review preserves the selected clip/time. Both views retain report export.

Verification: 63 focused analysis tests passed across 17 files (15.54s), including navigation identity/invalid-time cases and upstream integration. Changed-source lint passed. Later browser navigation/reload/seek verification passed; see the tab-return and production workflow notes below. The preceding full Chromium checkpoint, before this tab split, passed 40 tests and failed seven HTML/Trrack/MVNV demo tests; those failures were subsequently investigated in the local D3, Trrack, and MVNV sections below. Direct browser inspection confirmed blocked CDN requests for D3, Trrack and Svelte scripts in those iframe fixtures. The unchanged MVNV test passed an isolated rerun (1.5 minutes); its earlier suite failure remains a timing concern to investigate, not a proven fixed defect.

### Local D3 for HTML demos

The HTML bar-chart, reactive HTML bar-chart and HTML Trrack demos now load D3 from the repository instead of requesting the D3 CDN. The local asset is the existing locked D3 7.9.0 dependency, with its ISC license copied alongside it; no dependency was added. Regenerate both with `node scripts/sync-demo-d3.mjs` after an intentional D3 update.

This follows an actual browser reproduction of `ERR_NETWORK_ACCESS_DENIED` for the remote D3 script. The generated asset and license have matching SHA-256 hashes to their installed sources. The unchanged reactive HTML demo Chromium test passed (7.4s), including rendered bars, selected response values and study completion. The Svelte compiler and runtime still have external dependencies, and the external-website demo still requires its target site; this change does not make those entire studies offline.

### Returning to a recording search

The cross-clip tab now remembers the last submitted search query while navigating between analysis tabs. After inspecting a matching recording, returning to the cross-clip tab restores the query so it can be run again. Search text stays in local component memory, is scoped to the current study, and is not added to the URL or automatically submitted. Reloading the page clears it. Leaving the tab still cancels its in-flight search.

Verification: all 13 parent analysis-tab tests passed (2.64s), including query retention across tab changes and isolation from another study. Changed production-source lint and TypeScript passed. The delegated Chromium recording-review workflow passed in 35.9s, including the restored search query, matching recording navigation, saved evidence and reload behavior. This run still used the four-second dense fixture; the later full-duration stress check is documented below.

### Full-duration timeline stress check

The recording-review browser test now ends with a separate 120-second synthetic video, 2,000 events, 64 OCR frames and 120 score windows. Unlike the earlier four-second fixture, all 2,184 timeline markers are inside the actual video duration. The test checks every paginated evidence list's final page and confirms that selecting the last event seeks the real video to 99.95 seconds. Performance output defaults to the test's own result directory; set `REVIEW_PERFORMANCE_OUTPUT` only when intentionally saving a separate measurement file.

The complete workflow passed in 34.4s. In this single development-build observation, evidence became ready in 2,066ms, with 50 initial controls per evidence list, 200 HTML buttons, 86.0MB JavaScript heap and 19,933 Chrome-reported nodes. Chrome node and heap totals may include retained objects from earlier workflow steps. No Long Tasks were observed. These results verify full-duration coverage, not a benchmark distribution or the report's historical human review-time improvement. The earlier production/four-second measurements are not directly comparable to this run. Test lint and TypeScript passed; the development build completed in 4.12s.

### Complete review artifact export

Both review tabs now offer **Export review artifacts (JSON)**. The versioned file includes all nine logical artifact categories for registered participants and saved tasks, regardless of filters: summary, events, tags, OCR, confusion scores, embeddings, clip prompts, study index and settings. It also retains the atomic analysis revision, duration, prompt and diagnostics. Missing categories are explicitly `null`. The four analysis categories are derived from a single analysis read, keeping them on the same revision. Older separate analysis records use the existing compatibility reader.

This export reads no videos and does not run analysis. It stops on unreadable data, cancellation, a study change or output exceeding 50 million characters. Export reads are sequential by recording, with at most four artifact reads together. The JSON contains normalized saved artifacts, not a transactional snapshot of concurrent edits or a backup of unregistered/orphaned storage files. Use the existing snapshot workflow for restoring a study; JSON import is not implemented. The expanded real-local-storage suite passed 19 tests (2.00s), now checking that public snapshot restore recovers all nine categories plus atomic metadata after edits/deletions, and that deleting a copied snapshot removes every category while preserving live data. Cloud adapters have local contract-test coverage, not live-service verification.

Verification: four focused tests passed using real local storage (1.83s), covering all nine categories, metadata, missing artifacts, read failures, cancellation and study isolation. The delegated Chromium workflow passed (32.1s): the downloaded JSON was parsed and checked for all nine categories, three participant/task identities, current analysis revision, prompt, diagnostics, embeddings, tags, legacy analysis and explicit missing values. Export triggered no new analysis requests. TypeScript and changed-source lint passed. The preceding full checkpoint passed 2,187 frontend tests with one existing skip, all 69 backend tests, eight Python tests and source lint. Chromium passed 41 tests and failed six: the external-site demo, four HTML/Svelte Trrack cases and the MVNV completion flow. Recording review passed. These remaining browser failures are still open.

### Local Trrack demo dependency and MVNV test synchronization

The HTML and Svelte Trrack demos now import a local browser module built from the existing locked Trrack 1.3.0 dependency and its installed dependencies. Regenerate it with `node scripts/sync-demo-trrack.mjs`. The script uses the existing Vite build tool, rejects external imports or multiple output chunks, and collects dependency versions and licenses in `public/revisitUtilities/vendor/trrack-NOTICES.txt`. No package was added. The 83,127-byte bundle regenerated with identical SHA-256 bytes. The Svelte compiler/runtime and external-website demo still require their separate network resources; both unchanged HTML Trrack Chromium tests passed (19.2s), covering initial answers, dot limits and Undo/Redo replay.

MVNV's browser test now waits for both the next route and the changed question after clicking Next. Diagnostic evidence from a failed run showed the old question surviving a route update; six iterations were then wasted before the 20-attempt limit. The test no longer treats any nonempty question as a completed transition or swallows a transition timeout. Completion and recorded-answer replay assertions remain. The revised test reached study completion, confirming the transition fix. A separate replay defect was then identified: saved answers contain short labels, while restoration matched full names. Replay now matches short labels and retains full-name compatibility for older answers; restored labels use the same display format as recording. A diagnostic run had restored only Rina out of ten saved selections, so the browser assertion now requires the complete saved selection set rather than any one selected box. JavaScript syntax and test lint pass; two independent Chromium repetitions passed (3.0 minutes total), each requiring the entire saved selection set before continuing replay.

### Broader synthetic evaluation and silent-audio efficiency

The default evaluation corpus now includes the four-second scene transition, 120 seconds of steady video without audio, and a four-second H.264/AAC MP4 with digital silence. Expected events come from fixture construction; the steady/silent fixtures must produce no events. Their generation commands and hashes are in `tests/fixtures/README.md`.

Before the change, the silent AAC track still loaded Whisper and took 21.9s in a local observation. The timeline pipeline now checks the first audio track with FFmpeg astats, with a 60-second limit and failure on decoding errors. It skips transcription only when the complete decoded track has an exactly zero peak, recording `audio_skip_reason: digital_silence`. Quiet nonzero audio is still transcribed. Scene detection and OCR continue; existing diagnostic handling reports audio failures. The analyzer version is now `timeline-v4`, also changing derived cloud/local-VLM cache versions so earlier results are not reused.

All three actual evaluation cases completed with expected event counts after the change: one transition, no steady-video events, no silent-audio events. The silent MP4 took 7.53s, retained eight OCR samples and reported the skip reason. The existing 11.8-second synthetic speech fixture still ran Whisper and detected all three phrases: not sure (0.38s), confused (3.22s) and wait (6.08s). These before/after timings are individual observations, not a benchmark distribution. Nine Python tests and all 69 backend tests pass. Human summary-quality ratings, participant-recording accuracy and multi-provider comparisons remain unverified.

### Signal failure isolation and acceptance audit

Audio, scene detection, and OCR report failures independently. Added regressions verify that simultaneous audio/OCR failures preserve a successful scene-change event, and a failed scene detector preserves OCR from a recording without audio. All 11 Python tests pass. These tests use controlled decoder failures; the three-clip evaluation and speech regression above exercise actual media tools.

The report audit now verifies event bounds and six event kinds, exact OCR phrase grounding, weighted time windows, silent-audio diagnostics, and reproducible synthetic evaluation. Human summary ratings and review-time savings remain unmeasured. Full browser completion and broader performance distributions remain open; existing passing checks do not imply every report claim has been reproduced.

Remaining browser failures were reproduced separately: one reactive website test passed, while the external-site previous-button test and two Svelte demo tests failed. Traces show network access denied for `www.revisit.dev` and the existing Svelte 3.59.2 compiler URL on unpkg. The Svelte demo displays its load error. These three cases still require external access or an offline dependency solution; they are not recorded as passing.

### Indexing retry and cancellation safety

Manual indexing now waits for every admitted save in its current batch before reporting an upload failure or enabling retry. Previously, one rejected upload could release the controls while sibling writes were still running. Successful saves remain intact. Cancellation waits for those admitted writes and prevents another batch from starting.

The new regression failed against the previous implementation and passes after the fix. Ten focused indexing, background-job, and ranking tests pass, including cancellation across a 33-recording input. The preceding full frontend checkpoint passed 2,191 tests across 176 files with one existing skip; the focused checks cover this subsequent change.

### Settings save feedback

Saving analysis settings now shows a loading control and an accessible saving, saved, or failed status. Wait for **Analysis settings saved.** before reloading or leaving the page. A reload before the storage promise completes can interrupt the write. The browser regression previously reloaded immediately after clicking Save and intermittently returned to default phrases; its verification now waits for acknowledgment and inspects the stored phrases before testing reload persistence. The updated full recording-review workflow passes in Chromium (20.3 seconds), including indexing/search and failed batch retry. Partial concurrent indexing-write failures remain covered by the focused unit regression, not a forced browser failure.

### Repeated synthetic processing measurements

Five sequential repetitions of the three synthetic fixtures completed with the expected event results on Windows, Node 24.19.0, and an Intel Core i7-14700F. Each call starts the Python analyzer and includes its process, import, and media-tool costs. No HTTP cache or discarded warmup was used; OS caches were uncontrolled and no other tests were intentionally running.

- Four-second scene transition: median **4.789 s**, observed range **4.481–5.001 s**.
- 120-second steady video: median **4.717 s**, observed range **4.440–5.052 s**.
- Four-second silent-audio MP4: median **5.276 s**, observed range **4.850–5.431 s**.

All 15 calls retained the expected event agreement. The evaluation outputs retain each sample, input hashes, analyzer version, and machine metadata. Five samples describe these synthetic clips only; they do not estimate production tail latency, speech-processing cost, summary quality, or human review-time savings. Absolute timings from earlier single runs are not directly comparable because runtime conditions differ.

### Cache reuse for digital silence

Successful exact-silence analysis now participates in the HTTP cache. The initial silence optimization introduced a new diagnostic reason that the cache still treated as a failure, causing repeated processing. The regression reproduces that miss and verifies reuse after the fix. Audio dependency failures and scene/OCR errors remain uncached so repaired tools can recover.

All 70 native tests pass. A real four-second silent MP4 retained eight OCR samples and the expected empty event set: the first HTTP request took 4.886 seconds, and the repeat was a confirmed cache hit at 16.5 ms. Cache-hit latency is not model inference time. Both evaluations preserve full result and input fingerprints.

**Pipeline availability:** the bridge enables deterministic analysis after local Python/scene and ffprobe startup checks. Missing audio/OCR components are reported separately. Local VLM setup checks the configured Ollama model's vision capability. Cloud adapters require explicit enablement and configuration; appearing in the selector means configured, not that provider credentials, quota, or inference quality have been verified. Provider failures surface on the requested analysis and do not trigger another paid model automatically. Cloud contracts use local doubles; no live cloud inference or live Ollama model was verified in this rebuild.

### Browser checks wait for completed operations

The skip-logic test now waits for each Next action to change the participant URL before interacting with the next trial. Consecutive trials can have identical text, so finding that text alone could act on the previous trial. The existing answer, skip-target, tag, and completion assertions remain.

The long-prompt recording test also waits for the atomic saved prompt to match the submitted text. Observing an HTTP request arrive does not establish that analysis and storage have finished. These changes strengthen verification of completed operations; they do not change production skip logic or make unfinished writes safe to interrupt.

The updated skip-logic test passed two Chromium repetitions (1.6 minutes total). The recording workflow passed against the production build and production storage prefix (20.5 seconds), including the full-length Unicode prompt and subsequent reload. The default `/study/` production build also passed (2.13 seconds); its generated asset URLs retain that base path. These targeted passes do not erase the external-network failures in the full suite.

### Real bridge startup verification

The actual startup command was checked with cloud access disabled. After restart, health reported local timeline and embeddings available, and all cloud/local-VLM adapters disabled as configured. A real uncached HTTP embedding request returned a finite, nonzero 384-dimensional MiniLM vector.

An earlier startup reported embeddings unavailable despite installed model files; a separate import check and the restart succeeded. Its exact cause was not captured, so this is not claimed as a reproduced timeout or a model-installation defect. Startup diagnostics now include the failure code instead of always telling the user to install MiniLM. If a startup check fails, inspect that code and the local Python/model setup before restarting. No live cloud service was contacted.

## Paper

If you are using reVISit for a paper, please cite:

> Zach Cutler, Jack Wilburn, Hilson Shrestha, Yiren Ding, Brian Bollen, Khandaker Abrar Nadib, Tingying He, Andrew McNutt, Lane Harrison, Alexander Lex. [ReVISit 2: A Full Experiment Life Cycle User Study Framework](https://www.visdesignlab.net/publications/2025_vis_revisit/). IEEE Transactions on Visualization and Computer Graphics (VIS), 32(1): 13-23, [doi:10.1109/TVCG.2025.3633896](https://dx.doi.org/10.1109/TVCG.2025.3633896), 2026.

**IEEE VIS 2025 Best Paper Award**

GitHub citation metadata for this repository is available in [CITATION.cff](./CITATION.cff).

## Trying it out

You can try out reVISit in a couple of different versions: 

* [Stable with Firebase](https://revisit.dev/study/)
* [Stable with Supabase](https://revisit.dev/study/supabase/)
* [Development with Firebase](https://revisit.dev/study/dev/)
* [Development with Supabase](https://revisit.dev/study/dev-supabase/)

## Build Instructions

To run this demo experiment locally, you will need to install Node.js on your computer.

* Clone `https://github.com/revisit-studies/study`
* Run `yarn install`. If you don't have Yarn installed, run `npm i -g yarn`.
* To run locally, run `yarn serve`.
* Go to [http://localhost:8080](http://localhost:8080) to view it in your browser. The page will reload when you make changes.

## Adding Tests

This repo uses two test types:

* **Unit tests** with **Vitest** for parser, utility, and component logic.
* **End-to-end (E2E) tests** with **Playwright** for participant/designer flows in a running app.

### Unit tests (Vitest)

* Place unit tests in a sibling `tests/` folder next to the source file they cover.
* Use the same base filename and add `.spec.` (for example: `src/parser/parser.ts` -> `src/parser/tests/parser.spec.ts`).
* Use `vitest` APIs (`describe`, `test`/`it`, `expect`).
* Run unit tests with:

```bash
yarn unittest
```

### E2E tests (Playwright)

* Put E2E tests in the root `tests/` directory.
* Name files with `.spec.ts` (for example: `tests/demo-vlat.spec.ts`).
* Keep tests focused on user-observable behavior (navigation, input, progression, reviewer/designer behavior).
* Run E2E tests with:

```bash
yarn test
```

## Release Instructions

Releasing reVISit.dev happens automatically when a PR is merged into the `main` branch. The pull request title must exactly match the release version, e.g. `v1.0.0`. The release workflow updates version-pinned references, creates a release commit, and pushes a tag with the same name as the PR. Pushing the tag automatically creates the official GitHub release with generated release notes. The `main` branch is protected and requires two reviews before merging.

The workflow for release looks as follows:
Develop features on feature branch
| PRs
Dev branch
| PR (1 per release)
Main branch
| Run release workflow on merge
References are updated, and a release commit and tag are pushed
| Tag push and repository dispatch events
GitHub release is created and downstream builds are triggered
