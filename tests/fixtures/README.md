# Recording fixtures

These recordings are synthetic and contain no participant data.

- `review-scene-change.webm`: four seconds, black then white with a transition at two seconds. Used for actual media decoding and scene-detection checks.
- `review-dense-timeline.webm`: 120 seconds of black frames, 320×240 at one frame per second, no audio. Its duration allows the browser stress fixture's 2,000 events, 64 OCR frames and 120 score windows to appear on the timeline. Those evidence entries are separately generated test data, not model detections.
- `review-silent-audio.mp4`: four seconds of black H.264 video with a mono AAC track encoding digital silence. Tests MP4 decoding and skipping silent audio without loading Whisper. FFmpeg astats measured a peak of negative infinity across the complete track.

Generate the longer fixture using the installed FFmpeg executable:

```sh
ffmpeg -n -f lavfi -i color=c=black:s=320x240:r=1:d=120 -c:v libvpx-vp9 -an tests/fixtures/review-dense-timeline.webm
```

The checked-in long fixture was generated with FFmpeg 9.0.1 and measured with ffprobe: 120.000 seconds, 3,616 bytes. SHA-256: `4d339ae740928a75a82b76683d92a367684b7df7868bf38b1c508645bbae3921`. Re-encoding may change container bytes; verify duration/content rather than requiring a regenerated file to have the same hash.

Generate the silent-audio fixture:

```sh
ffmpeg -n -f lavfi -i color=c=black:s=320x240:r=10:d=4 -f lavfi -i anullsrc=r=16000:cl=mono -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart -shortest tests/fixtures/review-silent-audio.mp4
```

FFmpeg 9.0.1 output: 4.000 seconds, 4,556 bytes. SHA-256: `3b19530fb6333643d0432c7c7da7628ff5319a6ee129bea36a2b9832949778ac`. The evaluation manifest uses the actual expected empty event lists for steady and silent media, independently of the browser's synthetic overlay entries.
