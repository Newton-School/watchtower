import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability, getBundlesForConfig } from '../access/control.js';
import { toolchainEnv } from '../backends/codexBackend.js';
import { REPO_REGISTRY, repoPathOrNull } from '../repos/registry.js';
import { whileWaitingForAnswer } from '../runtime/humanWaits.js';
import { jobSlots } from '../runtime/jobSlots.js';
import { confirmationBlocks, postGatePrompt, withButtonReplies, withRetire } from '../slack/buttonReplies.js';
import { fetchThreadRepliesSince, type ThreadMessage } from '../slack/threadContext.js';
import type { AppConfig, NormalizedTask, PrContext, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import { deployDryRunText, dispatchMarketingProdDeploy, MARKETING_PROD_WORKFLOW } from './deployWorkflow.js';
import { normalizeConfirmationReply } from './shared/confirmationGate.js';
import { isDeployDryRun, listWorkflowRuns } from './shared/githubActionsRun.js';
import { requesterOf } from './shared/requester.js';
import { putMainBackOnStagingAfterMerge, type StagingDeployStore } from './stagingDeployWorkflow.js';

/**
 * After miniOG merges a marketing PR, it offers the production deploy in the
 * same thread, and someone from core-dev taps to deploy (issue #703, the
 * owner's decision of 2026-10-25: a prod deploy needs a tap from core-dev,
 * it is not automatic). The wait runs in the job, like a plan approval: it
 * gives the job's slot up, shows in the app as waiting, ends on a stop, and
 * a restart drops it, so nothing deploys later without a fresh tap.
 */

const execFileAsync = promisify(execFile);
const REPO_KEY = 'newton-marketing-web';

/** How long the offer stays open. */
export const DEPLOY_OFFER_WAIT_MS = 2 * 60 * 60 * 1000;
/** What core-dev replies to deploy; the button sends the same. */
export const DEPLOY_TAP_PHRASE = 'deploy it';
/** A merge by an agent counts as this run's when GitHub dates it no earlier than this before the run began. */
const MERGE_CLOCK_SLACK_MS = 2 * 60 * 1000;

export const DEPLOY_OFFER_LINE =
  "It isn't live yet: someone from core-dev can reply `deploy it` here in the next 2 hours to put it on newtonschool.co.";
export const DEPLOY_OFFER_EXPIRED =
  "No deploy tap in 2 hours, so it isn't live yet. When it should go live, someone from core-dev can ask me to deploy marketing to prod.";
export const DEPLOY_OFFER_DECLINED =
  'Okay, not deploying it now. When it should go live, someone from core-dev can ask me to deploy marketing to prod.';
export const DEPLOY_OFFER_SUPERSEDED =
  "I was holding this thread for the deploy tap, so I didn't pick that up. The offer is closed now: mention me again with it. To deploy later, someone from core-dev can ask me to deploy marketing to prod.";

/** Poll/deadline knobs — a test seam so suites never sleep for real. */
export const __deployOfferTiming = {
  pollMs: 5_000,
  deadlineMs: DEPLOY_OFFER_WAIT_MS,
};

/** Internal seam — tests stub `gh` instead of reading GitHub. */
export const __deployOfferGh = {
  async exec(args: string[], githubToken?: string): Promise<string> {
    const { stdout } = await execFileAsync('gh', args, {
      timeout: 30_000,
      env: { ...toolchainEnv(), ...(githubToken ? { GH_TOKEN: githubToken } : {}) },
    });
    return stdout;
  },
};

const TAP_PHRASES = new Set([
  'deploy it',
  'deploy',
  'confirm deploy',
  'ship it',
  'go live',
  'deploy to prod',
  'deploy it to prod',
  'deploy to production',
  'deploy it to production',
  'deploy marketing',
  'deploy marketing to prod',
  'deploy marketing to production',
]);
const DECLINE_PHRASES = new Set([
  'no',
  'nope',
  'not now',
  'not yet',
  'not today',
  'later',
  'cancel',
  'stop',
  'abort',
  'skip',
  'hold',
  'hold off',
  'dont',
  'dont deploy',
  'do not deploy',
  'dont deploy it',
  'do not deploy it',
]);

/** What was typed, without mentions, punctuation, politeness or a trailing "now". */
function corePhrase(text: string): string {
  return normalizeConfirmationReply(text)
    .replace(/^(?:(?:ok|okay|yes|yep|yeah|sure|please|pls|plz)\s+)+/, '')
    .replace(/(?:\s+(?:please|pls|plz|now|thanks|thank you|asap))+$/, '')
    .trim();
}

/** A reply that asks for the deploy. A bare "yes" never does: it may be meant for someone else. */
export function isDeployTap(text: string): boolean {
  return TAP_PHRASES.has(corePhrase(text));
}

export function isDeployDecline(text: string): boolean {
  // "not now" is a decline before the trailing "now" is dropped.
  return DECLINE_PHRASES.has(normalizeConfirmationReply(text)) || DECLINE_PHRASES.has(corePhrase(text));
}

/**
 * Who may tap: whoever may deploy to production in this channel (the owner,
 * and core-dev's bundle). Never a bot.
 */
export function deployTappers(config: AppConfig, channelId: string, channelType?: string): string[] {
  const candidates = new Set([
    ...config.ownerSlackUserIds,
    ...getBundlesForConfig(config).flatMap(bundle => bundle.resolvedUserIds),
  ]);
  return [...candidates].filter(
    userId =>
      userId !== config.botUserId &&
      evaluateCapability({ config, userId, channelId, channelType, capability: 'deploy_prod' }).allowed,
  );
}

export type DeployTapOutcome = 'tapped' | 'declined' | 'expired' | 'cancelled' | 'superseded';

export interface DeployTapResult {
  outcome: DeployTapOutcome;
  userId?: string;
  replyTs?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

interface TapWaitParams {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  /** ts of the offer; earlier replies never count. */
  promptTs: string;
  allowedUserIds: string[];
  /** May turn the offer down too, though not tap. */
  requesterId: string;
  botUserId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}

/**
 * Waits for a tap on the offer. The thread stays with this job while it
 * waits, as during a plan approval, so a new mention of miniOG there is not
 * picked up as a new ask: it closes the offer instead, and is told so.
 */
async function pollForDeployTap(params: TapWaitParams): Promise<DeployTapResult> {
  const { slack, channelId, threadTs, promptTs, allowedUserIds, requesterId, botUserId, logStep, signal } = params;
  const deadline = Date.now() + __deployOfferTiming.deadlineMs;
  const toldOff = new Set<string>();
  logStep?.({
    stage: 'deploy_offer.waiting',
    message: `Waiting for someone from core-dev to reply "${DEPLOY_TAP_PHRASE}".`,
    data: { allowedUserIds, deadlineMs: __deployOfferTiming.deadlineMs },
  });

  for (;;) {
    if (signal?.aborted) return { outcome: 'cancelled' };
    if (Date.now() >= deadline) return { outcome: 'expired' };
    await sleep(__deployOfferTiming.pollMs, signal);
    if (signal?.aborted) return { outcome: 'cancelled' };

    let messages: ThreadMessage[];
    try {
      messages = await fetchThreadRepliesSince(slack, channelId, threadTs, promptTs);
    } catch {
      // Transient Slack error — retry on the next tick, still bounded by the deadline.
      continue;
    }

    // A button on the offer counts as the typed reply.
    for (const reply of withButtonReplies(messages, channelId, promptTs)) {
      if (!(Number(reply.ts) > Number(promptTs)) || !reply.user || reply.user === botUserId) continue;
      if (reply.botId || reply.subtype === 'bot_message') continue;
      const allowed = allowedUserIds.includes(reply.user);

      if (isDeployTap(reply.text)) {
        if (allowed) return { outcome: 'tapped', userId: reply.user, replyTs: reply.ts };
        if (!toldOff.has(reply.user)) {
          toldOff.add(reply.user);
          logStep?.({
            stage: 'deploy_offer.unauthorized',
            level: 'WARN',
            message: `<@${reply.user}> asked to deploy but may not deploy to production here.`,
            data: { userId: reply.user },
          });
          // Nobody else is tagged: the list of who may deploy is long.
          slack.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `<@${reply.user}> only someone from core-dev can put it live.`,
            })
            .catch(() => {});
        }
        continue;
      }
      if (isDeployDecline(reply.text) && (allowed || reply.user === requesterId)) {
        return { outcome: 'declined', userId: reply.user, replyTs: reply.ts };
      }
      if (botUserId && reply.text.includes(`<@${botUserId}`)) {
        return { outcome: 'superseded', userId: reply.user, replyTs: reply.ts };
      }
    }
  }
}

