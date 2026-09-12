// Reproducible illustrative media. No participant recordings or external assets.
// Run with PLAYWRIGHT_BROWSERS_PATH set if using a custom browser installation.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('../public/review-demo/', import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch();
try {
  for (const profile of ['fluent', 'hesitant', 'reconsidering']) {
    const page = await browser.newPage();
    const bytes = await page.evaluate(async (behavior) => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(15);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 500000 });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const finished = new Promise((resolve) => { recorder.onstop = resolve; });
      const start = performance.now();
      const draw = () => {
        const t = (performance.now() - start) / 1000;
        ctx.fillStyle = '#f4f6fa'; ctx.fillRect(0, 0, 960, 540);
        ctx.fillStyle = '#16243a'; ctx.font = 'bold 26px Arial'; ctx.fillText('Compare the bars', 48, 64);
        ctx.fillStyle = '#9b4a00'; ctx.font = 'bold 16px Arial'; ctx.fillText('SIMULATED / ILLUSTRATIVE ANIMATION', 48, 100);
        ctx.fillStyle = '#4a5668'; ctx.font = '18px Arial'; ctx.fillText(`Behavior: ${behavior}  |  ${Math.min(18, Math.floor(t))} / 18 seconds`, 48, 135);
        const heights = [104, 44, 184, 205, 140, 78, 65];
        const selected = t > (behavior === 'fluent' ? 7 : behavior === 'hesitant' ? 14 : 15);
        heights.forEach((height, index) => {
          ctx.fillStyle = selected && index === 3 ? '#167a66' : '#4779c6';
          ctx.fillRect(90 + index * 110, 410 - height, 64, height);
          ctx.fillStyle = '#4a5668'; ctx.font = '18px Arial'; ctx.fillText(String.fromCharCode(65 + index), 114 + index * 110, 440);
        });
        if (behavior === 'reconsidering' && t >= 5 && t < 9) {
          ctx.fillStyle = '#fff'; ctx.fillRect(250, 165, 460, 210);
          ctx.strokeStyle = '#ccd4e0'; ctx.strokeRect(250, 165, 460, 210);
          ctx.fillStyle = '#16243a'; ctx.font = 'bold 24px Arial'; ctx.fillText('Help', 280, 210);
          ctx.font = '20px Arial'; ctx.fillText('Compare bar heights before selecting.', 280, 265);
        }
        const caption = behavior === 'hesitant' && t >= 10 && t < 13 ? 'NOT SURE' : selected ? 'Selection recorded' : 'Reading and comparing…';
        ctx.fillStyle = '#16243a'; ctx.font = '22px Arial'; ctx.fillText(caption, 48, 492);
        ctx.fillStyle = '#e27d32'; ctx.beginPath(); ctx.arc(selected ? 452 : 200 + Math.sin(t / 2) * 105, selected ? 320 : 360, 9, 0, Math.PI * 2); ctx.fill();
      };
      draw();
      recorder.start();
      const interval = setInterval(draw, 1000 / 15);
      await new Promise((resolve) => setTimeout(resolve, 18000));
      clearInterval(interval);
      recorder.stop();
      await finished;
      stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    }, profile);
    await writeFile(new URL(`${profile}.webm`, directory), Buffer.from(bytes));
    await page.close();
    console.log(`Generated ${profile}.webm`);
  }
} finally {
  await browser.close();
}
