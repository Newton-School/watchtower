import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import type {
  DossierRole,
  AppConfig,
  CodexRunRequest,
  CodexRunResult,
  ImplementationApprovalResume,
  NormalizedTask,
  PrContext,
  ResumeContext,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { evaluateCapability, getAdminUserIds, getConfiguredAccessControl } from '../access/control.js';
import { composeChangeReply, requesterIsEngineer, sanitizeRequesterSummary } from './shared/changeReply.js';
import { approvalBlocks, confirmationBlocks, postGatePrompt, yesNoBlocks } from '../slack/buttonReplies.js';
import { connectorsFor, withConnectors } from '../backends/connectors.js';
import { runCodex, getActiveBackendId, selectBackendForUser } from '../codex/runCodex.js';
import { connectionLostReply, killedFromOutsideReply, runWithInfraRetry } from '../codex/infraRetry.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { getBackend } from '../backends/registry.js';
import type { AgentBackendId } from '../backends/types.js';
import {
  runAgentPipeline,
  planNeedsRequesterConfirmation,
  postPlanForApproval,
  changesSinceLastPlan,
  waitForApproval,
  buildApprovalMessage,
  coderDeclaredBlocked,
  formatExternalChanges,
} from '../agents/pipeline.js';
import { normalizePlannerOutput, planListsFiles } from '../agents/normalizePlannerOutput.js';
import { inferRepoFromAffectedFiles, readRepoAffinity, repoPathFor, resolveRepoOrAsk } from './shared/repoResolver.js';
import {
  enabledRepoKeys,
  getRepo,
  repoKeyForWorkspacePath,
  repoKeyFromGithubRepoName,
  type ContentPolicy,
} from '../repos/registry.js';
import type { RepoAffinity } from '../router/repoClassifier.js';
import { waitForClarificationWithIdle, detectClarificationLoop } from './shared/clarificationGuards.js';
import { requesterOf } from './shared/requester.js';
import type { ClarificationRound } from './shared/clarificationGuards.js';
import { profileForAgentRole } from '../codex/modelProfiles.js';
import { buildPlannerPrompt, buildPlannerPlanModePrompt } from '../agents/prompts.js';
import { refreshWorktreeToBase, resolveWorkspace } from '../workspaces/workspaceManager.js';
import {
  commentFollowUpOnPr,
  createPrFromWorkspace,
  findRunPr,
  pushFollowUpToPr,
  relandFollowUpAsNewPr,
  settleUnfinishedFollowUp,
} from '../github/postPipelinePr.js';
import {
  checkoutFollowUpBranch,
  findFollowUpPr,
  followUpNoteFor,
  followUpPlanNote,
  followUpPlannerBlock,
  originSlug,
  readPrNow,
  STAGING_STILL_OLD,
  stagingShowsBranch,
  unfinishedFollowUpLine,
  unfinishedFollowUpSummary,
  whichPrQuestion,
  type FollowUpPr,
} from './shared/followUpPr.js';
import { buildUnfinishedRunMessage, coderReportedPrUrl } from '../agents/unfinishedRun.js';
import {
  fetchChecksState,
  fetchMergeState,
  fetchUnresolvedReviewThreadCount,
  type MergeState,
} from '../github/prReviewComments.js';
import { checkContentOnlyPr, type ContentOnlyVerdict } from '../github/contentOnlyDiff.js';
import { toolchainEnv } from '../backends/codexBackend.js';
import { waitForExactConfirmation } from './shared/confirmationGate.js';
import { cancelledResult } from './shared/cancelState.js';
import { headsUpOnSameFiles, type OpenPr } from './shared/sameFileGuard.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { AgentStepResult, PipelineConfig } from '../agents/types.js';
import type { InvestigationStore } from '../state/investigationStore.js';
import {
  prepareWorkflowContext,
  resolveCombinedWorkspaceRoot,
  sanitizeOwnerSummary,
  extractReplyFromCodexResult,
  type WorkflowContext,
} from './shared/workflowUtils.js';
import {
  ANY_OPERATION_WORD,
  pickPr,
  quickActionWords,
  readQuickOperation,
  readSyncPhrase,
  type QuickOperation,
} from '../router/prActionAsk.js';
import { refreshSharedClones } from '../workspaces/staleCheckout.js';
import { assertThreadParentExists } from '../slack/threadContext.js';
import { runAgenticEntry } from '../agentic/agenticEntry.js';
import { offerMarketingProdDeploy } from './marketingDeployOffer.js';
import type { StagingDeployStore } from './stagingDeployWorkflow.js';
import { reloadBundlesIfChanged } from '../runtime/bundleReload.js';
import type { JobStore } from '../state/jobStore.js';

const execFileAsync = promisify(execFile);

function buildOwnerPrimaryPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  workspaceRoot: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

You are running Watchtower implementation mode.

The request below was sent by a configured owner Slack user.

Environment:
- Working directory: ${workspaceRoot}
- Known repositories: ${enabledRepoKeys(config).join(', ')}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Guardrails:
- Operate only inside the working directory above. Do NOT \`cd\` to any other path.
- If the working directory is not the right repo for this task, return { "status": "failed", "summary": "wrong-repo-assigned: <explanation>" } instead of switching directories.

Task:
Execute the implementation request end-to-end within the working directory. Infer intent from thread context and execute directly.

Slack thread context:
${threadContext}${imageContext}

Output rules:
Your response will be posted to a Slack thread. The "summary" field is what the user sees directly.

Return strict JSON with:
- status: "success" | "failed"
- summary: a short, clean Slack message describing what you did. This is posted directly to the user — write it as a ready-to-post Slack message. No telemetry, no ceremony, no "Actions performed" lists.
- actions: array of concrete actions performed (for internal logging only, the user does not see this)
- prUrl: PR URL if one was created, else empty string
- confidence: number between 0 and 1
`.trim();
}

function buildOwnerRelaxedPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  workspaceRoot: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, config, workspaceRoot, githubToken, threadContext, imageContext } = params;
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

You are running Watchtower implementation mode in relaxed output mode.

Environment:
- Working directory: ${workspaceRoot}
- Known repositories: ${enabledRepoKeys(config).join(', ')}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

Guardrails:
- Operate only inside the working directory above. Do NOT \`cd\` to any other path.

Task:
Execute the implementation request end-to-end within the working directory.

Slack thread context:
${threadContext}${imageContext}

Your response will be posted DIRECTLY to a Slack thread as-is. Write a ready-to-post Slack message:
- One concise response describing what you did.
- Plain text only (not JSON).
- Use Slack markdown if needed (*bold*, \`code\`).
`.trim();
}

/**
 * Repo-scoped policy pack for the agent pipeline. Rendered into planner,
 * coder, reviewer, and verifier prompts via `policyBlock`. Placed as an
 * explicit override so recalled per-user habits from OTHER repos (jest
 * tests, /public assets, styled-components) can't leak into repos whose
 * conventions differ.
 */
function repoPolicyPackForCwd(cwd: string, config: AppConfig): { packName: string; rules: string[] } | undefined {
  const key = repoKeyForWorkspacePath(cwd, config);
  if (!key) return undefined;
  const rules = getRepo(key).guardrails;
  if (rules.length === 0) return undefined;
  return {
    packName: `repo:${key}`,
    rules: ['These repo rules OVERRIDE any prior habits or recalled conventions from other repos.', ...rules],
  };
}

function buildGuardrailedPrompt(params: {
  task: NormalizedTask;
  config: AppConfig;
  repoPath: string;
  repoName: string;
  githubToken?: string;
  threadContext: string;
  imageContext: string;
}): string {
  const { task, config, repoPath, repoName, githubToken, threadContext, imageContext } = params;
  const repoPack = repoPolicyPackForCwd(repoPath, config);
  const repoRules = repoPack ? `\n${repoPack.rules.map(rule => `- ${rule}`).join('\n')}` : '';
  return `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

You are running Watchtower implementation mode with repository-scoped guardrails.

Environment:
- Working directory: ${repoPath}
- Repository: ${repoName}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}

GUARDRAILS:
- Work only within this repository directory. Do not access or modify files outside of it.
- Do not run destructive git commands (force push, reset --hard, etc.).${repoRules}

Task:
Implement the requested changes within the repository. Create a branch, commit your changes, and open a PR to the default branch.

Slack thread context:
${threadContext}${imageContext}

Output rules:
Your "summary" field will be posted directly to a Slack thread — write it as a ready-to-post message.

Return strict JSON with:
- status: "success" | "failed"
- summary: a short, clean Slack message describing what you did. No telemetry, no ceremony.
- actions: array of concrete actions performed (for internal logging only)
- prUrl: PR URL if one was created, else empty string
- confidence: number between 0 and 1
`.trim();
}

const MAX_FEEDBACK_ITERATIONS = 5;
/** A plan waiting for approval re-pings the approvers after 15 minutes and again after 2 hours (issue #436). */
export const PLAN_APPROVAL_REMINDERS_MS = [15 * 60 * 1000, 2 * 60 * 60 * 1000];

/** Deploy semantics in a no-code ask. Wider than the deploy gate on purpose: here a match only withholds an action. */
export const QUICK_ACTION_DEPLOY_RE =
  /\b(deploy|release|ship|roll ?back|push (?:it |this |that )?to prod(?:uction)?)\b/i;

export const QUICK_ACTION_DEPLOY_REDIRECT =
  "I don't deploy or roll back from here. If you want something shipped, ask me directly — `@miniOG deploy newton-web to prod` or `@miniOG deploy marketing to prod` — and I'll confirm with you before anything goes out.";

/**
 * Quick actions that change a pull request and cannot be taken back cheaply.
 * "sync" merges the base branch into the PR branch (issue #603): the daily
 * follow-up offers it when a PR conflicts or is behind. Never a rebase or a
 * force-push: the branch has an open PR. Read from the words by
 * `readQuickOperation` (issue #719).
 */
type QuickPrAction = 'merge' | 'close' | 'revert' | 'sync';
/** Why a quick action asks instead of acting (issue #719). */
type QuickActionUnclearReason =
  | Extract<QuickOperation, { kind: 'unclear' }>['reason']
  | 'several_prs'
  | 'no_pr'
  | 'unnamed';

/**
 * One question instead of an operation nobody asked for plainly: nothing is
 * changed, and the job ends. "Tell me" in a DM, "Mention me" in a channel.
 */
async function askWhatToDo(params: {
  task: NormalizedTask;
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  prs: PrContext[];
  reason: QuickActionUnclearReason;
}): Promise<WorkflowResult> {
  const { task, slack, logStep, prs, reason } = params;
  const again =
    task.event.channelType === 'im' || task.event.channelType === 'mpim' ? 'Tell me again' : 'Mention me again';
  const urls = [...new Set(prs.map(pr => pr.url))];
  const reply =
    reason === 'several_prs'
      ? `I wasn't sure which pull request you mean (${urls.join(', ')}), so I haven't changed anything. ${again} with the one pull request and what to do with it.`
      : urls.length === 1
        ? `I wasn't sure what to do with ${urls[0]}, so I haven't changed anything. ${again} with just the one you want: merge it, close it, or sync it with its base branch.`
        : `I wasn't sure what you want me to do, so I haven't changed anything. ${again} with the pull request and the one thing to do with it: merge, close, or sync it with its base branch.`;
  logStep?.({
    stage: 'implementation.quick_action.unclear',
    message: `The words name a pull-request operation but can't be read safely (${reason}) — asking, not acting.`,
    data: { reason, prUrls: urls },
  });
  const posted = await slack.chat
    .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: reply })
    .then(() => true)
    .catch(() => false);
  return { workflow: 'IMPLEMENTATION', status: 'SKIPPED', message: reply, notifyDesktop: false, slackPosted: posted };
}

export const QUICK_ACTION_APPROVE_REFUSAL =
  "I don't approve pull requests. Ask me to review one and I'll post comments; the approval is a person's call.";

/** Internal seam — tests stub the wait instead of scripting Slack replies. */
export const __quickActionConfirm = { wait: waitForExactConfirmation };

/**
 * What branch protection means for merging now (issue #605). A merge past a
 * required review goes through on admin rights; whoever says yes should know
 * that before they do, not learn it afterwards. Whether such a merge is
 * allowed is unchanged: this only says it. Empty when nothing stands in the
 * way.
 */
export function mergeProtectionNote(state: MergeState | undefined): string {
  if (!state) return "I couldn't check branch protection.";
  if (state.mergeStateStatus === 'DIRTY') return "It has conflicts, so it can't be merged yet.";
  if (state.isDraft || state.mergeStateStatus === 'DRAFT') return "It's still a draft.";
  // The review decision is known even while GitHub is still working out the rest.
  if (state.reviewDecision === 'REVIEW_REQUIRED') {
    return 'It still needs an approving review, so merging now uses admin rights.';
  }
  if (state.reviewDecision === 'CHANGES_REQUESTED') {
    return 'A reviewer asked for changes, so merging now uses admin rights.';
  }
  if (!state.mergeStateStatus || state.mergeStateStatus === 'UNKNOWN') return "I couldn't check branch protection.";
  if (state.mergeStateStatus === 'BLOCKED') {
    return 'Branch protection still blocks it, so merging now uses admin rights.';
  }
  if (state.mergeStateStatus === 'BEHIND') {
    return "It's behind the base branch, so merging now skips the up-to-date rule.";
  }
  return '';
}

/**
 * What a merge checks on GitHub, read once: the unresolved review threads and
 * the merge state come from separate queries, so a failure reading the state
 * leaves the count, which gates the owner's own merges, intact.
 */
async function readMergeChecks(pr: PrContext, githubToken: string): Promise<MergeChecks> {
  const target = { owner: pr.owner, repo: pr.repo, pullNumber: pr.number, githubToken };
  type Threads = Awaited<ReturnType<typeof fetchUnresolvedReviewThreadCount>>;
  const [threads, state] = await Promise.all([
    fetchUnresolvedReviewThreadCount(target).catch(
      (): Threads => ({ unresolvedCount: 0, totalThreads: 0, failed: true }),
    ),
    fetchMergeState(target).catch(() => undefined),
  ]);
  return { unresolvedCount: threads.unresolvedCount, threadsKnown: !threads.failed && !threads.incomplete, state };
}

type MergeChecks = {
  unresolvedCount: number;
  /** False when the review threads could not all be read, so the count means nothing. */
  threadsKnown: boolean;
  state: MergeState | undefined;
};

/**
 * Merge states a content-only PR may be merged from without the owner (issue
 * #701). BLOCKED counts only when the block is the missing review, which is
 * what the owner decided builders may go past.
 */
const CONTENT_MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'BEHIND']);

type ContentMergeDecision =
  | {
      kind: 'merge';
      pr: PrContext;
      policy: ContentPolicy;
      files: string[];
      headSha: string;
      /** Merging needs admin rights: past the missing review, or a branch behind its base. */
      admin: boolean;
      /** The merge goes in without the approving review the repo asks for. */
      skipsReview: boolean;
    }
  /** `reason` is said in the owner's confirmation; none when what blocks it is said there already. */
  | { kind: 'owner'; reason?: string };

/** Internal seam — tests stub `gh` instead of merging for real. */
export const __contentMergeGh = {
  async exec(args: string[], githubToken: string): Promise<string> {
    const { stdout } = await execFileAsync('gh', args, {
      timeout: 60_000,
      env: { ...toolchainEnv(), GH_TOKEN: githubToken },
    });
    return stdout;
  },
};

/** Internal seam — tests stub the deploy offer after a merge (issue #703). */
export const __marketingDeployOffer = { offer: offerMarketingProdDeploy };

/** The job store as the deploy offer reads it: the dry-run switch and the staging record. */
function deployStoreOf(store: ImplementationStore | undefined): StagingDeployStore | undefined {
  if (!store?.getState) return undefined;
  return {
    getState: key => store.getState?.(key),
    setState: (key, value) => store.setState?.(key, value),
  };
}

/** Reloads access edited in the app since the run started, for a wait that outlasts it (issue #703). */
function accessRefresherOf(store: ImplementationStore | undefined, config: AppConfig): (() => void) | undefined {
  const { getAccessCacheSignalAt, getBundles } = store ?? {};
  if (!store || !getAccessCacheSignalAt || !getBundles) return undefined;
  return () => {
    reloadBundlesIfChanged(config, {
      getAccessCacheSignalAt: () => getAccessCacheSignalAt.call(store),
      getBundles: () => getBundles.call(store),
    });
  };
}

/** Why an owner still has to confirm a change that is more than content, in one sentence. */
export function contentOwnerReason(verdict: Exclude<ContentOnlyVerdict, { contentOnly: true }>): string {
  if (verdict.kind === 'unreadable') return "I couldn't check that it only changes text, so an owner has to confirm.";
  if (verdict.kind === 'not_default_base') return "It doesn't merge into the main branch, so an owner has to confirm.";
  if (verdict.kind === 'too_many_files' || !verdict.offending?.length) {
    return `It changes more than text (${verdict.fileCount ?? 'many'} files), so an owner has to confirm.`;
  }
  const named = verdict.offending.slice(0, 2).map(file => `\`${file}\``);
  const more = verdict.offending.length - named.length;
  return `It changes more than text (${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}), so an owner has to confirm.`;
}

/**
 * Whether a merge someone other than the owner asked for can go ahead on
 * their word (issue #701): the owner decided that admins and builders may
 * merge a PR that only changes content. Undefined when that does not apply
 * here at all (a repo without a content policy, or a requester who could not
 * have asked for the change), so the confirmation stays exactly as it was.
 */
