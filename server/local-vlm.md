# Local VLM summarization (Ollama)

This repo supports a **local-only** screen recording summarization path for cases where clips cannot be sent to Gemini.

## Requirements

- `ffmpeg` + `ffprobe` available on PATH
- [Ollama](https://ollama.com/) running locally
- A vision-language model pulled (default: `llava:7b`)

## Setup

1. Install and start Ollama.
2. Pull a VLM model:

```bash
ollama pull llava:7b
```

3. (Optional) Configure env vars in `.env`:

- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `OLLAMA_VLM_MODEL` (default `llava:7b`)
- `MQP_LOCAL_FRAMES` (default `6`, max `12`)

## API

- `POST /api/analyze-local` (multipart form-data)
  - `video`: the clip
  - `prompt`: (optional) extra guidance for the final synthesis prompt

Response matches the summary shape used by `/api/analyze-large`:

```json
{ "summary": "...", "modelUsed": "llava:7b", "durationMs": 1234 }
```

## Notes / tradeoffs

- This is **slower** and typically **lower quality** than Gemini.
- It samples a small number of frames and summarizes from frame descriptions; it does not transcribe audio.

