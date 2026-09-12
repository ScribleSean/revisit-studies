import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Also runs against the real Pages prefix via REVIEW_DEMO_BASE_PATH.
const base = process.env.REVIEW_DEMO_BASE_PATH || '/';

test('simulated demo imports once, plays evidence, compares studies, and survives reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}review-demo`);
  await expect(page.getByRole('heading', { name: 'Explore the ReVIEW rebuild' })).toBeVisible();
  await page.getByRole('button', { name: 'Load simulated recordings' }).click();
  await expect(page.getByText('Loaded 12 simulated participants', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Load simulated recordings' }).click();
  await expect(page.getByText('The simulated participants are already loaded.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Review recordings', exact: true }).first().click();
  await expect(page.getByText('This demonstrates the interface, not model accuracy.', { exact: false })).toBeVisible();
  const recording = page.getByLabel('Study recording', { exact: true });
  await expect(recording).toBeVisible();
  await expect.poll(() => recording.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '2.0s · reading', exact: false }).click();
  await expect.poll(() => recording.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(2, 0);
  await page.reload();
  await expect(page.getByText('SIMULATED / Fluent:', { exact: false }).or(page.getByText('SIMULATED / Reconsidering:', { exact: false }))).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review artifacts (JSON)' }).click();
  const download = await downloaded;
  const archive = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(archive.clips).toHaveLength(6);
  expect(JSON.stringify(archive)).toContain('SIMULATED');
  await page.getByRole('tab', { name: 'Study analysis (cross-clip)' }).click();
  await expect(page.getByLabel('Event count status')).toHaveText('28 events across 6 recordings with evidence.');
  await page.goto(`${base}review-demo`);
  await page.getByRole('link', { name: 'Compare recordings', exact: true }).last().click();
  await expect(page.getByLabel('Event count status')).toHaveText('56 events across 12 recordings with evidence.');
  expect(errors).toEqual([]);
});

test('failed media import makes no partial participants and a retry preserves edits', async ({ page }) => {
  await page.goto(`${base}review-demo`);
  await page.route('**/review-demo/hesitant.webm', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.getByRole('button', { name: 'Load simulated recordings' }).click();
  await expect(page.getByText('Could not load the simulated recording.', { exact: false })).toBeVisible();
  await page.unroute('**/review-demo/hesitant.webm');
  await page.getByRole('button', { name: 'Load simulated recordings' }).click();
  await expect(page.getByText('Loaded 12 simulated participants', { exact: false })).toBeVisible();
  const key = `${process.env.REVIEW_TEST_STORAGE_PREFIX === 'prod' ? 'prod-' : 'dev-'}demo-screen-recording/review/${encodeURIComponent(JSON.stringify(['SIMULATED-review-v1-01', 'barChart_audio_screen_1']))}_review-tags`;
  await page.evaluate(async (tagKey) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('revisit');
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('keyvaluepairs', 'readwrite');
        tx.objectStore('keyvaluepairs').put({ version: 1, updatedAt: new Date().toISOString(), value: [{ id: 'edited', timestamp: 2, label: 'Preserve this reviewer edit' }] }, tagKey);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => reject(tx.error);
      };
    });
  }, key);
  await page.getByRole('button', { name: 'Load simulated recordings' }).click();
  await expect(page.getByText('The simulated participants are already loaded.', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Review recordings', exact: true }).first().click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review artifacts (JSON)' }).click();
  const download = await downloaded;
  expect(await readFile((await download.path())!, 'utf8')).toContain('Preserve this reviewer edit');
});

