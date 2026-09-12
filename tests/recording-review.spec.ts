import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resetClientStudyState } from './utils';

const studyId = 'demo-screen-recording';
const participantId = 'review-browser-participant';
const taskId = 'barChart_audio_screen_1';
const secondParticipantId = 'search-target-participant';
const secondTaskId = 'external_website_audio_screen_1';
const storagePrefix = process.env.REVIEW_TEST_STORAGE_PREFIX === 'prod' ? 'prod-' : 'dev-';
const baseKey = `${storagePrefix}${studyId}`;
const clipKey = encodeURIComponent(JSON.stringify([participantId, taskId]));
const secondClipKey = encodeURIComponent(JSON.stringify([secondParticipantId, secondTaskId]));
const recordingBytes = readFileSync(fileURLToPath(new URL('./fixtures/review-scene-change.webm', import.meta.url)));
const recordingBase64 = recordingBytes.toString('base64');
const denseTimelineBytes = readFileSync(fileURLToPath(new URL('./fixtures/review-dense-timeline.webm', import.meta.url)));
const denseTimelineBase64 = denseTimelineBytes.toString('base64');

type LocalForageEntry = { key: string; value: unknown };
type ReviewIndexEntry = {
  participantId: string;
  taskId: string;
  timestamp: number;
  type: string;
  evidence: string;
  source: 'auto' | 'tag';
};
type StudyReviewIndex = { version?: number; updatedAt?: string; value?: ReviewIndexEntry[] };

