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
import {
  spendKey,
  type PersonalAction,
  type PersonalItem,
  type PersonalRun,
  type PersonalWorkKind,
} from '../state/personalStore.js';
import { agentCallContext } from '../state/runContext.js';
import type { AppConfig, WorkflowStepLog } from '../types/contracts.js';
import { readToolCalls } from './agentTranscript.js';
import {
  buildDraftPrompt,
  draftOutcomes,
  draftTarget,
  isConfirmedAsk,
  oneDraftPerConversation,
  type DraftTarget,
} from './drafts.js';
import { collectGithubInventory } from './githubInventory.js';
import { runPrAction } from './prActions.js';
import { fetchPrInfo, type PrInfo } from './prInfo.js';
import { policyNameFor, policyOf, reconcileWork, startItemNow, startWaitingWork } from './work.js';
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
/** The workspace's id, which the app needs to open the Slack app on a thread. */
export const PERSONAL_TEAM_ID_KEY = 'personal.team_id';

const workAwake = new KeepAwake();
const SESSION_KEY_PREFIX = 'session:';
const TICK_MS = 15_000;
const TAP_POLL_MS = 2_000;
/** The agent reads dozens of threads one call at a time, and a three-day window is slow. */
const TRIAGE_TIMEOUT_MS = 90 * 60 * 1000;
const DRAFT_TIMEOUT_MS = 20 * 60 * 1000;

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

