import type {
  AppConfig,
  NormalizedTask,
  PersonalityMode,
  WorkflowIntent,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { readToolRouterMode } from '../router/toolRouter.js';

const REVIEW_KEYWORDS = [/review/i, /pr\b/i, /pull request/i, /code review/i];
const CORRECTION_CUE = /\b(actually|instead|wrong|not this|no,|retry|again)\b/i;

export type LearningResult = {
  intent: WorkflowIntent;
  correctionApplied: boolean;
  personalityMode: PersonalityMode;
  notes: string[];
};

export function applyLearning(input: {
  task: NormalizedTask;
  config: AppConfig;
  store: JobStore;
  logStep?: WorkflowStepLogger;
}): LearningResult {
  const { task, config, store, logStep } = input;

  const notes: string[] = [];
  let intent = task.intent;
  let correctionApplied = false;
  const personalityMode: PersonalityMode = 'normal';

  // With the tool-router deciding (issue #456), a remembered phrase must not
  // pick the workflow: every correction on record turns a keyword-gated seed
  // into a PR review, past the review gate and past the router.
  if (readToolRouterMode(store) === 'on') {
    return { intent, correctionApplied, personalityMode, notes: ['skipped: the tool-router decides'] };
  }

  const phraseKey = normalizePhraseKey(task.event.text);
  const explicitIntent = detectExplicitIntent(task.event.text, task.event.channelId, config);
  const latest = store.latestJobForThread(task.event.channelId, task.event.threadTs);

  if (
    explicitIntent &&
    latest &&
    latest.workflow !== explicitIntent &&
    (CORRECTION_CUE.test(task.event.text) || latest.workflow === 'UNKNOWN')
  ) {
    store.saveIntentCorrection({
      channelId: task.event.channelId,
      userId: task.event.userId,
      phraseKey,
      correctedIntent: explicitIntent,
    });

    notes.push(`learned correction ${latest.workflow} -> ${explicitIntent}`);
    logStep?.({
      stage: 'learning.intent.learned',
      message: 'Learned a new intent correction from thread feedback.',
      data: {
        previousIntent: latest.workflow,
        correctedIntent: explicitIntent,
        phraseKey,
      },
    });
  }

  // AI-classified intents should not be overridden by the phrase-matching learning engine
  const AI_CLASSIFIED_INTENTS = new Set([
    'OWNER_AUTOPILOT',
    'IMPLEMENTATION',
    'INFORMATIONAL',
    'CONVERSATIONAL',
    'NONE',
  ]);
  if (!AI_CLASSIFIED_INTENTS.has(intent) && intent !== 'DEV_ASSIST') {
    const corrected = store.findIntentCorrection({
      channelId: task.event.channelId,
      userId: task.event.userId,
      phraseKey,
    });
    if (corrected && corrected !== intent) {
      intent = corrected;
      correctionApplied = true;
      notes.push(`applied learned correction -> ${corrected}`);
      logStep?.({
        stage: 'learning.intent.applied',
        message: 'Applied learned intent correction.',
        data: {
          correctedIntent: corrected,
          phraseKey,
        },
      });
    }
  }

  return {
    intent,
    correctionApplied,
    personalityMode,
    notes,
  };
}

function detectExplicitIntent(text: string, _channelId: string, _config: AppConfig): WorkflowIntent | undefined {
  if (REVIEW_KEYWORDS.some(regex => regex.test(text))) {
    return 'PR_REVIEW';
  }
  return undefined;
}

function normalizePhraseKey(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
    .slice(0, 10)
    .join(' ');
}
