import localforage from 'localforage';
import { GlobalConfig } from '../parser/types';
import { getStudyConfig } from '../utils/fetchConfig';
import { PREFIX } from '../utils/Prefix';
import { hash } from '../storage/engines/utils/storageEngineHelpers';
import { parseReviewAnalysis, reviewArtifactPrefix } from '../storage/reviewArtifacts';
import type { TimelineEvent } from '../analysis/individualStudy/screenRecordingSummarization/timelineEventTypes';

export const DEMO_STUDIES = [
  { id: 'demo-screen-recording', name: 'Screen recording study', tasks: ['barChart_audio_screen'] },
  { id: 'demo-html-input', name: 'Interactive bar chart study', tasks: ['bar-chart-1', 'bar-chart-2'] },
];

// These are scripted examples, not measurements or model predictions.
const profiles = [
  {
    name: 'Fluent', file: 'fluent', events: [{ timestamp: 2, type: 'reading', evidence: 'Scripted: reading the chart instruction.' }, { timestamp: 7, type: 'active_interaction', evidence: 'Scripted: selecting a bar.' }], score: 0,
  },
  {
    name: 'Hesitant', file: 'hesitant', events: [{ timestamp: 2, type: 'reading', evidence: 'Scripted: reading the chart instruction.' }, { timestamp: 6, type: 'hesitation', evidence: 'Scripted: pausing over the bars.' }, { timestamp: 10, type: 'confusion_word', evidence: 'Scripted caption: NOT SURE.' }, { timestamp: 14, type: 'active_interaction', evidence: 'Scripted: selecting a bar.' }], score: 3.25,
  },
  {
    name: 'Reconsidering', file: 'reconsidering', events: [{ timestamp: 2, type: 'reading', evidence: 'Scripted: reading the chart instruction.' }, { timestamp: 5, type: 'scene_change', evidence: 'Scripted: opening the help panel.' }, { timestamp: 9, type: 'confused_transition', evidence: 'Scripted: returning to the chart.' }, { timestamp: 12, type: 'hesitation', evidence: 'Scripted: reconsidering the selection.' }, { timestamp: 15, type: 'active_interaction', evidence: 'Scripted: selecting a bar.' }], score: 3,
  },
];