async function decideContentMerge(params: {
  task: NormalizedTask;
  config: AppConfig;
  pr: PrContext;
  checks: MergeChecks;
  githubToken: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<ContentMergeDecision | undefined> {
  const { task, config, pr, checks, githubToken, logStep, signal } = params;
  const repoKey = repoKeyFromGithubRepoName(pr.repo);
  const descriptor = repoKey ? getRepo(repoKey) : undefined;
  const policy = descriptor?.contentPolicy;
  if (!policy || descriptor.githubSlug.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase()) return undefined;
  const requester = requesterOf(task);
  const mayAsk = evaluateCapability({
    config,
    userId: requester,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    capability: 'start_implementation',
  }).allowed;
  if (!mayAsk) return undefined;

  const owner = (why: string, reason?: string): ContentMergeDecision => {
    logStep?.({
      stage: 'implementation.quick_action.content_check',
      message: `Not merging ${pr.url} on <@${requester}>'s word: ${why}`,
      data: { prUrl: pr.url, requestedBy: requester, why },
    });
    return { kind: 'owner', reason };
  };
  const early = contentMergeBlock(checks);
  if (early) return owner(early.why, early.reason);

  const verdict = await checkContentOnlyPr({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    githubToken,
    policy,
    signal,
  });
  if (signal?.aborted) return owner('the run was cancelled.');
  if (!verdict.contentOnly) {
    const files = verdict.offending ? ` (${verdict.offending.join(', ')})` : '';
    return owner(`${verdict.reason}${files}`, contentOwnerReason(verdict));
  }

  // GitHub again, now that the files are read: a push, a review or a comment
  // meanwhile changes the answer, and the merge is pinned to what was read.
  const fresh = await readMergeChecks(pr, githubToken);
  const late = contentMergeBlock(fresh);
  if (late) return owner(late.why, late.reason);
  if (fresh.state?.headSha !== verdict.headSha) {
    return owner(
      `the head moved from ${verdict.headSha} to ${fresh.state?.headSha ?? 'unknown'} while checking.`,
      'Someone pushed to it while I was checking, so an owner has to confirm.',
    );
  }
  if (fresh.state?.baseRef !== verdict.baseRef) {
    return owner(
      `the base moved from ${verdict.baseRef} to ${fresh.state?.baseRef ?? 'unknown'} while checking.`,
      'Its base branch changed while I was checking, so an owner has to confirm.',
    );
  }
  const checksState = await fetchChecksState({ owner: pr.owner, repo: pr.repo, sha: verdict.headSha, githubToken });
  const checksProblem = checksReason(checksState);
  if (checksProblem) return owner(`checks are ${checksState ?? 'unreadable'}.`, checksProblem);
  const status = fresh.state?.mergeStateStatus;
  return {
    kind: 'merge',
    pr,
    policy,
    files: verdict.files,
    headSha: verdict.headSha,
    // Past the missing review, or a branch behind its base: the only blocks the gate lets through.
    admin: status === 'BLOCKED' || status === 'BEHIND',
    skipsReview: fresh.state?.reviewDecision === 'REVIEW_REQUIRED',
  };
}

/**
 * What in a PR's merge checks keeps a content-only merge from going ahead
 * without the owner: `why` for the logs, and `reason` for the requester when
 * the owner's confirmation doesn't already say it. Undefined when nothing
 * does.
 */
function contentMergeBlock(checks: MergeChecks): { why: string; reason?: string } | undefined {
  const { state, unresolvedCount, threadsKnown } = checks;
  const status = state?.mergeStateStatus;
  if (!state || !status || status === 'UNKNOWN') {
    // The confirmation says it couldn't check branch protection.
    return { why: `merge state ${status ?? 'unreadable'}.`, reason: 'Without that, an owner has to confirm.' };
  }
  if (status === 'UNSTABLE') {
    return { why: 'merge state UNSTABLE.', reason: "Some of its checks aren't passing, so an owner has to confirm." };
  }
  if (state.isDraft || status === 'DRAFT') return { why: 'it is a draft.' };
  if (state.reviewDecision === 'CHANGES_REQUESTED') return { why: 'a reviewer asked for changes.' };
  const blockedOnlyByReview = status === 'BLOCKED' && state.reviewDecision === 'REVIEW_REQUIRED';
  if (!CONTENT_MERGEABLE_STATES.has(status) && !blockedOnlyByReview) {
    return { why: `merge state ${status}, review ${state.reviewDecision ?? 'none'}.` };
  }
  if (!threadsKnown) {
    return {
      why: "the review comments couldn't all be read.",
      reason: "I couldn't read all of its review comments, so an owner has to confirm.",
    };
  }
  if (unresolvedCount > 0) return { why: `${unresolvedCount} unresolved review comments.` };
  return undefined;
}

/** What to tell the requester about the checks of the commit to merge; undefined when they passed or there are none. */
function checksReason(state: string | null | undefined): string | undefined {
  if (state === null || state === 'SUCCESS') return undefined;
  if (state === 'PENDING' || state === 'EXPECTED') return 'Its checks are still running, so an owner has to confirm.';
  if (state === undefined) return "I couldn't read its checks, so an owner has to confirm.";
  return 'Its checks are failing, so an owner has to confirm.';
}

function contentMergedLead(url: string, skipsReview: boolean): string {
  const how = skipsReview ? ', so it went in without the usual review' : '';
  return `Merged ${url}: it only changes text and numbers${how}.`;
}

/** The merge reply when no deploy offer goes with it. */
function contentMergedReply(url: string, skipsReview: boolean): string {
  return `${contentMergedLead(url, skipsReview)} It isn't live yet; someone from core-dev has to deploy it.`;
}

/**
 * Merge a content-only PR on the requester's word (issue #701), with `gh`
 * rather than an agent: the action is one command. A merge past the required
 * review uses the owner identity's admin rights, as every marketing merge so
 * far has. The branch stays: staging may still be showing it.
 */
async function mergeContentOnlyPr(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: ImplementationStore;
  decision: Extract<ContentMergeDecision, { kind: 'merge' }>;
  githubToken: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, decision, githubToken, logStep, signal } = params;
  const { pr, policy, files, headSha, admin, skipsReview } = decision;
  if (signal?.aborted) return cancelledResult('IMPLEMENTATION');
  const requester = requesterOf(task);
  logStep?.({
    stage: 'implementation.quick_action.content_merge',
    message: `Merging ${pr.url} without the owner's confirmation: it only changes content, and <@${requester}> asked.`,
    data: { prUrl: pr.url, files, requestedBy: requester, admin, headSha, mergeMethod: policy.mergeMethod },
  });
  const repoArg = `${pr.owner}/${pr.repo}`;
  // Only the commit that was read: a push after the check makes GitHub refuse the merge.
  const args = ['pr', 'merge', String(pr.number), '--repo', repoArg, `--${policy.mergeMethod}`];
  args.push('--match-head-commit', headSha);
  if (admin) args.push('--admin');

  let reply: string;
  let status: WorkflowResult['status'];
  const startedAtMs = Date.now();
  try {
    await __contentMergeGh.exec(args, githubToken);
    reply = contentMergedReply(pr.url, skipsReview);
    status = 'SUCCESS';
  } catch (error) {
    const failure = error as { code?: unknown; killed?: unknown; signal?: unknown };
    if (HEAD_MOVED.test(ghErrorLine(error))) {
      // --match-head-commit refused it: GitHub merged nothing.
      logStep?.({
        stage: 'implementation.quick_action.content_merge_head_moved',
        message: `${pr.url} moved past ${headSha} after the check; GitHub refused the merge.`,
        data: { prUrl: pr.url, headSha },
      });
      const text = "Someone pushed to it after I checked, so nothing was merged. Ask again and I'll re-check.";
      const posted = await slack.chat
        .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text })
        .then(() => true)
        .catch(() => false);
      return {
        workflow: 'IMPLEMENTATION',
        status: 'SKIPPED',
        message: text,
        notifyDesktop: false,
        slackPosted: posted,
      };
    }
    // gh never ran, so nothing can have happened.
    const notRun = failure.code === 'ENOENT';
    // Killed mid-run: GitHub may have merged it anyway, whatever it says a moment later.
    const timedOut = failure.killed === true || Boolean(failure.signal) || failure.code === 'ETIMEDOUT';
    const detail = notRun
      ? "the GitHub command-line tool isn't available here."
      : timedOut
        ? 'the merge command timed out.'
        : ghErrorLine(error);
    const prState = notRun
      ? undefined
      : await __contentMergeGh
          .exec(['pr', 'view', String(pr.number), '--repo', repoArg, '--json', 'state', '-q', '.state'], githubToken)
          .then(out => out.trim())
          .catch(() => undefined);
    logStep?.({
      stage: 'implementation.quick_action.content_merge_failed',
      message: `gh pr merge failed for ${pr.url}: ${detail}`,
      level: prState === 'MERGED' ? 'WARN' : 'ERROR',
      data: { prUrl: pr.url, prState, notRun, timedOut },
    });
    if (prState === 'MERGED') {
      reply = contentMergedReply(pr.url, skipsReview);
      status = 'SUCCESS';
    } else if (notRun || (prState && !timedOut)) {
      reply = `I couldn't merge ${pr.url}: ${detail} Nothing was merged.`;
      status = 'FAILED';
    } else {
      reply = `I couldn't tell whether ${pr.url} merged: ${detail} Check the PR before asking again.`;
      status = 'FAILED';
    }
  }
  // Merged: the reply carries the offer to deploy it (issue #703).
  if (status === 'SUCCESS') {
    const offered = await __marketingDeployOffer.offer({
      task,
      config,
      slack,
      store: deployStoreOf(store),
      githubToken,
      merged: [{ pr, knownMerged: true }],
      startedAtMs,
      lead: contentMergedLead(pr.url, skipsReview),
      refreshAccess: accessRefresherOf(store, config),
      logStep,
      signal,
    });
    if (offered) return { workflow: 'IMPLEMENTATION', ...offered };
  }
  const posted = await slack.chat
    .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: reply })
    .then(() => true)
    .catch(() => false);
  return {
    workflow: 'IMPLEMENTATION',
    status,
    message: reply,
    notifyDesktop: status === 'FAILED',
    slackPosted: posted,
  };
}

/** What GitHub says when the PR's head is no longer the commit a merge was pinned to. */
const HEAD_MOVED = /head branch was modified/i;

/** The first line of what `gh` said, as a sentence. */
function ghErrorLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const raw = (typeof stderr === 'string' && stderr.trim()) || (error instanceof Error ? error.message : String(error));
  const line = raw.trim().split('\n')[0].trim().slice(0, 200);
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

/**
 * Merge, close and revert run under the owner's GitHub identity, so when
 * someone else asks, the owner confirms first (issue #429). Returns the
 * confirming user, or the result to return with nothing changed.
 */
async function confirmQuickPrAction(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  action: QuickPrAction;
  prUrls: string[];
  unresolvedCount?: number;
  /** What branch protection means for a merge now (`mergeProtectionNote`). */
  protectionNote?: string;
  /** Why the owner has to confirm a merge the requester could otherwise make (issue #701). */
  ownerReason?: string;
  /**
   * The requester confirms instead of the owner: a content-only merge they
   * may make, read by a planner rather than the strict gate (issue #719).
   */
  requesterConfirms?: { note: string };
  /**
   * A planner read the ask: the opening line promised a plan, and there is
   * none to approve. The prompt says so first.
   */
  afterPlanner?: boolean;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ confirmedBy: string } | { result: WorkflowResult }> {
  const { task, config, slack, action, prUrls, unresolvedCount, protectionNote, ownerReason, logStep, signal } = params;
  const { channelId, threadTs } = task.event;
  const userId = requesterOf(task);
  const phrase = `confirm ${action}`;
  const owners = params.requesterConfirms ? [userId] : config.ownerSlackUserIds;
  const ownerMentions = owners.map(id => `<@${id}>`).join(' or ');
  const stop = (status: WorkflowResult['status'], message: string, slackPosted: boolean) => ({
    result: {
      workflow: 'IMPLEMENTATION',
      status,
      message,
      notifyDesktop: status === 'FAILED',
      slackPosted,
    } satisfies WorkflowResult,
  });
  const say = (text: string) =>
    slack.chat
      .postMessage({ channel: channelId, thread_ts: threadTs, text })
      .then(() => true)
      .catch(() => false);

  if (owners.length === 0) {
    const msg = `I can't ${action} on request here: there is no owner configured to confirm it.`;
    return stop('SKIPPED', msg, await say(msg));
  }

  const target = prUrls.length > 0 ? prUrls.join(', ') : 'the pull request in this thread';
  const unresolvedNote =
    unresolvedCount && unresolvedCount > 0
      ? ` It has ${unresolvedCount} unresolved review comment${unresolvedCount > 1 ? 's' : ''}.`
      : '';
  let promptTs: string | undefined;
  try {
    const notes = [protectionNote, ownerReason].map(note => (note ? ` ${note}` : '')).join('');
    const noPlan = params.afterPlanner ? 'No code change is needed, so there is no plan to approve. ' : '';
    const confirmText = params.requesterConfirms
      ? `${noPlan}I read this as: ${action} ${target}. ${params.requesterConfirms.note} <@${userId}>, reply \`${phrase}\` within 10 minutes and I'll do it. Without that, nothing changes.`
      : `${noPlan}<@${userId}> asked me to ${action} ${target}.${unresolvedNote}${notes} ${ownerMentions}, reply \`${phrase}\` within 10 minutes and I'll do it. Without that, nothing changes.`;
    promptTs = await postGatePrompt(slack, {
      channel: channelId,
      thread_ts: threadTs,
      text: confirmText,
      blocks: () => confirmationBlocks(confirmText, phrase, `Confirm ${action}`),
    });
  } catch {
    // Handled below: without an anchored prompt there is nothing safe to wait on.
  }
  if (!promptTs) {
    const msg = `Couldn't post the ${action} confirmation, so nothing was changed.`;
    logStep?.({ stage: 'implementation.quick_action.confirm.prompt_failed', message: msg, level: 'ERROR' });
    return stop('FAILED', msg, false);
  }
  logStep?.({
    stage: 'implementation.quick_action.confirm.asked',
    message: params.requesterConfirms
      ? `Asked <@${userId}> to confirm the ${action} they asked for.`
      : `Asked the owner to confirm: ${action} requested by <@${userId}>.`,
    data: { action, prUrls, requestedBy: userId, promptTs, confirmers: owners },
  });

  const confirmation = await __quickActionConfirm.wait({
    slack,
    channelId,
    threadTs,
    promptTs,
    phrase,
    allowedUserIds: owners,
    botUserId: config.botUserId,
    stagePrefix: 'implementation.quick_action.confirm',
    logStep,
    signal,
  });
  if (confirmation.outcome === 'confirmed') return { confirmedBy: confirmation.userId ?? owners[0] };
  if (confirmation.outcome === 'cancelled')
    return stop('CANCELLED', `Stopped before the ${action} was confirmed.`, false);

  const msg =
    confirmation.outcome === 'declined'
      ? 'Okay, leaving it as it is.'
      : params.requesterConfirms
        ? `No \`${phrase}\` in 10 minutes, so nothing was changed. Ask again when you're ready.`
        : `No \`${phrase}\` from ${ownerMentions} in 10 minutes, so nothing was changed. Ask again when they're around.`;
  return stop('SKIPPED', msg, await say(msg));
}
type ImplementationStore = PipelineStore & {
  /** PRs earlier change runs in a thread opened, newest first, and who each was for (issue #730). */
  changeRunPrsInThread?: (channelId: string, threadTs: string) => Array<{ prUrl: string; requesterId?: string }>;
  getState?: (key: string) => string | undefined;
  setState?: (key: string, value: string) => void;
  getAccessCacheSignalAt?: () => string | undefined;
  getBundles?: () => import('../types/contracts.js').Bundle[];
  dossierStore?: () => import('../state/dossierStore.js').DossierStore;
  readVaultSettings?: () => { vaultPath: string; vaultEnabled: boolean };
  recentSignalsForUser?: (
    userId: string,
    limit?: number,
  ) => Array<{
    intent: string | null;
    workflow: string | null;
    status: string | null;
    repo: string | null;
    errorKind: string | null;
    createdAt: string;
  }>;
};

/**
 * A request that needs no code change, run as one agent call (merge, close,
 * sync, re-run tests…). Reached when the planner finds no code change is
 * needed, or straight away for a message that is only an operation on one
 * pull request (issue #605). Every gate lives here, so both ways in keep the
 * same confirmations.
 */
