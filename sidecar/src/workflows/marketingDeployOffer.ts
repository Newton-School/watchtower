import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import { evaluateCapability, getBundlesForConfig } from '../access/control.js';
import { toolchainEnv } from '../backends/codexBackend.js';
import { REPO_REGISTRY, repoPathOrNull } from '../repos/registry.js';
import { whileWaitingForAnswer } from '../runtime/humanWaits.js';
import { jobSlots } from '../runtime/jobSlots.js';
import { DEPLOY_TAP_PHRASE } from '../runtime/restartNotice.js';
import { confirmationBlocks, postGatePrompt, withButtonReplies, withRetire } from '../slack/buttonReplies.js';
import { fetchThreadRepliesSince, type ThreadMessage } from '../slack/threadContext.js';
import type { AppConfig, NormalizedTask, PrContext, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import {
  deployDryRunText,
  dispatchMarketingProdDeploy,
  MARKETING_PROD_WORKFLOW,
  oneMarketingProdDeployAtATime,
} from './deployWorkflow.js';
import { normalizeConfirmationReply } from './shared/confirmationGate.js';
import { isDeployDryRun, listWorkflowRuns } from './shared/githubActionsRun.js';
import { requesterOf } from './shared/requester.js';
import { putMainBackOnStagingAfterMerge, type StagingDeployStore } from './stagingDeployWorkflow.js';

export { DEPLOY_TAP_PHRASE };

/**
 * After miniOG merges a marketing PR, it offers the production deploy in the
 * same thread, and someone from core-dev taps to deploy (issue #703, the
 * owner's decision of 2026-10-25: a prod deploy needs a tap from core-dev,
 * it is not automatic). The wait runs in the job, like a plan approval: it
 * gives the job's slot up, shows in the app as waiting, ends on a stop, and
 * a restart closes it, so nothing deploys later without a fresh tap.
 */

const execFileAsync = promisify(execFile);
const REPO_KEY = 'newton-marketing-web';

/** How long the offer stays open. */
export const DEPLOY_OFFER_WAIT_MS = 2 * 60 * 60 * 1000;
/** A merge by an agent counts as this run's when GitHub dates it no earlier than this before the run began. */
const MERGE_CLOCK_SLACK_MS = 2 * 60 * 1000;
/** A tap older than this when first seen came while miniOG was away (the host slept): it isn't acted on. */
export const STALE_TAP_MS = 15 * 60 * 1000;

export const DEPLOY_OFFER_LINE =
  "It isn't live yet: someone from core-dev can reply `deploy it` here in the next 2 hours to put it on newtonschool.co.";
export const DEPLOY_OFFER_DM_LINE =
  "It isn't live yet. A deploy can't be tapped in a DM: someone from core-dev can ask me in a channel to deploy marketing to prod.";
export const DEPLOY_OFFER_EXPIRED =
  "No deploy tap in 2 hours, so it isn't live yet. When it should go live, someone from core-dev can ask me to deploy marketing to prod.";
export const DEPLOY_OFFER_DECLINED = 'Okay, not deploying it now.';
/** A hold that also asked for something: the thread was held, so the ask didn't start. */
export const DEPLOY_OFFER_DECLINED_WITH_ASK =
  "Okay, not deploying it now. Mention me again with the rest of your message and I'll pick it up.";
/** A new ask closed the offer: the thread was held, so it didn't start. */
export const DEPLOY_OFFER_SUPERSEDED =
  "That closes the deploy offer. Mention me again with your message and I'll pick it up now.";
export const DEPLOY_OFFER_STATUS = "Not yet: it's waiting for a tap from core-dev.";
export const DEPLOY_TAP_QUEUED_FOR_SLOT =
  "Deploy tapped. I'm finishing other work first and will start it as soon as I can.";

/** Poll/deadline knobs — a test seam so suites never sleep for real. */
export const __deployOfferTiming = {
  /** How often the thread is read at first… */
  pollMs: 5_000,
  /** …for this long… */
  fastWindowMs: 2 * 60 * 1000,
  /** …and how often after that. */
  slowPollMs: 25_000,
  deadlineMs: DEPLOY_OFFER_WAIT_MS,
};

/** Test seam: the clock taps are aged against. */
export const __deployOfferClock = { now: (): number => Date.now() };

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
/**
 * Holding back, from someone who may decide: any negation, "hold", "wait",
 * "not yet"… closes the offer. A loose "wait, don't deploy yet, the image is
 * broken" must never leave it open for the next tap.
 */
const HOLD_RE =
  /^(?:no|nope|nah|cancel|stop|abort|skip|later)$|^(?:no|nope|nah)\b|\b(?:dont|do not|shouldnt|should not|wont|will not|cant|cannot|can not|never ?mind|nvm|not yet|not now|not today|not ready|not until|until|hold|hang on|one sec|one second|one min|wait|pause|stop|cancel|abort|later|tomorrow|after|broken)\b/;
/** Said before a tap without changing it: "LGTM, deploy it". */
const LEADING_PLEASANTRY_RE =
  /^(?:(?:ok|okay|yes|yep|yeah|sure|please|pls|plz|lgtm|looks good|looks great|look good|all good|good to go|great|nice|cool|perfect|awesome|thanks|thank you|thx|approved|go ahead and|go ahead|you can)\s+)+/;
/** "is it live yet?", "when will it go live?", "any update on the deploy?" */
const STATUS_QUESTION_RE =
  /^(?:is|has|did|when|whats|what is|any|where|how)\b.*\b(?:live|deployed|deploy|prod|production|shipped|out|up|status|update)\b|\b(?:live|deployed|shipped) yet\b|\bstatus\b|\b(?:check|see|confirm|know|tell me)\b.*\b(?:live|deployed|shipped)\b|\bif (?:it|its|this)\b.*\b(?:live|deployed|out|up)\b/;
/** Things a message can ask miniOG to do, beyond holding the deploy. */
const ASK_VERBS =
  '(?:change|update|add|remove|fix|make|revert|undo|rename|replace|reword|move|check|show|tell|send|write|put|set|edit|delete|create|open|close|merge|sync|run|test|look|swap|use|tweak|correct)';
const POLITE_ASK_RE = new RegExp(
  `\\b(?:can you|could you|would you|will you|please|pls|also)\\s+(?:also\\s+)?${ASK_VERBS}\\b`,
);
const IMPERATIVE_CLAUSE_RE = new RegExp(`^(?:then |and |also |first |instead )?${ASK_VERBS}\\b`);
const QUESTION_RE =
  /\b(?:can|could|would|will|what|whats|why|how|when|where|which|who|is|are|do|does|did|should)\b[^?]*\?/;
const PLEASANTRY_RE =
  /^(?:(?:thanks|thank you|thank u|thx|ty|tysm|cheers|cool|nice|great|awesome|perfect|amazing|sweet|ok|okay|k|kk|got it|noted|sounds good|lgtm|good job|great job|nice work|great work|well done|love it|yay|woohoo|hi|hey|hello)\s*)+(?:so much|a lot|again|man|bro|buddy|team|all|folks)?$/;
const EMOJI_ONLY_RE = /^(?::[a-z0-9_+'-]+:\s*)+$/;

/** A reply as the offer reads it. */
interface ReadReply {
  /** Lowercased, without mentions, formatting marks or trailing punctuation. */
  text: string;
  /** Lowercased and without mentions, punctuation kept: where one clause ends and the next begins. */
  lower: string;
  mentionsBot: boolean;
  /** It names someone else, or a group: it is addressed to them. */
  mentionsOther: boolean;
}

function readReply(raw: string, botUserId?: string): ReadReply {
  const visible = raw
    // Struck-through words were taken back.
    .replace(/~[^~\n]+~/g, ' ')
    .split('\n')
    // A quote is someone else's words.
    .filter(line => !/^\s*(?:&gt;|>)/.test(line))
    .join('\n');
  const mentioned = [...visible.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map(match => match[1]);
  return {
    text: normalizeConfirmationReply(visible.replace(/<![^>]+>/g, ' ')),
    lower: visible
      .replace(/<[@!][^>]+>/g, ' ')
      .toLowerCase()
      .trim(),
    mentionsBot: Boolean(botUserId && mentioned.includes(botUserId)),
    mentionsOther: mentioned.some(id => id !== botUserId) || /<!(?:subteam\^|here|channel|everyone)/.test(visible),
  };
}

/** What was typed, without politeness or a trailing "now". */
function corePhrase(text: string): string {
  return text
    .replace(LEADING_PLEASANTRY_RE, '')
    .replace(/(?:\s+(?:please|pls|plz|now|thanks|thank you|asap|:[a-z0-9_+'-]+:|\p{Extended_Pictographic}+))+$/u, '')
    .trim();
}

/** A reply that asks for the deploy. A bare "yes", or one aimed at someone else, never does. */
export function isDeployTap(raw: string, botUserId?: string): boolean {
  const reply = readReply(raw, botUserId);
  return !reply.mentionsOther && !HOLD_RE.test(reply.text) && TAP_PHRASES.has(corePhrase(reply.text));
}

/** A reply that holds the deploy back: closes the offer when it comes from someone who may decide. */
export function isDeployDecline(raw: string, botUserId?: string): boolean {
  return HOLD_RE.test(readReply(raw, botUserId).text);
}

function isPleasantry(text: string): boolean {
  return text === '' || PLEASANTRY_RE.test(text) || EMOJI_ONLY_RE.test(text);
}

/**
 * Who may tap: whoever may deploy to production in this channel (the owner,
 * and core-dev's bundle). Never a bot. For the app's view of the wait; a tap
 * itself is checked again when it comes, since access can change meanwhile.
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
  /** A hold that also asked miniOG for something. */
  hasAsk?: boolean;
}

/**
 * Whether a message asks for something beyond holding the deploy: a real
 * question or an instruction ("wait, can you also change the footer link?").
 * "don't deploy this until marketing signs off" and "not yet, waiting on the
 * legal review" don't.
 */
export function asksForMore(lower: string): boolean {
  const clauses = lower
    .split(/[,.;:!\n]+|\s[-–—]\s/)
    .map(clause => clause.trim())
    .filter(Boolean);
  return POLITE_ASK_RE.test(lower) || QUESTION_RE.test(lower) || clauses.some(c => IMPERATIVE_CLAUSE_RE.test(c));
}

/** May this person deploy to production here, right now; and when not, is it only this channel. */
type DeployAccess = (userId: string) => { allowed: boolean; elsewhere: boolean };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // A two-hour wait polls hundreds of times on one signal.
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface TapWaitParams {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  /** ts of the offer; earlier replies never count. */
  promptTs: string;
  /** Who may tap when the offer went up, for the app's view of the wait. */
  allowedUserIds: string[];
  /** Asked when someone taps or speaks up. */
  access: DeployAccess;
  /** May hold the deploy back too, though not tap. */
  requesterId: string;
  botUserId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}

/**
 * Waits for a tap on the offer. The thread stays with this job while it
 * waits, as during a plan approval, so a new mention of miniOG there is not
 * started as a new ask: from the requester or core-dev it closes the offer
 * (and is picked up once the thread is free); from anyone else it gets one
 * line saying to ask in a new thread.
 */
async function pollForDeployTap(params: TapWaitParams): Promise<DeployTapResult> {
  const { slack, channelId, threadTs, promptTs, access, requesterId, botUserId, logStep, signal } = params;
  const startedAt = Date.now();
  const deadline = startedAt + __deployOfferTiming.deadlineMs;
  const seen = new Set<string>();
  const toldOnce = new Set<string>();
  const sayOnce = (key: string, text: string): void => {
    if (toldOnce.has(key)) return;
    toldOnce.add(key);
    slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).catch(() => {});
  };
  logStep?.({
    stage: 'deploy_offer.waiting',
    message: `Waiting for someone from core-dev to reply "${DEPLOY_TAP_PHRASE}".`,
    data: { allowedUserIds: params.allowedUserIds, deadlineMs: __deployOfferTiming.deadlineMs },
  });

  for (;;) {
    if (signal?.aborted) return { outcome: 'cancelled' };
    if (Date.now() >= deadline) return { outcome: 'expired' };
    const fast = Date.now() - startedAt < __deployOfferTiming.fastWindowMs;
    await sleep(fast ? __deployOfferTiming.pollMs : __deployOfferTiming.slowPollMs, signal);
    if (signal?.aborted) return { outcome: 'cancelled' };

    let messages: ThreadMessage[];
    try {
      messages = await fetchThreadRepliesSince(slack, channelId, threadTs, promptTs);
    } catch {
      // Transient Slack error — retry on the next tick, still bounded by the deadline.
      continue;
    }

    // A button on the offer counts as the typed reply. Each reply is read once.
    for (const message of withButtonReplies(messages, channelId, promptTs)) {
      if (!(Number(message.ts) > Number(promptTs)) || seen.has(message.ts)) continue;
      seen.add(message.ts);
      if (!message.user || message.user === botUserId || message.botId || message.subtype === 'bot_message') continue;
      const reply = readReply(message.text, botUserId);
      const who = access(message.user);
      const decides = who.allowed || message.user === requesterId;

      if (decides && HOLD_RE.test(reply.text)) {
        // "wait, can you also change the footer link?" holds the deploy back and asks for more.
        const hasAsk = reply.mentionsBot && asksForMore(reply.lower);
        return { outcome: 'declined', userId: message.user, replyTs: message.ts, ...(hasAsk ? { hasAsk } : {}) };
      }

      if (isDeployTap(message.text, botUserId)) {
        if (!who.allowed) {
          logStep?.({
            stage: 'deploy_offer.unauthorized',
            level: 'WARN',
            message: `<@${message.user}> asked to deploy but may not deploy to production here.`,
            data: { userId: message.user, elsewhere: who.elsewhere },
          });
          // Nobody else is tagged: the list of who may deploy is long.
          sayOnce(
            `denied:${message.user}`,
            who.elsewhere
              ? `<@${message.user}> you can't deploy from this channel.`
              : `<@${message.user}> only someone from core-dev can put it live.`,
          );
          continue;
        }
        const ageMs = __deployOfferClock.now() - Number(message.ts) * 1000;
        if (ageMs > STALE_TAP_MS) {
          logStep?.({
            stage: 'deploy_offer.stale_tap',
            level: 'WARN',
            message: `A tap from ${Math.round(ageMs / 60_000)} minutes ago was first seen now: not acted on.`,
            data: { userId: message.user, replyTs: message.ts, ageMs },
          });
          sayOnce(
            `stale:${message.ts}`,
            `<@${message.user}> I only just saw that \`deploy it\` from ${Math.round(ageMs / 60_000)} minutes ago, so I haven't deployed. The offer is still open: reply \`deploy it\` again to put it live.`,
          );
          continue;
        }
        return { outcome: 'tapped', userId: message.user, replyTs: message.ts };
      }

      // Asking whether it is live yet is not a new ask: answered, the offer stays.
      if (reply.mentionsBot && STATUS_QUESTION_RE.test(reply.text)) {
        sayOnce(`status:${message.ts}`, `<@${message.user}> ${DEPLOY_OFFER_STATUS}`);
        continue;
      }
      if (reply.mentionsBot && !isPleasantry(reply.text)) {
        if (decides) return { outcome: 'superseded', userId: message.user, replyTs: message.ts };
        sayOnce(
          `busy:${message.user}`,
          `<@${message.user}> I'm holding this thread for a deploy tap, so I can't take new asks here for now. Ask me in a new thread.`,
        );
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
      return `${who} held it back; nothing was deployed.`;
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
    {
      signal: params.signal,
      // A tap takes a slot back; when none is free, the thread is told it waits.
      logStep: entry => {
        params.logStep?.(entry);
        if (entry.stage === 'job.slot.waiting') {
          params.slack.chat
            .postMessage({ channel: params.channelId, thread_ts: params.threadTs, text: DEPLOY_TAP_QUEUED_FOR_SLOT })
            .catch(() => {});
        }
      },
      // Anything but a tap leaves only a line to post: no slot needed for that.
      endsJob: result => result.outcome !== 'tapped',
    },
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
  /** When GitHub says it merged; unknown when GitHub couldn't be read back. */
  mergedAtMs?: number;
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
  if (!info) return ref.knownMerged ? { url: ref.pr.url } : undefined;
  if (info.state !== 'MERGED' || info.baseRefName !== defaultBranch) return undefined;
  const mergedAtMs = info.mergedAt ? Date.parse(info.mergedAt) : Number.NaN;
  // An agent's run: only a merge it could have made, not one from before it started.
  if (!ref.knownMerged && !(mergedAtMs >= startedAtMs - MERGE_CLOCK_SLACK_MS)) return undefined;
  return {
    url: ref.pr.url,
    headRef: info.headRefName,
    ...(Number.isFinite(mergedAtMs) ? { mergedAtMs } : {}),
  };
}

type Deployed = { kind: 'live' | 'running'; url?: string; id: number };

/**
 * A production deploy of main started after the merge: that deploy carries
 * it. Undefined when there is none, or the runs can't be read.
 */
async function deployedSinceMerge(
  repoPath: string,
  mergedAtMs: number,
  logStep?: WorkflowStepLogger,
): Promise<Deployed | undefined> {
  try {
    const runs = await listWorkflowRuns({ repoPath, workflowFile: MARKETING_PROD_WORKFLOW, limit: 10 });
    const since = runs.filter(
      run => run.headBranch === 'main' && run.createdAt !== undefined && Date.parse(run.createdAt) >= mergedAtMs,
    );
    const live = since.find(run => run.status === 'completed' && run.conclusion === 'success');
    if (live) return { kind: 'live', url: live.url, id: live.id };
    const going = since.find(run => run.status !== 'completed');
    if (going) return { kind: 'running', url: going.url, id: going.id };
  } catch (error) {
    logStep?.({
      stage: 'deploy_offer.runs_unreadable',
      level: 'WARN',
      message: `Couldn't read recent prod deploys: ${String(error)}`,
    });
  }
  return undefined;
}

function deployedLine(deployed: Deployed): string {
  if (deployed.kind === 'live') {
    return deployed.url
      ? `Already live: ${deployed.url}`
      : 'Already live: a production deploy after the merge succeeded.';
  }
  return `A production deploy that started after the merge is already running${deployed.url ? `: ${deployed.url}` : '.'}`;
}

const isDirect = (channelType?: string) => channelType === 'im' || channelType === 'mpim';

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
  /** Reloads access when it was edited since it was loaded (`reloadBundlesIfChanged`). */
  refreshAccess?: () => void;
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
  // What the job's record keeps whatever happens next: the merge happened.
  const mergedLine = `Merged ${merged.map(pr => pr.url).join(', ')}.`;
  logStep?.({
    stage: 'deploy_offer.merged',
    message: mergedLine,
    data: { prUrls: merged.map(pr => pr.url), headRefs: merged.map(pr => pr.headRef ?? null) },
  });
  if (signal?.aborted) return undefined;

  const say = (text: string) =>
    slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).then(
      () => true,
      () => false,
    );
  // Staging goes back to main now, not after the tap: the branch on it is merged.
  // Never throws, and nothing waits on it unless the deploy itself goes ahead.
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

  // Core-dev can't tap in a DM: the offer would wait on nobody.
  if (isDirect(channelType)) {
    const text = lead ? `${lead} ${DEPLOY_OFFER_DM_LINE}` : DEPLOY_OFFER_DM_LINE;
    logStep?.({ stage: 'deploy_offer.direct', message: 'A DM: no deploy offer, said how to deploy instead.' });
    const posted = await say(text);
    return {
      status: 'SUCCESS',
      message: `${mergedLine} ${DEPLOY_OFFER_DM_LINE}`,
      notifyDesktop: false,
      slackPosted: posted,
    };
  }

  const access: DeployAccess = userId => {
    // Access edited in the app since the run started counts now, not at the next run.
    try {
      params.refreshAccess?.();
    } catch {
      // The bundles as last loaded still decide.
    }
    if (userId === config.botUserId) return { allowed: false, elsewhere: false };
    const decision = evaluateCapability({ config, userId, channelId, channelType, capability: 'deploy_prod' });
    return { allowed: decision.allowed, elsewhere: decision.denyReason === 'CHANNEL_NOT_ENABLED' };
  };
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
  const allowed = deployTappers(config, channelId, channelType);
  logStep?.({
    stage: 'deploy_offer.asked',
    message: `Offered the marketing prod deploy for ${merged.map(pr => pr.url).join(', ')}.`,
    data: { prUrls: merged.map(pr => pr.url), allowedCount: allowed.length, promptTs },
  });

  const tap = await __deployOffer.wait({
    slack,
    channelId,
    threadTs,
    promptTs,
    allowedUserIds: allowed,
    access,
    requesterId: requesterOf(task),
    botUserId: config.botUserId,
    logStep,
    signal,
  });
  // Every merge has to be in the deploy that counts as having shipped it. A
  // merge time GitHub didn't give means no deploy can be shown to carry it.
  const times = merged.map(pr => pr.mergedAtMs);
  const latestMergeMs = times.every((ms): ms is number => ms !== undefined) ? Math.max(...times) : undefined;
  const result = await actOnTap({
    tap,
    latestMergeMs,
    access,
    repoPath,
    slack,
    store,
    channelId,
    threadTs,
    say,
    logStep,
    signal,
  });
  // The deploy kept the run going anyway; anything else ends now and lets the thread go.
  if (tap.outcome === 'tapped') await staging;
  return { ...result, message: `${mergedLine} ${result.message}` };
}

async function actOnTap(params: {
  tap: DeployTapResult;
  latestMergeMs?: number;
  access: DeployAccess;
  repoPath: string;
  slack: WebClient;
  store?: StagingDeployStore;
  channelId: string;
  threadTs: string;
  say: (text: string) => Promise<boolean>;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<Omit<WorkflowResult, 'workflow'>> {
  const { tap, latestMergeMs, access, repoPath, slack, store, channelId, threadTs, say, logStep, signal } = params;
  const done = (message: string, slackPosted: boolean, status: WorkflowResult['status'] = 'SUCCESS') => ({
    status,
    message,
    notifyDesktop: status === 'FAILED',
    slackPosted,
  });
  const deployed = () =>
    latestMergeMs === undefined ? Promise.resolve(undefined) : deployedSinceMerge(repoPath, latestMergeMs, logStep);
  logStep?.({
    stage: `deploy_offer.${tap.outcome}`,
    message: tapOutcomeLine(tap),
    data: { userId: tap.userId ?? null, replyTs: tap.replyTs ?? null },
  });

  if (tap.outcome === 'cancelled') {
    return done('Stopped before anyone tapped deploy; nothing was deployed.', false, 'CANCELLED');
  }
  // The thread was held while the offer was open, so a message that closed it
  // started nothing: its author is asked to send it again, now that it is free.
  if (tap.outcome === 'superseded') {
    logStep?.({ stage: 'deploy_offer.closed_for_ask', message: DEPLOY_OFFER_SUPERSEDED });
    return done(DEPLOY_OFFER_SUPERSEDED, await say(DEPLOY_OFFER_SUPERSEDED));
  }
  if (tap.outcome !== 'tapped') {
    // Someone may have deployed main from GitHub meanwhile: then it is live, whatever the offer did.
    const already = await deployed();
    const askAgain = tap.hasAsk ? " Mention me again with the rest of your message and I'll pick it up." : '';
    const text =
      already?.kind === 'live'
        ? `${deployedLine(already)}${askAgain}`
        : tap.outcome === 'expired'
          ? DEPLOY_OFFER_EXPIRED
          : tap.hasAsk
            ? DEPLOY_OFFER_DECLINED_WITH_ASK
            : DEPLOY_OFFER_DECLINED;
    return done(text, await say(text));
  }

  // Only a tap deploys, and only from someone who may deploy here now.
  if (!tap.userId || !access(tap.userId).allowed) {
    const text = 'That tap came from someone who can no longer deploy here, so nothing was deployed.';
    logStep?.({
      stage: 'deploy_offer.tap_revoked',
      level: 'WARN',
      message: text,
      data: { userId: tap.userId ?? null },
    });
    return done(text, await say(text));
  }

  return oneMarketingProdDeployAtATime(
    async () => {
      // Checked again now: a deploy may have started while this waited its turn.
      const already = await deployed();
      if (already) {
        const text = deployedLine(already);
        logStep?.({ stage: `deploy_offer.already_${already.kind}`, message: text, data: { runId: already.id } });
        return done(text, await say(text));
      }
      if (signal?.aborted) return done('Stopped before the deploy started; nothing was deployed.', false, 'CANCELLED');
      if (isDeployDryRun(store)) {
        const text = deployDryRunText('newton-marketing-web');
        logStep?.({ stage: 'deploy_offer.dry_run', message: text, level: 'WARN' });
        return done(text, await say(text));
      }
      return dispatchMarketingProdDeploy({ repoPath, slack, channelId, threadTs, logStep, signal });
    },
    {
      signal,
      onWait: () =>
        say(
          "Another production deploy of the marketing site is running. I'll check whether it carries this once it's done.",
        ),
      whenStopped: () => done('Stopped before the deploy started; nothing was deployed.', false, 'CANCELLED'),
    },
  );
}

/**
 * After a restart, the offer's message would still read as open, with its
 * button: it says it is closed now (issue #703). Best effort, never throws.
 */
export async function closeDeployOfferAfterRestart(
  slack: WebClient,
  params: { channelId: string; threadTs: string; promptTs: string },
): Promise<void> {
  try {
    const found = await slack.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      oldest: params.promptTs,
      latest: params.promptTs,
      inclusive: true,
      // Slack may return the thread's first message too: the offer is found by its ts.
      limit: 10,
    });
    const offer = (found.messages ?? []).find(message => message.ts === params.promptTs);
    if (!offer) return;
    const text = `${offer.text ?? ''}\n_Closed: I was restarted, so nothing was deployed._`.trim();
    await slack.chat.update({ channel: params.channelId, ts: params.promptTs, text, blocks: [] });
  } catch {
    // The notice in the thread says it either way.
  }
}
