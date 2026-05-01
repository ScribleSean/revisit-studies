# Optional image for hosting the mass API on Render/Fly with OCR deps.
# Render: create a Web Service, set root directory to this repo, Dockerfile path `server/Dockerfile`,
# start command overridden by CMD below, and set GEMINI_API_KEY / OPENAI_API_KEY as needed.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    tesseract-ocr \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

COPY . .

# Timeline + Whisper: run in image build once you accept the image size, or exec into the container:
#   yarn setup:timeline-python

ENV NODE_ENV=production
EXPOSE 3001
ENV PORT=3001
CMD ["node", "server/analyze-large.mjs"]