async function runQuickAction(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  ctx: WorkflowContext;
  store?: ImplementationStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  /** The planner's plan, for the logs; none when the planner was skipped. */
  plan?: unknown;
  /** The pull requests the agent may act on. */
  prs: PrContext[];
  /** The pull request whose review threads and branch protection a merge checks. */
  checkPr?: PrContext;
  /** The operation, when the message was read as only that; otherwise it is read from the text. */
  action?: QuickPrAction;
}): Promise<WorkflowResult> {
  const { task, config, slack, ctx, store, jobId, logStep, signal, plan } = params;
  // The operation is read from the words alone: a link, its label, a mention,
  // a code span or a typed branch or file name ("fix/merge-banner",
  // "close-modal.tsx") naming "merge", "close" or "deploy" is not an
  // instruction (#710). A link to the pull request reads as "this pr", and
  // code or a typed name leaves a placeholder (issue #719).
  const rawWords = quickActionWords(task.event.text);
  // "bring it up to date with master", "merge main into it", "rebase on master":
  // a sync, never a merge of the PR. "Don't merge it, just sync it", "merge it
  // with master" or "did you merge it?" name no operation to run (issue #719).
  const syncPhrase = readSyncPhrase(rawWords);
  const words = syncPhrase.sync ? syncPhrase.text : rawWords;
  const operation: QuickOperation = params.action
    ? { kind: 'operation', action: params.action, rebase: syncPhrase.rebase }
    : readQuickOperation(rawWords);
  const prAction: QuickPrAction | undefined = operation.kind === 'operation' ? operation.action : undefined;
  // Only the strict gate's sentences run unconfirmed for the owner; after a
  // planner, every merge, close or revert asks for `confirm <op>` (issue #719).
  const fromGate = Boolean(params.action);

  // After a planner, the pull request acted on is the one the words name: a
  // number, else the only one linked, else the only one known (issue #719).
  let prs = params.prs;
  let checkPr = params.checkPr;
  let unclear: QuickActionUnclearReason | undefined = operation.kind === 'unclear' ? operation.reason : undefined;
  if (!fromGate && prAction && !unclear) {
    const numbers = new Set([...rawWords.matchAll(/\b\d{2,}\b/g)].map(match => Number(match[0])));
    const byNumber = params.prs.filter(pr => numbers.has(pr.number));
    // "merge it 9999" names a PR this thread doesn't know: ask, don't act on the one it does.
    const picked =
      numbers.size > 0 && byNumber.length === 0
        ? undefined
        : pickPr(params.prs, byNumber.length === 1 ? byNumber[0].number : undefined);
    if (picked) {
      prs = [picked];
      checkPr = picked;
    } else {
      unclear = params.prs.length === 0 ? 'no_pr' : 'several_prs';
    }
  }
  if (unclear) return askWhatToDo({ task, slack, logStep, prs: params.prs, reason: unclear });

  const mergeIntent = prAction === 'merge';
  const mergeChecks =
    mergeIntent && checkPr && ctx.githubToken ? await readMergeChecks(checkPr, ctx.githubToken) : undefined;

  // Nobody can merge a PR with conflicts, admin rights or not: a message that
  // is only that merge gets no confirmation to answer and no agent (issue
  // #605). After a planner the ask may be more than the merge, so its prompt
  // says it instead.
  if (params.action === 'merge' && checkPr && mergeChecks?.state?.mergeStateStatus === 'DIRTY') {
    const reply = `${checkPr.url} has conflicts with its base branch, so it can't be merged yet. Nothing was changed.`;
    logStep?.({
      stage: 'implementation.quick_action.merge_conflicts',
      message: 'The PR has conflicts — not asking to merge it.',
      data: { prUrl: checkPr.url },
    });
    const posted = await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: reply })
      .then(() => true)
      .catch(() => false);
    return { workflow: 'IMPLEMENTATION', status: 'SKIPPED', message: reply, notifyDesktop: false, slackPosted: posted };
  }

  // For merge requests: check for unresolved review comments before proceeding
  // Asked by someone else, or after a planner, the confirmation further down
  // covers it (and shows the same count), so this check is for the owner's own
  // gate asks.
  if (mergeIntent && fromGate && task.isOwnerAuthor && mergeChecks) {
    const adminUserIds = getAdminUserIds(config);
    const { unresolvedCount } = mergeChecks;
    if (unresolvedCount > 0) {
      const protection = mergeProtectionNote(mergeChecks.state);
      const confirmMsg = `This PR has ${unresolvedCount} unresolved review comment${unresolvedCount > 1 ? 's' : ''}.${protection ? ` ${protection}` : ''} Should I still merge? Reply *yes* to proceed or *no* to cancel.`;
      // Yes or No: a No turns the merge down, it does not stop the job.
      const confirmTs = await postGatePrompt(slack, {
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: confirmMsg,
        blocks: () => yesNoBlocks(confirmMsg),
      });
      const confirmResult = { ts: confirmTs };
      if (confirmResult.ts) {
        const approval = await waitForApproval({
          slack,
          channelId: task.event.channelId,
          threadTs: task.event.threadTs,
          approverUserIds: adminUserIds,
          triggerUserId: requesterOf(task),
          approvalPromptTs: confirmResult.ts,
          logStep: logStep ?? (() => {}),
          botUserId: config.botUserId,
          signal,
        });

        // The job's abort: nothing to say. A "stop" or "cancel" by reply skips the merge like a "no",
        // and so does a change of instructions: a merge with new conditions is a new ask.
        if (approval.outcome === 'cancelled' && !approval.approverId) {
          return cancelledResult('IMPLEMENTATION');
        }

        if (approval.outcome === 'rejected' || approval.outcome === 'cancelled' || approval.outcome === 'feedback') {
          await slack.chat
            .postMessage({
              channel: task.event.channelId,
              thread_ts: task.event.threadTs,
              text: 'Got it, skipping the merge.',
            })
            .catch(() => {});

          return {
            workflow: 'IMPLEMENTATION',
            status: 'SKIPPED',
            message: 'Merge cancelled — unresolved review comments.',
            notifyDesktop: false,
            slackPosted: true,
          };
        }

        if (approval.outcome === 'paused') {
          // The merge-confirm gate doesn't have plan state to resume; treat
          // pause as a cancellation here. The user can re-issue the merge
          // request when they're ready (it's a quick-action, not an
          // expensive pipeline).
          await slack.chat
            .postMessage({
              channel: task.event.channelId,
              thread_ts: task.event.threadTs,
              text: `Pausing the merge — re-mention <@${config.botUserId}> when you'd like to retry.`,
            })
            .catch(() => {});
          return {
            workflow: 'IMPLEMENTATION',
            status: 'SKIPPED',
            message: 'Merge paused by user — re-issue when ready.',
            notifyDesktop: false,
            slackPosted: true,
          };
        }
      }
    }
  }

  // Distinguish a genuine operational action (merge/close/deploy/run/etc.)
  // from an informational ask the planner also flags as no-code (explain /
  // summarize / "what changed"). The quick-action prompt below frames the
  // task as an operation; routing a question through it produced the
  // bug-fix dead-end in #348. Hand questions to the tuned read-only
  // INFORMATIONAL path instead. Default to informational — both misroute
  // directions are non-destructive (a misrouted op just gets explained).
  const operationalAction =
    operation.kind !== 'question' &&
    /\b(merge|close|reopen|revert|sync|restart|rerun|re-run|run (?:the )?tests?|approve|assign)\b/i.test(words);

  // Deploys never run from here (issue #407). This path has no deploy
  // capability check and no confirmation, and its agent runs with
  // permissions bypassed — "release the X fix" must not become an
  // ungated production deploy. A deploy-only ask is redirected to the
  // deploy command; a mixed ask ("merge and deploy") keeps its other
  // operation and the prompt below forbids the deploy half.
  if (QUICK_ACTION_DEPLOY_RE.test(words) && !operationalAction) {
    logStep?.({
      stage: 'implementation.quick_action.deploy_redirect',
      message: 'Deploy-shaped ask reached the quick-action path — redirecting to the deploy command.',
      level: 'WARN',
      data: { plan },
    });
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: QUICK_ACTION_DEPLOY_REDIRECT,
      })
      .catch(() => {});
    return {
      workflow: 'IMPLEMENTATION',
      status: 'SKIPPED',
      message: QUICK_ACTION_DEPLOY_REDIRECT,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (!operationalAction) {
    logStep?.({
      stage: 'implementation.no_code_needed.informational',
      message: 'Planner says no code changes and this is not an operational action — answering as informational.',
      data: { plan },
    });
    return runAgenticEntry({
      mode: 'informational',
      task,
      config,
      slack,
      store: store as unknown as JobStore,
      jobId,
      logStep,
      signal,
    });
  }

  const prUrls = [...new Set(prs.map(pr => pr.url))];

  // The agent below runs with permissions bypassed: it never runs a pull-request
  // operation nobody confirmed. Words that still name one ("sync up the branch",
  // a struck-through "merge", "merged master in") without a clear reading are
  // asked about instead (issue #719).
  if (!prAction && ANY_OPERATION_WORD.test(rawWords)) {
    return askWhatToDo({ task, slack, logStep, prs: params.prs, reason: 'unnamed' });
  }

  // An approval from this agent would be submitted under the owner's
  // GitHub identity (issue #429). An approve-only ask is declined; in a
  // mixed ask the prompt below forbids the approving review.
  if (!prAction && /\bapprove\b/i.test(words)) {
    logStep?.({
      stage: 'implementation.quick_action.approve_refused',
      message: 'Approve-only ask reached the quick-action path — declined.',
      level: 'WARN',
    });
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: QUICK_ACTION_APPROVE_REFUSAL,
      })
      .catch(() => {});
    return {
      workflow: 'IMPLEMENTATION',
      status: 'SKIPPED',
      message: QUICK_ACTION_APPROVE_REFUSAL,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (prAction) {
    let confirmedBy = task.event.userId;
    // A run the owner started or picked up for someone else still needs
    // the phrase: answering their question isn't saying yes to a merge.
    const forSomeoneElse = requesterOf(task) !== task.event.userId;
    // A rebase ask runs as a merge of the base branch: even the owner sees that
    // first. After a planner, so does every merge, close or revert: the prompt
    // names the PR and the operation, so a misread is seen before it runs (#719).
    const rebaseAsked = prAction === 'sync' && operation.kind === 'operation' && operation.rebase;
    const readByPlanner = !fromGate && prAction !== 'sync';
    if (!task.isOwnerAuthor || forSomeoneElse || rebaseAsked || readByPlanner) {
      const checks = prAction === 'merge' ? mergeChecks : undefined;
      // A merge of a PR that only changes content, from someone who could have
      // asked for the change: their word is the OK (issue #701). A message that
      // is only that merge merges at once; read by a planner, they confirm it
      // with `confirm merge` first, which names the PR (issue #719).
      const githubToken = ctx.githubToken;
      const contentMerge =
        prAction === 'merge' && checkPr && checks && githubToken
          ? await decideContentMerge({ task, config, pr: checkPr, checks, githubToken, logStep, signal })
          : undefined;
      if (contentMerge?.kind === 'merge' && githubToken) {
        if (!fromGate) {
          if (signal?.aborted) return cancelledResult('IMPLEMENTATION');
          const confirmed = await confirmQuickPrAction({
            task,
            config,
            slack,
            action: 'merge',
            prUrls,
            requesterConfirms: { note: 'It only changes text and numbers, so your word is enough.' },
            afterPlanner: true,
            logStep,
            signal,
          });
          if ('result' in confirmed) return confirmed.result;
          // Up to ten minutes went by: merge only what was checked, and only if it still checks out.
          const fresh = await readMergeChecks(contentMerge.pr, githubToken);
          const again = await decideContentMerge({
            task,
            config,
            pr: contentMerge.pr,
            checks: fresh,
            githubToken,
            logStep,
            signal,
          });
          if (again?.kind !== 'merge' || again.headSha !== contentMerge.headSha) {
            const pushed =
              Boolean(fresh.state?.headSha && fresh.state.headSha !== contentMerge.headSha) ||
              (again?.kind === 'merge' && again.headSha !== contentMerge.headSha);
            const what = pushed
              ? 'someone pushed to it'
              : "it can't go in on your word any more (its changes or its state moved on)";
            const reply = `${contentMerge.pr.url} changed while I waited for your confirmation: ${what}, so I haven't merged it. Ask again and I'll check it afresh.`;
            logStep?.({
              stage: 'implementation.quick_action.content_merge.stale',
              message: reply,
              data: {
                prUrl: contentMerge.pr.url,
                checkedSha: contentMerge.headSha,
                nowSha: again?.kind === 'merge' ? again.headSha : null,
              },
            });
            const posted = await slack.chat
              .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: reply })
              .then(() => true)
              .catch(() => false);
            return {
              workflow: 'IMPLEMENTATION',
              status: 'SKIPPED',
              message: reply,
              notifyDesktop: false,
              slackPosted: posted,
            };
          }
          return mergeContentOnlyPr({ task, config, slack, store, decision: again, githubToken, logStep, signal });
        }
        return mergeContentOnlyPr({ task, config, slack, store, decision: contentMerge, githubToken, logStep, signal });
      }
      if (signal?.aborted) return cancelledResult('IMPLEMENTATION');
      const confirmation = await confirmQuickPrAction({
        task,
        config,
        slack,
        action: prAction,
        prUrls,
        unresolvedCount: checks?.unresolvedCount,
        protectionNote: checks
          ? mergeProtectionNote(checks.state)
          : rebaseAsked
            ? "I'll merge its base branch into it, a merge commit: I don't rebase or squash a branch with an open pull request."
            : undefined,
        ownerReason: contentMerge?.kind === 'owner' ? contentMerge.reason : undefined,
        afterPlanner: !fromGate,
        logStep,
        signal,
      });
      if ('result' in confirmation) return confirmation.result;
      confirmedBy = confirmation.confirmedBy;
    }
    logStep?.({
      stage: 'implementation.quick_action.pr_action',
      message: `Running quick action "${prAction}" requested by <@${requesterOf(task)}>, confirmed by <@${confirmedBy}>.`,
      data: { action: prAction, prUrls, requestedBy: requesterOf(task), confirmedBy },
    });
  }

  const quickPrompt = `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- Your response will be posted DIRECTLY into a Slack thread as-is.
- Working directory: ${ctx.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(ctx.githubToken))}

Task:
Execute this request directly. No code changes are needed — this is a quick operational action (merge PR, close PR, run a command, etc.).

"sync" means: bring the pull request's branch up to date with its base branch by merging the base branch into it. Do it in a fresh, isolated checkout under the OS temp directory (\`gh pr checkout <number>\` inside a new \`git worktree\` or clone there), never in the working directory you were started in, which other runs read. Then \`git fetch origin && git merge origin/<base>\`; resolve nothing by guesswork: if the merge conflicts, abort it, remove the checkout and report the conflicting files. Push with a plain \`git push\`, remove the checkout, and say what the branch now contains. Never rebase and never force-push a branch that has an open pull request.

Never deploy, release, ship or roll back anything, and never run a deploy command, script or skill, even if the request asks for it. If the request includes that, do the rest and say that deploys go through "@miniOG deploy <target> to prod", which asks for confirmation first.

Never submit an approving review or request changes on a pull request (no \`gh pr review --approve\`, no \`--request-changes\`), even if the request asks for it. Say that approval is a person's call.${
    prUrls.length > 0
      ? `\n\nPull requests you may act on: ${prUrls.join(', ')}. Do not merge, close, revert or sync any other pull request.`
      : ''
  }${
    prAction
      ? ''
      : '\n\nNo pull-request operation was confirmed for this request: do not merge, close, revert, sync, reopen or push to any pull request, even if the request asks for it. Do the rest, and say that the person can ask me for that operation on its own.'
  }${prAction ? `\n\nThe confirmed operation is \`${prAction}\`; perform no other pull-request operation.` : ''}${
    prAction === 'sync' && operation.kind === 'operation' && operation.rebase
      ? '\n\nThey asked for a rebase. Merge the base branch in instead, because a branch with an open pull request is never rebased, and say so in one short sentence.'
      : ''
  }

Slack thread context:
${ctx.threadContext}${ctx.imageContext}

