import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { runClaudeAgentic } from '../agentic/runClaude.js';
import { settingsProblem } from '../backends/personalSlack.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { logger } from '../logging/logger.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { KeepAwake } from '../runtime/keepAwake.js';
import type { JobStore } from '../state/jobStore.js';
import { spendKey, type PersonalAction, type PersonalRun } from '../state/personalStore.js';
import { agentCallContext } from '../state/runContext.js';
import type { AppConfig, WorkflowStepLog } from '../types/contracts.js';
import { collectGithubInventory } from './githubInventory.js';
import { isRunDue, runWindow } from './schedule.js';
import { findUnfinishedSessions } from './sessions.js';
import { standDownForMiniog } from './standDown.js';
import { buildTriagePrompt, parseTriageReply, toPersonalItem } from './triage.js';

/**
 * My day's nightly run. miniOG keeps the live requests. This run, once a day,
 * finds what neither the owner nor miniOG finished and fills the app's inbox.
 * For now it only reads: nothing goes to Slack or GitHub.
 */

export const PERSONAL_ENABLED_KEY = 'personal.enabled';
export const PERSONAL_ENABLED_AT_KEY = 'personal.enabled_at';
export const PERSONAL_RUN_TIME_KEY = 'personal.run_time';

const SESSION_KEY_PREFIX = 'session:';
const TICK_MS = 15_000;
/** The agent reads dozens of threads one call at a time, and a three-day window is slow. */
const TRIAGE_TIMEOUT_MS = 90 * 60 * 1000;

export interface NightlyRunDeps {
  store: JobStore;
  config: AppConfig;
  webClient: WebClient;
}

/** The DM goes through miniOG's bot token, so it needs no agent: a run that died can still say so. */
async function alertOwner(deps: NightlyRunDeps, text: string): Promise<void> {
  notifyDesktop('My day', text);
  const owner = deps.config.ownerSlackUserIds[0];
  if (!owner) return;
  try {
    await deps.webClient.chat.postMessage({ channel: owner, text });
  } catch (error) {
    logger.warn({ error: String(error) }, 'my day: could not DM the failure');
  }
}

/** How he's named in Slack, for finding mentions without a tag. */
async function ownerNames(deps: NightlyRunDeps, ownerId: string): Promise<string[]> {
  try {
    const { user } = await deps.webClient.users.info({ user: ownerId });
    const names = [user?.profile?.display_name, user?.real_name?.split(' ')[0]];
    return [...new Set(names.filter((name): name is string => Boolean(name?.trim())))];
  } catch {
    return [];
  }
}

async function collectSessions(deps: NightlyRunDeps, run: PersonalRun): Promise<void> {
  const personal = deps.store.personalStore();
  const { unfinished, finishedIds } = await findUnfinishedSessions({
    sinceIso: run.windowStart,
    recheckIds: personal.openSessionKeys().map(key => key.slice(SESSION_KEY_PREFIX.length)),
  });
  for (const sessionId of finishedIds) {
    personal.closeItem(`${SESSION_KEY_PREFIX}${sessionId}`, run.id, 'Nothing left unfinished.');
  }
  for (const session of unfinished) {
    personal.upsertItem({
      key: `${SESSION_KEY_PREFIX}${session.sessionId}`,
      source: 'session',
      state: 'needs_you',
      ask: session.title,
      doneSummary: session.reasons.join(' '),
      evidence: session.lastReply || undefined,
      prUrls: [],
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      lastRunId: run.id,
    });
  }
}

/** What a run couldn't read. A missed source keeps the run from moving the window: see `runWindow`. */
interface RunGaps {
  gaps: string[];
  sourceFailed: boolean;
}

function logStepToLogger(step: WorkflowStepLog): void {
  logger.info({ stage: step.stage, level: step.level }, `my day: ${step.message}`);
}