async function rememberTeamId(deps: NightlyRunDeps): Promise<void> {
  const auth = await deps.webClient.auth.test().catch(() => undefined);
  if (auth?.team_id) deps.store.setState(PERSONAL_TEAM_ID_KEY, auth.team_id);
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
    closedAsks: personal.closedByOwner().map(item => item.ask),
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
    const readCalls = readToolCalls(cwd);
    for (const triaged of reply.items) {
      const item = toPersonalItem(triaged, run.id);
      const decided = standDownForMiniog(item, jobs);
      personal.upsertItem({
        ...item,
        state: decided.state,
        jobId: decided.jobId,
        doneSummary: decided.doneSummary ?? item.doneSummary,
      });
      personal.setAskConfirmed(item.key, isConfirmedAsk(item, readCalls));
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** Each item's PRs, looked up. A lookup that fails only leaves that PR with nothing to press. */
async function refreshPrInfo(deps: NightlyRunDeps, only?: PersonalItem): Promise<void> {
  const personal = deps.store.personalStore();
  const items = only ? [only] : personal.itemsWithPrs();
  if (items.length === 0) return;
  const info = await fetchPrInfo({
    urls: items.flatMap(item => item.prUrls),
    githubToken: await resolveGithubTokenForCodex(),
  });
  for (const item of items) {
    const known = item.prUrls.filter(url => info[url]).map(url => [url, info[url]]);
    personal.setPrInfo(item.key, Object.fromEntries(known) as Record<string, PrInfo>);
  }
}

/** His Merge or Approve. Says what came of it on the item, and looks the PR up again either way. */
async function runTap(deps: NightlyRunDeps, action: PersonalAction): Promise<void> {
  const personal = deps.store.personalStore();
  const item = action.itemKey ? personal.item(action.itemKey) : undefined;
  if (!item || !action.prUrl || !action.head) return;
  const kind = action.kind === 'merge' ? 'merge' : 'approve';
  let message: string;
  if (!item.prUrls.includes(action.prUrl)) {
    message = "That PR isn't on this item, so nothing was done.";
  } else {
    const token = await resolveGithubTokenForCodex();
    message = token
      ? (
          await runPrAction({
            kind,
            url: action.prUrl,
            head: action.head,
            allowedOrg: deps.config.allowedPrOrg,
            githubToken: token,
          })
        ).message
      : "Couldn't get a GitHub login, so nothing was done.";
  }
  personal.setTapResult(item.key, message);
  logger.info({ key: item.key, kind, prUrl: action.prUrl, message }, 'my day: tap action');
  await refreshPrInfo(deps, item).catch(error => logger.warn({ error: String(error) }, 'my day: PR lookup failed'));
}

/**
 * Saves a run's replies as Slack drafts, once its work has finished and the facts
 * are final. A failure here costs a draft, which the inbox still shows to copy, not
 * the night's work. A reply only goes to a conversation triage really read.
 */
async function saveDrafts(deps: NightlyRunDeps, run: PersonalRun): Promise<void> {
  const personal = deps.store.personalStore();
  const gaps: string[] = [];
  const targets: DraftTarget[] = [];
  let unconfirmed = 0;
  for (const item of personal.repliesToDraft(run.id)) {
    const target = draftTarget(item);
    if (target && item.askConfirmed) {
      targets.push(target);
    } else {
      unconfirmed += 1;
      personal.setDraftResult(item.key, {
        status: 'failed',
        error: "Couldn't confirm this is the conversation the ask came from, so no draft was saved.",
      });
    }
  }
  if (unconfirmed > 0) gaps.push(`${unconfirmed} replies weren't saved as drafts: their ask couldn't be confirmed.`);
  const { send, waiting } = oneDraftPerConversation(targets);
  for (const target of waiting) personal.setDraftResult(target.key, { status: 'blocked' });
  if (send.length > 0) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-my-day-'));
    try {
      const agent = await agentCallContext.run({ jobId: spendKey(run.id), store: deps.store }, () =>
        runClaudeAgentic({
          systemPrompt: buildDraftPrompt(send),
          userMessage: 'Save the drafts now.',
          cwd,
          forceBackend: 'claude-code',
          tier: 'light',
          timeoutMs: DRAFT_TIMEOUT_MS,
          personalSlack: 'draft',
          doing: 'saving your drafts',
          logStep: logStepToLogger,
        }),
      );
      const { results, strays } = draftOutcomes(send, readToolCalls(cwd), agent.error);
      for (const draft of results) personal.setDraftResult(draft.key, draft);
      const failed = results.filter(draft => draft.status === 'failed').length;
      if (failed > 0) gaps.push(`${failed} of ${results.length} drafts couldn't be saved. Copy them from the inbox.`);
      if (strays.length > 0) {
        const where = strays.map(call => String(call.input.channel_id)).join(', ');
        gaps.push(`A draft nobody asked for was saved in ${where}. Check Drafts in Slack, and don't send it.`);
        await alertOwner(
          deps,
          `My day saved a draft nobody asked for in ${where}. Check Drafts in Slack, and don't send it.`,
        );
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
  personal.addGaps(run.id, gaps);
}

/**
 * The part that goes on after a run ends: starts its work, follows every job, and
 * saves its drafts once nothing is left in flight. Polled, so a restart loses
 * nothing. A run that missed a source or was Prepare only starts nothing and drafts nothing.
 */
async function advanceWork(deps: NightlyRunDeps): Promise<void> {
  const personal = deps.store.personalStore();
  await reconcileWork(deps);
  const run = personal.lastRun();
  // The Mac stays awake from the moment a run ends until its work and drafts are done.
  workAwake.set(personal.workInFlight().length > 0);
  if (!run || run.status !== 'OK' || run.prepareOnly) return;
  await startWaitingWork(deps, run.id);
  await reconcileWork(deps);
  // Replies can name what the work produced, so they wait for it. Work set to wait for his
  // button doesn't hold them up.
  const stillToStart = personal.workToStart(run.id).filter(item => willStartItself(deps, item.action));
  const drafts = personal.repliesToDraft(run.id).length;
  workAwake.set(personal.workInFlight().length > 0 || stillToStart.length > 0 || drafts > 0);
  if (personal.workInFlight().length > 0 || stillToStart.length > 0) return;
  if (drafts > 0) await saveDrafts(deps, run);
  workAwake.set(false);
}

function willStartItself(deps: NightlyRunDeps, action: PersonalWorkKind | undefined): boolean {
  return Boolean(action) && policyOf(deps.store, policyNameFor(action as PersonalWorkKind)) === 'auto';
}

/** One run start to finish. Never throws: a failure is recorded and told to the owner. */
export async function runNightly(
  deps: NightlyRunDeps,
  params: { trigger: PersonalRun['trigger']; span?: string; prepareOnly?: boolean; now?: Date },
): Promise<PersonalRun> {
  const personal = deps.store.personalStore();
  const now = params.now ?? new Date();
  const window = runWindow({ now, lastWindowEnd: personal.lastFinishedRun()?.windowEnd, span: params.span });
  const run = personal.startRun({
    trigger: params.trigger,
    prepareOnly: params.prepareOnly,
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
    await rememberTeamId(deps);
    await triage(deps, run, result);
    await refreshPrInfo(deps).catch(error => {
      result.gaps.push(`PR states couldn't be checked: ${String(error)}`);
    });
    // Without every source a reply or a review could be wrong, so that waits for a run that has them.
    if (result.sourceFailed) result.gaps.push('No work was started and no drafts saved, because a source was missing.');
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

  const step = async () => {
    const actions: PersonalAction[] = personal.takeActions(['run_now', 'start_item']);
    for (const action of actions) {
      if (action.kind === 'start_item') await startItemNow(deps, action);
    }
    const runNow = actions.find(action => action.kind === 'run_now');
    if (runNow) {
      await runNightly(deps, { trigger: 'manual', span: runNow.span, prepareOnly: runNow.prepareOnly });
      return;
    }
    const due = isRunDue({
      now: new Date(),
      enabled: store.getState(PERSONAL_ENABLED_KEY) === '1',
      runTime: store.getState(PERSONAL_RUN_TIME_KEY),
      enabledAt: store.getState(PERSONAL_ENABLED_AT_KEY),
      lastStartedAt: personal.lastRun()?.startedAt,
    });
    if (due) {
      await runNightly(deps, { trigger: 'schedule' });
      return;
    }
    await advanceWork(deps);
  };

  const tick = () => {
    if (running) return;
    running = true;
    void step()
      .catch(error => logger.warn({ error: String(error) }, 'my day: tick failed'))
      .finally(() => {
        running = false;
      });
  };

  setInterval(tick, TICK_MS);

  // Apart from the rest: a button shouldn't wait for a run of an hour to finish.
  let tapping = false;
  setInterval(() => {
    if (tapping) return;
    tapping = true;
    void (async () => {
      for (const action of personal.takeActions(['merge', 'approve'])) await runTap(deps, action);
    })()
      .catch(error => logger.warn({ error: String(error) }, 'my day: tap action failed'))
      .finally(() => {
        tapping = false;
      });
  }, TAP_POLL_MS);
}