export async function loadReviewDemo(globalConfig: GlobalConfig) {
  if (import.meta.env.VITE_STORAGE_ENGINE !== 'localStorage') throw new Error('The simulated demo requires browser local storage.');
  const media = await Promise.all(profiles.map(async (profile) => {
    const response = await fetch(`${PREFIX}review-demo/${profile.file}.webm`);
    if (!response.ok || !response.headers.get('content-type')?.includes('video/')) throw new Error('Could not load the simulated recording. Please retry.');
    return response.blob();
  }));
  const prepared = await Promise.all(DEMO_STUDIES.map(async (study) => {
    const parsed = await getStudyConfig(study.id, globalConfig);
    if (!parsed || parsed.errors.length) throw new Error(`Could not load ${study.name}.`);
    const { errors: _errors, warnings: _warnings, ...config } = parsed;
    return { ...study, config, configHash: await hash(JSON.stringify(config)) };
  }));
  const storage = localforage.createInstance({ name: 'revisit', driver: localforage.INDEXEDDB });
  await storage.ready();
  // One transaction prevents a partially installed demo and protects concurrent imports.
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('revisit');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let added = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('keyvaluepairs', 'readwrite');
      const store = transaction.objectStore('keyvaluepairs');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Demo import was cancelled. No data was changed.'));
      const updatedAt = new Date().toISOString();
      prepared.forEach((study) => {
        const base = `${import.meta.env.DEV ? 'dev-' : 'prod-'}${study.id}`;
        store.put(study.config, `${base}/configs/${study.configHash}_config`);
        const assignmentsRequest = store.get(`${base}/sequenceAssignment`);
        assignmentsRequest.onsuccess = () => {
          const assignments = assignmentsRequest.result || {};
          Array.from({ length: 6 }, (_, index) => index).forEach((index) => {
            const participantId = `SIMULATED-review-v1-${String(index + 1).padStart(2, '0')}`;
            // Never replace an existing participant, recording, or reviewer edits.
            if (assignments[participantId]) return;
            const participantKey = `${base}/participants/${participantId}_participantData`;
            const existing = store.get(participantKey);
            existing.onsuccess = () => {
              if (existing.result) return;
              const profileIndex = index % profiles.length;
              const profile = profiles[profileIndex];
              const start = Date.UTC(2026, 8, 12, 12, index);
              const answers = Object.fromEntries(study.tasks.map((componentName, taskIndex) => {
                const taskId = `${componentName}_${taskIndex + 1}`;
                const clip = { participantId, taskId };
                const events = profile.events as TimelineEvent[];
                const ocr = [{ timestamp: 2, text: 'SIMULATED: Compare the bars' }, ...(profile.file === 'hesitant' ? [{ timestamp: 10, text: 'NOT SURE' }] : [])];
                const analysis = parseReviewAnalysis({
                  version: 1,
                  revision: crypto.randomUUID(),
                  updatedAt,
                  value: {
                    duration: 18,
                    summary: { text: `SIMULATED / ${profile.name}: ${events.map((event) => event.evidence.replace('Scripted: ', '')).join(' ')} This illustrative animation is reused across example participants; it is not a captured participant session or AI output.`, pipeline: 'heuristic', model: 'Scripted simulation (not AI inference)' },
                    events,
                    ocr,
                    confusion: [{
                      start: 0, end: 18, score: profile.score, evidence: ['Scripted events scored with report weights; the hesitant example includes the OCR multiplier.'],
                    }],
                    diagnostics: ['SIMULATED DATA: scripted evidence and illustrative animation. This demonstrates the interface, not model accuracy.'],
                  },
                });
                store.put(analysis, `${base}/${reviewArtifactPrefix('summary', clip)}_review-analysis`);
                store.put({ version: 1, updatedAt, value: [{ id: `simulation-${index}-${taskIndex}`, timestamp: 2, label: `SIMULATED / ${profile.name}` }] }, `${base}/${reviewArtifactPrefix('tags', clip)}_review-tags`);
                store.put(media[profileIndex], `${base}/screenRecording/${participantId}_${taskId}`);
                return [taskId, {
                  identifier: taskId,
                  componentName,
                  trialOrder: String(taskIndex + 1),
                  answer: {},
                  incorrectAnswers: {},
                  startTime: start + taskIndex * 20000,
                  endTime: start + taskIndex * 20000 + 18000,
                  windowEvents: [],
                  timedOut: false,
                  helpButtonClickedCount: profile.file === 'reconsidering' ? 1 : 0,
                  parameters: {},
                  correctAnswer: [],
                  optionOrders: {},
                  questionOrders: {},
                }];
              }));
              assignments[participantId] = {
                participantId,
                timestamp: start,
                rejected: false,
                claimed: false,
                completed: start + study.tasks.length * 20000,
                createdTime: start,
                total: study.tasks.length,
                answered: study.tasks,
                isDynamic: false,
                stage: 'default',
              };
              store.put({
                participantId,
                participantConfigHash: study.configHash,
                participantIndex: index + 1,
                sequence: {},
                answers,
                searchParams: {},
                metadata: {
                  userAgent: 'SIMULATED', resolution: { width: 960, height: 540 }, language: 'en', ip: null,
                },
                rejected: false,
                participantTags: ['SIMULATED'],
                stage: 'default',
                createdTime: start,
              }, participantKey);
              store.put(assignments, `${base}/sequenceAssignment`);
              added += 1;
            };
          });
        };
      });
    });
  } finally {
    database.close();
  }
  return added;
}