function tapOutcomeLine(result: DeployTapResult): string {
  const who = result.userId ? `<@${result.userId}>` : 'Someone';
  switch (result.outcome) {
    case 'tapped':
      return `${who} tapped deploy.`;
    case 'declined':
      return `${who} said not now; nothing was deployed.`;
    case 'expired':
      return 'No deploy tap in 2 hours; nothing was deployed.';
    case 'superseded':
      return 'Closed for a new ask; nothing was deployed.';
    default:
      return 'Cancelled; nothing was deployed.';
  }
}

/** Waits for a tap. The job's slot is free while it waits (issue #434). */
export function waitForDeployTap(params: TapWaitParams): Promise<DeployTapResult> {
  return jobSlots.whileWaitingOnHuman(
    () =>
      withRetire(
        () =>
          whileWaitingForAnswer(
            {
              kind: 'confirm',
              channelId: params.channelId,
              threadTs: params.threadTs,
              promptTs: params.promptTs,
              allowedUserIds: [...params.allowedUserIds],
              expects: DEPLOY_TAP_PHRASE,
            },
            () => pollForDeployTap(params),
          ),
        { slack: params.slack, channelId: params.channelId, promptTs: params.promptTs, line: tapOutcomeLine },
      ),
    // Anything but a tap leaves only a line to post: no slot needed for that.
    { signal: params.signal, logStep: params.logStep, endsJob: result => result.outcome !== 'tapped' },
  );
}