Write your response as a ready-to-post Slack message describing what you did.
`.trim();

  const quickBackend = store?.dossierStore
    ? selectBackendForUser({
        userId: task.event.userId,
        workflow: 'IMPLEMENTATION',
        dossierStore: store.dossierStore(),
        onSelect: info =>
          logStep?.({
            stage: 'pipeline.backend.select',
            message: `Selected backend ${info.backend} (${info.reason}).`,
            data: info,
          }),
      })
    : getActiveBackendId();
  const quickStartedAtMs = Date.now();
  const quickResult = await runCodex({
    cwd: ctx.cwd,
    prompt: quickPrompt,
    githubToken: ctx.githubToken,
    ...highReasoningProfile(quickBackend),
    // timeoutMs: Math.floor(workflowTimeoutMs * 0.5),
    onLog: logStep,
    signal,
  });

  // Cancelled mid-action: "Quick action completed." would be false (#438).
  if (signal?.aborted && !quickResult.ok) {
    return cancelledResult('IMPLEMENTATION');
  }

  const reply = extractReplyFromCodexResult(quickResult) || 'Quick action completed.';

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: reply,
  });

  // A marketing PR the agent actually merged gets the deploy offer (issue #703).
  // GitHub is asked whether it merged: the agent's words are not enough.
  const offered =
    prAction === 'merge' && !signal?.aborted
      ? await __marketingDeployOffer.offer({
          task,
          config,
          slack,
          store: deployStoreOf(store),
          githubToken: ctx.githubToken,
          merged: prs.map(pr => ({ pr, knownMerged: false })),
          startedAtMs: quickStartedAtMs,
          refreshAccess: accessRefresherOf(store, config),
          logStep,
          signal,
        })
      : undefined;
  if (offered) {
    // The agent's own failure stays the run's outcome: the offer only adds to it.
    const failed = !quickResult.ok && offered.status !== 'CANCELLED';
    return {
      workflow: 'IMPLEMENTATION',
      ...offered,
      status: failed ? 'FAILED' : offered.status,
      notifyDesktop: failed || offered.notifyDesktop,
      message: `${reply}\n${offered.message}`,
    };
  }

  return {
    workflow: 'IMPLEMENTATION',
    status: quickResult.ok ? 'SUCCESS' : 'FAILED',
    message: reply,
    notifyDesktop: false,
    slackPosted: true,
  };
}
const MAX_PAUSE_CYCLES = 10;

type ApprovalLoopState = {
  planMarkdown: string;
  planAffectedFiles: string[];
  planScope: string;
  plannerOutput: Record<string, unknown>;
  plannerSessionId?: string;
  planMessageTs?: string;
};

type ApprovalLoopOutcome =
  | ({ kind: 'approved'; feedbackRounds: number; pipelineCwd: string } & ApprovalLoopState)
  | { kind: 'rejected_then_cancelled'; message: string }
  | { kind: 'exhausted' }
  /** `stoppedBy` is set when a reply ("stop") ended it, not the job's abort (issue #598). */
  | { kind: 'cancelled'; stoppedBy?: string }
  | { kind: 'paused'; resumeContext: ImplementationApprovalResume };

/**
 * Stamps the admin-approved plan (the values rendered in Slack) onto the planner
 * output the downstream pipeline consumes.
 *
 * #388: the approval loop's feedback-revision path replaces plannerOutput with the
 * raw codex JSON (`{ plan: string[], ... }`) which has no `planMarkdown`/`scope`/
 * `affectedFiles` — the exact fields the coder, reviewer, and verifier read. Without
 * re-stamping, a revised plan is silently dropped and the coder falls back to the
 * original request. The initial-plan path already surfaces these fields; this keeps
 * both paths consistent at the single point where the planner step is built.
 */
export function stampApprovedPlan(
  plannerOutput: Record<string, unknown>,
  approved: { planMarkdown: string; scope: string; affectedFiles: string[] },
): Record<string, unknown> {
  plannerOutput.planMarkdown = approved.planMarkdown;
  plannerOutput.scope = approved.scope;
  plannerOutput.affectedFiles = approved.affectedFiles;
  return plannerOutput;
}

/**
 * Runs the iterative plan-approval loop. Used by both the fresh-start path and
 * the pause-resume path. On any "wait" message in the thread, returns kind:'paused'
 * with a serializable resume context the dispatcher persists into result_json.
 *
 * Bundled fix: when re-planning after feedback, posts the revised plan as a NEW
 * message rather than only chat.update'ing the original — so the "Here's the
 * revised plan" prompt actually sits below visible plan content.
 */
export async function runApprovalLoop(input: {
  slack: WebClient;
  config: AppConfig;
  task: NormalizedTask;
  initial: ApprovalLoopState;
  pipelineCwd: string;
  iterationStart: number;
  feedbackRoundsStart: number;
  pauseCountStart: number;
  plannerSchemaPath: string;
  plannerProfile: ReturnType<typeof profileForAgentRole>;
  /** Backend the planner ran on — decides how revision output is normalized. */
  plannerBackend: AgentBackendId;
  workflowTimeoutMs: number;
  githubToken?: string;
  /** When set, the first loop iteration uses this ts as the wait-cutoff instead of posting a fresh prompt. */
  resumeApprovalPromptTs?: string;
  workflowIntent: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  logStep?: WorkflowStepLogger;
  /** The job's abort signal: ends the approval wait and stops a revision run (issue #264). */
  signal?: AbortSignal;
  /** The thread's screenshots and PDFs, for revisions too (issue #595). */
  imagePaths?: string[];
}): Promise<ApprovalLoopOutcome> {
  const {
    slack,
    config,
    task,
    initial,
    iterationStart,
    feedbackRoundsStart,
    pauseCountStart,
    plannerSchemaPath,
    plannerProfile,
    plannerBackend,
    githubToken,
    resumeApprovalPromptTs,
    workflowIntent,
    logStep,
    signal,
  } = input;

  const adminUserIds = getAdminUserIds(config);
  const canApprove = planDecidersFor(config, task);
  let { planMarkdown, planAffectedFiles, planScope, plannerOutput, plannerSessionId, planMessageTs } = initial;
  let feedbackRounds = feedbackRoundsStart;
  let pauseCount = pauseCountStart;
  // Mutable shadow of the worktree path: revisions can flip the repo
  // (e.g. admin redirects from newton-api → newton-web), and the coder must
  // run against the worktree that matches the *approved* plan, not the
  // worktree we materialized from the initial classifier guess.
  let pipelineCwd = input.pipelineCwd;

  const buildResumeContext = (
    iteration: number,
    approvalPromptTs: string | undefined,
  ): ImplementationApprovalResume => ({
    workflow: workflowIntent,
    stage: 'awaiting_approval',
    iteration,
    feedbackRounds,
    planMarkdown,
    planAffectedFiles,
    planScope,
    plannerSessionId,
    plannerOutput,
    planMessageTs,
    approvalPromptTs,
    pipelineCwd,
    pauseCount,
  });

  // When a re-plan attempt fails to parse, we post a recovery message that
  // doubles as the next approval prompt and let the loop wait on its ts —
  // that way the next iteration doesn't post a misleading "Here's the revised
  // plan" prompt above an unchanged plan.
  let overrideNextPromptTs: string | undefined;

  for (let iteration = iterationStart; iteration < MAX_FEEDBACK_ITERATIONS; iteration++) {
    // Worked out for each version of the plan: a revision can add or remove a behaviour change.
    const requesterToConfirm = requesterToConfirmFor(planMarkdown, config, requesterOf(task));
    let approvalPromptTs: string | undefined;
    if (iteration === iterationStart && resumeApprovalPromptTs) {
      // Resuming: the prompt is already posted; the resume mention is the next reply we want to classify.
      approvalPromptTs = resumeApprovalPromptTs;
    } else if (overrideNextPromptTs) {
      // Previous re-plan failed; the recovery message we already posted IS this iteration's prompt.
      approvalPromptTs = overrideNextPromptTs;
      overrideNextPromptTs = undefined;
    } else {
      const promptText =
        iteration === 0
          ? `Here's my plan. ${requesterToConfirm ? 'I start once the requester confirms it is what they want' : 'Anyone here can approve it'}:\n• "yes" or "go" — I'll start coding\n• "stop" or "cancel" — I'll drop it\n• "no", or changes you'd like — I'll adjust the plan`
          : `Here's the revised plan. "yes" to proceed, "stop" to drop it, or reply with more changes.${requesterToConfirm ? ' I start once the requester confirms it.' : ''}`;

      try {
        approvalPromptTs = await postGatePrompt(slack, {
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: promptText,
          blocks: () => approvalBlocks(promptText),
        });
      } catch {
        // Non-fatal
      }
      if (!approvalPromptTs) {
        return { kind: 'exhausted' };
      }
    }

    logStep?.({
      stage: 'implementation.approval.waiting',
      message: `Waiting for approval of the plan (iteration ${iteration + 1}).`,
    });

    let approval = await waitForApproval({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      approverUserIds: adminUserIds,
      canApprove,
      triggerUserId: requesterOf(task),
      approvalPromptTs,
      logStep: logStep ?? (() => {}),
      botUserId: config.botUserId,
      signal,
      reminders: {
        afterMs: PLAN_APPROVAL_REMINDERS_MS,
        text: `<@${requesterOf(task)}> the plan above still needs a yes or no.`,
      },
      requesterToConfirm,
    });

    if (approval.outcome === 'cancelled') {
      return { kind: 'cancelled', stoppedBy: approval.approverId || undefined };
    }

    if (approval.outcome === 'paused') {
      pauseCount++;
      if (pauseCount > MAX_PAUSE_CYCLES) {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `Paused/resumed too many times (${MAX_PAUSE_CYCLES}) — cancelling. Start a fresh request when you're ready.`,
          })
          .catch(() => {});
        return { kind: 'rejected_then_cancelled', message: 'Exceeded max pause cycles.' };
      }
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: `Pausing — <@${approval.approverId}>, mention <@${config.botUserId}> when you'd like me to resume.`,
        })
        .catch(() => {});
      // Use the pause message's ts as the next wait-cutoff so the resume mention is the first new reply we see.
      return { kind: 'paused', resumeContext: buildResumeContext(iteration, approval.replyTs) };
    }

    if (approval.outcome === 'approved') {
      return {
        kind: 'approved',
        feedbackRounds,
        planMarkdown,
        planAffectedFiles,
        planScope,
        plannerOutput,
        plannerSessionId,
        planMessageTs,
        pipelineCwd,
      };
    }

    if (approval.outcome === 'rejected') {
      let askReviseTs: string | undefined;
      try {
        const askResult = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          // An open question: "Would you like to change it?" drew a "yes", which went ahead with the plan just turned down.
          text: 'Got it. What should I change? Reply with what you\'d like different, "go" to use the plan as it is, or "cancel" to stop.',
        });
        askReviseTs = askResult.ts ?? undefined;
      } catch {
        // Non-fatal
      }

      if (!askReviseTs) {
        return { kind: 'rejected_then_cancelled', message: 'Plan turned down.' };
      }

      const followUp = await waitForApproval({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        approverUserIds: adminUserIds,
        canApprove,
        triggerUserId: requesterOf(task),
        approvalPromptTs: askReviseTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
        signal,
        requesterToConfirm,
      });

      if (followUp.outcome === 'cancelled') {
        return { kind: 'cancelled', stoppedBy: followUp.approverId || undefined };
      }

      if (followUp.outcome === 'paused') {
        pauseCount++;
        if (pauseCount > MAX_PAUSE_CYCLES) {
          return { kind: 'rejected_then_cancelled', message: 'Exceeded max pause cycles.' };
        }
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `Pausing — <@${followUp.approverId}>, mention <@${config.botUserId}> when you'd like me to resume.`,
          })
          .catch(() => {});
        // Reuse the awaiting_revision_choice stage marker conceptually: the next resume mention should
        // re-classify against askReviseTs's prompt. We reuse approval-stage with the followUp ts as cutoff.
        return { kind: 'paused', resumeContext: buildResumeContext(iteration, followUp.replyTs) };
      }

      if (followUp.outcome === 'rejected') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Understood, cancelling.',
          })
          .catch(() => {});
        return { kind: 'rejected_then_cancelled', message: 'Plan turned down after the revision prompt.' };
      }

      if (followUp.outcome === 'approved') {
        return {
          kind: 'approved',
          feedbackRounds,
          planMarkdown,
          planAffectedFiles,
          planScope,
          plannerOutput,
          plannerSessionId,
          planMessageTs,
          pipelineCwd,
        };
      }

      // followUp.outcome === 'feedback' — synthesize an approval=feedback so the next branch handles it
      approval = { ...followUp, outcome: 'feedback' };
    }

    if (approval.outcome === 'feedback') {
      feedbackRounds++;
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: 'Got your feedback. Revising the plan...',
        })
        .catch(() => {});

      logStep?.({
        stage: 'implementation.approval.revising',
        message: `Revising plan with feedback: "${approval.userReply}"`,
        data: { feedbackRounds },
      });

      // Always pass the prior plan as JSON in the prompt — do NOT use
      // resumeSessionId here. claudeCodeBackend silently drops outputSchemaPath
      // (it's only honored by codexBackend), so resumed sessions rely entirely
      // on the model "remembering" the JSON contract from the initial call.
      // That memory is unreliable: revision calls were producing prose/markdown
      // instead of JSON, the parser bailed, and the workflow re-posted the old
      // plan unchanged. Passing the plan inline + restating the contract is
      // slightly more tokens but reliably produces parseable JSON.
      // On claude-code the plan is markdown with an approver block, so the
      // revision is too. It used to ask for JSON steps, which normalized to an
      // empty plan: the old plan was re-posted as "revised" and the coder built
      // the old one (issue #388).
      const feedbackPrompt =
        plannerBackend === 'claude-code'
          ? revisionPromptMarkdown(planMarkdown, approval.userReply)
          : `You previously produced this plan:
${JSON.stringify(plannerOutput, null, 2)}

It was reviewed, and this feedback came back (from someone in the thread, or from the requester saying what they want):

"${approval.userReply}"

Revise the plan to incorporate this feedback. Output rules — strict:
- Reply with ONE JSON object and nothing else. No prose, no markdown fences, no preamble, no trailing notes.
- The JSON must match this exact schema (every key required, no extras):
{
  "plan": string[],
  "affectedFiles": string[],
  "scope": "small" | "medium" | "large",
  "requiresCodeChanges": boolean
}
- "plan" should reflect the FEEDBACK above. If the feedback adds new behavior (e.g. an additional log line, a different function call, an extra parameter), the steps and "affectedFiles" must mention it explicitly. Do not return the prior plan unchanged unless the feedback was purely cosmetic.

Return the JSON now.`;

      const revisedResult = await runWithInfraRetry(
        {
          cwd: pipelineCwd,
          prompt: feedbackPrompt,
          outputSchemaPath: plannerSchemaPath,
          githubToken,
          imagePaths: input.imagePaths,
          // A revision only reads. It runs in the coder's worktree, before
          // anyone approved a change.
          readOnly: true,
          ...plannerProfile,
          // No per-agent timeoutMs — see investigationWorkflow.ts for rationale.
          // Outer abort signal remains the safety net.
          onLog: logStep,
          signal,
        },
        { label: 'plan revision', logStep },
      );
      if (signal?.aborted) {
        return { kind: 'cancelled' };
      }

      // Even though we no longer resume, capture sessionId so a later coder
      // step or follow-up logging can reference this revision's session.
      plannerSessionId = revisedResult.sessionId ?? plannerSessionId;

      // A revision that yields no plan is a failed revision, not the old plan
      // again (issue #388).
      const revisedPlan =
        revisedResult.ok && revisedResult.parsedJson
          ? normalizePlannerOutput(revisedResult.parsedJson, plannerBackend)
          : undefined;
      if (!revisedPlan?.planMarkdown) {
        // Re-plan failed (model output wasn't valid JSON, or runCodex errored).
        // Pre-fix, the workflow silently fell through to "post the revised plan
        // as a new message" using the unchanged old plan — making "Here's the
        // revised plan" a lie. Tell the user instead and let them rephrase.
        logStep?.({
          stage: 'implementation.approval.revising.failed',
          message:
            revisedResult.errorKind === 'API_ERROR'
              ? 'Plan revision lost the connection to the model API; surfacing recovery prompt to the user.'
              : 'Plan revision returned no plan; surfacing recovery prompt to the user.',
          level: 'WARN',
          data: {
            feedbackRounds,
            ok: revisedResult.ok,
            hasParsedJson: Boolean(revisedResult.parsedJson),
            errorKind: revisedResult.errorKind,
          },
        });
        try {
          const recoveryPosted = await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text:
              revisedResult.errorKind === 'API_ERROR'
                ? "I lost my connection to the model while revising the plan, and retrying didn't bring it back. The plan above is unchanged. Reply with your feedback again in a few minutes, `yes` to proceed with the original plan, or `no` to cancel."
                : 'I had trouble revising the plan from that feedback: the planner did not return a revised plan. The plan above is unchanged. Reply with rephrased feedback, `yes` to proceed with it as it stands, or `no` to cancel.',
          });
          overrideNextPromptTs = recoveryPosted.ts ?? undefined;
        } catch {
          // Non-fatal; if posting failed we'll fall back to the default "Here's
          // the revised plan" prompt next iteration (suboptimal but not stuck).
        }
        // Don't post a fake-revised plan; loop back. feedbackRounds was already
        // incremented above — counts as a used revision attempt to bound the cap.
        continue;
      }

      plannerOutput = revisedResult.parsedJson as Record<string, unknown>;
      planMarkdown = revisedPlan.planMarkdown;
      planAffectedFiles = revisedPlan.affectedFiles.length > 0 ? revisedPlan.affectedFiles : planAffectedFiles;
      planScope = revisedPlan.scope || planScope;
      logStep?.({
        stage: 'implementation.approval.revised',
        message: `Revised the plan (${planMarkdown.length} chars, ${planAffectedFiles.length} file(s)).`,
        data: { feedbackRounds, changes: changesSinceLastPlan(planMarkdown) },
      });

      // If the revision swung the plan to a different repo (e.g. admin said
      // "make changes in newton-web, not newton-api"), materialize the matching
      // worktree before the coder runs. Without this swap the coder runs in
      // the original repo and silently produces an empty diff because none of
      // the affectedFiles exist there.
      const desiredRepo = inferRepoFromAffectedFiles(planAffectedFiles);
      if (desiredRepo) {
        const desiredCwd = await resolveWorkspace(repoPathFor(desiredRepo, config), task.event.threadTs);
        if (desiredCwd !== pipelineCwd) {
          logStep?.({
            stage: 'implementation.workspace.switched',
            message: `Plan now targets ${desiredRepo}; switching workspace.`,
            data: { from: pipelineCwd, to: desiredCwd, repo: desiredRepo, feedbackRounds },
          });
          await slack.chat
            .postMessage({
              channel: task.event.channelId,
              thread_ts: task.event.threadTs,
              text: `Switching to *${desiredRepo}* based on the revised plan.`,
            })
            .catch(() => {});
          pipelineCwd = desiredCwd;
        }
      }

      // Post the revised plan as a NEW message (instead of only updating the
      // original in place). The "Here's the revised plan" approval prompt
      // posted on the next loop iteration will then sit below visible plan
      // content. We also still update the original message so it reflects the
      // latest plan for anyone scrolling back.
      try {
        const revisedTs = await postPlanForApproval({
          slack,
          channelId: task.event.channelId,
          threadTs: task.event.threadTs,
          planMarkdown,
          affectedFiles: planAffectedFiles,
          scope: planScope,
          repoPath: pipelineCwd,
          requesterToConfirm: requesterToConfirmFor(planMarkdown, config, requesterOf(task)),
          logStep,
        });
        planMessageTs = revisedTs ?? planMessageTs;
      } catch {
        // Non-fatal
      }
      // Loop back to post next approval prompt
    }
  }

  return { kind: 'exhausted' };
}