async function triage(deps: NightlyRunDeps, run: PersonalRun, result: RunGaps): Promise<void> {
  const { store, config } = deps;
  const personal = store.personalStore();
  const ownerId = config.ownerSlackUserIds[0];
  if (!ownerId) throw new Error('no owner is set in Settings');
  const problem = settingsProblem(path.join(os.homedir(), '.claude', 'settings.json'));
  if (problem) throw new Error(problem);

  const github = await collectGithubInventory({
    sinceIso: run.windowStart,
    githubToken: await resolveGithubTokenForCodex(),
  });
  result.gaps.push(...github.errors.map(error => `GitHub: ${error}`));
  result.sourceFailed ||= github.errors.length > 0;

  const openItems = personal.openItems();
  const jobsById = new Map(personal.jobsSince(run.windowStart).map(job => [job.id, job]));
  for (const item of openItems) {
    if (!item.channelId || !item.threadTs) continue;
    for (const job of personal.jobsInThread(item.channelId, item.threadTs)) jobsById.set(job.id, job);
  }
  const jobs = [...jobsById.values()];
  const prompt = buildTriagePrompt({
    ownerSlackId: ownerId,
    ownerNames: await ownerNames(deps, ownerId),
    windowStart: new Date(run.windowStart),
    windowEnd: new Date(run.windowEnd),
    github,
    miniogJobs: jobs,
    openItems,
  });

  // An empty folder: this agent has no business in a repo, and no tools to read one with.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-my-day-'));
  try {
    const agent = await agentCallContext.run({ jobId: spendKey(run.id), store }, () =>
      runClaudeAgentic({
        systemPrompt: prompt,
        userMessage: 'Triage the window now and reply with the JSON.',
        cwd,
        forceBackend: 'claude-code',
        timeoutMs: TRIAGE_TIMEOUT_MS,
        personalSlack: 'read',
        doing: 'reading your Slack',
        logStep: logStepToLogger,
      }),
    );
    if (!agent.ok) throw new Error(agent.error ?? 'the triage agent failed');
    const reply = parseTriageReply(agent.reply);
    result.gaps.push(...reply.gaps);
    for (const triaged of reply.items) {
      const item = toPersonalItem(triaged, run.id);
      const decided = standDownForMiniog(item, jobs);
      personal.upsertItem({
        ...item,
        state: decided.state,
        jobId: decided.jobId,
        doneSummary: decided.doneSummary ?? item.doneSummary,
      });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** One run start to finish. Never throws: a failure is recorded and told to the owner. */
export async function runNightly(
  deps: NightlyRunDeps,
  params: { trigger: PersonalRun['trigger']; span?: string; now?: Date },
): Promise<PersonalRun> {
  const personal = deps.store.personalStore();
  const now = params.now ?? new Date();
  const window = runWindow({ now, lastWindowEnd: personal.lastFinishedRun()?.windowEnd, span: params.span });
  const run = personal.startRun({
    trigger: params.trigger,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
  });
  logger.info({ runId: run.id, window }, 'my day: run starting');
  // A separate hold from the job one: that one follows the count of running jobs.
  const awake = new KeepAwake();
  awake.set(true);
  const result: RunGaps = { gaps: [], sourceFailed: false };
  let failure: string | undefined;
  try {
    await collectSessions(deps, run).catch(error => {
      result.gaps.push(`Claude sessions couldn't be checked: ${String(error)}`);
    });
    await triage(deps, run, result);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    awake.set(false);
  }
  const status = failure ? 'FAILED' : result.sourceFailed ? 'PARTIAL' : 'OK';
  personal.finishRun(run.id, { status, gaps: result.gaps, error: failure });
  if (failure) {
    logger.warn({ runId: run.id, failure }, 'my day: run failed');
    await alertOwner(deps, `Tonight's My day run failed: ${failure}`);
  } else {
    logger.info({ runId: run.id, status, costUsd: personal.runCostUsd(run.id) }, 'my day: run finished');
    notifyDesktop('My day', 'Your inbox is ready.', 'success');
  }
  return { ...run, status };
}

/** Starts the schedule and the app's Run now. Only one run at a time. */
export function startNightlyRuns(deps: NightlyRunDeps): void {
  const { store } = deps;
  const personal = store.personalStore();
  personal.failInterruptedRuns('Watchtower restarted during the run.');
  let running = false;

  const start = (params: { trigger: PersonalRun['trigger']; span?: string }) => {
    running = true;
    void runNightly(deps, params)
      .catch(error => logger.error({ error: String(error) }, 'my day: run crashed'))
      .finally(() => {
        running = false;
      });
  };

  const tick = () => {
    if (running) return;
    try {
      const actions: PersonalAction[] = personal.takeActions();
      const runNow = actions.find(action => action.kind === 'run_now');
      if (runNow) {
        start({ trigger: 'manual', span: runNow.span });
        return;
      }
      const due = isRunDue({
        now: new Date(),
        enabled: store.getState(PERSONAL_ENABLED_KEY) === '1',
        runTime: store.getState(PERSONAL_RUN_TIME_KEY),
        enabledAt: store.getState(PERSONAL_ENABLED_AT_KEY),
        lastStartedAt: personal.lastRun()?.startedAt,
      });
      if (due) start({ trigger: 'schedule' });
    } catch (error) {
      logger.warn({ error: String(error) }, 'my day: tick failed');
    }
  };

  setInterval(tick, TICK_MS);
}