/** Test seams: the wait, and putting main back on staging. */
export const __deployOffer = {
  wait: waitForDeployTap,
  restoreStaging: putMainBackOnStagingAfterMerge,
};

/** A PR this run merged, or asked an agent to merge. */
export interface MergedPrRef {
  pr: PrContext;
  /** This run merged it itself and GitHub said so: when GitHub can't be read back, it still counts. */
  knownMerged: boolean;
}

interface MergedMarketingPr {
  url: string;
  headRef?: string;
  mergedAtMs: number;
}

async function readMergedPr(
  ref: MergedPrRef,
  slug: string,
  defaultBranch: string,
  startedAtMs: number,
  githubToken: string | undefined,
): Promise<MergedMarketingPr | undefined> {
  let info: { state?: string; mergedAt?: string | null; headRefName?: string; baseRefName?: string } | undefined;
  try {
    const out = await __deployOfferGh.exec(
      ['pr', 'view', String(ref.pr.number), '--repo', slug, '--json', 'state,mergedAt,headRefName,baseRefName'],
      githubToken,
    );
    info = JSON.parse(out || '{}');
  } catch {
    info = undefined;
  }
  if (!info) return ref.knownMerged ? { url: ref.pr.url, mergedAtMs: startedAtMs } : undefined;
  if (info.state !== 'MERGED' || info.baseRefName !== defaultBranch) return undefined;
  const mergedAtMs = info.mergedAt ? Date.parse(info.mergedAt) : Number.NaN;
  // An agent's run: only a merge it could have made, not one from before it started.
  if (!ref.knownMerged && !(mergedAtMs >= startedAtMs - MERGE_CLOCK_SLACK_MS)) return undefined;
  return {
    url: ref.pr.url,
    headRef: info.headRefName,
    mergedAtMs: Number.isFinite(mergedAtMs) ? mergedAtMs : startedAtMs,
  };
}

/**
 * Offers the production deploy after a marketing merge and carries it out on
 * a tap. Returns undefined when nothing was offered (not a marketing PR into
 * main, not actually merged, no clone here, or the offer couldn't be posted),
 * so the caller says what it would have said anyway.
 */
export async function offerMarketingProdDeploy(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: StagingDeployStore;
  githubToken?: string;
  merged: MergedPrRef[];
  /** When this run started merging. */
  startedAtMs: number;
  /** The start of the offer message: the merge reply, when the offer carries it. */
  lead?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<Omit<WorkflowResult, 'workflow'> | undefined> {
  const { task, config, slack, store, githubToken, startedAtMs, lead, logStep, signal } = params;
  const { channelId, channelType, threadTs } = task.event;
  const repo = REPO_REGISTRY[REPO_KEY];
  const repoPath = repoPathOrNull(config, REPO_KEY);
  if (!repoPath) return undefined;
  const slug = repo.githubSlug;
  const ours = params.merged.filter(ref => `${ref.pr.owner}/${ref.pr.repo}`.toLowerCase() === slug.toLowerCase());
  if (ours.length === 0) return undefined;

  const merged: MergedMarketingPr[] = [];
  for (const ref of ours) {
    const pr = await readMergedPr(ref, slug, repo.expectedDefaultBranch, startedAtMs, githubToken);
    if (pr) merged.push(pr);
  }
  if (merged.length === 0) {
    logStep?.({
      stage: 'deploy_offer.none',
      message: 'No marketing PR was merged into main by this run: no deploy offer.',
      data: { prUrls: ours.map(ref => ref.pr.url) },
    });
    return undefined;
  }
  if (signal?.aborted) return undefined;

  const say = (text: string) =>
    slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).then(
      () => true,
      () => false,
    );
  const allowed = deployTappers(config, channelId, channelType);
  const text = lead ? `${lead} ${DEPLOY_OFFER_LINE}` : DEPLOY_OFFER_LINE;
  const promptTs = await postGatePrompt(slack, {
    channel: channelId,
    thread_ts: threadTs,
    text,
    blocks: () => confirmationBlocks(text, DEPLOY_TAP_PHRASE, 'Deploy to prod'),
  }).catch(() => undefined);
  if (!promptTs) {
    logStep?.({ stage: 'deploy_offer.prompt_failed', level: 'WARN', message: "Couldn't post the deploy offer." });
    return undefined;
  }
  logStep?.({
    stage: 'deploy_offer.asked',
    message: `Offered the marketing prod deploy for ${merged.map(pr => pr.url).join(', ')}.`,
    data: { prUrls: merged.map(pr => pr.url), allowedCount: allowed.length, promptTs },
  });

  // Staging goes back to main now, not after the tap: the branch on it is merged.
  const staging = __deployOffer.restoreStaging({
    config,
    slack,
    store,
    channelId,
    channelType,
    threadTs,
    mergedBranches: merged.flatMap(pr => (pr.headRef ? [pr.headRef] : [])),
    logStep,
    signal,
  });

  const result = await actOnTap({
    tap: await __deployOffer.wait({
      slack,
      channelId,
      threadTs,
      promptTs,
      allowedUserIds: allowed,
      requesterId: requesterOf(task),
      botUserId: config.botUserId,
      logStep,
      signal,
    }),
    // Every merge has to be in the deploy that counts as having shipped it.
    latestMergeMs: Math.max(...merged.map(pr => pr.mergedAtMs)),
    repoPath,
    slack,
    store,
    channelId,
    threadTs,
    say,
    logStep,
    signal,
  });
  await staging;
  return result;
}