/**
 * The prompt for revising a markdown plan (claude-code). The revision is the
 * whole plan again, in the same format, with its approver block rewritten and
 * a list of what changed, so the approver and the requester see the new plan
 * and the coder builds it (issue #388).
 */
export function revisionPromptMarkdown(previousPlan: string, feedback: string): string {
  return `You wrote this implementation plan:

${previousPlan}

It was reviewed, and this feedback came back (from someone in the thread, or from the requester saying what they want):

"${feedback}"

Revise the plan to do what the feedback asks. Read the code again where you need to.

Reply with the complete revised plan as markdown and nothing else, in the same format as before:
- First the "## For the approver" block with all its lines, rewritten for the revised plan. Do not copy the old block: every line must be true of the revised plan, including "Behaviour change" and "Outside the repo".
- Then a section headed exactly "## Changed since the last plan", with one bullet for each thing you changed because of the feedback.
- Then the rest of the plan: the intent, the "## Files to change" section, the steps, and the "Scope:" and "Requires code changes:" tags.`;
}

/**
 * The planner's follow-up after a clarifying answer, on Claude Code, where
 * plans are markdown. Asking it for the JSON contract got markdown or JSON
 * without `requiresCodeChanges` back, which read as "no code changes" and
 * sent a change request to the quick action with no approval (issue #695).
 */
export function clarifiedPromptMarkdown(question: string, answer: string, previousPlan: string): string {
  const draft = previousPlan.trim() ? `\n\nYour plan so far:\n\n${previousPlan.trim()}` : '';
  return `You asked the requester: "${question}"

They answered: "${answer}"${draft}

Now write the final plan with that answer in mind. Read the code again where you need to.

Reply with the complete plan as markdown and nothing else, in the same format as before: the "## For the approver" block with all its lines, the intent, the "## Files to change" section, the steps, and the "Scope:" and "Requires code changes:" tags.`;
}

/**
 * Who can decide a plan besides the admins: the requester, and anyone who
 * could have asked for the change in this channel themselves. Waiting on an
 * admin for every plan was friction. Without enforced access, anyone. The
 * requester is the person the run is for, even when it runs on an owner's
 * authority (a tag of the owner, or an ask from the app for them).
 */
function planDecidersFor(config: AppConfig, task: NormalizedTask): (userId: string) => boolean {
  // The router enforces access in DMs and group DMs even in audit mode.
  const dm = task.event.channelType === 'im' || task.event.channelType === 'mpim';
  const enforced = getConfiguredAccessControl(config).mode === 'enforce' || dm;
  return userId =>
    userId === requesterOf(task) ||
    !enforced ||
    evaluateCapability({
      config,
      userId,
      channelId: task.event.channelId,
      channelType: task.event.channelType,
      capability: 'start_implementation',
    }).allowed;
}

/**
 * The requester, when they have to confirm the plan before work starts: it
 * changes behaviour or rests on assumptions, and they cannot approve it
 * themselves (issue #437). An admin requester's own yes covers both.
 */
function requesterToConfirmFor(planMarkdown: string, config: AppConfig, requesterId: string): string | undefined {
  return planNeedsRequesterConfirmation(planMarkdown) && !getAdminUserIds(config).includes(requesterId)
    ? requesterId
    : undefined;
}

/** What the thread is told when the planner run itself failed. Never the run's own last line. */
export function plannerFailureReply(
  result: Pick<CodexRunResult, 'errorKind' | 'limitResetsAtText' | 'timedOut'>,
): string {
  if (result.errorKind === 'API_ERROR') return connectionLostReply('planning');
  if (result.errorKind === 'EXTERNAL_KILL') return killedFromOutsideReply('My planning run');
  if (result.errorKind === 'USAGE_LIMIT') {
    const resets = result.limitResetsAtText ? ` It resets ${result.limitResetsAtText}.` : '';
    return `I hit the Claude usage limit while planning.${resets} Nothing has been changed. Mention me again after that and I'll start over.`;
  }
  return `The planner ${result.timedOut ? 'timed out' : 'stopped with an error'} before it produced a plan. Nothing has been changed. Mention me again to retry.`;
}

/**
 * The last step before the coder (issue #602). A heads-up when another run
 * or an open miniOG PR is changing the same files, then the worktree moved to
 * the latest base: the plan may have waited hours for approval, and anything
 * merged since belongs under this change. Nothing in the worktree is lost:
 * the planner only reads (plan mode, or a read-only run), the plan itself is
 * in memory, and attachments are downloaded outside it. A refresh that fails
 * leaves the worktree as it was and the approved run carries on.
 */
export async function prepareForCoder(params: {
  jobId?: string;
  task: NormalizedTask;
  config: AppConfig;
  pipelineCwd: string;
  planMarkdown: string;
  planAffectedFiles: string[];
  threadTexts: string[];
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  /** The open PR from this thread the change adds to (issue #730). */
  followUp?: FollowUpPr;
  /** Test seams. */
  deps?: {
    listOpenPrs?: (cwd: string) => Promise<OpenPr[]>;
    refresh?: typeof refreshWorktreeToBase;
    checkoutBranch?: typeof checkoutFollowUpBranch;
    readPr?: typeof readPrNow;
    originOf?: typeof originSlug;
  };
}): Promise<{
  /** Set when the worktree is on the PR's branch: the coder adds to that PR. */
  followUp?: { pr: FollowUpPr; startHead: string };
  /** Why the change gets a new PR after all, for the reply. */
  followUpFallback?: string;
}> {
  const { jobId, task, config, pipelineCwd, planMarkdown, slack, logStep, followUp } = params;
  const repoKey = repoKeyForWorkspacePath(pipelineCwd, config);

  // A follow-up works on the PR's branch, never reset to the default branch (issue #730).
  let active: { pr: FollowUpPr; startHead: string } | undefined;
  let followUpFallback: string | undefined;
  const fallBack = (reason: string, note: string, detail?: string) => {
    followUpFallback = note;
    logStep?.({
      stage: 'implementation.followup.fallback',
      message: `${note} (${reason})`,
      level: reason === 'checkout_failed' || reason === 'unreadable' ? 'WARN' : 'INFO',
      data: { prUrl: followUp?.url, reason, ...(detail ? { detail } : {}) },
    });
  };
  if (followUp) {
    const origin = await (params.deps?.originOf ?? originSlug)(pipelineCwd);
    const prSlug = `${followUp.owner}/${followUp.repo}`.toLowerCase();
    const otherRepo = origin ? origin !== prSlug : Boolean(followUp.repoKey && repoKey && followUp.repoKey !== repoKey);
    // The plan may have waited hours: the PR may be merged or closed by now.
    const now = otherRepo ? undefined : await (params.deps?.readPr ?? readPrNow)(followUp.url);
    if (otherRepo) {
      fallBack(
        'other_repo',
        `This change is in ${repoKey ?? origin ?? 'another repository'}, so it has its own pull request rather than going onto ${followUp.url}.`,
      );
    } else if (!now) {
      fallBack('unreadable', `I couldn't check ${followUp.url} on GitHub, so this change is in a new pull request.`);
    } else if (now.state !== 'OPEN' || now.crossRepo || !now.branch) {
      fallBack(
        now.state.toLowerCase(),
        `${followUp.url} was ${now.state === 'MERGED' ? 'merged' : 'closed'} while the plan waited, so this change is in a new pull request.`,
      );
    } else {
      const pr = { ...followUp, branch: now.branch };
      const checkout = await (params.deps?.checkoutBranch ?? checkoutFollowUpBranch)(pipelineCwd, pr.branch);
      if (checkout.ok) {
        active = { pr, startHead: checkout.head };
        logStep?.({
          stage: 'implementation.followup.checked_out',
          message: `The coder works on ${pr.branch}, the branch of ${pr.url}.`,
          data: { prUrl: pr.url, branch: pr.branch, head: checkout.head },
        });
      } else {
        fallBack(
          'checkout_failed',
          `I couldn't check out the branch of ${followUp.url}, so this change is in a new pull request.`,
          checkout.reason,
        );
      }
    }
  }

  // The PR this change adds to is never "someone else changing this file";
  // when the change gets its own PR after all, that PR is, so the thread's
  // mention of it no longer hides it from the heads-up.
  const threadTexts =
    followUp && !active ? params.threadTexts.map(text => text.split(followUp.url).join('')) : params.threadTexts;
  await headsUpOnSameFiles({
    jobId,
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    repo: repoKey ?? path.dirname(pipelineCwd),
    cwd: pipelineCwd,
    // Files the plan lists, never a guess from every path in it.
    files: planListsFiles(planMarkdown) ? params.planAffectedFiles : [],
    context: [task.event.text ?? '', ...threadTexts, planMarkdown, active?.pr.url ?? ''],
    slack,
    logStep,
    listOpenPrs: params.deps?.listOpenPrs,
  });
  if (active) return { followUp: active };

  const refresh = await (params.deps?.refresh ?? refreshWorktreeToBase)(pipelineCwd);
  if (refresh.ok) {
    logStep?.({
      stage: 'implementation.workspace.refreshed',
      message: `Moved the worktree to the latest ${refresh.base} before the coder starts.`,
      data: { pipelineCwd, base: refresh.base, head: refresh.head },
    });
  } else if (!refresh.skipped) {
    logStep?.({
      stage: 'implementation.refresh.failed',
      message: "Couldn't move the worktree to the latest base; the coder starts from where the plan was made.",
      level: 'WARN',
      data: { pipelineCwd, reason: refresh.reason },
    });
  }
  return followUpFallback ? { followUpFallback } : {};
}

export type LandedFollowUp =
  | { kind: 'added'; ontoNewerCommits: boolean; commented: boolean; stagingStillOld: boolean; wipBranch?: undefined }
  | { kind: 'stacked'; prUrl: string; wipBranch?: undefined }
  | { kind: 'relanded'; prUrl: string; state: 'MERGED' | 'CLOSED'; wipBranch?: undefined }
  | { kind: 'nothing'; wipBranch?: undefined }
  | { kind: 'rewritten'; wipBranch?: string }
  | { kind: 'failed'; reason: string; wipBranch?: string };

/**
 * Lands a follow-up whose checks passed (issue #730). The PR is read again
 * first: if it was merged or closed while the run worked, pushing to its
 * branch would land on a dead branch, so the new commits become a fresh PR
 * from the default branch instead. Otherwise the commits go onto the PR's
 * branch, and the engineering account goes on the PR as a comment.
 */
export async function landFollowUp(params: {
  followUp: { pr: FollowUpPr; startHead: string };
  repoPath: string;
  task: NormalizedTask;
  summary: string;
  requestedBy?: string;
  store?: ImplementationStore;
  logStep?: WorkflowStepLogger;
  onLog?: (msg: string) => void;
  /** Test seams. */
  deps?: {
    readPr?: typeof readPrNow;
    push?: typeof pushFollowUpToPr;
    reland?: typeof relandFollowUpAsNewPr;
    comment?: typeof commentFollowUpOnPr;
  };
}): Promise<LandedFollowUp> {
  const { followUp, repoPath, task, summary, requestedBy, store, logStep, onLog, deps } = params;
  const { pr, startHead } = followUp;
  const common = {
    repoPath,
    startHead,
    uniqueTs: task.event.eventTs,
    threadTs: task.event.threadTs,
    summary,
    requestedBy,
  };

  const now = await (deps?.readPr ?? readPrNow)(pr.url);
  if (now && (now.state === 'MERGED' || now.state === 'CLOSED')) {
    const state = now.state;
    const relanded = await (deps?.reland ?? relandFollowUpAsNewPr)({
      ...common,
      originalPrUrl: pr.url,
      originalState: state,
      channelId: task.event.channelId,
      onLog,
    });
    logStep?.({
      stage: 'implementation.followup.fallback',
      message: `${pr.url} was ${state.toLowerCase()} while the run worked — ${relanded.kind === 'opened' ? `opened ${relanded.prUrl} from the default branch` : relanded.kind}.`,
      level: relanded.kind === 'failed' ? 'ERROR' : 'INFO',
      data: { prUrl: pr.url, reason: state.toLowerCase(), result: relanded },
    });
    if (relanded.kind === 'opened') return { kind: 'relanded', prUrl: relanded.prUrl, state };
    if (relanded.kind === 'nothing') return { kind: 'nothing' };
    return { kind: 'failed', reason: relanded.reason, wipBranch: relanded.wipBranch };
  }

  const push = await (deps?.push ?? pushFollowUpToPr)({ ...common, branch: pr.branch, prUrl: pr.url, onLog });
  if (push.kind === 'pushed') {
    const commented = await (deps?.comment ?? commentFollowUpOnPr)({
      repoPath,
      prUrl: pr.url,
      summary,
      requestedBy,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
    });
    logStep?.({
      stage: 'implementation.followup.pushed',
      message: `Added the change to ${pr.url} (${pr.branch})${push.ontoNewerCommits ? ', on top of commits someone else pushed meanwhile' : ''}.`,
      data: { prUrl: pr.url, branch: pr.branch, ontoNewerCommits: push.ontoNewerCommits, commented },
    });
    return {
      kind: 'added',
      ontoNewerCommits: push.ontoNewerCommits,
      commented,
      stagingStillOld: stagingShowsBranch(deployStoreOf(store), pr),
    };
  }
  if (push.kind === 'stacked') {
    logStep?.({
      stage: 'implementation.followup.fallback',
      message: `${pr.branch} moved and the change conflicts with it — opened ${push.prUrl} into it instead.`,
      data: { prUrl: pr.url, reason: 'branch_moved_conflict', stackedPrUrl: push.prUrl },
    });
    return push;
  }
  if (push.kind === 'nothing') {
    logStep?.({
      stage: 'implementation.followup.nothing',
      message: `The run left nothing new on top of ${pr.url}.`,
      data: { prUrl: pr.url },
    });
    return push;
  }
  logStep?.({
    stage: 'implementation.followup.fallback',
    message:
      push.kind === 'rewritten'
        ? `The coder rewrote ${pr.url}'s history instead of adding a commit — not pushed.`
        : `Couldn't push the follow-up to ${pr.url}: ${push.reason}`,
    level: push.kind === 'rewritten' ? 'WARN' : 'ERROR',
    data: {
      prUrl: pr.url,
      reason: push.kind === 'rewritten' ? 'history_rewritten' : 'push_failed',
      ...(push.kind === 'failed' ? { detail: push.reason } : {}),
      wipBranch: push.wipBranch,
    },
  });
  return push;
}

/**
 * A code change keeps Figma, to read the design it implements, and for an
 * admin-tier requester the Newton admin upload tools. Every agent the workflow
 * starts gets that list instead of the host user's connectors (issue #443);
 * the pipeline narrows it again to none for the roles that only review.
 */
export async function runImplementationWorkflow(
  params: Parameters<typeof runImplementationWorkflowBody>[0],
): Promise<WorkflowResult> {
  // The person the change is for, not the owner it may run on behalf of (issue #443).
  const isAdmin = getAdminUserIds(params.config).includes(requesterOf(params.task));
  const connectors = connectorsFor(isAdmin ? 'code_change_admin' : 'code_change', params.config);
  params.logStep?.({
    stage: 'workflow.connectors',
    message:
      `Connectors for this change: ${Object.keys(connectors.mcpServers).join(', ') || 'none'}` +
      (connectors.unavailable.length > 0 ? ` (not set up on this host: ${connectors.unavailable.join(', ')})` : '') +
      '.',
    level: connectors.unavailable.length > 0 ? 'WARN' : 'INFO',
    data: { servers: Object.keys(connectors.mcpServers), unavailable: connectors.unavailable, adminTier: isAdmin },
  });
  return withConnectors(connectors, () => runImplementationWorkflowBody(params));
}