async function openLocalForageStore(page: Page) {
  return await page.evaluate(async () => {
    const open = (version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = version === undefined ? indexedDB.open('revisit') : indexedDB.open('revisit', version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('keyvaluepairs')) {
          request.result.createObjectStore('keyvaluepairs');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const database = await open();
    if (database.objectStoreNames.contains('keyvaluepairs')) {
      database.close();
      return true;
    }
    const nextVersion = database.version + 1;
    database.close();
    (await open(nextVersion)).close();
    return true;
  });
}

async function putLocalForageEntries(page: Page, entries: LocalForageEntry[]) {
  await openLocalForageStore(page);
  await page.evaluate(async (items) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('revisit');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('keyvaluepairs', 'readwrite');
        const store = transaction.objectStore('keyvaluepairs');
        items.forEach(({ key, value }) => store.put(value, key));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, entries);
}

async function putLocalForageVideo(page: Page, key: string, base64: string) {
  await openLocalForageStore(page);
  await page.evaluate(async ({ storageKey, encoded }) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('revisit');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('keyvaluepairs', 'readwrite');
        transaction.objectStore('keyvaluepairs').put(new Blob([bytes], { type: 'video/webm' }), storageKey);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, { storageKey: key, encoded: base64 });
}

async function readLocalForageEntry(page: Page, key: string) {
  return await page.evaluate(async (storageKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('revisit');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction('keyvaluepairs', 'readonly');
        const request = transaction.objectStore('keyvaluepairs').get(storageKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, key);
}

async function listLocalForageKeys(page: Page, prefix: string) {
  return await page.evaluate(async (keyPrefix) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('revisit');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const transaction = database.transaction('keyvaluepairs', 'readonly');
        const request = transaction.objectStore('keyvaluepairs').getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String).filter((key) => key.includes(keyPrefix)).sort());
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, prefix);
}

async function readStudyReviewIndex(page: Page) {
  return await readLocalForageEntry(page, `${baseKey}/review/study_review-index`) as StudyReviewIndex;
}

function orderIndexEntries(entries: ReviewIndexEntry[]) {
  return [...entries].sort((left, right) => [
    left.participantId, left.taskId, left.source, left.timestamp, left.type, left.evidence,
  ].join('\u0000').localeCompare([
    right.participantId, right.taskId, right.source, right.timestamp, right.type, right.evidence,
  ].join('\u0000')));
}

function orderedIndexEntries(index: StudyReviewIndex) {
  return orderIndexEntries(index.value || []);
}

async function selectRecording(page: Page, expectedParticipantId: string, componentName: string) {
  const select = page.getByRole('textbox', { name: 'Participant and recording' });
  await select.click();
  await page.getByRole('option', { name: new RegExp(`${expectedParticipantId} · ${componentName}`) }).click();
  await expect(select).toHaveValue(new RegExp(expectedParticipantId));
  await expect.poll(() => new URL(page.url()).searchParams.get('participant')).toBe(expectedParticipantId);
  await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(`${componentName}_1`);
}

async function openCrossRecordingReview(page: Page) {
  await page.getByRole('tab', { name: 'Study analysis (cross-clip)' }).click();
  await expect(page).toHaveURL(new RegExp(`/analysis/stats/${studyId}/cross-recordings(?:\\?.*)?$`));
  await expect(page.getByRole('heading', { name: 'Study analysis (cross-clip)' })).toBeVisible();
}

async function openRecordingReview(page: Page) {
  await page.getByRole('tab', { name: 'Recording review' }).click();
  await expect(page).toHaveURL(new RegExp(`/analysis/stats/${studyId}/recordings(?:\\?.*)?$`));
  await expect(page.getByRole('heading', { name: 'Recording review' })).toBeVisible();
}

test('reviews a locally stored recording, persists evidence, and keeps saved work accessible offline', async ({ page }) => {
  let analysisServiceAvailable = true;
  let analysisRequests = 0;
  let failNextAnalysis = false;
  const cleanupWarning = 'Remote cleanup failed for Gemini files/review-fixture';
  const cleanupWarningRequests = new Set([1, 3, 6]);
  const analysisPrompts: string[] = [];
  const analysisUploads: Array<{ prompt: string; confusionWords: string; metadataLength: number }> = [];

  await page.route('**/api/review/health', async (route) => {
    if (!analysisServiceAvailable) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'offline' }) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pipelines: [{ id: 'heuristic', available: true }, { id: 'gemini', available: false }, { id: 'gpt4o', available: false }, { id: 'local', available: false }], embeddings: true }),
    });
  });
  await page.route('**/api/review/analyze?**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.toString() !== 'pipeline=heuristic') throw new Error(`Unexpected analysis query: ${requestUrl.search}`);
    const metadataHeader = await route.request().headerValue('x-review-metadata-length');
    const metadataLength = Number(metadataHeader);
    const body = route.request().postDataBuffer();
    if (!body || !Number.isSafeInteger(metadataLength) || metadataLength <= 0 || metadataLength >= body.length) throw new Error(`Analysis request did not contain a valid metadata prefix (header=${metadataHeader}, body=${body?.length ?? 'none'}).`);
    const metadata = JSON.parse(new TextDecoder().decode(body.subarray(0, metadataLength))) as { prompt?: unknown; confusionWords?: unknown };
    if (typeof metadata.prompt !== 'string' || typeof metadata.confusionWords !== 'string' || Buffer.byteLength(JSON.stringify(metadata)) !== metadataLength) throw new Error('Analysis metadata prefix was malformed.');
    if (!body.subarray(metadataLength).equals(recordingBytes)) throw new Error('Analysis upload video bytes changed after the metadata prefix.');
    analysisRequests += 1;
    analysisPrompts.push(metadata.prompt);
    analysisUploads.push({ prompt: metadata.prompt, confusionWords: metadata.confusionWords, metadataLength });
    if (failNextAnalysis) {
      failNextAnalysis = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic analysis failure' }) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          events: [{ timestamp: 1.5, type: 'confusion_word', evidence: 'Matched: NOT SURE' }],
          summary: { text: 'Synthetic recording summary', pipeline: 'heuristic', model: 'local-timeline' },
          ocr: [{ timestamp: 1, text: 'NOT SURE' }],
          confusion: [{
            start: 0, end: 4, score: 2.25, evidence: ['OCR grounded'],
          }],
          meta: {
            duration: 4,
            audio_skipped: true,
            audio_skip_reason: 'synthetic recording',
            ...(cleanupWarningRequests.has(analysisRequests) ? { cleanupWarning } : {}),
          },
        },
      }),
    });
  });
  await page.route('**/api/review/embed', async (route) => {
    const { texts } = route.request().postDataJSON() as { texts: string[] };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ embeddings: texts.map(() => ({ model: 'fixture', vector: [1, 0] })) }),
    });
  });

  await resetClientStudyState(page);
  await page.goto('/');
  await putLocalForageEntries(page, [
    {
      key: `${baseKey}/sequenceAssignment`,
      value: {
        [participantId]: {
          participantId,
          timestamp: 1000,
          rejected: false,
          claimed: false,
          completed: 3000,
          createdTime: 1000,
          total: 1,
          answered: [taskId],
          isDynamic: false,
          stage: 'default',
        },
        [secondParticipantId]: {
          participantId: secondParticipantId,
          timestamp: 1100,
          rejected: false,
          claimed: false,
          completed: 3100,
          createdTime: 1100,
          total: 1,
          answered: [secondTaskId],
          isDynamic: false,
          stage: 'default',
        },
      },
    },
    {
      key: `${baseKey}/participants/${participantId}_participantData`,
      value: {
        participantId,
        participantConfigHash: 'review-browser-config',
        sequence: {},
        participantIndex: 1,
        answers: {
          [taskId]: {
            answer: {},
            identifier: taskId,
            componentName: 'barChart_audio_screen',
            trialOrder: '4',
            incorrectAnswers: {},
            startTime: 1000,
            endTime: 3000,
            windowEvents: [],
            timedOut: false,
            helpButtonClickedCount: 0,
            parameters: {},
            correctAnswer: [],
            optionOrders: {},
            questionOrders: {},
          },
        },
        searchParams: {},
        metadata: {
          userAgent: 'Playwright', resolution: { width: 1280, height: 720 }, language: 'en', ip: null,
        },
        rejected: false,
        participantTags: [],
        stage: 'default',
        createdTime: 1000,
      },
    },
    {
      key: `${baseKey}/participants/${secondParticipantId}_participantData`,
      value: {
        participantId: secondParticipantId,
        participantConfigHash: 'review-browser-config',
        sequence: {},
        participantIndex: 2,
        answers: {
          [secondTaskId]: {
            answer: {},
            identifier: secondTaskId,
            componentName: 'external_website_audio_screen',
            trialOrder: '3',
            incorrectAnswers: {},
            startTime: 1100,
            endTime: 3100,
            windowEvents: [],
            timedOut: false,
            helpButtonClickedCount: 0,
            parameters: {},
            correctAnswer: [],
            optionOrders: {},
            questionOrders: {},
          },
        },
        searchParams: {},
        metadata: {
          userAgent: 'Playwright', resolution: { width: 1280, height: 720 }, language: 'en', ip: null,
        },
        rejected: false,
        participantTags: [],
        stage: 'default',
        createdTime: 1100,
      },
    },
    {
      key: `${baseKey}/review/${secondClipKey}_review-summary`,
      value: { version: 1, updatedAt: '2026-09-09T00:00:00.000Z', value: { text: 'Second recording with a separate task', pipeline: 'heuristic', model: 'fixture' } },
    },
    {
      key: `${baseKey}/review/${secondClipKey}_review-events`,
      value: { version: 1, updatedAt: '2026-09-09T00:00:00.000Z', value: [] },
    },
    {
      key: `${baseKey}/review/${secondClipKey}_review-ocr`,
      value: { version: 1, updatedAt: '2026-09-09T00:00:00.000Z', value: [] },
    },
  ]);

  await page.evaluate(async (recordings) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('revisit');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('keyvaluepairs', 'readwrite');
        const store = transaction.objectStore('keyvaluepairs');
        recordings.forEach((recording) => {
          const bytes = Uint8Array.from(atob(recording.value), (character) => character.charCodeAt(0));
          store.put(new Blob([bytes], { type: 'video/webm' }), recording.storageKey);
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, [
    { storageKey: `${baseKey}/screenRecording/${participantId}_${taskId}`, value: recordingBase64 },
    { storageKey: `${baseKey}/screenRecording/${secondParticipantId}_${secondTaskId}`, value: recordingBase64 },
  ]);

  await page.goto(`/analysis/stats/${studyId}/recordings`);
  await expect(page.getByRole('heading', { name: 'Recording review' })).toBeVisible({ timeout: 15000 });
  await selectRecording(page, participantId, 'barChart_audio_screen');
  const recording = page.getByLabel('Study recording');
  await expect(recording).toBeVisible();
  await expect.poll(() => recording.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1);

  const researcherPrompt = 'Prioritize moments when participants hesitate before acting.';
  await page.getByLabel('Researcher prompt').fill(researcherPrompt);
  await page.getByRole('button', { name: 'Save analysis settings' }).click();
  await page.getByLabel('Prompt name').fill('Hesitation review');
  await page.getByRole('button', { name: 'Save as new prompt' }).click();
  await expect(page.getByLabel('Prompt library status')).toHaveText('Named prompt saved.');
  await page.reload();
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(researcherPrompt);
  await page.getByLabel('Researcher prompt').fill('Temporary prompt to replace');
  const savedPrompts = page.getByRole('textbox', { name: 'Saved prompts' });
  await savedPrompts.click();
  await page.getByRole('option', { name: 'Hesitation review', exact: true }).click();
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(researcherPrompt);
  const updatedPrompt = 'Focus on visible hesitation and indecision.';
  await page.getByLabel('Researcher prompt').fill(updatedPrompt);
  await page.getByRole('button', { name: 'Update saved prompt' }).click();
  await expect(page.getByLabel('Prompt library status')).toHaveText('Named prompt saved.');
  const settingsAfterPromptUpdate = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as { value?: { promptLibrary?: Array<{ id: string; name: string; text: string }> } };
  expect(settingsAfterPromptUpdate.value?.promptLibrary).toHaveLength(1);
  expect(settingsAfterPromptUpdate.value?.promptLibrary?.[0]).toMatchObject({ name: 'Hesitation review', text: updatedPrompt });
  await page.getByRole('button', { name: 'Save as new prompt' }).click();
  await expect(page.getByText('A prompt with this name already exists. Select it to update it.')).toBeVisible();
  const settingsAfterDuplicate = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as { value?: { promptLibrary?: Array<{ id: string; name: string; text: string }> } };
  expect(settingsAfterDuplicate.value?.promptLibrary).toEqual(settingsAfterPromptUpdate.value?.promptLibrary);
  await page.getByRole('button', { name: 'Delete saved prompt' }).click();
  await expect(page.getByLabel('Prompt library status')).toHaveText('Named prompt deleted. Current prompt text is unchanged.');
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(updatedPrompt);
  await page.reload();
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(updatedPrompt);
  const settingsAfterPromptDelete = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as { value?: { promptLibrary?: Array<unknown> } };
  expect(settingsAfterPromptDelete.value?.promptLibrary).toEqual([]);

  const currentLibraryPrompt = 'Keep this current saved prompt unchanged.';
  await page.getByLabel('Researcher prompt').fill(currentLibraryPrompt);
  await page.getByLabel('Prompt name').fill('Current saved prompt');
  await page.getByRole('button', { name: 'Save as new prompt' }).click();
  await expect(page.getByLabel('Prompt library status')).toHaveText('Named prompt saved.');
  const settingsBeforeLegacyImport = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as { value?: { pipeline?: string; confusionWords?: string[]; prompt?: string; promptLibrary?: Array<{ id: string; name: string; text: string }> } };
  const currentSavedPrompt = settingsBeforeLegacyImport.value?.promptLibrary?.[0];
  expect(currentSavedPrompt).toMatchObject({ name: 'Current saved prompt', text: currentLibraryPrompt });
  expect(currentSavedPrompt?.id).toBeTruthy();
  const legacyPromptSource = {
    prompts: [
      {
        id: 'legacy-imported-prompt', name: 'Imported legacy prompt', prompt: 'Look for evidence of hesitation.', updatedAt: '2026-04-01T12:00:00.000Z',
      },
      {
        id: currentSavedPrompt!.id, name: 'Legacy ID collision', prompt: 'This must not overwrite the saved prompt.', updatedAt: '2026-04-02T12:00:00.000Z',
      },
      {
        id: 'legacy-name-collision', name: 'Current saved prompt', prompt: 'This must not replace the saved name.', updatedAt: '2026-04-03T12:00:00.000Z',
      },
    ],
  };
  const legacyPromptSourceKey = `${baseKey}/_screenRecordingPrompts`;
  await putLocalForageEntries(page, [{ key: legacyPromptSourceKey, value: legacyPromptSource }]);
  await page.getByRole('button', { name: 'Import legacy prompts' }).click();
  await expect(page.getByLabel('Legacy prompt import status')).toHaveText('Imported 1; already present 0; conflicts 2. Legacy source preserved.');
  await expect(page.getByText('Skipped Legacy ID collision: id conflict. The original remains in legacy storage.')).toBeVisible();
  await expect(page.getByText('Skipped Current saved prompt: name conflict. The original remains in legacy storage.')).toBeVisible();
  const settingsAfterLegacyImport = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as { value?: { pipeline?: string; confusionWords?: string[]; prompt?: string; promptLibrary?: Array<{ id: string; name: string; text: string }> } };
  expect(settingsAfterLegacyImport.value).toMatchObject({
    pipeline: settingsBeforeLegacyImport.value?.pipeline,
    confusionWords: settingsBeforeLegacyImport.value?.confusionWords,
    prompt: currentLibraryPrompt,
  });
  expect(settingsAfterLegacyImport.value?.promptLibrary).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: currentSavedPrompt!.id, name: 'Current saved prompt', text: currentLibraryPrompt }),
    expect.objectContaining({ id: 'legacy-imported-prompt', name: 'Imported legacy prompt', text: 'Look for evidence of hesitation.' }),
  ]));
  expect(await readLocalForageEntry(page, legacyPromptSourceKey)).toEqual(legacyPromptSource);
  await page.getByRole('button', { name: 'Import legacy prompts' }).click();
  await expect(page.getByLabel('Legacy prompt import status')).toHaveText('Imported 0; already present 1; conflicts 2. Legacy source preserved.');
  await page.reload();
  const importedPrompts = page.getByRole('textbox', { name: 'Saved prompts' });
  await importedPrompts.click();
  await page.getByRole('option', { name: 'Imported legacy prompt', exact: true }).click();
  await expect(page.getByLabel('Researcher prompt')).toHaveValue('Look for evidence of hesitation.');
  expect(await readLocalForageEntry(page, legacyPromptSourceKey)).toEqual(legacyPromptSource);

  const legacySettingsSourceKey = `${baseKey}/_screenRecordingAnalysisSettings`;
  const legacySettingsSource = { summarizationPipeline: 'local', useLocalModel: true };
  await putLocalForageEntries(page, [{ key: legacySettingsSourceKey, value: legacySettingsSource }]);
  await page.getByRole('button', { name: 'Import legacy pipeline preference' }).click();
  await expect(page.getByLabel('Legacy settings import status')).toHaveText('Imported pipeline: local. Other settings and legacy source preserved.');
  const settingsAfterLegacyPipelineImport = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as { value?: { pipeline?: string; confusionWords?: string[]; prompt?: string; promptLibrary?: Array<{ id: string; name: string; text: string }> } };
  expect(settingsAfterLegacyPipelineImport.value).toMatchObject({
    pipeline: 'local',
    confusionWords: settingsAfterLegacyImport.value?.confusionWords,
    prompt: currentLibraryPrompt,
  });
  expect(settingsAfterLegacyPipelineImport.value?.promptLibrary).toEqual(settingsAfterLegacyImport.value?.promptLibrary);
  expect(await readLocalForageEntry(page, legacySettingsSourceKey)).toEqual(legacySettingsSource);
  await page.reload();
  const pipelineSelect = page.getByRole('textbox', { name: 'Analysis pipeline' });
  await expect(pipelineSelect).toHaveValue('local');
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(currentLibraryPrompt);
  await expect(page.getByLabel('Confusion phrases (comma separated)')).toHaveValue((settingsAfterLegacyImport.value?.confusionWords || []).join(', '));
  await page.getByRole('button', { name: 'Import legacy pipeline preference' }).click();
  await expect(page.getByLabel('Legacy settings import status')).toHaveText('Already saved pipeline: local. Other settings and legacy source preserved.');
  await pipelineSelect.click();
  await page.getByRole('option', { name: 'Local timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Save analysis settings' }).click();

  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect(recording).toBeVisible();
  await expect.poll(() => recording.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1);
  await page.getByLabel('Researcher prompt').fill(researcherPrompt);
  await page.getByRole('button', { name: 'Save analysis settings' }).click();
  await page.getByRole('button', { name: 'Analyze recording' }).click();
  await expect(page.getByText('Synthetic recording summary')).toBeVisible();
  await expect(page.getByText(cleanupWarning)).toBeVisible();
  const warningAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { revision?: string; value?: { summary?: { text?: string }; diagnostics?: string[] } };
  if (!warningAnalysis) {
    const selection = await page.getByRole('textbox', { name: 'Participant and recording' }).inputValue();
    const reviewKeys = await listLocalForageKeys(page, 'review-analysis');
    throw new Error(`Missing atomic analysis for ${baseKey}; url=${page.url()}; selection=${selection}; review-analysis keys=${JSON.stringify(reviewKeys)}`);
  }
  expect(warningAnalysis.revision).toMatch(/^[0-9a-f-]{36}$/i);
  expect(warningAnalysis.value?.summary?.text).toBe('Synthetic recording summary');
  expect(warningAnalysis.value?.diagnostics).toEqual([
    'Audio analysis skipped: synthetic recording',
    cleanupWarning,
  ]);
  await openCrossRecordingReview(page);
  const crossRecordingEvidence = page.locator('section[aria-label="Cross-recording evidence"]');
  await expect(crossRecordingEvidence.getByLabel('Event count status')).toHaveText('1 events across 1 recordings with evidence.');
  const sourceAutoEvent: ReviewIndexEntry = {
    participantId, taskId, timestamp: 1.5, type: 'confusion_word', evidence: 'Matched: NOT SURE', source: 'auto',
  };
  const initialStudyIndex = await readStudyReviewIndex(page);
  expect(initialStudyIndex.version).toBe(1);
  expect(Date.parse(initialStudyIndex.updatedAt || '')).toBeGreaterThan(0);
  expect(orderedIndexEntries(initialStudyIndex)).toEqual(orderIndexEntries([sourceAutoEvent]));
  await openRecordingReview(page);
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(new RegExp(participantId));
  const evidence = page.getByRole('button', { name: '1.5s · confusion word · Matched: NOT SURE', exact: true });
  await expect(evidence).toBeVisible();
  await expect.poll(async () => (await evidence.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const onScreenText = page.getByRole('button', { name: '1.0s · NOT SURE', exact: true });
  const confusionScore = page.getByRole('button', { name: 'Confusion score 2.25 from 0 to 4 seconds', exact: true });
  await expect(onScreenText).toBeVisible();
  await expect(confusionScore).toBeVisible();
  expect(analysisPrompts).toEqual([researcherPrompt]);
  const timeline = page.locator('section[aria-label="Synchronized recording timeline"]');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText('● hesitation');
  await expect(timeline).toContainText('▲ confusion word');
  await expect(timeline).toContainText('■ scene change');
  await expect(timeline).toContainText('◆ reading');
  await expect(timeline).toContainText('✚ confused transition');
  await expect(timeline).toContainText('★ active interaction');
  const timelineEvent = timeline.getByRole('button', { name: 'Timeline event at 1.5 seconds: confusion word. Matched: NOT SURE. OCR grounded', exact: true });
  const timelineOcr = timeline.getByRole('button', { name: 'Timeline OCR at 1.0 seconds: NOT SURE. OCR grounded', exact: true });
  const timelineScore = timeline.getByRole('button', { name: 'Timeline score 2.25 from 0 to 4 seconds. OCR grounded', exact: true });
  await expect(timelineEvent).toBeVisible();
  await expect(timelineOcr).toBeVisible();
  await expect(timelineScore).toBeVisible();
  await expect(timeline.locator('circle[data-grounded="true"]')).toHaveCount(2);
  await timelineEvent.click();
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1.5, 4);
  await timelineOcr.focus();
  await expect(timeline.locator('[aria-live="polite"]')).toHaveText('Timeline OCR at 1.0 seconds: NOT SURE. OCR grounded');
  await timelineOcr.press('Space');
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1, 4);
  const timelineSeek = timeline.getByLabel('Timeline seek');
  await timelineSeek.focus();
  await timelineSeek.press('End');
  await expect(timelineSeek).toHaveValue('4');
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(4, 4);
  await recording.evaluate((video) => { video.currentTime = 2; video.dispatchEvent(new Event('timeupdate')); });
  await expect(timelineSeek).toHaveValue('2');
  await expect(timeline.getByText('Video time: 2.0 of 4.0 seconds', { exact: true })).toBeVisible();
  expect(analysisRequests).toBe(1);
  await confusionScore.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '../review-ui.png', fullPage: true });

  await evidence.click();
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1.5, 4);
  await onScreenText.click();
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1, 4);
  await confusionScore.click();
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(0, 4);

  await recording.evaluate((video) => { video.currentTime = 2.25; });
  await page.getByLabel('Tag at current video time').fill('Needs review');
  await page.getByRole('button', { name: 'Add tag' }).click();
  const savedTag = page.getByRole('button', { name: '2.3s · Needs review', exact: true });
  await expect(savedTag).toBeVisible();
  const sourceTagEvent: ReviewIndexEntry = {
    participantId, taskId, timestamp: 2.25, type: 'tag', evidence: 'Needs review', source: 'tag',
  };
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, sourceTagEvent]));
  await page.setViewportSize({ width: 1280, height: 1600 });
  await timeline.scrollIntoViewIfNeeded();
  await timeline.screenshot({ path: '../review-timeline.png' });
  await openCrossRecordingReview(page);
  await expect(crossRecordingEvidence.getByLabel('Event count status')).toHaveText('2 events across 1 recordings with evidence.');
  await expect(crossRecordingEvidence.getByRole('heading', { name: 'Events by task' })).toBeVisible();
  const taskCounts = crossRecordingEvidence.getByRole('table', { name: 'Task and event type counts' });
  await expect(taskCounts.getByRole('row', { name: new RegExp(`${taskId}.*1.*1`) })).toBeVisible();
  await expect(crossRecordingEvidence.getByRole('button', { name: `${participantId} · ${taskId}: 2 events`, exact: true })).toBeVisible();
  const denseWindow = crossRecordingEvidence.getByRole('button', { name: `${participantId} · ${taskId} · 1.5–31.5s: 2 events`, exact: true });
  await expect(denseWindow).toBeVisible();
  await expect(crossRecordingEvidence.getByText('confusion word + tag: 1', { exact: true })).toBeVisible();
  await crossRecordingEvidence.scrollIntoViewIfNeeded();
  await crossRecordingEvidence.screenshot({ path: '../review-dashboard.png' });
  await page.screenshot({ path: '../review-ui.png', fullPage: true });
  await crossRecordingEvidence.getByLabel('Co-occurrence gap (seconds)').fill('0');
  await expect(crossRecordingEvidence.getByText('No matching event pairs.', { exact: true })).toBeVisible();
  await denseWindow.click();
  const timestampTarget = new URL(page.url());
  expect(timestampTarget.pathname).toBe(`/analysis/stats/${studyId}/recordings`);
  expect(timestampTarget.searchParams.get('participant')).toBe(participantId);
  expect(timestampTarget.searchParams.get('task')).toBe(taskId);
  expect(timestampTarget.searchParams.get('time')).toBe('1.5');
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(new RegExp(participantId));
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1.5, 4);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(new RegExp(participantId));
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1.5, 4);

  const analysis = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as {
    version?: number; revision?: string; updatedAt?: string; value?: {
      summary?: { text?: string }; events?: Array<{ timestamp: number }>; ocr?: Array<{ timestamp: number; text: string }>;
      confusion?: Array<{ start: number; end: number; score: number; evidence: string[] }>; duration?: number; prompt?: string;
    };
  };
  expect(analysis.version).toBe(1);
  expect(analysis.revision).toMatch(/^[0-9a-f-]{36}$/i);
  expect(Date.parse(analysis.updatedAt || '')).toBeGreaterThan(0);
  expect(analysis.value?.summary?.text).toBe('Synthetic recording summary');
  expect(analysis.value?.events).toEqual([{ timestamp: 1.5, type: 'confusion_word', evidence: 'Matched: NOT SURE' }]);
  expect(analysis.value?.ocr).toEqual([{ timestamp: 1, text: 'NOT SURE' }]);
  expect(analysis.value?.confusion).toEqual([{
    start: 0, end: 4, score: 2.25, evidence: ['OCR grounded'],
  }]);
  expect(analysis.value?.duration).toBe(4);
  expect(analysis.value?.prompt).toBe(researcherPrompt);

  await page.getByLabel('Confusion phrases (comma separated)').fill('wait, need help');
  await page.getByRole('button', { name: 'Save analysis settings' }).click();
  await expect(page.getByRole('status', { name: 'Analysis settings save status' })).toHaveText('Analysis settings saved.');
  const savedSettings = await readLocalForageEntry(page, `${baseKey}/review/study_review-settings`) as {
    value?: { confusionWords?: string[] };
  };
  expect(savedSettings.value?.confusionWords).toEqual(['wait', 'need help']);
  await page.reload();
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect(page.getByText('Diagnostics recorded with this analysis', { exact: true })).toBeVisible();
  await expect(page.getByText(cleanupWarning, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Confusion phrases (comma separated)')).toHaveValue('wait, need help');
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(researcherPrompt);
  await expect(savedTag).toBeVisible();
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, sourceTagEvent]));
  await expect(onScreenText).toBeVisible();
  await expect(confusionScore).toBeVisible();
  await onScreenText.click();
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(1, 4);
  await page.getByRole('button', { name: 'Delete tag Needs review' }).click();
  await expect(savedTag).toHaveCount(0);
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent]));
  await openCrossRecordingReview(page);
  await expect(crossRecordingEvidence.getByLabel('Event count status')).toHaveText('1 events across 1 recordings with evidence.');

  await page.getByRole('button', { name: 'Index saved recordings' }).click();
  await expect(page.getByText('Indexed 2 recordings with saved analysis.')).toBeVisible();
  const firstEmbedding = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-embedding`) as { value?: { model: string; vector: number[]; analysisRevision?: string } };
  const secondEmbedding = await readLocalForageEntry(page, `${baseKey}/review/${secondClipKey}_review-embedding`) as { value?: { model: string; vector: number[]; analysisRevision?: string } };
  expect(firstEmbedding.value).toMatchObject({ model: 'fixture', vector: [1, 0], analysisRevision: analysis.revision });
  expect(secondEmbedding.value).toMatchObject({ model: 'fixture', vector: [1, 0] });
  expect(secondEmbedding.value?.analysisRevision).toMatch(/^legacy:/);

  await page.getByLabel('Search recording content').fill('separate task');
  await page.getByRole('button', { name: 'Search recordings' }).click();
  await expect(page.getByText('Searched 2 indexed recordings. Showing up to five matches.')).toBeVisible();
  const targetResult = page.getByRole('button', { name: new RegExp(`^${secondParticipantId} · ${secondTaskId} · similarity 1\\.000`) });
  const currentResult = page.getByRole('button', { name: new RegExp(`^${participantId} · ${taskId} · similarity 1\\.000`) });
  await expect(targetResult).toBeVisible();
  await expect(currentResult).toBeVisible();
  await page.screenshot({ path: '../review-ui.png', fullPage: true });
  await targetResult.click();
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(/search-target-participant/);
  await expect(page.getByText('Second recording with a separate task', { exact: true })).toBeVisible();
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(/review-browser-participant/);
  await expect(page.getByText('Synthetic recording summary', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Analyze recording' }).click();
  await expect.poll(() => analysisRequests).toBe(2);
  await expect.poll(async () => (await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { revision?: string }).revision).not.toBe(analysis.revision);
  const reanalyzed = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { revision?: string };
  expect(reanalyzed.revision).toMatch(/^[0-9a-f-]{36}$/i);
  expect(reanalyzed.revision).not.toBe(analysis.revision);
  await expect(page.getByText(/Search index updated\./)).toBeVisible();

  await openCrossRecordingReview(page);
  await expect(page.getByLabel('Search recording content')).toHaveValue('separate task');
  await expect(page.getByRole('button', { name: 'Search recordings' })).toBeEnabled();
  await page.getByRole('button', { name: 'Search recordings' }).click();
  await expect(page.getByText('Searched 2 indexed recordings. Showing up to five matches.')).toBeVisible();
  await expect(currentResult).toBeVisible();
  await expect(targetResult).toBeVisible();

  await openRecordingReview(page);
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await page.getByRole('button', { name: 'Analyze listed recordings' }).click();
  await expect(page.getByText('Batch: 2 of 2 processed · finished')).toBeVisible();
  const batchCleanupStatus = page.locator('p').filter({ hasText: cleanupWarning });
  await expect(batchCleanupStatus).toHaveCount(1);
  await expect(batchCleanupStatus).toContainText(': saved');
  await expect(batchCleanupStatus).toContainText(cleanupWarning);
  await expect.poll(() => analysisRequests).toBe(4);
  const batchFirstAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { version?: number; revision?: string; value?: { prompt?: string } };
  const batchSecondAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${secondClipKey}_review-analysis`) as { version?: number; revision?: string; value?: { prompt?: string } };
  expect(batchFirstAnalysis.version).toBe(1);
  expect(batchFirstAnalysis.revision).toMatch(/^[0-9a-f-]{36}$/i);
  expect(batchFirstAnalysis.revision).not.toBe(reanalyzed.revision);
  expect(batchSecondAnalysis.version).toBe(1);
  expect(batchSecondAnalysis.revision).toMatch(/^[0-9a-f-]{36}$/i);
  expect(batchFirstAnalysis.value?.prompt).toBe(researcherPrompt);
  expect(batchSecondAnalysis.value?.prompt).toBe(researcherPrompt);
  const batchFirstEmbedding = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-embedding`) as { value?: { analysisRevision?: string } };
  const batchSecondEmbedding = await readLocalForageEntry(page, `${baseKey}/review/${secondClipKey}_review-embedding`) as { value?: { analysisRevision?: string } };
  expect(batchFirstEmbedding.value?.analysisRevision).toBe(batchFirstAnalysis.revision);
  expect(batchSecondEmbedding.value?.analysisRevision).toBe(batchSecondAnalysis.revision);
  const targetAutoEvent: ReviewIndexEntry = {
    participantId: secondParticipantId, taskId: secondTaskId, timestamp: 1.5, type: 'confusion_word', evidence: 'Matched: NOT SURE', source: 'auto',
  };
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, targetAutoEvent]));
  await openCrossRecordingReview(page);
  await expect(crossRecordingEvidence.getByLabel('Event count status')).toHaveText('2 events across 2 recordings with evidence.');
  const targetRecordingEvents = crossRecordingEvidence.getByRole('button', { name: `${secondParticipantId} · ${secondTaskId}: 1 events`, exact: true });
  await expect(targetRecordingEvents).toBeVisible();
  await targetRecordingEvents.click();
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(new RegExp(secondParticipantId));
  await expect(page.getByText('Synthetic recording summary', { exact: true })).toBeVisible();
  await selectRecording(page, participantId, 'barChart_audio_screen');

  failNextAnalysis = true;
  await page.getByRole('button', { name: 'Analyze listed recordings' }).click();
  await expect(page.getByText('Batch: 2 of 2 processed · finished')).toBeVisible();
  await expect(page.getByText(`${secondParticipantId} · ${secondTaskId}: failed`)).toBeVisible();
  await expect(page.getByText(`${participantId} · ${taskId}: saved`)).toBeVisible();
  await expect.poll(() => analysisRequests).toBe(6);
  const failedTargetAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${secondClipKey}_review-analysis`) as { revision?: string };
  const savedSourceAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { revision?: string };
  expect(failedTargetAnalysis.revision).toBe(batchSecondAnalysis.revision);
  expect(savedSourceAnalysis.revision).not.toBe(batchFirstAnalysis.revision);

  await page.getByRole('button', { name: 'Retry unfinished recordings' }).click();
  await expect(page.getByText('Batch: 1 of 1 processed · finished')).toBeVisible();
  await expect.poll(() => analysisRequests).toBe(7);
  expect(analysisPrompts).toEqual(Array.from({ length: 7 }, () => researcherPrompt));
  const retriedTargetAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${secondClipKey}_review-analysis`) as { revision?: string };
  const preservedSourceAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { revision?: string };
  expect(retriedTargetAnalysis.revision).not.toBe(failedTargetAnalysis.revision);
  expect(preservedSourceAnalysis.revision).toBe(savedSourceAnalysis.revision);

  const legacyParticipantId = 'rebuild-only-legacy-participant';
  const legacyTaskId = 'legacy_review_task_1';
  const legacyClipKey = encodeURIComponent(JSON.stringify([legacyParticipantId, legacyTaskId]));
  const assignmentsBeforeRebuild = await readLocalForageEntry(page, `${baseKey}/sequenceAssignment`) as Record<string, unknown>;
  await putLocalForageEntries(page, [
    {
      key: `${baseKey}/sequenceAssignment`,
      value: {
        ...assignmentsBeforeRebuild,
        [legacyParticipantId]: {
          participantId: legacyParticipantId,
          timestamp: 3500,
          rejected: false,
          claimed: false,
          completed: 4500,
          createdTime: 3500,
          total: 1,
          answered: [legacyTaskId],
          isDynamic: false,
          stage: 'default',
        },
      },
    },
    {
      key: `${baseKey}/participants/${legacyParticipantId}_participantData`,
      value: {
        participantId: legacyParticipantId,
        participantConfigHash: 'review-browser-config',
        sequence: {},
        participantIndex: 3,
        answers: {
          [legacyTaskId]: {
            answer: {},
            identifier: legacyTaskId,
            componentName: 'legacy_review_task',
            trialOrder: '1',
            incorrectAnswers: {},
            startTime: 3500,
            endTime: 4500,
            windowEvents: [],
            timedOut: false,
            helpButtonClickedCount: 0,
            parameters: {},
            correctAnswer: [],
            optionOrders: {},
            questionOrders: {},
          },
        },
        searchParams: {},
        metadata: {
          userAgent: 'Playwright', resolution: { width: 1280, height: 720 }, language: 'en', ip: null,
        },
        rejected: false,
        participantTags: [],
        stage: 'default',
        createdTime: 3500,
      },
    },
    {
      key: `${baseKey}/screenRecordingSummary/${legacyParticipantId}_${legacyTaskId}`,
      value: { summary: 'Imported historical recording summary', model: 'old-review-model', prompt: 'Describe visible uncertainty.' },
    },
    {
      key: `${baseKey}/screenRecordingEvents/${legacyParticipantId}_${legacyTaskId}`,
      value: { events: [{ timestamp: '3', type: 'scene_change', evidence: 'Recovered legacy event' }] },
    },
    {
      key: `${baseKey}/screenRecordingTags/${legacyParticipantId}_${legacyTaskId}`,
      value: { tags: [{ id: 'historical-tag', timestamp: '2', label: 'Historical note' }] },
    },
  ]);

  const legacySummarySourceKey = `${baseKey}/screenRecordingSummary/${legacyParticipantId}_${legacyTaskId}`;
  const legacyEventsSourceKey = `${baseKey}/screenRecordingEvents/${legacyParticipantId}_${legacyTaskId}`;
  const legacyTagsSourceKey = `${baseKey}/screenRecordingTags/${legacyParticipantId}_${legacyTaskId}`;
  const legacySummarySource = await readLocalForageEntry(page, legacySummarySourceKey);
  const legacyEventsSource = await readLocalForageEntry(page, legacyEventsSourceKey);
  const legacyTagsSource = await readLocalForageEntry(page, legacyTagsSourceKey);
  expect(await readLocalForageEntry(page, `${baseKey}/review/${legacyClipKey}_review-analysis`)).toBeUndefined();
  await page.reload();
  await selectRecording(page, legacyParticipantId, 'legacy_review_task');
  await expect(page.getByText('No summary saved yet.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import legacy recording results' }).click();
  await expect(page.getByLabel('Legacy recording import status')).toHaveText('Imported: analysis, tags. Existing results preserved: none. Legacy source preserved.');
  await expect(page.getByText('Imported historical recording summary', { exact: true })).toBeVisible();
  const importedLegacyAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${legacyClipKey}_review-analysis`) as { revision?: string; value?: { summary?: { text?: string }; events?: Array<{ timestamp: number; type: string; evidence: string }> } };
  expect(importedLegacyAnalysis.revision).toMatch(/^[0-9a-f-]{36}$/i);
  expect(importedLegacyAnalysis.value?.summary?.text).toBe('Imported historical recording summary');
  expect(importedLegacyAnalysis.value?.events).toEqual([{ timestamp: 3, type: 'scene_change', evidence: 'Recovered legacy event' }]);
  const importedLegacyTags = await readLocalForageEntry(page, `${baseKey}/review/${legacyClipKey}_review-tags`) as { value?: Array<{ id: string; timestamp: number; label: string }> };
  expect(importedLegacyTags.value).toEqual([{ id: 'historical-tag', timestamp: 2, label: 'Historical note' }]);
  expect(await readLocalForageEntry(page, legacySummarySourceKey)).toEqual(legacySummarySource);
  expect(await readLocalForageEntry(page, legacyEventsSourceKey)).toEqual(legacyEventsSource);
  expect(await readLocalForageEntry(page, legacyTagsSourceKey)).toEqual(legacyTagsSource);
  const legacyAutoEvent: ReviewIndexEntry = {
    participantId: legacyParticipantId, taskId: legacyTaskId, timestamp: 3, type: 'scene_change', evidence: 'Recovered legacy event', source: 'auto',
  };
  const legacyTagEvent: ReviewIndexEntry = {
    participantId: legacyParticipantId, taskId: legacyTaskId, timestamp: 2, type: 'tag', evidence: 'Historical note', source: 'tag',
  };
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, targetAutoEvent, legacyAutoEvent, legacyTagEvent]));
  await page.reload();
  await selectRecording(page, legacyParticipantId, 'legacy_review_task');
  await page.getByRole('button', { name: 'Import legacy recording results' }).click();
  await expect(page.getByLabel('Legacy recording import status')).toHaveText('Imported: none. Existing results preserved: analysis, tags. Legacy source preserved.');
  const retriedLegacyAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${legacyClipKey}_review-analysis`) as { revision?: string };
  expect(retriedLegacyAnalysis.revision).toBe(importedLegacyAnalysis.revision);
  expect(await readLocalForageEntry(page, legacySummarySourceKey)).toEqual(legacySummarySource);
  expect(await readLocalForageEntry(page, legacyEventsSourceKey)).toEqual(legacyEventsSource);
  expect(await readLocalForageEntry(page, legacyTagsSourceKey)).toEqual(legacyTagsSource);

  await putLocalForageEntries(page, [{ key: `${baseKey}/review/study_review-index`, value: { version: 999 } }]);
  await openCrossRecordingReview(page);
  await page.getByRole('button', { name: 'Rebuild saved study index' }).click();
  await expect(crossRecordingEvidence.getByLabel('Saved index rebuild status')).toHaveText('Saved study index rebuilt: 4 events.');
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, targetAutoEvent, legacyAutoEvent, legacyTagEvent]));
  await expect(crossRecordingEvidence.getByLabel('Event count status')).toHaveText('4 events across 3 recordings with evidence.');

  await openRecordingReview(page);
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect(recording).toBeVisible();
  await recording.evaluate((video) => { video.currentTime = 2; });
  await page.getByLabel('Tag at current video time').fill('Export report tag');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByRole('button', { name: '2.0s · Export report tag', exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export study report (Markdown)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('recording-review-demo-screen-recording.md');
  await expect(page.getByLabel('Report export status')).toHaveText('Report downloaded: 3 recordings, 1 thumbnail warnings.');
  const reportPath = await download.path();
  expect(reportPath).not.toBeNull();
  const reportMarkdown = readFileSync(reportPath!, 'utf8');
  expect(reportMarkdown).toContain('# Recording review report');
  expect(reportMarkdown).toContain('Study: demo\\-screen\\-recording');
  expect(reportMarkdown).toContain('3 recordings; 5 automatic events and researcher tags.');
  expect(reportMarkdown).toContain('review\\-browser\\-participant');
  expect(reportMarkdown).toContain('search\\-target\\-participant');
  expect(reportMarkdown).toContain('rebuild\\-only\\-legacy\\-participant');
  expect(reportMarkdown).toContain('Synthetic recording summary');
  expect(reportMarkdown).toContain('### Researcher prompt used');
  expect(reportMarkdown).toContain('Prioritize moments when participants hesitate before acting\\.');
  expect(reportMarkdown).toContain('### Diagnostics recorded with this analysis');
  expect(reportMarkdown).toContain('Remote cleanup failed for Gemini files/review\\-fixture');
  expect(reportMarkdown).toContain('NOT SURE');
  expect(reportMarkdown).toContain('OCR grounded');
  expect(reportMarkdown).toContain('Export report tag');
  expect(reportMarkdown).toMatch(/Thumbnail unavailable: ScreenRecording for task legacy\\_review\\_task\\_1 and participant rebuild\\-only\\-legacy\\-participant not found/);
  expect(reportMarkdown).toContain('Pipeline: legacy; model:');
  expect(reportMarkdown).toContain('Imported historical recording summary');
  expect(reportMarkdown.match(/!\[Frame at 25 percent of recording duration\]\(data:image\/jpeg;base64,[A-Za-z0-9+/=]+\)/g)).toHaveLength(2);
  const firstThumbnail = reportMarkdown.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/)?.[0];
  expect(firstThumbnail).toBeTruthy();
  const decodedThumbnail = await page.evaluate(async (dataUri) => {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('Downloaded report thumbnail could not be decoded'));
      image.src = dataUri;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable while validating report thumbnail');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0;
    for (let index = 0; index < pixels.length; index += 4) total += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    return { width: image.naturalWidth, height: image.naturalHeight, averageBrightness: total / (pixels.length / 4) };
  }, firstThumbnail!);
  expect(decodedThumbnail.width).toBeGreaterThan(0);
  expect(decodedThumbnail.height).toBeGreaterThan(0);
  expect(decodedThumbnail.width).toBeLessThanOrEqual(320);
  expect(decodedThumbnail.height).toBeLessThanOrEqual(240);
  expect(decodedThumbnail.averageBrightness).toBeLessThan(20);

  const analysisRequestsBeforeArtifactExport = analysisRequests;
  const artifactDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export review artifacts (JSON)' }).click();
  const artifactDownload = await artifactDownloadPromise;
  expect(artifactDownload.suggestedFilename()).toBe('recording-review-demo-screen-recording.json');
  await expect(page.getByLabel('Report export status')).toHaveText('Artifacts downloaded: 3 recordings, all nine categories included.');
  expect(analysisRequests).toBe(analysisRequestsBeforeArtifactExport);
  const artifactPath = await artifactDownload.path();
  expect(artifactPath).not.toBeNull();
  const artifactExport = JSON.parse(readFileSync(artifactPath!, 'utf8')) as {
    format: string;
    version: number;
    studyId: string;
    generatedAt: string;
    study: { settings: unknown; index: unknown };
    clips: Array<{
      participantId: string;
      taskId: string;
      analysis: { revision: string; value: { prompt?: string; diagnostics?: string[]; summary?: { text?: string } } } | null;
      artifacts: Record<string, { value?: unknown } | null>;
    }>;
  };
  expect(artifactExport).toMatchObject({ format: 'revisit-review-artifacts', version: 1, studyId });
  expect(Date.parse(artifactExport.generatedAt)).toBeGreaterThan(0);
  expect(artifactExport.study.settings).not.toBeNull();
  expect(artifactExport.study.index).not.toBeNull();
  expect(artifactExport.clips).toHaveLength(3);
  const sourceArchive = artifactExport.clips.find((clip) => clip.participantId === participantId && clip.taskId === taskId);
  const targetArchive = artifactExport.clips.find((clip) => clip.participantId === secondParticipantId && clip.taskId === secondTaskId);
  const legacyArchive = artifactExport.clips.find((clip) => clip.participantId === legacyParticipantId && clip.taskId === legacyTaskId);
  expect(sourceArchive).toBeTruthy();
  expect(targetArchive).toBeTruthy();
  expect(legacyArchive).toBeTruthy();
  for (const clip of artifactExport.clips) {
    expect(Object.keys(clip.artifacts).sort()).toEqual(['confusion', 'embedding', 'events', 'ocr', 'prompt', 'summary', 'tags']);
  }
  const sourceStoredAtExport = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as {
    revision?: string;
    value?: { prompt?: string; diagnostics?: string[] };
  };
  expect(sourceArchive!.analysis?.revision).toBe(sourceStoredAtExport.revision);
  expect(sourceArchive!.analysis?.value.prompt).toBe(sourceStoredAtExport.value?.prompt);
  expect(sourceArchive!.analysis?.value.diagnostics).toEqual(sourceStoredAtExport.value?.diagnostics);
  expect(sourceArchive!.artifacts.embedding?.value).toMatchObject({ model: 'fixture', vector: [1, 0], analysisRevision: sourceStoredAtExport.revision });
  expect(sourceArchive!.artifacts.tags?.value).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Export report tag', timestamp: 2 })]));
  expect(targetArchive!.artifacts.tags).toBeNull();
  expect(legacyArchive!.analysis?.value.summary?.text).toBe('Imported historical recording summary');
  expect(legacyArchive!.analysis?.value.prompt).toBe('Describe visible uncertainty.');
  expect(legacyArchive!.artifacts.prompt).toBeNull();
  await page.getByRole('button', { name: 'Delete tag Export report tag' }).click();
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, targetAutoEvent, legacyAutoEvent, legacyTagEvent]));

  const matrixClips = Array.from({ length: 26 }, (_, index) => ({
    participantId: `matrix-participant-${String(index).padStart(2, '0')}`,
    taskId: `matrix_task_${String(index % 13).padStart(2, '0')}`,
    index,
  }));
  const savedAssignments = await readLocalForageEntry(page, `${baseKey}/sequenceAssignment`) as Record<string, unknown>;
  await putLocalForageEntries(page, [
    {
      key: `${baseKey}/sequenceAssignment`,
      value: {
        ...savedAssignments,
        ...Object.fromEntries(matrixClips.map(({ participantId: matrixParticipantId, taskId: matrixTaskId, index }) => [matrixParticipantId, {
          participantId: matrixParticipantId,
          timestamp: 4000 + index,
          rejected: false,
          claimed: false,
          completed: 5000 + index,
          createdTime: 4000 + index,
          total: 1,
          answered: [matrixTaskId],
          isDynamic: false,
          stage: 'default',
        }])),
      },
    },
    ...matrixClips.flatMap(({ participantId: matrixParticipantId, taskId: matrixTaskId, index }) => {
      const matrixKey = encodeURIComponent(JSON.stringify([matrixParticipantId, matrixTaskId]));
      return [
        {
          key: `${baseKey}/participants/${matrixParticipantId}_participantData`,
          value: {
            participantId: matrixParticipantId,
            participantConfigHash: 'review-browser-config',
            sequence: {},
            participantIndex: index + 3,
            answers: {
              [matrixTaskId]: {
                answer: {},
                identifier: matrixTaskId,
                componentName: matrixTaskId,
                trialOrder: '1',
                incorrectAnswers: {},
                startTime: 4000 + index,
                endTime: 5000 + index,
                windowEvents: [],
                timedOut: false,
                helpButtonClickedCount: 0,
                parameters: {},
                correctAnswer: [],
                optionOrders: {},
                questionOrders: {},
              },
            },
            searchParams: {},
            metadata: {
              userAgent: 'Playwright', resolution: { width: 1280, height: 720 }, language: 'en', ip: null,
            },
            rejected: false,
            participantTags: [],
            stage: 'default',
            createdTime: 4000 + index,
          },
        },
        {
          key: `${baseKey}/review/${matrixKey}_review-analysis`,
          value: {
            version: 1,
            revision: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            updatedAt: '2026-09-09T00:00:00.000Z',
            value: {
              summary: { text: `Matrix recording ${index}`, pipeline: 'fixture', model: 'fixture' },
              events: [{ timestamp: 1, type: 'scene_change', evidence: 'Matrix event' }],
              ocr: [],
              confusion: [],
            },
          },
        },
      ];
    }),
  ]);
  await page.reload();
  await openCrossRecordingReview(page);
  await expect(crossRecordingEvidence.getByLabel('Event count status')).toHaveText('30 events across 29 recordings with evidence.');
  await expect.poll(async () => orderedIndexEntries(await readStudyReviewIndex(page))).toEqual(orderIndexEntries([sourceAutoEvent, targetAutoEvent, legacyAutoEvent, legacyTagEvent]));
  const recordingMatrix = crossRecordingEvidence.getByRole('table', { name: 'Participant and task event counts' });
  await expect(recordingMatrix).toBeVisible();
  await expect(recordingMatrix.getByRole('row', { name: /matrix-participant-00.*matrix_task_00.*1/ })).toBeVisible();
  const rowPages = crossRecordingEvidence.getByLabel('Participant and task event counts row pages');
  const columnPages = crossRecordingEvidence.getByLabel('Participant and task event counts column pages');
  await expect(rowPages).toBeVisible();
  await expect(columnPages).toBeVisible();
  await rowPages.getByRole('button', { name: '2', exact: true }).click();
  await columnPages.getByRole('button', { name: '2', exact: true }).click();
  const matrixTarget = recordingMatrix.getByRole('button', { name: 'matrix-participant-25 · matrix_task_12: 1 events', exact: true });
  await expect(matrixTarget).toBeVisible();
  await rowPages.getByRole('button', { name: '1', exact: true }).click();
  await columnPages.getByRole('button', { name: '1', exact: true }).click();
  await expect(recordingMatrix.getByRole('row', { name: /matrix-participant-00.*matrix_task_00.*1/ })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1600 });
  await crossRecordingEvidence.scrollIntoViewIfNeeded();
  await crossRecordingEvidence.screenshot({ path: '../review-dashboard.png' });
  await rowPages.getByRole('button', { name: '2', exact: true }).click();
  await columnPages.getByRole('button', { name: '2', exact: true }).click();
  await matrixTarget.click();
  await expect(page.getByRole('textbox', { name: 'Participant and recording' })).toHaveValue(/matrix-participant-25/);

  const longUnicodePrompt = '界'.repeat(8000);
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await page.getByLabel('Researcher prompt').fill(longUnicodePrompt);
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(longUnicodePrompt);
  await page.getByRole('button', { name: 'Save analysis settings' }).click();
  await expect(page.getByRole('status', { name: 'Analysis settings save status' })).toHaveText('Analysis settings saved.');
  await page.getByRole('button', { name: 'Analyze recording' }).click();
  await expect.poll(() => analysisRequests).toBe(8);
  expect(analysisPrompts.at(-1)).toBe(longUnicodePrompt);
  expect(analysisUploads).toHaveLength(8);
  expect(analysisUploads.at(-1)?.metadataLength).toBeGreaterThan(longUnicodePrompt.length);
  await expect.poll(async () => {
    const longPromptAnalysis = await readLocalForageEntry(page, `${baseKey}/review/${clipKey}_review-analysis`) as { value?: { prompt?: string } };
    return longPromptAnalysis.value?.prompt;
  }).toBe(longUnicodePrompt);
  await page.reload();
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect(page.getByLabel('Researcher prompt')).toHaveValue(longUnicodePrompt);

  analysisServiceAvailable = false;
  await page.reload();
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect(page.getByText('Analysis service unavailable')).toBeVisible();
  await expect(page.getByText('Synthetic recording summary')).toBeVisible();
  await expect(page.getByRole('button', { name: '1.5s · confusion word · Matched: NOT SURE', exact: true })).toBeVisible();
  await expect(onScreenText).toBeVisible();
  await expect(confusionScore).toBeVisible();
  await expect(page.getByRole('button', { name: 'Analyze recording' })).toBeDisabled();

  const denseEvents = Array.from({ length: 2000 }, (_, index) => ({
    timestamp: index / 20,
    type: ['hesitation', 'reading', 'scene_change', 'confusion_word', 'active_interaction'][index % 5],
    evidence: `Synthetic dense event ${index}`,
  }));
  const denseOcr = Array.from({ length: 64 }, (_, index) => ({ timestamp: index * 1.75, text: `Synthetic OCR ${index}` }));
  const denseConfusion = Array.from({ length: 120 }, (_, index) => ({
    start: index,
    end: index + 0.5,
    score: (index % 9) - 4,
    evidence: [`Synthetic score ${index}`],
  }));
  await putLocalForageVideo(page, `${baseKey}/screenRecording/${participantId}_${taskId}`, denseTimelineBase64);
  await putLocalForageEntries(page, [{
    key: `${baseKey}/review/${clipKey}_review-analysis`,
    value: {
      version: 1,
      revision: '00000000-0000-4000-8000-000000002000',
      updatedAt: '2026-09-09T00:00:00.000Z',
      value: {
        summary: { text: 'Synthetic dense evidence baseline', pipeline: 'fixture', model: 'fixture' },
        events: denseEvents,
        ocr: denseOcr,
        confusion: denseConfusion,
        duration: 120,
      },
    },
  }]);
  // The 120-second synthetic video makes every persisted event, OCR frame, and score
  // window representable in the synchronized timeline.
  const expectedVisibleTimelineMarkers = denseEvents.length + denseOcr.length + denseConfusion.length;
  expect(expectedVisibleTimelineMarkers).toBe(2184);
  const initialEvidencePageSize = 50;
  await page.addInitScript(({ eventCount, markerCount }) => {
    const state = {
      startAt: performance.now(),
      readyAt: null as number | null,
      longTasks: [] as Array<{ startTime: number; duration: number }>,
      longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    };
    (window as typeof window & { __reviewDenseBaseline?: typeof state }).__reviewDenseBaseline = state;
    const markReady = () => {
      if (state.readyAt !== null) return;
      const eventButtons = Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes('Synthetic dense event ')).length;
      const timelineMarkers = document.querySelectorAll('section[aria-label="Synchronized recording timeline"] g[role="button"]').length;
      if (eventButtons === eventCount && timelineMarkers === markerCount) state.readyAt = performance.now();
    };
    const mutations = new MutationObserver(markReady);
    mutations.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'title'],
    });
    if (state.longTaskSupported) {
      new PerformanceObserver((entries) => {
        entries.getEntries().forEach((entry) => state.longTasks.push({ startTime: entry.startTime, duration: entry.duration }));
      }).observe({ type: 'longtask', buffered: true });
    }
    requestAnimationFrame(markReady);
  }, { eventCount: initialEvidencePageSize, markerCount: expectedVisibleTimelineMarkers });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.reload();
  await selectRecording(page, participantId, 'barChart_audio_screen');
  await expect.poll(() => recording.evaluate((video) => video.duration)).toBeCloseTo(120, 2);
  await page.waitForFunction((eventCount) => Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes('Synthetic dense event ')).length >= eventCount, initialEvidencePageSize);
  const [denseMetrics, chromeMetrics] = await Promise.all([
    page.evaluate(() => {
      const state = (window as typeof window & { __reviewDenseBaseline?: { startAt: number; readyAt: number | null; longTasks: Array<{ startTime: number; duration: number }>; longTaskSupported: boolean } }).__reviewDenseBaseline;
      if (!state) throw new Error('Dense evidence baseline was not installed.');
      // The awaited selector predicate is the authoritative ready condition. Chromium can
      // coalesce DOM mutations during React commits, so retain its timing when observed
      // and otherwise stamp the same completed predicate here.
      const readyAt = state.readyAt ?? performance.now();
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return {
        renderToEvidenceReadyMs: readyAt - state.startAt,
        navigationDurationMs: navigation?.duration ?? null,
        evidenceButtons: Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes('Synthetic dense event ')).length,
        ocrButtons: Array.from(document.querySelectorAll('button')).filter((button) => button.textContent?.includes('· Synthetic OCR ')).length,
        scoreButtons: document.querySelectorAll('button[aria-label^="Confusion score"]').length,
        timelineMarkers: document.querySelectorAll('section[aria-label="Synchronized recording timeline"] g[role="button"]').length,
        totalButtons: document.querySelectorAll('button').length,
        longTaskSupported: state.longTaskSupported,
        longTasks: state.longTasks,
      };
    }),
    cdp.send('Performance.getMetrics'),
  ]);
  expect(denseMetrics.evidenceButtons).toBe(initialEvidencePageSize);
  expect(denseMetrics.ocrButtons).toBe(initialEvidencePageSize);
  expect(denseMetrics.scoreButtons).toBe(initialEvidencePageSize);
  expect(denseMetrics.timelineMarkers).toBe(expectedVisibleTimelineMarkers);
  const denseEventsList = page.getByRole('region', { name: 'Events list' });
  const denseOcrList = page.getByRole('region', { name: 'OCR list' });
  const denseScoresList = page.getByRole('region', { name: 'Scores list' });
  await expect(denseEventsList.getByRole('status')).toHaveText('Events: 1–50 of 2000');
  await expect(denseOcrList.getByRole('status')).toHaveText('OCR: 1–50 of 64');
  await expect(denseScoresList.getByRole('status')).toHaveText('Scores: 1–50 of 120');
  await denseEventsList.getByRole('button', { name: 'Events last page', exact: true }).click();
  const lastDenseEvent = denseEventsList.getByRole('button', { name: '100.0s · active interaction · Synthetic dense event 1999', exact: true });
  await expect(lastDenseEvent).toBeVisible();
  await lastDenseEvent.click();
  await expect.poll(() => recording.evaluate((video) => video.currentTime)).toBeCloseTo(99.95, 2);
  await denseOcrList.getByRole('button', { name: 'OCR last page', exact: true }).click();
  await expect(denseOcrList.getByRole('button', { name: '110.3s · Synthetic OCR 63', exact: true })).toBeVisible();
  await denseScoresList.getByRole('button', { name: 'Scores last page', exact: true }).click();
  await expect(denseScoresList.getByRole('button', { name: 'Confusion score -2 from 119 to 119.5 seconds', exact: true })).toBeVisible();
  const denseMetricsOutput = process.env.REVIEW_PERFORMANCE_OUTPUT || test.info().outputPath('dense-metrics.json');
  writeFileSync(denseMetricsOutput, `${JSON.stringify({
    label: 'Synthetic dense evidence browser baseline with paged lists and 120-second media',
    synthetic: true,
    fixture: {
      events: denseEvents.length,
      ocr: denseOcr.length,
      scoreWindows: denseConfusion.length,
      visibleTimelineMarkers: expectedVisibleTimelineMarkers,
      initialEvidencePageSize,
    },
    rendered: denseMetrics,
    chromeMetrics: Object.fromEntries(chromeMetrics.metrics.filter((metric) => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'JSHeapUsedSize', 'Nodes'].includes(metric.name)).map((metric) => [metric.name, metric.value])),
    capturedAt: new Date().toISOString(),
  }, null, 2)}\n`);
});