async function actOnTap(params: {
  tap: DeployTapResult;
  latestMergeMs: number;
  repoPath: string;
  slack: WebClient;
  store?: StagingDeployStore;
  channelId: string;
  threadTs: string;
  say: (text: string) => Promise<boolean>;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<Omit<WorkflowResult, 'workflow'>> {
  const { tap, latestMergeMs, repoPath, slack, store, channelId, threadTs, say, logStep, signal } = params;
  const done = (message: string, slackPosted: boolean, status: WorkflowResult['status'] = 'SUCCESS') => ({
    status,
    message,
    notifyDesktop: status === 'FAILED',
    slackPosted,
  });
  logStep?.({
    stage: `deploy_offer.${tap.outcome}`,
    message: tapOutcomeLine(tap),
    data: { userId: tap.userId ?? null, replyTs: tap.replyTs ?? null },
  });

  if (tap.outcome === 'cancelled')
    return done('Stopped before anyone tapped deploy; nothing was deployed.', false, 'CANCELLED');
  if (tap.outcome === 'expired') return done(DEPLOY_OFFER_EXPIRED, await say(DEPLOY_OFFER_EXPIRED));
  if (tap.outcome === 'declined') return done(DEPLOY_OFFER_DECLINED, await say(DEPLOY_OFFER_DECLINED));
  if (tap.outcome === 'superseded') return done(DEPLOY_OFFER_SUPERSEDED, await say(DEPLOY_OFFER_SUPERSEDED));

  // Someone may have deployed since the merge, from GitHub or another thread:
  // that deploy already carries it.
  try {
    const runs = await listWorkflowRuns({ repoPath, workflowFile: MARKETING_PROD_WORKFLOW, limit: 10 });
    const since = runs.filter(run => run.createdAt && Date.parse(run.createdAt) >= latestMergeMs);
    const live = since.find(run => run.status === 'completed' && run.conclusion === 'success');
    if (live) {
      const msg = live.url
        ? `Already live: ${live.url}`
        : 'Already live: a production deploy after the merge succeeded.';
      logStep?.({ stage: 'deploy_offer.already_live', message: msg, data: { runId: live.id } });
      return done(msg, await say(msg));
    }
    const going = since.find(run => run.status !== 'completed');
    if (going) {
      const msg = `A production deploy that started after the merge is already running${going.url ? `: ${going.url}` : '.'}`;
      logStep?.({ stage: 'deploy_offer.already_running', message: msg, data: { runId: going.id } });
      return done(msg, await say(msg));
    }
  } catch (error) {
    // Deploying main again is harmless; not deploying after a tap is not.
    logStep?.({
      stage: 'deploy_offer.runs_unreadable',
      level: 'WARN',
      message: `Couldn't read recent prod deploys, deploying anyway: ${String(error)}`,
    });
  }

  if (signal?.aborted) return done('Stopped before the deploy started; nothing was deployed.', false, 'CANCELLED');
  if (isDeployDryRun(store)) {
    const msg = deployDryRunText('newton-marketing-web');
    logStep?.({ stage: 'deploy_offer.dry_run', message: msg, level: 'WARN' });
    return done(msg, await say(msg));
  }
  return dispatchMarketingProdDeploy({ repoPath, slack, channelId, threadTs, logStep, signal });
}