async function runImplementationWorkflowBody(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: ImplementationStore;
  investigationStore?: InvestigationStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  /**
   * Forward-compatibility hook: when set, a future revision will re-enter the
   * workflow at the saved wait stage. Today the workflow always starts fresh
   * even on resume mentions — the slot has already been freed by the prior
   * PAUSED return, and the persisted resumeContext is consumed by the 24h
   * sweeper rather than by a state-reload path. Tracked as follow-up.
   */
  resumeFrom?: ResumeContext;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, investigationStore, jobId, logStep, signal } = params;
  void params.resumeFrom;

  logStep?.({
    stage: 'implementation.start',
    message: 'Running implementation workflow.',
  });

  const ctx = await prepareWorkflowContext({ task, config, slack, store, logStep, signal });
  // Cancelled while asking which repo: no "routing to the desktop queue" copy (issue #264).
  if (signal?.aborted) {
    return cancelledResult('IMPLEMENTATION');
  }

  // Fail closed when prepareWorkflowContext could not pin down the target
  // repo: it sets ctx.cwd = os.tmpdir() and ctx.desktopOnly. Without this
  // gate the legacy single-agent path below (and the multi-agent fallback)
  // would happily launch Codex against /tmp instead of stopping for human
  // triage. Mirrors the pattern used by investigationWorkflow.
  if (ctx.desktopOnly) {
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `I couldn't pin down which repo to implement against (${ctx.desktopOnly.reason}) — routing this to the desktop queue instead of running in /tmp.`,
      })
      .catch(() => {});
    return {
      workflow: 'IMPLEMENTATION',
      status: ctx.desktopOnly.cancelled ? 'CANCELLED' : 'PAUSED',
      message: `Routed to desktop (${ctx.desktopOnly.reason}).`,
      notifyDesktop: !ctx.desktopOnly.cancelled,
      slackPosted: true,
    };
  }

  // Thread-scoped investigation findings: if a prior INVESTIGATION ran in
  // this same thread, seed the planner with its diagnosis so vague follow-up
  // messages like "yes fix it" land on a concrete plan instead of re-asking.
  const priorFindings = investigationStore?.getForThread(task.event.threadTs);
  if (priorFindings) {
    const seed = [
      '',
      '=== PRIOR INVESTIGATION FINDINGS FOR THIS THREAD ===',
      `(from job ${priorFindings.jobId}, saved ${priorFindings.createdAt})`,
      priorFindings.summary ? `Summary: ${priorFindings.summary}` : '',
      `Full findings (JSON): ${priorFindings.findingsJson}`,
      '=== END PRIOR FINDINGS ===',
      '',
      'Use these findings as your primary context. The user has already seen them and is now asking you to act — produce a concrete file-level plan. Only ask for clarification if the findings leave a genuine gap.',
    ]
      .filter(Boolean)
      .join('\n');
    ctx.threadContext = `${ctx.threadContext}${seed}`;
    logStep?.({
      stage: 'implementation.investigation_seed',
      message: 'Seeded planner context with prior investigation findings for this thread.',
      data: { investigationJobId: priorFindings.jobId, savedAt: priorFindings.createdAt },
    });
  }

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'implementation.pipeline.start',
      message: 'Running implementation through multi-agent pipeline.',
      data: { isOwnerAuthor: ctx.isOwnerAuthor },
    });

    // Cheap pre-flight: if the user has already deleted the source mention,
    // skip the 5-minute planner call and any quick action. Slack would
    // silently promote any post we make into an orphan channel-root message
    // (see processMessageDeleted doc-comment in index.ts for the RCA). One
    // ~50ms API call to save minutes of compute and a confusing channel artifact.
    const parentAlive = await assertThreadParentExists(slack, task.event.channelId, task.event.threadTs);
    if (!parentAlive) {
      logStep?.({
        stage: 'implementation.source_deleted',
        level: 'WARN',
        message: 'Source mention no longer exists — aborting before planner spawn.',
        data: { channelId: task.event.channelId, threadTs: task.event.threadTs },
      });
      return {
        workflow: 'IMPLEMENTATION',
        status: 'CANCELLED',
        message: 'Source message deleted before planner ran.',
        notifyDesktop: false,
        slackPosted: false,
      };
    }

    // "merge the PR" and nothing else needs no plan (issue #605): it goes
    // straight to the quick action. Only the router's gate decides that
    // (issue #719): a task it didn't mark, a resumed "go ahead and merge it"
    // among them, goes through the planner and its confirmations.
    let prActionAsk = task.prActionGate;
    // "merge it into master" runs unplanned only when master is the PR's base.
    if (prActionAsk?.intoBase) {
      const base = ctx.githubToken
        ? (
            await fetchMergeState({
              owner: prActionAsk.pr.owner,
              repo: prActionAsk.pr.repo,
              pullNumber: prActionAsk.pr.number,
              githubToken: ctx.githubToken,
            }).catch(() => undefined)
          )?.baseRef
        : undefined;
      if (base !== prActionAsk.intoBase) {
        logStep?.({
          stage: 'implementation.quick_action.base_mismatch',
          message: `Asked to merge into ${prActionAsk.intoBase}, but the PR's base is ${base ?? 'unknown'} — planning first.`,
          data: { prUrl: prActionAsk.pr.url, intoBase: prActionAsk.intoBase, base: base ?? null },
        });
        prActionAsk = undefined;
      }
    }
    if (prActionAsk) {
      logStep?.({
        stage: 'implementation.quick_action.no_planner',
        message: `The message only asks to ${prActionAsk.action} ${prActionAsk.pr.url} — running it as a quick action without a planner.`,
        data: { action: prActionAsk.action, prUrl: prActionAsk.pr.url },
      });
      return runQuickAction({
        task,
        config,
        slack,
        ctx,
        store,
        jobId,
        logStep,
        signal,
        prs: [prActionAsk.pr],
        checkPr: prActionAsk.pr,
        action: prActionAsk.action,
      });
    }

    // A change asked in a thread whose earlier change run left an open PR goes
    // onto that PR, not a second one that conflicts with it (issue #730).
    const followUpRequester = requesterOf(task);
    const followUpLookup = await findFollowUpPr({
      task,
      store,
      requesterId: followUpRequester,
      // The owner or an admin may add to anyone's PR; others only to their own (S4).
      mayAddToOthers: getAdminUserIds(config).includes(followUpRequester),
      logStep,
    });
    if (followUpLookup.kind === 'several') {
      const question = whichPrQuestion(followUpLookup.prUrls);
      logStep?.({
        stage: 'implementation.followup.ask',
        message: 'More than one open PR from this thread could take the change — asking which.',
        data: { prUrls: followUpLookup.prUrls },
      });
      const posted = await slack.chat
        .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: question })
        .then(() => true)
        .catch(() => false);
      return {
        workflow: 'IMPLEMENTATION',
        status: 'SKIPPED',
        message: question,
        notifyDesktop: false,
        slackPosted: posted,
      };
    }
    const followUpCandidate = followUpLookup.kind === 'followup' ? followUpLookup.pr : undefined;
    // Said at the end when the change lands in a new PR for a reason the person would not guess.
    let followUpNote = followUpNoteFor(followUpLookup);
    // The coder reads the thread without the follow-up block when the change gets its own PR.
    const threadContextWithoutFollowUp = ctx.threadContext;
    if (followUpCandidate) {
      logStep?.({
        stage: 'implementation.followup.detected',
        message: `This thread has an open PR from an earlier change: ${followUpCandidate.url} — planning this as a follow-up on it.`,
        data: { prUrl: followUpCandidate.url, branch: followUpCandidate.branch },
      });
      ctx.threadContext = `${ctx.threadContext}${followUpPlannerBlock(followUpCandidate)}`;
    } else if (followUpNote) {
      const prUrl =
        followUpLookup.kind === 'others' ? followUpLookup.pr.url : (followUpLookup as { prUrl: string }).prUrl;
      logStep?.({
        stage: 'implementation.followup.fallback',
        message: `${followUpNote} (${followUpLookup.kind})`,
        data: {
          prUrl,
          reason: followUpLookup.kind === 'ended' ? followUpLookup.state.toLowerCase() : followUpLookup.kind,
        },
      });
    }

    // Planner runs directly via runCodex to capture sessionId for iterative feedback
    const workflowTimeoutMs = config.bugFixTimeoutMs;
    const plannerPipelineConfig: PipelineConfig = {
      agents: ['planner'],
      maxRetryLoops: 0,
      abortOnCriticalFinding: false,
      slackProgressUpdates: false,
      requireApproval: false,
      totalTimeoutMs: Math.floor(workflowTimeoutMs * 0.15),
      perAgentTimeoutMs: Math.floor(workflowTimeoutMs * 0.15),
    };

    const plannerCtx = {
      workflowIntent: 'IMPLEMENTATION' as const,
      task,
      config,
      repoPath: ctx.cwd,
      githubToken: ctx.githubToken,
      threadContext: ctx.threadContext,
      previousSteps: [] as AgentStepResult[],
      pipelineConfig: plannerPipelineConfig,
      imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
      requestedBy: ctx.requestedBy,
    };

    const plannerBackend = store?.dossierStore
      ? selectBackendForUser({
          userId: task.event.userId,
          workflow: 'IMPLEMENTATION',
          dossierStore: store.dossierStore(),
          onSelect: info =>
            logStep?.({
              stage: 'pipeline.backend.select',
              message: `Selected backend ${info.backend} (${info.reason}).`,
              data: info,
            }),
        })
      : getActiveBackendId();
    const plannerProfile = profileForAgentRole('planner', plannerBackend);
    const plannerPlanMode = plannerBackend === 'claude-code';
    let plannerPrompt = plannerPlanMode ? buildPlannerPlanModePrompt(plannerCtx) : buildPlannerPrompt(plannerCtx);
    // An owner's request plans from the shared clones, not a fresh worktree.
    // A clone that is behind origin gets the same warning a lookup does
    // (issue #446): read origin, never conclude "it does not exist" from disk.
    if (ctx.cwd === resolveCombinedWorkspaceRoot(config)) {
      const staleBlock = await refreshSharedClones({ config, stage: 'pipeline.repo_refresh', logStep });
      if (staleBlock) plannerPrompt = `${plannerPrompt}\n\n${staleBlock}`;
    }
    // Recall personalizes the plan to whoever the work is FOR — launchpad
    // retriggers carry the real requester in requestedForUserId (issue #343).
    const recallUserId = task.event.requestedForUserId ?? task.event.userId;
    if (store?.dossierStore && store.recentSignalsForUser && recallUserId) {
      try {
        const recall = await assembleRecall({
          userId: recallUserId,
          workflow: 'IMPLEMENTATION',
          store: store as unknown as import('../state/jobStore.js').JobStore,
          vaultRoot: store.readVaultSettings?.().vaultPath ?? null,
          query: task.event.text ?? '',
          excludeThread: { channelId: task.event.channelId, threadTs: task.event.threadTs },
          channelId: task.event.channelId,
        });
        if (recall.promptBlock) {
          plannerPrompt = `${recall.promptBlock}\n\n${plannerPrompt}`;
          logStep?.({
            stage: 'pipeline.recall.injected',
            message: `Injected recall block (${recall.estimatedTokens} tokens, sources: ${recall.sources.join(', ')})`,
            data: { sources: recall.sources, estimatedTokens: recall.estimatedTokens },
          });
        }
      } catch (err) {
        logStep?.({
          stage: 'pipeline.recall.failed',
          level: 'WARN',
          message: 'Failed to assemble recall block; running without it.',
          data: { error: (err as Error).message },
        });
      }
    }
    const plannerSchemaPath = path.resolve(process.cwd(), 'schemas/agent-planner-result.schema.json');

    logStep?.({ stage: 'pipeline.agent.planner.start', message: 'Starting planner agent.' });

    let plannerRunResult: CodexRunResult = await runWithInfraRetry(
      {
        cwd: ctx.cwd,
        prompt: plannerPrompt,
        outputSchemaPath: plannerPlanMode ? undefined : plannerSchemaPath,
        githubToken: ctx.githubToken,
        planMode: plannerPlanMode,
        // Plan mode wins where it applies; read-only covers the rest, so no
        // planner call runs with permissions bypassed (issue #695).
        readOnly: true,
        // The thread's screenshots and PDFs: a plan written without them
        // shipped the wrong PDF to production (issue #595).
        imagePaths: plannerCtx.imagePaths,
        ...plannerProfile,
        // No per-agent timeoutMs — see investigationWorkflow.ts for rationale.
        // The outer abort signal is the safety net, so it has to be passed:
        // without it a cancelled job's planner ran to the end (issue #264).
        onLog: logStep,
        signal,
      },
      { label: 'planner', logStep },
    );

    // Cancelled while planning: do not post a plan, a question or failure copy (#438).
    if (signal?.aborted) {
      return cancelledResult('IMPLEMENTATION');
    }

    // A planner run that failed has no plan in it, whatever text it ended on.
    // Its last line used to be harvested and posted for approval: "*Plan*
    // (scope: medium, 0 files affected) API Error: Can't reach the API
    // server" (issue #439).
    if (!plannerRunResult.ok) {
      const reply = plannerFailureReply(plannerRunResult);
      logStep?.({
        stage: 'implementation.planner.failed',
        message: `Planner run failed (${plannerRunResult.errorKind ?? `exit ${plannerRunResult.exitCode}`}) — not posting a plan.`,
        level: 'ERROR',
        data: {
          errorKind: plannerRunResult.errorKind,
          exitCode: plannerRunResult.exitCode,
          timedOut: plannerRunResult.timedOut,
          detail: plannerRunResult.apiErrorDetail,
        },
      });
      await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: reply });
      return { workflow: 'IMPLEMENTATION', status: 'FAILED', message: reply, notifyDesktop: false, slackPosted: true };
    }

    let plannerSessionId = plannerRunResult.sessionId;
    let plannerOutput: Record<string, unknown> = plannerRunResult.parsedJson ?? {};

    if (plannerPlanMode) {
      // Plan mode produces free-form markdown via ExitPlanMode. Pre-normalize so the
      // clarificationNeeded / requiresCodeChanges gates below see consistent defaults
      // (requiresCodeChanges=true, clarificationNeeded=null) and downstream consumers
      // can read planMarkdown/scope/affectedFiles directly from plannerOutput.
      const normalized = normalizePlannerOutput(plannerOutput, plannerBackend);
      plannerOutput = {
        ...plannerOutput,
        planMarkdown: normalized.planMarkdown,
        scope: normalized.scope,
        affectedFiles: normalized.affectedFiles,
        requiresCodeChanges: normalized.requiresCodeChanges,
        clarificationNeeded: normalized.clarificationNeeded,
      };
    }

    // Planner-clarification loop: unbounded — keeps asking until the planner
    // produces a concrete plan (no clarificationNeeded), the user goes silent
    // (idle timeout → PAUSED), the user cancels, or we detect a repetition
    // loop (same question twice, or unhelpful short answers back-to-back).
    const clarificationHistory: ClarificationRound[] = [];
    let clarificationRound = 0;
    while (
      typeof plannerOutput.clarificationNeeded === 'string' &&
      plannerOutput.clarificationNeeded.trim().length > 0
    ) {
      clarificationRound++;
      const question = String(plannerOutput.clarificationNeeded).trim();

      const loopCheck = detectClarificationLoop(clarificationHistory, question);
      if (loopCheck.looping) {
        logStep?.({
          stage: 'implementation.planner.clarification.loop_detected',
          message: `Repetition detected after ${clarificationRound - 1} rounds: ${loopCheck.reason} Proceeding with best-guess plan.`,
          level: 'WARN',
          data: { reason: loopCheck.reason, rounds: clarificationRound - 1 },
        });
        try {
          await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: "I've asked this a couple of times — let me proceed with my best guess and flag my assumptions. Reply here if I got it wrong.",
          });
        } catch {
          // best-effort
        }
        break;
      }

      logStep?.({
        stage: 'implementation.planner.clarification.asking',
        message: `Planner needs clarification (round ${clarificationRound}): ${question}`,
        data: { question, round: clarificationRound },
      });

      let clarificationTs: string | undefined;
      try {
        const posted = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: `Quick question before I plan this out: ${question}`,
        });
        clarificationTs = posted.ts ?? undefined;
      } catch {
        break;
      }
      if (!clarificationTs) break;

      const allowedAnswerers = [...new Set([requesterOf(task), ...getAdminUserIds(config)])];
      const outcome = await waitForClarificationWithIdle({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        allowedUserIds: allowedAnswerers,
        promptTs: clarificationTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
        nudgeText: "Still waiting on that clarification to build the plan. Reply here or say 'cancel' to stop.",
        // Thread the job's abort signal so cancelJob() actually terminates this
        // wait. Without it a "cancelled" job stays parked and can zombie-resume
        // on a later thread reply against an already-aborted signal (#348 RC3).
        signal,
      });

      if (outcome.outcome === 'cancelled') {
        try {
          await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Got it, cancelling.',
          });
        } catch {
          // best-effort
        }
        return {
          workflow: 'IMPLEMENTATION',
          status: 'CANCELLED',
          message: 'User cancelled during planner clarification.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }
      if (outcome.outcome === 'timeout') {
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: 'No reply within the idle window — paused. Reply in the thread to resume.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }
      if (outcome.outcome === 'paused') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `Pausing — re-mention <@${config.botUserId}> with the clarification answer when you're ready.`,
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'SKIPPED',
          message: `User asked miniOG to wait during planner clarification (<@${outcome.pauserId}>).`,
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      const answer = outcome.answer;
      clarificationHistory.push({ question, answer });

      // On Claude Code plans are markdown, so the follow-up asks for markdown
      // too: the JSON contract came back as markdown or without
      // `requiresCodeChanges`, which read as "no code changes" (issue #695).
      const followUpPrompt = plannerPlanMode
        ? clarifiedPromptMarkdown(
            question,
            answer,
            typeof plannerOutput.planMarkdown === 'string' ? plannerOutput.planMarkdown : '',
          )
        : plannerSessionId
          ? `The user answered your clarifying question ("${question}") with:\n\n"${answer}"\n\nNow produce the final plan. Return the same JSON schema with \`clarificationNeeded\` set to null.`
          : `You previously asked: "${question}"\nThe user answered: "${answer}"\n\nOriginal plan so far:\n${JSON.stringify(plannerOutput, null, 2)}\n\nNow produce the final plan. Return the same JSON schema with \`clarificationNeeded\` set to null.`;

      plannerRunResult = await runWithInfraRetry(
        {
          cwd: ctx.cwd,
          prompt: followUpPrompt,
          ...(plannerSessionId ? { resumeSessionId: plannerSessionId } : {}),
          outputSchemaPath: plannerPlanMode ? undefined : plannerSchemaPath,
          githubToken: ctx.githubToken,
          imagePaths: plannerCtx.imagePaths,
          // Planning only reads, before anyone approved a change; this call
          // used to run with every permission bypassed (issue #695). Like the
          // plan revision it runs read-only rather than in plan mode, and its
          // final message is the plan.
          readOnly: true,
          ...plannerProfile,
          // No per-agent timeoutMs — see investigationWorkflow.ts for rationale.
          // Outer abort signal remains the safety net.
          onLog: logStep,
          signal,
        },
        { label: 'planner', logStep },
      );
      if (signal?.aborted) {
        return cancelledResult('IMPLEMENTATION');
      }
      plannerSessionId = plannerRunResult.sessionId ?? plannerSessionId;
      // Read the answer's plan the way the first plan is read. One that can't
      // be read as a plan keeps the earlier one, which goes to approval; it is
      // never taken as "no code changes" (issue #695).
      const followUpPlan =
        plannerRunResult.ok && plannerRunResult.parsedJson
          ? normalizePlannerOutput(plannerRunResult.parsedJson, plannerBackend)
          : undefined;
      if (!followUpPlan || (plannerPlanMode && !followUpPlan.planMarkdown)) {
        logStep?.({
          stage: 'implementation.planner.clarification.unreadable',
          message: 'The planner did not return a readable plan after the answer; the earlier plan goes to approval.',
          level: 'WARN',
          data: { ok: plannerRunResult.ok, hasParsedJson: Boolean(plannerRunResult.parsedJson) },
        });
        plannerOutput = { ...plannerOutput, requiresCodeChanges: true, clarificationNeeded: null };
        break;
      }
      plannerOutput = {
        ...plannerRunResult.parsedJson,
        planMarkdown: followUpPlan.planMarkdown,
        scope: followUpPlan.scope,
        affectedFiles: followUpPlan.affectedFiles,
        requiresCodeChanges: followUpPlan.requiresCodeChanges,
        clarificationNeeded: followUpPlan.clarificationNeeded,
      };
    }

    // Read through the same normalisation, so a plan with no
    // `requiresCodeChanges` counts as a change (the safe direction), never as
    // a quick action with no approval (issue #695).
    const plannerRequiresCodeChanges = normalizePlannerOutput(plannerOutput, plannerBackend).requiresCodeChanges;

    // Quick-action fast path: if the planner says no code changes are needed
    // (e.g., "merge this PR", "close PR", "deploy", "run tests"), skip the full
    // pipeline and execute directly with a single codex call. No approval gate needed.
    if (!plannerRequiresCodeChanges) {
      logStep?.({
        stage: 'implementation.quick_action',
        message: 'Planner says no code changes needed — executing as quick action (no approval, no pipeline).',
        data: { plan: plannerOutput.plan },
      });
      return runQuickAction({
        task,
        config,
        slack,
        ctx,
        store,
        jobId,
        logStep,
        signal,
        plan: plannerOutput.plan,
        prs: task.prContexts ?? (task.prContext ? [task.prContext] : []),
        checkPr: task.prContext,
      });
    }

    // Full pipeline path: code changes are needed. Normalize the planner
    // output once so the downstream coder, Slack rendering, and resume contexts
    // all see a consistent shape regardless of which backend produced the plan.
    const plannerNormalized = normalizePlannerOutput(plannerOutput, plannerBackend);
    // Surface the normalized fields on plannerOutput so the coder prompt (built
    // later by buildCoderPrompt) and any other plannerOutput consumers read a
    // consistent shape.
    plannerOutput.planMarkdown = plannerNormalized.planMarkdown;
    plannerOutput.scope = plannerNormalized.scope;
    plannerOutput.affectedFiles = plannerNormalized.affectedFiles;
    plannerOutput.requiresCodeChanges = plannerNormalized.requiresCodeChanges;
    plannerOutput.clarificationNeeded = plannerNormalized.clarificationNeeded;

    let planMarkdown = plannerNormalized.planMarkdown;
    let planAffectedFiles = plannerNormalized.affectedFiles;
    let planScope: string = plannerNormalized.scope;

    // Resolve workspace for the coder agent. Single entry point:
    // resolveRepoOrAsk cascades through file hints → text mentions → extension
    // heuristics → classifier → admin clarification (with 6h idle timeout).
    // On timeout or no admins, falls through to desktop_only. On admin cancel
    // we abandon cleanly.
    let pipelineCwd = ctx.cwd;
    if (ctx.isOwnerAuthor) {
      let repoAffinity: RepoAffinity | undefined;
      if (store?.dossierStore && task.event.userId) {
        try {
          repoAffinity = readRepoAffinity(store.dossierStore().getDossier(task.event.userId));
        } catch {
          // dossier read shouldn't block repo resolution
        }
      }
      const resolution = await resolveRepoOrAsk({
        task,
        config,
        slack,
        logStep,
        planAffectedFiles,
        planMarkdown,
        threadMessages: ctx.threadMessages,
        repoAffinity,
        // A follow-up belongs in its PR's repo unless the plan's files say otherwise (issue #730).
        preferredRepo: followUpCandidate?.repoKey,
        signal,
      });

      if (signal?.aborted) {
        return cancelledResult('IMPLEMENTATION');
      }

      if (resolution.outcome === 'cancelled') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Cancelled — no repo selected.',
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'CANCELLED',
          message: 'Cancelled during repo-selection clarification.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      if (resolution.outcome === 'desktop_only') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `I couldn't pin down which repo this is for (${resolution.reason}) — handing this over to the desktop queue for a human to pick up.`,
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: `Routed to desktop (${resolution.reason}).`,
          notifyDesktop: true,
          slackPosted: true,
        };
      }

      pipelineCwd = await resolveWorkspace(resolution.path, task.event.threadTs);
      logStep?.({
        stage: 'implementation.workspace.resolved',
        message: 'Resolved implementation workspace to isolated worktree.',
        data: { targetRepoPath: resolution.path, repoName: resolution.name, source: resolution.source, pipelineCwd },
      });
    }

    // Post initial plan
    let planMessageTs: string | undefined;
    let planPostError: unknown;
    if (planMarkdown.length > 0) {
      try {
        planMessageTs = await postPlanForApproval({
          slack,
          channelId: task.event.channelId,
          threadTs: task.event.threadTs,
          planMarkdown,
          affectedFiles: planAffectedFiles,
          scope: planScope,
          repoPath: pipelineCwd,
          requesterToConfirm: requesterToConfirmFor(planMarkdown, config, requesterOf(task)),
          ...(followUpCandidate ? { note: followUpPlanNote(followUpCandidate) } : {}),
          logStep,
        });
      } catch (error) {
        planPostError = error;
      }
    }

    // Fail closed: approval is mandatory for fresh implementation runs,
    // and the only thing the thread can approve is the plan message. If the
    // planner produced no plan content, or the plan post failed, we have no
    // reviewable artifact and no approval prompt \u2014 proceeding would let the
    // coder/reviewer/verifier write code unsupervised.
    if (!planMessageTs) {
      const reason =
        planMarkdown.length === 0
          ? 'Planner returned no plan content \u2014 cannot proceed without a reviewable plan.'
          : 'Failed to post the plan to Slack \u2014 cannot proceed without an approval prompt.';
      logStep?.({
        stage: 'implementation.approval.unreachable',
        message: reason,
        level: 'ERROR',
        data: {
          planMarkdownLength: planMarkdown.length,
          planPostError: planPostError ? String(planPostError) : undefined,
        },
      });
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: `Couldn't post the plan for approval \u2014 ${reason} Cancelling.`,
        })
        .catch(() => {});
      return {
        workflow: 'IMPLEMENTATION',
        status: 'FAILED',
        message: reason,
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    // Iterative approval loop (handles fresh runs and resumed-from-pause).
    // Extracted into runApprovalLoop so the pause/resume path can re-enter at
    // any saved iteration. Bundled fix: the helper posts the revised plan as a
    // NEW Slack message on each feedback round (instead of only chat.update'ing
    // the original) so "Here's the revised plan" is honest.
    let feedbackRounds = 0;
    const loopOutcome = await runApprovalLoop({
      slack,
      config,
      task,
      initial: {
        planMarkdown,
        planAffectedFiles,
        planScope,
        plannerOutput,
        plannerSessionId,
        planMessageTs,
      },
      pipelineCwd,
      iterationStart: 0,
      feedbackRoundsStart: 0,
      pauseCountStart: 0,
      plannerSchemaPath,
      plannerProfile,
      plannerBackend,
      workflowTimeoutMs,
      githubToken: ctx.githubToken,
      imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
      workflowIntent: task.intent === 'OWNER_AUTOPILOT' ? 'OWNER_AUTOPILOT' : 'IMPLEMENTATION',
      logStep,
      signal,
    });

    if (loopOutcome.kind === 'cancelled') {
      // A reply stopped it: say so, where the job's own cancel lane would have
      // (issue #598). When the stop lane also saw the reply it has aborted the
      // job and said "Stopped." already, so nothing is said twice.
      if (loopOutcome.stoppedBy && !signal?.aborted) {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'Stopped. Nothing was changed.',
          })
          .catch(() => {});
        return {
          ...cancelledResult('IMPLEMENTATION'),
          message: `Stopped from Slack by <@${loopOutcome.stoppedBy}>.`,
          slackPosted: true,
        };
      }
      return cancelledResult('IMPLEMENTATION');
    }
    if (loopOutcome.kind === 'paused') {
      return {
        workflow: loopOutcome.resumeContext.workflow,
        status: 'PAUSED',
        message: 'Paused \u2014 awaiting next mention to resume.',
        notifyDesktop: false,
        slackPosted: true,
        resumeContext: loopOutcome.resumeContext,
      };
    }
    if (loopOutcome.kind === 'rejected_then_cancelled') {
      return {
        workflow: 'IMPLEMENTATION',
        status: 'SKIPPED',
        message: loopOutcome.message,
        notifyDesktop: false,
        slackPosted: true,
      };
    }
    if (loopOutcome.kind === 'exhausted') {
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: `Reached the revision limit (${MAX_FEEDBACK_ITERATIONS}). Cancelling \u2014 feel free to start a new request.`,
        })
        .catch(() => {});
      return {
        workflow: 'IMPLEMENTATION',
        status: 'SKIPPED',
        message: 'Exceeded maximum feedback iterations.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }
    // loopOutcome.kind === 'approved' \u2014 refresh outer state with possibly-revised plan and continue.
    planMarkdown = loopOutcome.planMarkdown;
    planAffectedFiles = loopOutcome.planAffectedFiles;
    planScope = loopOutcome.planScope;
    plannerOutput = loopOutcome.plannerOutput;
    // #388: re-stamp the admin-approved plan onto plannerOutput so the planner step
    // the pipeline consumes matches what was approved \u2014 covers both the initial plan
    // and any feedback-revised plan (whose raw codex shape lacks these fields).
    stampApprovedPlan(plannerOutput, {
      planMarkdown,
      scope: planScope,
      affectedFiles: planAffectedFiles,
    });
    plannerSessionId = loopOutcome.plannerSessionId;
    planMessageTs = loopOutcome.planMessageTs;
    feedbackRounds = loopOutcome.feedbackRounds;
    // Adopt the worktree the loop ended on. Revisions may have swapped repos
    // mid-flight (newton-api \u2192 newton-web); the coder/reviewer/verifier
    // pipeline below must run against that worktree, not the one chosen at
    // initial repo classification.
    pipelineCwd = loopOutcome.pipelineCwd;

    const prepared = await prepareForCoder({
      jobId,
      task,
      config,
      pipelineCwd,
      planMarkdown,
      planAffectedFiles,
      threadTexts: (ctx.threadMessages ?? []).map(message => message.text),
      slack,
      logStep,
      followUp: followUpCandidate,
    });
    const activeFollowUp = prepared.followUp;
    const followUpLog = (msg: string) => logStep?.({ stage: 'implementation.pr.progress', message: msg });
    const settleFollowUp = (followUp: { pr: FollowUpPr; startHead: string }) =>
      settleUnfinishedFollowUp({
        repoPath: pipelineCwd,
        branch: followUp.pr.branch,
        startHead: followUp.startHead,
        uniqueTs: task.event.eventTs,
        onLog: followUpLog,
      });
    if (prepared.followUpFallback) followUpNote = prepared.followUpFallback;
    if (signal?.aborted) {
      return cancelledResult('IMPLEMENTATION');
    }

    // Build the plannerStep for downstream consumption
    const plannerStep: AgentStepResult = {
      role: 'planner',
      status: 'passed',
      output: plannerOutput,
      findings: [],
      durationMs: plannerRunResult.durationMs,
    };

    // Assert on the step the agents will actually read, not on the local
    // planMarkdown variable. #413: the old check inspected `planMarkdown` — which
    // was correctly populated — while the coder was being handed an empty plan by
    // a different code path entirely, so this never fired on the job that broke.
    const seededPlanMarkdown = plannerStep.output.planMarkdown;
    if (typeof seededPlanMarkdown !== 'string' || seededPlanMarkdown.trim().length === 0) {
      logStep?.({
        stage: 'implementation.plan.empty',
        message: 'Approved planner step carries no planMarkdown — the coder will be flying blind.',
        level: 'ERROR',
        data: {
          feedbackRounds,
          plannerOutputKeys: Object.keys(plannerStep.output),
          localPlanMarkdownLength: planMarkdown.length,
        },
      });
    }

    const introMsg = buildApprovalMessage(feedbackRounds);

    // Run the execution pipeline (coder -> reviewer -> verifier)
    const fullPipelineConfig: PipelineConfig = {
      agents: ['coder', 'reviewer', 'verifier'],
      maxRetryLoops: 2,
      abortOnCriticalFinding: true,
      slackProgressUpdates: true,
      requireApproval: false,
      totalTimeoutMs: workflowTimeoutMs,
      perAgentTimeoutMs: Math.floor(workflowTimeoutMs / 3),
    };

    const buildPipelineCtx = (threadContextOverride: string) => ({
      workflowIntent: 'IMPLEMENTATION' as const,
      task,
      config,
      repoPath: pipelineCwd,
      githubToken: ctx.githubToken,
      threadContext: threadContextOverride,
      previousSteps: [plannerStep],
      pipelineConfig: fullPipelineConfig,
      imagePaths: ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
      requestedBy: ctx.requestedBy,
      // Repo-scoped hard rules (belt-and-braces over the repo's own CLAUDE.md,
      // which the backend also reads in the worktree). Derived from the final
      // pipelineCwd because plan revisions may have swapped repos mid-flight.
      policyPack: repoPolicyPackForCwd(pipelineCwd, config),
      // The coder commits to the thread's open PR instead of opening one (issue #730).
      followUp: activeFollowUp ? { prUrl: activeFollowUp.pr.url, branch: activeFollowUp.pr.branch } : undefined,
    });

    // The follow-up block is the coder's only when it really adds to that PR.
    let currentThreadContext = activeFollowUp ? ctx.threadContext : threadContextWithoutFollowUp;
    let fullResult = await runAgentPipeline({
      ctx: buildPipelineCtx(currentThreadContext),
      slack,
      logStep: logStep ?? (() => {}),
      introMessage: introMsg,
      store,
      jobId,
      signal,
    });

    const MAX_NEEDS_INPUT_RESUMES = 3;
    let needsInputResumes = 0;
    while (fullResult.finalStatus === 'needs-input' && needsInputResumes < MAX_NEEDS_INPUT_RESUMES) {
      needsInputResumes++;
      const question = fullResult.needsInputQuestion ?? 'I need more information to proceed — could you share details?';

      const askResp = await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: question,
      });
      const promptTs = askResp.ts;

      const adminUserIds = getAdminUserIds(config);
      const allowedIds = Array.from(new Set([requesterOf(task), ...adminUserIds, ...config.coreDevSlackUserIds]));

      if (!promptTs) {
        logStep?.({
          stage: 'implementation.needs_input.post_failed',
          message: 'Could not post the needs-input question to Slack — treating as paused.',
          level: 'WARN',
        });
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: 'Paused pending more information (Slack post failed).',
          notifyDesktop: false,
          slackPosted: false,
        };
      }

      const clarification = await waitForClarificationWithIdle({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        allowedUserIds: allowedIds,
        promptTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
        nudgeText:
          "Still waiting on more info for the fix — reply here with the error text, failing request, or file scope. Say 'cancel' to stop.",
        // Thread the job's abort signal so cancelJob() actually terminates this
        // wait. Without it a "cancelled" job stays parked and can zombie-resume
        // on a later thread reply against an already-aborted signal (#348 RC3).
        signal,
      });

      if (clarification.outcome === 'cancelled') {
        await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: 'Got it, cancelling.',
        });
        return {
          workflow: 'IMPLEMENTATION',
          status: 'CANCELLED',
          message: 'User cancelled after needs-input prompt.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      if (clarification.outcome === 'timeout') {
        return {
          workflow: 'IMPLEMENTATION',
          status: 'PAUSED',
          message: 'No reply within the idle window — paused. Reply in the thread to resume.',
          notifyDesktop: false,
          slackPosted: true,
        };
      }
      if (clarification.outcome === 'paused') {
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: `Pausing — re-mention <@${config.botUserId}> with the requested info when you're ready.`,
          })
          .catch(() => {});
        return {
          workflow: 'IMPLEMENTATION',
          status: 'SKIPPED',
          message: `User asked miniOG to wait during needs-input loop (<@${clarification.pauserId}>).`,
          notifyDesktop: false,
          slackPosted: true,
        };
      }

      currentThreadContext =
        `${currentThreadContext}\n\n<@${clarification.answererId}> follow-up answer: ${clarification.answer}`.trim();

      logStep?.({
        stage: 'implementation.needs_input.resuming',
        message: `Resuming pipeline with follow-up context (attempt ${needsInputResumes}/${MAX_NEEDS_INPUT_RESUMES}).`,
      });

      fullResult = await runAgentPipeline({
        ctx: buildPipelineCtx(currentThreadContext),
        slack,
        logStep: logStep ?? (() => {}),
        introMessage: 'Picking back up with the new info you shared.',
        store,
        jobId,
        signal,
      });
    }

    if (fullResult.finalStatus === 'needs-input') {
      logStep?.({
        stage: 'implementation.needs_input.exhausted',
        message: `Hit resume cap (${MAX_NEEDS_INPUT_RESUMES}) without enough info — pausing.`,
        level: 'WARN',
      });
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: "I've asked a few times but still don't have enough to write a targeted fix — pausing. Reply with concrete details and I'll resume.",
      });
      return {
        workflow: 'IMPLEMENTATION',
        status: 'PAUSED',
        message: 'Exhausted clarification attempts without enough info to proceed.',
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    if (fullResult.finalStatus === 'usage-limit') {
      // The CLI hit the account's session/usage cap — nothing the agents did
      // was wrong and nothing useful can run until the limit resets. Pause
      // with a truthful message instead of failing the job (issue #342).
      // The stage string below is the pause-resume key consumed by
      // jobStore.isPausedAwaitingUsageLimitRetry — a "resume"/"retry" reply
      // in-thread restarts the workflow (which re-plans; the prior plan and
      // approval remain in thread context, so re-approval is one word).
      logStep?.({
        stage: 'implementation.usage_limit.paused',
        message: `Pipeline hit the Claude usage limit — pausing${fullResult.usageLimitResetsAt ? ` until reset (${fullResult.usageLimitResetsAt})` : ''}.`,
        level: 'WARN',
        data: { resetsAtText: fullResult.usageLimitResetsAt },
      });

      const resetsClause = fullResult.usageLimitResetsAt
        ? ` It resets ${fullResult.usageLimitResetsAt}.`
        : ' It usually resets within a few hours.';
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: `Claude usage limit hit before I could finish.${resetsClause} Reply "resume" in this thread after the reset and I'll pick this up.`,
        })
        .catch(() => {});

      return {
        workflow: 'IMPLEMENTATION',
        status: 'PAUSED',
        message: `Paused on Claude usage limit${fullResult.usageLimitResetsAt ? ` (resets ${fullResult.usageLimitResetsAt})` : ''}.`,
        notifyDesktop: true,
        slackPosted: true,
      };
    }

    // Cancelled mid-pipeline: its agents were killed, which is not a review
    // verdict, and "Not opening a PR" would read as one (#438).
    if (signal?.aborted && fullResult.finalStatus !== 'passed') {
      logStep?.({
        stage: 'implementation.pipeline.cancelled',
        message: `Pipeline was cancelled (status ${fullResult.finalStatus}).`,
        level: 'WARN',
        data: { finalStatus: fullResult.finalStatus },
      });
      // A stopped follow-up pushed nothing to its PR: say so, and keep the work (issue #730).
      if (activeFollowUp) {
        const settled = await settleFollowUp(activeFollowUp);
        await slack.chat
          .postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: unfinishedFollowUpLine(activeFollowUp.pr.url, settled),
          })
          .catch(() => {});
      }
      return cancelledResult('IMPLEMENTATION');
    }

    // A follow-up that didn't pass: the coder only committed, so the PR is
    // normally untouched; the unreviewed work goes to a side branch (issue #730).
    if (fullResult.finalStatus !== 'passed' && activeFollowUp) {
      const settled = await settleFollowUp(activeFollowUp);
      const interruptedReason =
        fullResult.interrupted?.kind === 'connection_lost'
          ? connectionLostReply(`the ${fullResult.interrupted.role} was running`)
          : fullResult.interrupted
            ? killedFromOutsideReply(`The ${fullResult.interrupted.role}`)
            : undefined;
      const failureSummary = unfinishedFollowUpSummary(fullResult, interruptedReason, activeFollowUp.pr.url, settled);
      logStep?.({
        stage: 'implementation.followup.unfinished',
        message: `The follow-up did not pass; ${activeFollowUp.pr.url} ${settled.prUntouched ? 'is as it was' : 'was not confirmed unchanged'}.`,
        data: { finalStatus: fullResult.finalStatus, prUrl: activeFollowUp.pr.url, ...settled },
      });
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: failureSummary,
      });
      return {
        workflow: 'IMPLEMENTATION',
        status: 'FAILED',
        message: failureSummary,
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    if (fullResult.finalStatus !== 'passed') {
      // Refuse to publish a PR or report SUCCESS when the pipeline did not
      // pass. createPrFromWorkspace is willing to push & open a PR off any
      // dirty / ahead-of-base workspace, so without this gate a failed or
      // aborted run could leak commits into a PR and then be marked SUCCESS
      // purely because prUrl is truthy.
      logStep?.({
        stage: 'implementation.pipeline.failed',
        message: `Pipeline finished with status ${fullResult.finalStatus} — refusing to open a PR.`,
        level: 'WARN',
        data: { finalStatus: fullResult.finalStatus },
      });

      // A PR the coder opened is the requester's to know about, whatever
      // stopped the run: five times it was told "Not opening a PR" while
      // one was open (issue #333).
      const runPr = await findRunPr(pipelineCwd, coderReportedPrUrl(fullResult.steps));
      const interruptedReason =
        fullResult.interrupted?.kind === 'connection_lost'
          ? connectionLostReply(`the ${fullResult.interrupted.role} was running`)
          : fullResult.interrupted
            ? killedFromOutsideReply(`The ${fullResult.interrupted.role}`)
            : undefined;
      const failureSummary =
        interruptedReason && !runPr
          ? `${interruptedReason} Any work it had already done is still on its branch.`
          : buildUnfinishedRunMessage({ result: fullResult, pr: runPr, reason: interruptedReason });
      logStep?.({
        stage: 'implementation.pipeline.unfinished',
        message: runPr
          ? `The run did not pass; the coder's PR ${runPr.url} is ${runPr.state.toLowerCase()}.`
          : 'The run did not pass; there is no PR.',
        data: { finalStatus: fullResult.finalStatus, pr: runPr, budgetExhausted: fullResult.budgetExhausted },
      });
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: failureSummary,
      });

      return {
        workflow: 'IMPLEMENTATION',
        status: 'FAILED',
        message: failureSummary,
        notifyDesktop: false,
        slackPosted: true,
        ...(runPr ? { result: { prUrl: runPr.url, prState: runPr.state } } : {}),
      };
    }

    // The latest coder pass: after a reviewer-driven retry the first pass is stale.
    const coderStep = [...fullResult.steps].reverse().find(s => s.role === 'coder');
    const rawCoderSummary = coderStep?.output?.summary ? sanitizeOwnerSummary(String(coderStep.output.summary)) : '';
    const summary =
      rawCoderSummary || 'Pipeline completed but the agent did not return a summary. Check the repo for changes.';
    // The person who asked reads two or three plain lines unless they are an
    // engineer; the engineering account goes to the PR (issue #601).
    const requesterSummary = coderStep?.output?.requesterSummary
      ? sanitizeRequesterSummary(String(coderStep.output.requesterSummary))
      : '';
    const requesterUserId = task.event.requestedForUserId ?? task.event.userId;
    let requesterRole: DossierRole | undefined;
    try {
      requesterRole = store?.dossierStore?.().getDossier(requesterUserId).profile?.role ?? undefined;
    } catch {
      // A dossier read must not decide whether the run reports.
    }
    const engineerReads = requesterIsEngineer({ userId: requesterUserId, config, role: requesterRole });
    const replyFor = (
      prUrlForReply: string,
      external: string,
      prFailed = false,
      addedTo = false,
      notesInPr = true,
    ): string =>
      composeChangeReply({
        summary,
        requesterSummary,
        engineerReads,
        prUrl: prUrlForReply,
        externalBlock: external,
        prFailed,
        addedTo,
        notesInPr,
      });

    let prUrl = coderReportedPrUrl(fullResult.steps) ?? '';
    const externalBlock = fullResult.externalChanges?.length
      ? `\n\n${formatExternalChanges(fullResult.externalChanges, Boolean(fullResult.externalNotInPlan))}`
      : '';

    // The whole change was outside the repository (issue #432): nothing to
    // commit, so no PR. It used to end as "I haven't touched any files" while
    // seven Metabase cards had been changed.
    if (fullResult.externalOnly && !prUrl) {
      logStep?.({
        stage: 'implementation.external_only',
        message: 'The change was made outside the repository; no PR to open.',
        data: { externalChanges: fullResult.externalChanges, notInPlan: fullResult.externalNotInPlan },
      });
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: `${replyFor('', externalBlock)}\n\nNo pull request: nothing in the repository changed.`,
      });
      return {
        workflow: 'IMPLEMENTATION',
        status: 'SUCCESS',
        message: summary,
        notifyDesktop: false,
        slackPosted: true,
        result: { externalChanges: fullResult.externalChanges },
      };
    }

    // #413 belt-and-braces: the pipeline already routes a self-declared block to
    // the needs-input loop, so this should be unreachable — but a "Blocked: …"
    // summary must never survive far enough to become a commit message and a PR
    // title, which is exactly what happened on job 9c632322 (PR #862).
    if (!prUrl && coderStep && coderDeclaredBlocked(coderStep.output)) {
      logStep?.({
        stage: 'implementation.pr.skipped_blocked',
        message: 'Coder declared itself blocked — posting its question instead of opening a PR.',
        level: 'WARN',
      });
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: summary,
      });
      return {
        workflow: 'IMPLEMENTATION',
        status: 'PAUSED',
        message: summary,
        notifyDesktop: false,
        slackPosted: true,
      };
    }

    // A follow-up lands on the thread's open PR once its checks passed (issue
    // #730): the only push of a follow-up, never over someone else's commits.
    if (activeFollowUp) {
      const outcome = await landFollowUp({
        followUp: activeFollowUp,
        repoPath: pipelineCwd,
        task,
        summary,
        requestedBy: ctx.requestedBy,
        store,
        logStep,
        onLog: followUpLog,
      });
      const wipLine = outcome.wipBranch
        ? ` The change is on branch \`${outcome.wipBranch}\`, with no pull request.`
        : '';
      let text: string;
      switch (outcome.kind) {
        case 'added':
          text = `${replyFor(activeFollowUp.pr.url, externalBlock, false, true, outcome.commented)}${outcome.ontoNewerCommits ? `\nSomeone else had pushed to it meanwhile; this change is on top of their commits.` : ''}${outcome.stagingStillOld ? `\n${STAGING_STILL_OLD}` : ''}`;
          break;
        case 'stacked':
          text = `${replyFor(outcome.prUrl, externalBlock)}\n\nSomeone else pushed to ${activeFollowUp.pr.url} while I worked, and this change conflicts with their commits, so I didn't push over them: it's in its own pull request into that branch. Merge this one first, then ${activeFollowUp.pr.url}.`;
          break;
        case 'relanded':
          text = `${replyFor(outcome.prUrl, externalBlock)}\n\n${activeFollowUp.pr.url} was ${outcome.state === 'MERGED' ? 'merged' : 'closed'} while I worked, so this change is in a new pull request.`;
          break;
        case 'nothing':
          text = `${replyFor('', externalBlock)}\n\nNothing new was added to ${activeFollowUp.pr.url}.`;
          break;
        case 'rewritten':
          text = `${replyFor('', externalBlock, true)}\n\nThe coder changed ${activeFollowUp.pr.url}'s existing commits instead of adding one, so I didn't push it. Nothing was added to ${activeFollowUp.pr.url}; it's as it was.${wipLine}`;
          break;
        default:
          text = `${replyFor('', externalBlock, true)}\n\nI couldn't add this to ${activeFollowUp.pr.url}, so nothing was added to it.${wipLine}`;
      }
      const delivered = outcome.kind === 'added' || outcome.kind === 'stacked' || outcome.kind === 'relanded';
      await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text });
      return {
        workflow: 'IMPLEMENTATION',
        status: delivered || outcome.kind === 'nothing' ? 'SUCCESS' : 'FAILED',
        message: summary,
        notifyDesktop: !delivered && outcome.kind !== 'nothing',
        slackPosted: true,
        ...(outcome.kind === 'added'
          ? { result: { prUrl: activeFollowUp.pr.url } }
          : outcome.kind === 'stacked' || outcome.kind === 'relanded'
            ? { result: { prUrl: outcome.prUrl } }
            : {}),
      };
    }

    if (!prUrl) {
      logStep?.({
        stage: 'implementation.pr.creating',
        message: 'Coder did not produce a PR — creating one from workspace changes.',
      });

      prUrl =
        (await createPrFromWorkspace({
          repoPath: pipelineCwd,
          threadTs: task.event.threadTs,
          summary,
          requestedBy: ctx.requestedBy,
          channelId: task.event.channelId,
          workflow: 'IMPLEMENTATION',
          onLog: msg =>
            logStep?.({
              stage: 'implementation.pr.progress',
              message: msg,
            }),
        })) ?? '';
    }

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${replyFor(prUrl, externalBlock, prUrl === '')}${followUpNote ? `\n\n${followUpNote}` : ''}`,
    });

    return {
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      message: summary,
      notifyDesktop: false,
      slackPosted: true,
      result: { prUrl },
    };
  }

  // --- Single-agent path (legacy) ---
  const cwd = ctx.cwd;
  const prompt = ctx.isOwnerAuthor
    ? buildOwnerPrimaryPrompt({
        task,
        config,
        workspaceRoot: cwd,
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        imageContext: ctx.imageContext,
      })
    : buildGuardrailedPrompt({
        task,
        config,
        repoPath: cwd,
        repoName: ctx.repoName ?? 'unknown',
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        imageContext: ctx.imageContext,
      });

  const backend = getBackend(getActiveBackendId());
  const request: CodexRunRequest = {
    cwd,
    prompt,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken: ctx.githubToken,
    imagePaths: ctx.imagePaths.length > 0 && backend.supportsImages() ? ctx.imagePaths : undefined,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  };

  logStep?.({
    stage: 'implementation.codex.start',
    message: 'Starting implementation Codex execution with high-reasoning profile.',
    data: { cwd, isOwnerAuthor: ctx.isOwnerAuthor },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'implementation.codex.finish',
    message: 'Implementation Codex execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: { ok: result.ok, timedOut: result.timedOut, exitCode: result.exitCode },
  });

  // Plain text fallback
  const primaryTextFallback =
    result.ok && !result.parsedJson ? sanitizeOwnerSummary(result.lastMessage || result.stdout) : '';

  if (primaryTextFallback) {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: primaryTextFallback,
    });
    return {
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      message: primaryTextFallback,
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (!result.ok || !result.parsedJson) {
    // Owner relaxed retry
    if (ctx.isOwnerAuthor) {
      const relaxedPrompt = buildOwnerRelaxedPrompt({
        task,
        config,
        workspaceRoot: cwd,
        githubToken: ctx.githubToken,
        threadContext: ctx.threadContext,
        imageContext: ctx.imageContext,
      });
      const relaxedResult = await runCodex({
        cwd,
        prompt: relaxedPrompt,
        githubToken: ctx.githubToken,
        imagePaths: ctx.imagePaths.length > 0 && backend.supportsImages() ? ctx.imagePaths : undefined,
        ...highReasoningProfile(getActiveBackendId()),
        onLog: logStep,
        signal,
      });

      if (relaxedResult.ok) {
        const relaxedSummaryRaw = relaxedResult.lastMessage || relaxedResult.stdout;
        const relaxedSummary = sanitizeOwnerSummary(relaxedSummaryRaw || '');
        const messageText = relaxedSummary || 'Workflow completed but the agent returned empty output.';

        await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: messageText,
        });

        return {
          workflow: 'IMPLEMENTATION',
          status: 'SUCCESS',
          message: messageText,
          notifyDesktop: false,
          slackPosted: true,
        };
      }
    }

    const userFacingMessage =
      'I hit an execution issue right now. Ask me again in a moment, or share the task in one line and I will retry.';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: userFacingMessage,
    });

    notifyDesktop('Watchtower implementation failed', `thread=${task.event.threadTs}`);

    return {
      workflow: 'IMPLEMENTATION',
      status: 'PAUSED',
      message: userFacingMessage,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  // Parse structured JSON response
  const status = String(result.parsedJson.status ?? 'success') === 'success' ? 'success' : 'failed';
  const summaryRaw = String(result.parsedJson.summary ?? 'Implementation completed.');
  const summary = sanitizeOwnerSummary(summaryRaw);
  const prUrl = String(result.parsedJson.prUrl ?? '');

  const prBlock = prUrl ? `\n${prUrl}` : '';
  const text = `${summary}${prBlock}`.trim();

  if (text) {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text,
    });
  }

  return {
    workflow: 'IMPLEMENTATION',
    status: status === 'failed' ? 'FAILED' : 'SUCCESS',
    message: summary || 'Implementation completed.',
    notifyDesktop: false,
    slackPosted: Boolean(text),
    result: result.parsedJson,
  };
}
