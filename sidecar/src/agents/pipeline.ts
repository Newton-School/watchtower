import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { getAdminUserIds } from '../access/control.js';
import type { AgentContext, AgentFinding, AgentRole, AgentStepResult, PipelineResult } from './types.js';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { buildPromptForRole } from './prompts.js';
import { lightweightProfile, profileForAgentRole } from '../codex/modelProfiles.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { isInterruption, runWithInfraRetry, type InterruptionKind } from '../codex/infraRetry.js';
import { jobSlots } from '../runtime/jobSlots.js';
import {
  isNone,
  normalizePlannerOutput,
  parseApproverSummary,
  planWithoutApproverParts,
  type NormalizedPlannerOutput,
} from './normalizePlannerOutput.js';
import { REPO_KEYS, type RepoKey } from '../repos/registry.js';
import { withAgentCallContext } from '../state/runContext.js';
import { currentConnectors, NO_CONNECTORS, withConnectors } from '../backends/connectors.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import { currentHead, checkCoderProducedChanges, getDiffVsBase } from '../workspaces/gitState.js';

export type PipelineStore = {
  createPipelineRun(input: {
    id: string;
    jobId: string;
    pipelineConfigJson: string;
    status: string;
    stepsJson: string;
    retryLoops?: number;
    totalDurationMs?: number;
  }): void;
  updatePipelineRun(
    id: string,
    updates: {
      status?: string;
      stepsJson?: string;
      retryLoops?: number;
      totalDurationMs?: number;
    },
  ): void;
};

const SCHEMA_MAP: Partial<Record<AgentRole, string>> = {
  planner: 'agent-planner-result.schema.json',
  reviewer: 'agent-reviewer-result.schema.json',
  security: 'agent-security-result.schema.json',
  performance: 'agent-performance-result.schema.json',
  verifier: 'agent-verifier-result.schema.json',
};

function extractFindings(output: Record<string, unknown>): AgentFinding[] {
  const raw = output.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map(f => ({
    severity: f.severity ?? 'info',
    category: f.category ?? 'general',
    message: f.message ?? '',
    file: f.file,
    line: f.line,
    suggestion: f.suggestion,
  }));
}

function hasCriticalFinding(findings: AgentFinding[]): boolean {
  return findings.some(f => f.severity === 'critical');
}

function determineStepStatus(output: Record<string, unknown>, findings: AgentFinding[]): 'passed' | 'failed' {
  if (hasCriticalFinding(findings)) return 'failed';
  if (output.approved === false || output.verified === false) return 'failed';
  return 'passed';
}

const ROLE_START_MESSAGES: Record<AgentRole, string> = {
  planner: 'Thinking through the approach...',
  coder: 'Writing the code now.',
  reviewer: 'Reviewing the changes for quality.',
  security: 'Checking for security issues.',
  performance: 'Checking for performance issues.',
  verifier: 'Running final checks.',
};

function buildCompletionMessage(role: AgentRole, status: string, nextRole?: AgentRole): string {
  if (!nextRole) {
    return role === 'verifier' ? 'All checks done. Wrapping up.' : 'Done. Wrapping up.';
  }

  const transitions: Record<AgentRole, string> = {
    planner: 'Got a plan. Starting the code changes.',
    coder: "Code's done — running it through review.",
    reviewer:
      status === 'passed'
        ? 'Review looks good. Running final checks.'
        : 'Review flagged some things. Running final checks.',
    security: 'Security check done. Moving on.',
    performance: 'Performance check done. Moving on.',
    verifier: 'All checks done. Wrapping up.',
  };

  return transitions[role];
}

async function postSlackProgress(params: {
  slack: WebClient;
  ctx: AgentContext;
  text: string;
}): Promise<string | undefined> {
  if (!params.ctx.pipelineConfig.slackProgressUpdates) return undefined;
  const { channelId, threadTs } = params.ctx.task.event;
  try {
    const result = await params.slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: params.text,
    });
    return result.ts ?? undefined;
  } catch {
    // Non-fatal: progress update failure should not abort pipeline
    return undefined;
  }
}

async function updateSlackMessage(params: {
  slack: WebClient;
  ctx: AgentContext;
  ts: string;
  text: string;
}): Promise<void> {
  const { channelId } = params.ctx.task.event;
  try {
    await params.slack.chat.update({
      channel: channelId,
      ts: params.ts,
      text: params.text,
    });
  } catch {
    // Non-fatal
  }
}

function stripRepoPrefix(filePath: string, repoPath: string): string {
  if (filePath.startsWith(repoPath)) {
    const relative = filePath.slice(repoPath.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return filePath;
}

/** How many files the plan message lists before it says "and N more". */
const PLAN_MESSAGE_MAX_FILES = 8;

/**
 * The plan as posted for approval (issue #437).
 *
 * When the planner wrote its approver block, the message is only that block:
 * what changes, where, whether behaviour changes, what was assumed, the risk,
 * and the files to change. The full plan goes below it as a file
 * (`postPlanForApproval`): approvers read 8,000-character plans in a minute
 * or not at all. `requesterId` is passed when the requester has to confirm
 * the behaviour change or the assumptions before work starts, because the
 * approver is usually someone else: a default changed to 0 was approved in 54
 * seconds and meant the opposite of what the requester wanted.
 *
 * The header counts files the change edits. It used to count every
 * path-shaped token in the plan.
 */
export function formatPlanMessage(
  planMarkdown: string,
  affectedFiles: string[],
  scope: string,
  repoPath?: string,
  completed?: boolean,
  requesterId?: string,
): string {
  const displayFiles = repoPath ? affectedFiles.map(f => stripRepoPrefix(f, repoPath)) : affectedFiles;
  const count = displayFiles.length;
  const summary = parseApproverSummary(planMarkdown);
  const headerParts = [`scope: ${scope}`];
  if (count > 0) headerParts.push(`${count} file${count === 1 ? '' : 's'} to change`);
  if (summary?.risk) headerParts.push(`risk: ${summary.risk}`);
  const header = `*Plan* (${headerParts.join(', ')})`;

  const shownFiles = displayFiles.slice(0, PLAN_MESSAGE_MAX_FILES).map(f => `• \`${f}\``);
  if (count > PLAN_MESSAGE_MAX_FILES) shownFiles.push(`• … and ${count - PLAN_MESSAGE_MAX_FILES} more`);
  const filesSection = count > 0 ? `*Files to change:*\n${shownFiles.join('\n')}` : '';
  const completedSuffix = completed ? '\n\n_✅ Plan executed._' : '';

  if (!summary) {
    const body = planMarkdown.trim();
    return `${header}${body ? `\n${body}` : ''}${filesSection ? `\n\n${filesSection}` : ''}${completedSuffix}`;
  }

  const changesBehaviour = !isNone(summary.behaviourChange);
  const assumed = !isNone(summary.assumptions);
  const outside = !isNone(summary.outsideRepo);
  const block = [
    header,
    `*What changes:* ${summary.whatChanges}`,
    ...(summary.where ? [`*Where:* ${summary.where}`] : []),
    // "none" keeps whatever the planner added to it ("none. It is only a comment.").
    `*Behaviour change:* ${changesBehaviour ? ':warning: ' : ''}${summary.behaviourChange.trim() || 'none'}`,
    `*Assumptions to confirm:* ${summary.assumptions.trim() || 'none'}`,
    // A write to another system rides on the same yes as the code, so the approver sees it (issue #432).
    ...(outside ? [`*Outside the repo:* :warning: ${summary.outsideRepo.trim()}`] : []),
  ];
  // A revision says what it changed, right under the header (issue #388).
  const changes = changesSinceLastPlan(planMarkdown);
  if (changes.length > 0) {
    const shown = changes.slice(0, MAX_CHANGES_SHOWN).map(change => `• ${change}`);
    if (changes.length > MAX_CHANGES_SHOWN) shown.push(`• … and ${changes.length - MAX_CHANGES_SHOWN} more`);
    block.splice(1, 0, `*Changed since the last plan:*\n${shown.join('\n')}`);
  }
  if (requesterId && (changesBehaviour || assumed || outside)) {
    const parts = [
      changesBehaviour ? 'the behaviour change' : '',
      assumed ? 'the assumptions' : '',
      outside ? 'the changes outside the repo' : '',
    ].filter(Boolean);
    const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const plural = parts.length > 1 || assumed || outside;
    block.push(
      `<@${requesterId}> before I start, please confirm ${what} above ${plural ? 'are' : 'is'} what you want: reply *yes*, or tell me what to change.`,
    );
  }
  return [block.join('\n'), ...(filesSection ? [filesSection] : [])].join('\n\n').concat(completedSuffix);
}

const CHANGED_HEADING_RE = /^#{1,6}\s*changed since the last plan\b/i;
const MAX_CHANGES_SHOWN = 6;

/** The bullets of a revised plan's "Changed since the last plan" section (issue #388). */
export function changesSinceLastPlan(planMarkdown: string): string[] {
  const lines = planMarkdown.split('\n');
  const start = lines.findIndex(line => CHANGED_HEADING_RE.test(line.trim()));
  if (start === -1) return [];
  const changes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const bullet = /^\s*[-*•]\s+(.*\S)\s*$/.exec(line);
    if (bullet) changes.push(bullet[1]);
  }
  return changes;
}

/** The full plan, posted below the approver block. Empty when the plan has no block: it was posted whole. */
export function formatPlanDetail(planMarkdown: string): string {
  return parseApproverSummary(planMarkdown) ? planWithoutApproverParts(planMarkdown) : '';
}

/** The approved plan names changes outside the repository on its "Outside the repo" line (issue #432). */
export function planListsOutsideChanges(planMarkdown: string): boolean {
  const summary = parseApproverSummary(planMarkdown);
  return Boolean(summary && !isNone(summary.outsideRepo));
}

/** The plan changes behaviour or rests on assumptions, so the requester has to confirm it (issue #437). */
export function planNeedsRequesterConfirmation(planMarkdown: string): boolean {
  const summary = parseApproverSummary(planMarkdown);
  return Boolean(
    summary && (!isNone(summary.behaviourChange) || !isNone(summary.assumptions) || !isNone(summary.outsideRepo)),
  );
}

/**
 * Posts a plan for approval: the approver block as a message, and the full
 * plan below it as a `plan.md` file, which Slack shows collapsed. When the
 * upload fails, the full plan goes in as a message instead. Returns the ts of
 * the block message; throws when that message could not be posted.
 */
export async function postPlanForApproval(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  planMarkdown: string;
  affectedFiles: string[];
  scope: string;
  repoPath?: string;
  /** Set only when the requester has to confirm (`planNeedsRequesterConfirmation`). */
  requesterToConfirm?: string;
  logStep?: WorkflowStepLogger;
}): Promise<string | undefined> {
  const { slack, channelId, threadTs, planMarkdown, logStep } = params;
  const posted = await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: formatPlanMessage(
      planMarkdown,
      params.affectedFiles,
      params.scope,
      params.repoPath,
      false,
      params.requesterToConfirm,
    ),
  });
  const ts = posted.ts ?? undefined;
  const detail = formatPlanDetail(planMarkdown);
  if (!detail) return ts;
  try {
    await slack.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      file_uploads: [{ file: Buffer.from(detail, 'utf8'), filename: 'plan.md', title: 'Full plan (for the coder)' }],
    });
    logStep?.({ stage: 'plan.detail.posted', message: 'Posted the full plan as a file below the summary.' });
  } catch (error) {
    logStep?.({
      stage: 'plan.detail.upload_failed',
      level: 'WARN',
      message: `Could not upload the full plan as a file; posting it as a message. ${String(error).slice(0, 200)}`,
    });
    await slack.chat
      .postMessage({ channel: channelId, thread_ts: threadTs, text: `_Full plan, for the coder:_\n${detail}` })
      .catch(() => {});
  }
  return ts;
}

const APPROVE_PATTERNS = /^(yes|go|proceed|do it|go ahead|ship it|lgtm)$/i;
/** A requester confirming that the plan is what they want (issue #437). */
const CONFIRM_PATTERNS =
  /^(yes|yep|yeah|yup|correct|confirmed?|exactly|right|go|go ahead|proceed|do it|lgtm|looks good|that'?s (right|correct|it|what i want))[.!]*$/i;
/** An approver going ahead without the requester's confirmation: exact phrase, never inferred. */
const OVERRIDE_CONFIRMATION_RE = /^approve without (the requester'?s? )?confirmation[.!]*$/i;
const REJECT_PATTERNS = /^(no|stop|cancel|abort|nevermind|never mind)\b/i;
// Strict pause patterns: pause word must be the entire message (modulo punctuation).
// "wait, that's wrong" / "wait, also include X" → feedback, not pause.
const PAUSE_PATTERNS =
  /^(wait|hold on|hold up|pause|brb|one sec|one moment|stand by|i'?ll get back to you|(give me|gimme) (a )?(sec|second|minute|moment|min)|pause for (now|a bit|a sec)|stop for now)[.! ]*$/i;

/**
 * A reply as the exact-phrase patterns above read it: miniOG's own @-mention
 * and Slack formatting marks dropped. "@miniOG approve without confirmation",
 * or the phrase pasted from miniOG's message with its backticks, is the
 * phrase; matched raw, it fell through to the classifier, whose "approve"
 * only held the plan again. Anyone else's mention stays: "@someone yes" may
 * be addressed to them, and the classifier decides that.
 */
function approvalReplyCommand(text: string, botUserId?: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gi, (mention, userId: string) =>
      botUserId && userId === botUserId ? ' ' : mention,
    )
    .replace(/[‘’]/g, "'")
    .replace(/[`*_~"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolves after `ms`, or as soon as the job is aborted. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
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

export type ApprovalOutcome = 'approved' | 'rejected' | 'feedback' | 'paused' | 'cancelled';
export type ApprovalResult = {
  outcome: ApprovalOutcome;
  userReply: string;
  approverId: string;
  /** Slack ts of the reply that produced this outcome — used by resume to set the next wait-cutoff. */
  replyTs: string;
};

type ApprovalIntent = 'approve' | 'feedback' | 'reject' | 'pause' | 'unrelated';

/**
 * Runs on every non-bot reply during a wait gate. Anyone — requester, approver,
 * any participant — can park miniOG with a "wait"-style message. Cheap regex
 * first; falls through to the wait gate's classifier (which now also recognizes
 * 'pause') when the message is more nuanced.
 */
export function isQuickPauseMessage(text: string): boolean {
  return PAUSE_PATTERNS.test(text.trim());
}

/**
 * Returns null on transient failure (runCodex error / non-JSON output) so the
 * caller can decide whether to retry on the next poll tick. Returning
 * 'unrelated' on failure used to combine with the per-call ts cache to
 * permanently swallow a message after one flaky classification — pre-existing
 * behavior pre-cache; broken once we added caching for cost. The fix: caller
 * caches only when this function succeeds.
 */
async function classifyApprovalIntent(
  message: string,
  recentThread: string[],
  logStep: WorkflowStepLogger,
): Promise<ApprovalIntent | null> {
  const prompt = `You are a classifier for a developer bot called miniOG. miniOG just posted a plan in a Slack thread and asked for admin approval ("yes"/"go" to proceed, "no"/"stop" to cancel, or reply with feedback).

A new message appeared in the thread. Classify the message into one of five categories:

"approve" — The message is approving the plan and telling miniOG to proceed. Examples: "looks good, go ahead", "yes do it", "approved, start coding", "go ahead but also handle X" (approval WITH extra notes).

"feedback" — The message is directed at miniOG with instructions, changes, or additional context for the plan, but does NOT explicitly approve it. Examples: "also make sure X", "change the approach to Y", "use the existing middleware instead", "don't forget to handle edge case Z". The user wants the plan revised, not executed as-is.

"reject" — The message is telling miniOG to stop or cancel. Examples: "no", "stop", "don't do this", "cancel it".

"pause" — The message tells miniOG to wait / hold / pause without rejecting. The user explicitly wants miniOG to STOP working for now and resume later when tagged. Examples: "wait", "hold on", "pause", "gimme a minute", "I'll get back to you", "wait for me", "stop for now, I need to check something". CRITICAL: a "wait" used as filler before a real instruction (e.g. "wait, that's wrong" or "wait, also include X") is FEEDBACK, not pause — the user is still actively giving direction.

"unrelated" — The message is NOT directed at miniOG. It's a human-to-human conversation. Examples: messages addressing another user by @mention, asking another human for URLs/details, continuing a debugging discussion.

Key distinction between "approve" and "feedback": if the message gives instructions WITHOUT saying to proceed (no "go", "yes", "do it", "start", "approved", "ship it", "looks good"), classify as "feedback". The user wants changes before approving.

Recent thread messages (for context):
${recentThread.map((m, i) => `[${i + 1}] ${m}`).join('\n')}

New message to classify:
"${message}"

Return strict JSON:
{
  "intent": "approve" | "feedback" | "reject" | "pause" | "unrelated",
  "reasoning": "one sentence explaining why"
}`;

  try {
    const profile = lightweightProfile(getActiveBackendId());
    const result = await runCodex({
      cwd: os.tmpdir(),
      noTools: true,
      prompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 30_000,
    });

    if (!result.ok || !result.parsedJson) {
      logStep({
        stage: 'pipeline.approval.classify.fallback',
        message: 'Approval-intent classifier failed — will retry on next poll.',
        level: 'WARN',
      });
      return null;
    }

    const raw = result.parsedJson as { intent?: string; reasoning?: string };
    const validIntents: ApprovalIntent[] = ['approve', 'feedback', 'reject', 'pause', 'unrelated'];
    const intent: ApprovalIntent = validIntents.includes(raw.intent as ApprovalIntent)
      ? (raw.intent as ApprovalIntent)
      : 'unrelated';

    logStep({
      stage: 'pipeline.approval.classify.done',
      message: `Classified thread reply as "${intent}": ${raw.reasoning ?? ''}`,
      data: { intent, reasoning: raw.reasoning },
    });

    return intent;
  } catch (error) {
    logStep({
      stage: 'pipeline.approval.classify.error',
      message: `Approval-intent classifier threw: ${String(error)} — will retry on next poll.`,
      level: 'WARN',
    });
    return null;
  }
}

/** Waits for a plan to be approved. The job's slot is free while it waits (issue #434). */
export function waitForApproval(params: Parameters<typeof pollForApproval>[0]): Promise<ApprovalResult> {
  return jobSlots.whileWaitingOnHuman(() => pollForApproval(params), {
    signal: params.signal,
    logStep: params.logStep,
  });
}

async function pollForApproval(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  approverUserIds: string[];
  triggerUserId: string;
  approvalPromptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
  /** The job's abort signal. Without it a cancelled job kept waiting here forever (issue #264). */
  signal?: AbortSignal;
  /**
   * Re-ping while the plan waits (issue #436): `text` is posted once when each
   * delay in `afterMs` has passed. The wait has no other way to be noticed.
   */
  reminders?: { afterMs: number[]; text: string };
  /** Who can approve, as a Slack mention. Used once when someone who cannot approve says yes. */
  approverMention?: string;
  /**
   * The requester, when the plan changes behaviour or rests on assumptions
   * and they are not an approver (issue #437). An approver's yes then waits
   * for the requester's, and the requester may reply with what they want
   * instead, which revises the plan. An approver can skip them with exactly
   * "approve without confirmation".
   */
  requesterToConfirm?: string;
}): Promise<ApprovalResult> {
  const { slack, channelId, threadTs, approverUserIds, approvalPromptTs, logStep, botUserId, signal } = params;
  const { reminders, approverMention } = params;
  const requester =
    params.requesterToConfirm && !approverUserIds.includes(params.requesterToConfirm)
      ? params.requesterToConfirm
      : undefined;
  let requesterConfirmed = !requester;
  /** The first approval, held until the requester confirms. */
  let heldApproval: ApprovalResult | undefined;
  const postedOnce = new Set<'held' | 'confirmed' | 'askWhat'>();
  const postOnce = (key: 'held' | 'confirmed' | 'askWhat', text: string): void => {
    if (postedOnce.has(key)) return;
    postedOnce.add(key);
    slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).catch(() => {});
  };
  /**
   * An approver said yes: done, unless the requester still has to confirm.
   * Logged once, when it counts: a plain "yes" is read again on every poll,
   * and a held one was logged as approved every 5 seconds.
   */
  const approve = (result: ApprovalResult): ApprovalResult | undefined => {
    if (requesterConfirmed) {
      logStep({
        stage: 'pipeline.approval.approved',
        message: `Core-dev member <@${result.approverId}> approved the plan: "${result.userReply}"`,
      });
      return result;
    }
    heldApproval ??= result;
    if (!postedOnce.has('held')) {
      logStep({
        stage: 'pipeline.approval.awaiting_requester',
        message: `<@${result.approverId}> approved; waiting for <@${requester}> to confirm the plan is what they want.`,
      });
    }
    postOnce(
      'held',
      `Thanks <@${result.approverId}>. <@${requester}>, before I start: is the plan above what you want? Reply *yes*, or tell me what to change. (An admin can reply \`approve without confirmation\` to go ahead without that.)`,
    );
    return undefined;
  };
  const waitStartedAt = Date.now();
  const reminderDelays = [...(reminders?.afterMs ?? [])].sort((a, b) => a - b);
  let remindersSent = 0;
  let approversTagged = false;
  const cancelled = (): ApprovalResult => {
    logStep({ stage: 'pipeline.approval.cancelled', message: 'Job cancelled while waiting for approval.' });
    return { outcome: 'cancelled', userReply: '', approverId: '', replyTs: '' };
  };
  // Callers post the prompt before calling, and posting clears Slack's thread
  // status — this is what puts "is waiting for admin approval" back up.
  logStep({
    stage: 'pipeline.approval.waiting',
    message: 'Waiting for an admin to approve.',
  });
  const pollIntervalMs = 5_000;
  const notifiedUsers = new Set<string>();
  // Per-call cache: messages we've already classified (and got non-actionable
  // intent for) — avoids re-classifying the same ts every 5s poll cycle.
  const classifiedTs = new Set<string>();

  while (true) {
    if (signal?.aborted) return cancelled();
    await abortableDelay(pollIntervalMs, signal);
    if (signal?.aborted) return cancelled();

    // One reminder per threshold. If several have passed at once (the host
    // slept), they collapse into a single message.
    let due = remindersSent;
    while (due < reminderDelays.length && Date.now() - waitStartedAt >= reminderDelays[due]) due += 1;
    if (reminders && due > remindersSent) {
      remindersSent = due;
      // Once approved, only the requester is holding the plan up: remind them, not the approvers.
      const waitingOnRequester = Boolean(heldApproval) && !requesterConfirmed;
      logStep({
        stage: 'pipeline.approval.reminder',
        message: `Reminded ${waitingOnRequester ? 'the requester' : 'approvers'} (${remindersSent} of ${reminderDelays.length}).`,
        data: { waitedMs: Date.now() - waitStartedAt },
      });
      const text = waitingOnRequester
        ? `<@${requester}> the plan above is approved and waits only for you: reply *yes* if it is what you want, or tell me what to change.`
        : reminders.text;
      slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).catch(() => {});
    }

    let messages: Array<{ text: string; user: string; ts: string }>;
    try {
      messages = await fetchThreadContext(slack, channelId, threadTs);
    } catch {
      // Transient Slack error — retry on next tick
      continue;
    }

    // Find messages newer than the approval prompt, excluding the bot itself
    const candidateReplies = messages.filter(m => m.ts > approvalPromptTs && m.user !== botUserId);

    for (const reply of candidateReplies) {
      const text = reply.text.trim();
      /** What the exact-phrase patterns read; the classifier and the result keep `text`. */
      const command = approvalReplyCommand(text, botUserId);
      const isApprover = approverUserIds.includes(reply.user);

      // Pause detection runs on EVERY non-bot reply (not admin-gated). Anyone in
      // the thread can park miniOG with a "wait" message; the workflow returns
      // PAUSED, releases its slot, and resumes on the next @miniOG mention.
      if (isQuickPauseMessage(command)) {
        logStep({
          stage: 'pipeline.approval.paused',
          message: `<@${reply.user}> asked miniOG to wait: "${text}"`,
        });
        return { outcome: 'paused', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

      // The requester confirming, or saying what they want instead (issue #437).
      if (requester && reply.user === requester) {
        if (requesterConfirmed) continue;
        let intent: ApprovalIntent | null = CONFIRM_PATTERNS.test(command) ? 'approve' : null;
        if (!intent) {
          if (classifiedTs.has(reply.ts)) continue;
          intent = await classifyApprovalIntent(
            text,
            messages.slice(-6).map(m => m.text.trim()),
            logStep,
          );
          if (intent === null) continue;
          classifiedTs.add(reply.ts);
        }
        if (intent === 'approve') {
          requesterConfirmed = true;
          logStep({
            stage: 'pipeline.approval.requester_confirmed',
            message: `<@${reply.user}> confirmed the plan is what they want: "${text}"`,
          });
          if (heldApproval) {
            logStep({
              stage: 'pipeline.approval.approved',
              message: `Core-dev member <@${heldApproval.approverId}> approved the plan, and the requester confirmed it.`,
            });
            return { ...heldApproval, replyTs: reply.ts > heldApproval.replyTs ? reply.ts : heldApproval.replyTs };
          }
          postOnce('confirmed', `Thanks <@${reply.user}>. Waiting for an admin to approve.`);
          continue;
        }
        if (intent === 'feedback') {
          logStep({
            stage: 'pipeline.approval.feedback',
            message: `The requester <@${reply.user}> asked for a change: "${text}"`,
          });
          return { outcome: 'feedback', userReply: text, approverId: reply.user, replyTs: reply.ts };
        }
        if (intent === 'pause') {
          return { outcome: 'paused', userReply: text, approverId: reply.user, replyTs: reply.ts };
        }
        if (intent === 'reject') {
          postOnce('askWhat', `<@${reply.user}> tell me what you want instead, and I'll revise the plan.`);
        }
        continue;
      }

      const isOverride = OVERRIDE_CONFIRMATION_RE.test(command);
      if (isApprover && isOverride) {
        logStep({
          stage: 'pipeline.approval.approved',
          message: `Core-dev member <@${reply.user}> approved the plan without the requester's confirmation: "${text}"`,
        });
        return { outcome: 'approved', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

      // The override from someone who cannot approve is an approval attempt like any other.
      if (isOverride || APPROVE_PATTERNS.test(command)) {
        if (!isApprover) {
          if (!notifiedUsers.has(reply.user)) {
            notifiedUsers.add(reply.user);
            logStep({
              stage: 'pipeline.approval.unauthorized',
              message: `Non-admin user <@${reply.user}> attempted to approve.`,
              level: 'WARN',
            });
            const tagApprovers = Boolean(approverMention) && !approversTagged;
            slack.chat
              .postMessage({
                channel: channelId,
                thread_ts: threadTs,
                // Say who can, and tag them once: "waiting for an admin" told
                // the requester nothing and reached no admin (issue #436).
                text: tagApprovers
                  ? `<@${reply.user}> only admins can approve plans. ${approverMention}, this one is waiting for you.`
                  : `<@${reply.user}> Only admins can approve plans. Waiting for an admin to respond.`,
              })
              .catch(() => {});
            if (tagApprovers) approversTagged = true;
          }
          continue;
        }
        const approved = approve({ outcome: 'approved', userReply: text, approverId: reply.user, replyTs: reply.ts });
        if (approved) return approved;
        continue;
      }

      // Raw text, not `command`: this pattern only anchors the start, and a rejection ends the job.
      // "@miniOG no, use the v2 endpoint" is a change to the plan, so the classifier reads it.
      if (REJECT_PATTERNS.test(text)) {
        if (!isApprover) {
          if (!notifiedUsers.has(reply.user)) {
            notifiedUsers.add(reply.user);
            slack.chat
              .postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `<@${reply.user}> Only admins can approve or reject plans.`,
              })
              .catch(() => {});
          }
          continue;
        }
        logStep({
          stage: 'pipeline.approval.rejected',
          message: `Core-dev member <@${reply.user}> rejected the plan: "${text}"`,
        });
        return { outcome: 'rejected', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

      // Non-pattern text from an approver — classify intent (approve/feedback/reject/pause/unrelated)
      if (isApprover) {
        if (classifiedTs.has(reply.ts)) continue;
        const recentThread = messages.slice(-6).map(m => m.text.trim());
        const intent = await classifyApprovalIntent(text, recentThread, logStep);
        if (intent === null) {
          // Transient classifier failure — retry on the next 5s poll tick.
          // Do NOT cache the ts here, otherwise one flaky call permanently
          // ignores this reply.
          continue;
        }
        classifiedTs.add(reply.ts);
        if (intent === 'approve') {
          const approved = approve({ outcome: 'approved', userReply: text, approverId: reply.user, replyTs: reply.ts });
          if (approved) return approved;
          continue;
        }
        if (intent === 'feedback') {
          logStep({
            stage: 'pipeline.approval.feedback',
            message: `Core-dev member <@${reply.user}> provided feedback: "${text}"`,
          });
          return { outcome: 'feedback', userReply: text, approverId: reply.user, replyTs: reply.ts };
        }
        if (intent === 'reject') {
          logStep({
            stage: 'pipeline.approval.rejected',
            message: `Core-dev member <@${reply.user}> rejected the plan: "${text}"`,
          });
          return { outcome: 'rejected', userReply: text, approverId: reply.user, replyTs: reply.ts };
        }
        if (intent === 'pause') {
          logStep({
            stage: 'pipeline.approval.paused',
            message: `Core-dev member <@${reply.user}> asked miniOG to wait: "${text}"`,
          });
          return { outcome: 'paused', userReply: text, approverId: reply.user, replyTs: reply.ts };
        }
        logStep({
          stage: 'pipeline.approval.ignored',
          message: `Ignored admin message not directed at bot: "${text}"`,
          data: { user: reply.user },
        });
        continue;
      }
      // Non-pattern text from non-approver — classifier still gets a shot at
      // pause detection so a requester (or anyone in the thread) can park miniOG
      // with a nuanced wait message that the cheap regex missed. Cached per-ts
      // only on a successful classify, so transient failures can retry next poll.
      if (classifiedTs.has(reply.ts)) continue;
      const recentThread = messages.slice(-6).map(m => m.text.trim());
      const intent = await classifyApprovalIntent(text, recentThread, logStep);
      if (intent === null) continue;
      classifiedTs.add(reply.ts);
      if (intent === 'pause') {
        logStep({
          stage: 'pipeline.approval.paused',
          message: `<@${reply.user}> asked miniOG to wait: "${text}"`,
        });
        return { outcome: 'paused', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }
      // Anything else from a non-approver: silently ignore — admins still drive
      // approve/feedback/reject.
    }
  }
}

/* -------------------------------------------------------------------------
 * Repo-choice clarification gate
 *
 * Used when miniOG can't deterministically identify the target repo for an
 * IMPLEMENTATION task. Instead of silently defaulting to newton-web (the
 * historical behavior that caused PRs to land in the wrong repo), we ask
 * admins in-thread "which repo?" and wait for an answer.
 * ---------------------------------------------------------------------- */

export type RepoChoiceOutcome = RepoKey | 'cancelled' | 'timeout' | 'paused';
export type RepoChoiceResult = {
  outcome: RepoChoiceOutcome;
  userReply: string;
  approverId: string;
  /** Slack ts of the reply that resolved the gate; '' for cancelled/timeout (no reply). */
  replyTs: string;
};

type RepoIntent = 'web' | 'api' | 'marketing' | 'both' | 'cancel' | 'unclear';

const REPO_FOR_INTENT: Record<'web' | 'api' | 'marketing', RepoKey> = {
  web: 'newton-web',
  api: 'newton-api',
  marketing: 'newton-marketing-web',
};

// MARKETING_SHORTHAND is tested before WEB_SHORTHAND: the anchors already keep
// "marketing web" out of WEB_SHORTHAND today, but the ordering makes that safe
// against any future de-anchoring of these regexes. Bare "landing (page)" is
// deliberately NOT shorthand — newton-web has landing screens too, so that
// reply goes to the LLM, which weighs the thread context.
const MARKETING_SHORTHAND = /^(marketing|mweb|nmw|mkt|marketing[- ]?(web|site)|newton[- ]?marketing([- ]?web)?)$/i;
const WEB_SHORTHAND = /^(web|newton-?web|frontend|fe|ui)$/i;
const API_SHORTHAND = /^(api|newton-?api|backend|be|server)$/i;
const BOTH_SHORTHAND =
  /^(both|all|both repos?|(?:web|api|marketing)\s*(?:and|&|\+)\s*(?:web|api|marketing)|dono|donon)$/i;
const CANCEL_SHORTHAND = /^(cancel|stop|abort|nevermind|never mind|skip)\b/i;

async function classifyRepoChoice(
  message: string,
  recentThread: string[],
  logStep: WorkflowStepLogger,
  allowedRepos: readonly RepoKey[] = REPO_KEYS,
): Promise<RepoIntent> {
  const trimmed = message.trim();
  const marketingAllowed = allowedRepos.includes('newton-marketing-web');

  // Cheap regex short-circuits before calling the model. The marketing
  // shorthand runs even when marketing is disabled — the caller's
  // allowedRepos gate then posts the "not configured on this host" notice,
  // which beats silently classifying "marketing" as unclear.
  if (MARKETING_SHORTHAND.test(trimmed)) return 'marketing';
  if (WEB_SHORTHAND.test(trimmed)) return 'web';
  if (API_SHORTHAND.test(trimmed)) return 'api';
  if (BOTH_SHORTHAND.test(trimmed)) return 'both';
  if (CANCEL_SHORTHAND.test(trimmed)) return 'cancel';

  // On a two-repo host the LLM prompt is BYTE-IDENTICAL to the pre-marketing
  // copy (invariant: an unconfigured marketing repo changes nothing).
  const prompt = marketingAllowed
    ? `You are a classifier for miniOG, a developer bot. miniOG asked an admin which repo to work in for an ambiguous task. The choices are:
- "newton-web" — the PRODUCT frontend (React/JavaScript, the logged-in app at my.newtonschool.co: pages, components, UI)
- "newton-api" — the backend repo (Python/Django, endpoints, models, serializers)
- "newton-marketing-web" — the PUBLIC MARKETING site (newtonschool.co landing pages, Webflow migration, Tailwind, Cloudflare)

Classify the admin's reply into one of six categories:

"web" — the reply identifies newton-web. Examples: "web", "newton-web", "frontend", "the react one", "UI", "it's a frontend change", "the product app".

"api" — the reply identifies newton-api. Examples: "api", "newton-api", "backend", "the django one", "it's in python".

"marketing" — the reply identifies newton-marketing-web. Examples: "marketing", "mweb", "nmw", "the marketing site", "the webflow one", "the tailwind one", "the public site".
IMPORTANT: "marketing web" and "marketing site" mean newton-marketing-web, NOT newton-web. But a bare "landing page" / "homepage" / "NSAT page" reply is AMBIGUOUS — both frontends have such pages (marketing owns the public admission landing pages; newton-web owns the logged-in NSAT timeline) — weigh the thread context, and return "unclear" if it doesn't settle it.

"both" — the reply says the task spans MULTIPLE repos. Examples: "both", "both repos", "web and api", "api and web", "web and marketing", "dono", "it's a cross-repo change", "frontend + backend".

"cancel" — the reply tells miniOG to stop / skip / abort. Examples: "cancel", "nevermind", "don't bother", "stop".

"unclear" — the reply doesn't pick a repo and isn't a cancel or "both". Examples: "not sure", a question, unrelated chat, or anything that doesn't map to a category above.

Recent thread messages (for context):
${recentThread.map((m, i) => `[${i + 1}] ${m}`).join('\n')}

New message to classify:
"${message}"

Return strict JSON:
{
  "intent": "web" | "api" | "marketing" | "both" | "cancel" | "unclear",
  "reasoning": "one sentence explaining why"
}`
    : `You are a classifier for miniOG, a developer bot. miniOG asked an admin which repo to work in for an ambiguous task. The choices are:
- "newton-web" — the frontend repo (React/JavaScript, pages, components, UI)
- "newton-api" — the backend repo (Python/Django, endpoints, models, serializers)

Classify the admin's reply into one of five categories:

"web" — the reply identifies newton-web. Examples: "web", "newton-web", "frontend", "the react one", "UI", "it's a frontend change".

"api" — the reply identifies newton-api. Examples: "api", "newton-api", "backend", "the django one", "it's in python".

"both" — the reply says the task spans BOTH repos. Examples: "both", "both repos", "web and api", "api and web", "dono", "it's a cross-repo change", "frontend + backend".

"cancel" — the reply tells miniOG to stop / skip / abort. Examples: "cancel", "nevermind", "don't bother", "stop".

"unclear" — the reply doesn't pick a repo and isn't a cancel or "both". Examples: "not sure", a question, unrelated chat, or anything that doesn't map to web/api/both/cancel.

Recent thread messages (for context):
${recentThread.map((m, i) => `[${i + 1}] ${m}`).join('\n')}

New message to classify:
"${message}"

Return strict JSON:
{
  "intent": "web" | "api" | "both" | "cancel" | "unclear",
  "reasoning": "one sentence explaining why"
}`;

  try {
    const profile = lightweightProfile(getActiveBackendId());
    const result = await runCodex({
      cwd: os.tmpdir(),
      noTools: true,
      prompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 30_000,
    });

    if (!result.ok || !result.parsedJson) {
      logStep({
        stage: 'pipeline.repo_choice.classify.fallback',
        message: 'Repo-choice classifier failed — defaulting to unclear.',
        level: 'WARN',
      });
      return 'unclear';
    }

    const raw = result.parsedJson as { intent?: string; reasoning?: string };
    const valid: RepoIntent[] = ['web', 'api', 'marketing', 'both', 'cancel', 'unclear'];
    const intent: RepoIntent = valid.includes(raw.intent as RepoIntent) ? (raw.intent as RepoIntent) : 'unclear';

    logStep({
      stage: 'pipeline.repo_choice.classify.done',
      message: `Classified repo-choice reply as "${intent}": ${raw.reasoning ?? ''}`,
      data: { intent, reasoning: raw.reasoning },
    });
    return intent;
  } catch (error) {
    logStep({
      stage: 'pipeline.repo_choice.classify.error',
      message: `Repo-choice classifier threw: ${String(error)} — defaulting to unclear.`,
      level: 'WARN',
    });
    return 'unclear';
  }
}

/**
 * Wait indefinitely for an admin to tell miniOG which repo to use. Mirrors
 * `waitForApproval`: 5-second polling loop, ignores non-admin replies, nudges
 * non-admins who try to answer. Returns the resolved repo or 'cancelled'.
 */
/** Waits for someone to say which repo. The job's slot is free while it waits (issue #434). */
export function waitForRepoChoice(params: Parameters<typeof pollForRepoChoice>[0]): Promise<RepoChoiceResult> {
  return jobSlots.whileWaitingOnHuman(() => pollForRepoChoice(params), {
    signal: params.signal,
    logStep: params.logStep,
  });
}

async function pollForRepoChoice(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  approverUserIds: string[];
  promptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
  idleTimeoutMs?: number;
  nudgeAfterMs?: number;
  nudgeText?: string;
  signal?: AbortSignal;
  /**
   * Repos this host may resolve to (from enabledRepoKeys). A reply that picks
   * a repo outside this list gets a one-time "not configured here" note and
   * the gate keeps waiting. Defaults to all known repos so existing callers
   * and tests keep working.
   */
  allowedRepos?: readonly RepoKey[];
}): Promise<RepoChoiceResult> {
  const {
    slack,
    channelId,
    threadTs,
    approverUserIds,
    promptTs,
    logStep,
    botUserId,
    idleTimeoutMs = 6 * 60 * 60 * 1000,
    nudgeAfterMs = 30 * 60 * 1000,
    nudgeText,
    signal,
    allowedRepos = REPO_KEYS,
  } = params;
  // Posted prompt first, so this is what restores the status after Slack's
  // post-message clear.
  logStep({
    stage: 'pipeline.repo_choice.waiting',
    message: 'Waiting to hear which repo this is for.',
  });
  const pollIntervalMs = 5_000;
  const notifiedUsers = new Set<string>();
  const startedAt = Date.now();
  let nudged = false;
  // Posted once if an admin answers "both": the implementation pipeline runs one
  // repo per run, so we acknowledge the cross-repo nature and ask them to pick a
  // starting repo instead of silently re-polling the same reply forever (#394).
  let bothGuidanceSent = false;
  // Posted once if an admin picks a repo that isn't configured on this host.
  let disallowedNoticeSent = false;

  while (true) {
    if (signal?.aborted) {
      return { outcome: 'cancelled', userReply: '', approverId: '', replyTs: '' };
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= idleTimeoutMs) {
      logStep({
        stage: 'pipeline.repo_choice.timeout',
        message: `No admin reply within ${Math.round(idleTimeoutMs / 60_000)} min — routing to desktop.`,
        level: 'WARN',
      });
      return { outcome: 'timeout', userReply: '', approverId: '', replyTs: '' };
    }
    if (!nudged && elapsed >= nudgeAfterMs && nudgeText) {
      try {
        await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: nudgeText });
      } catch {
        // best-effort
      }
      nudged = true;
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    let messages: Array<{ text: string; user: string; ts: string }>;
    try {
      messages = await fetchThreadContext(slack, channelId, threadTs);
    } catch {
      continue;
    }

    const candidateReplies = messages.filter(m => m.ts > promptTs && m.user !== botUserId);

    for (const reply of candidateReplies) {
      const text = reply.text.trim();
      const isApprover = approverUserIds.includes(reply.user);

      // Anyone can park miniOG with a "wait" — including non-admins.
      if (isQuickPauseMessage(text)) {
        logStep({
          stage: 'pipeline.repo_choice.paused',
          message: `<@${reply.user}> asked miniOG to wait: "${text}"`,
        });
        return { outcome: 'paused', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

      if (!isApprover) {
        // Nudge non-admins once so they know why they were ignored.
        if (!notifiedUsers.has(reply.user)) {
          notifiedUsers.add(reply.user);
          slack.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `<@${reply.user}> Only admins can pick the target repo. Waiting for an admin to respond.`,
            })
            .catch(() => {});
        }
        continue;
      }

      const recentThread = messages.slice(-6).map(m => m.text.trim());
      const intent = await classifyRepoChoice(text, recentThread, logStep, allowedRepos);

      if (intent === 'web' || intent === 'api' || intent === 'marketing') {
        const repo = REPO_FOR_INTENT[intent];
        if (!allowedRepos.includes(repo)) {
          if (!disallowedNoticeSent) {
            disallowedNoticeSent = true;
            slack.chat
              .postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `<@${reply.user}> *${repo}* isn't configured on this host, so I can't work in it. Pick one of the configured repos or say *cancel*.`,
              })
              .catch(() => {});
          }
          logStep({
            stage: 'pipeline.repo_choice.disallowed',
            message: `Admin <@${reply.user}> picked ${repo}, which is not configured on this host — still waiting: "${text}"`,
            level: 'WARN',
            data: { repo, allowedRepos: [...allowedRepos] },
          });
          continue;
        }
        logStep({
          stage: 'pipeline.repo_choice.resolved',
          message: `Admin <@${reply.user}> chose ${repo}: "${text}"`,
        });
        return { outcome: repo, userReply: text, approverId: reply.user, replyTs: reply.ts };
      }
      if (intent === 'cancel') {
        logStep({
          stage: 'pipeline.repo_choice.cancelled',
          message: `Admin <@${reply.user}> cancelled the task: "${text}"`,
        });
        return { outcome: 'cancelled', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

      if (intent === 'both') {
        // The task spans both repos, but the implementation pipeline works one
        // repo at a time. Acknowledge once and ask for a starting repo, then keep
        // waiting for a definitive web/api/cancel. Without this, "both" classifies
        // as 'unclear' and the loop silently re-polls until cancel/timeout (#394).
        if (!bothGuidanceSent) {
          bothGuidanceSent = true;
          slack.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `<@${reply.user}> This looks like it touches *multiple* repos. I implement one repo per run — reply ${allowedRepos.includes('newton-marketing-web') ? '*web*, *api*, or *marketing*' : '*web* or *api*'} to pick which I should start with, and tag me again for the others once that PR is up.`,
            })
            .catch(() => {});
          logStep({
            stage: 'pipeline.repo_choice.both',
            message: `Admin <@${reply.user}> said the task spans both repos; asked them to pick one to start with: "${text}"`,
            data: { user: reply.user },
          });
        }
        continue;
      }

      // intent === 'unclear' → keep waiting, don't echo into thread noise.
      logStep({
        stage: 'pipeline.repo_choice.unclear',
        message: `Admin reply did not clearly pick a repo, continuing to wait: "${text}"`,
        data: { user: reply.user },
      });
    }
  }
}

/* -------------------------------------------------------------------------
 * Planner-clarification gate
 *
 * When the planner sets `clarificationNeeded`, ask the question in-thread and
 * accept a free-text answer from the requester OR any admin.
 * ---------------------------------------------------------------------- */

export type ClarificationResult = { answer: string; answererId: string };

/** Waits for an answer to the planner's question. The job's slot is free while it waits (issue #434). */
export function waitForClarification(params: Parameters<typeof pollForClarification>[0]): Promise<ClarificationResult> {
  return jobSlots.whileWaitingOnHuman(() => pollForClarification(params), { logStep: params.logStep });
}

async function pollForClarification(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  allowedUserIds: string[];
  promptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
}): Promise<ClarificationResult> {
  const { slack, channelId, threadTs, allowedUserIds, promptTs, logStep, botUserId } = params;
  // Posted prompt first, so this is what restores the status after Slack's
  // post-message clear.
  logStep({
    stage: 'pipeline.clarification.waiting',
    message: "Waiting for an answer to the planner's clarification.",
  });
  const pollIntervalMs = 5_000;

  while (true) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    let messages: Array<{ text: string; user: string; ts: string }>;
    try {
      messages = await fetchThreadContext(slack, channelId, threadTs);
    } catch {
      continue;
    }

    const candidates = messages.filter(m => m.ts > promptTs && m.user !== botUserId);
    for (const reply of candidates) {
      if (!allowedUserIds.includes(reply.user)) {
        continue;
      }
      const answer = reply.text.trim();
      if (!answer) continue;

      logStep({
        stage: 'pipeline.clarification.answered',
        message: `<@${reply.user}> answered the planner's clarification: "${answer}"`,
      });
      return { answer, answererId: reply.user };
    }
  }
}

function buildPipelineIntroMessage(agents: AgentRole[], customIntro?: string): string {
  if (customIntro) return customIntro;

  const hasPlanner = agents.includes('planner');
  const hasCoder = agents.includes('coder');

  if (hasPlanner) {
    return "On it \u2014 planning the approach first, then I'll code it up, get it reviewed, and verify everything works.";
  }
  if (hasCoder) {
    return 'Starting implementation.';
  }
  return `Running ${agents.join(', ')}.`;
}

export function buildApprovalMessage(feedbackRounds: number): string {
  const prefix = feedbackRounds > 0 ? `After ${feedbackRounds} revision${feedbackRounds > 1 ? 's' : ''}, plan` : 'Plan';
  return `${prefix} approved \u2014 I'll code it up, then review and verify.`;
}
/** A change the coder reports making outside the repository (issue #432). */
export interface ExternalChange {
  system: string;
  target: string;
  description: string;
  verification: string;
}

/** The coder's `externalChanges`, keeping only entries that say what changed. */
export function parseExternalChanges(output: Record<string, unknown>): ExternalChange[] {
  if (!Array.isArray(output.externalChanges)) return [];
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  return output.externalChanges
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map(entry => ({
      system: text(entry.system),
      target: text(entry.target),
      description: text(entry.description),
      verification: text(entry.verification),
    }))
    .filter(change => change.description || change.target);
}

/** The thread's list of what changed outside the repository, and whether the approved plan said so. */
export function formatExternalChanges(changes: ExternalChange[], notInPlan: boolean): string {
  const lines = changes.map(change => {
    const where = [change.system, change.target].filter(Boolean).join(', ');
    const checked = change.verification ? ` Checked: ${change.verification}` : ' Not checked.';
    return `• ${where ? `*${where}:* ` : ''}${change.description || 'changed'}${checked}`;
  });
  return [
    '*Changed outside the repo:*',
    ...lines,
    ...(notInPlan ? [':warning: The approved plan did not list changes outside the repo.'] : []),
  ].join('\n');
}

/** What the pipeline result says about changes outside the repository. Nothing when there were none. */
function externalChangesResult(
  coderStep: AgentStepResult | undefined,
  externalOnly: boolean,
  planMarkdown: string,
): Pick<PipelineResult, 'externalChanges' | 'externalOnly' | 'externalNotInPlan'> {
  const changes = coderStep ? parseExternalChanges(coderStep.output) : [];
  if (changes.length === 0) return {};
  return { externalChanges: changes, externalOnly, externalNotInPlan: !planListsOutsideChanges(planMarkdown) };
}

/** True when the coder's JSON explicitly declares it could not act (#413). */
export function coderDeclaredBlocked(output: Record<string, unknown>): boolean {
  return typeof output.status === 'string' && output.status.trim().toLowerCase() === 'blocked';
}

/** The coder's own words for what it needs, falling back to its summary. */
function coderBlockedReason(output: Record<string, unknown>): string {
  const candidates = [output.blockedReason, output.summary];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return '';
}

/** Turns a coder's blocked reason into something worth reading in Slack. */
export function buildCoderBlockedQuestion(reason: string): string {
  return [reason, 'Reply in this thread with that and I\'ll pick it straight back up — or say "cancel" to stop.'].join(
    '\n\n',
  );
}

export function buildCoderFollowUpQuestion(
  ctx: AgentContext,
  planMarkdown: string,
  planAffectedFiles: string[],
): string {
  const trimmed = planMarkdown.trim();
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200).trim()}…` : trimmed;
  const filePreview = planAffectedFiles.slice(0, 3).join(', ');

  // Says what is known and no more. This used to add "so I haven't touched
  // any files", which nothing here had checked (issue #432).
  const lines = ["I couldn't pin down a concrete change from the info I have."];
  if (preview) {
    lines.push(`The plan opened with: _${preview}_`);
  }
  if (filePreview) {
    lines.push(`Suspected files: \`${filePreview}\`${planAffectedFiles.length > 3 ? ' …' : ''}`);
  }
  lines.push(
    'To move forward I need a bit more to go on. Any of these helps:',
    '• the specific change you want and where it should land,',
    '• a file, function, or component to start from,',
    '• or, if this is a bug, the exact error text or the failing request (URL + payload + response).',
    'Reply in this thread with any of the above and I\'ll pick it up from there — or say "cancel" to stop.',
  );
  void ctx;
  return lines.join('\n');
}

/** How much of the coder's own account is quoted back. A before/after report fits; a transcript does not. */
const CODER_REPORT_QUOTE_CHARS = 900;

/**
 * Asked when the coder says it finished and the repository shows no change.
 *
 * A clean worktree is not proof that nothing happened: the work may have been
 * outside the repo. A coder that had just updated seven Metabase cards in
 * production, and written a before/after report, was answered with "I haven't
 * touched any files"; its report was thrown away and the requester never
 * learned the dashboard had changed (issue #432).
 *
 * So this states only what was checked (the repository), quotes what the
 * coder said it did, and tells the requester to look before asking again.
 */
export function buildCoderNoDiffQuestion(
  planMarkdown: string,
  planAffectedFiles: string[],
  coderSummary: string,
): string {
  const report = coderSummary.trim();
  const quoted = (
    report.length > CODER_REPORT_QUOTE_CHARS ? `${report.slice(0, CODER_REPORT_QUOTE_CHARS).trim()}…` : report
  )
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
  const plan = planMarkdown.trim();
  const planPreview = plan.length > 200 ? `${plan.slice(0, 200).trim()}…` : plan;
  const filePreview = planAffectedFiles.slice(0, 3).join(', ');

  const lines = ['The coder finished, but nothing changed in the repository: no commit and no edited file.'];
  if (report) {
    lines.push(
      'This is what it says it did:',
      quoted,
      'If that describes work outside the repository (a dashboard, a setting, a record), it may already be in place. Check it before you ask me to do it again.',
    );
  } else {
    lines.push(
      'It gave no account of what it did, so I cannot tell you whether anything outside the repository changed.',
    );
  }
  if (planPreview) {
    lines.push(`The plan opened with: _${planPreview}_`);
  }
  if (filePreview) {
    lines.push(`Planned files: \`${filePreview}\`${planAffectedFiles.length > 3 ? ' …' : ''}`);
  }
  lines.push(
    'If a code change is still needed, tell me the specific change and where it should land, and I\'ll pick it up from there — or say "cancel" to stop.',
  );
  return lines.join('\n');
}

/**
 * Reads an already-approved plan off a planner step seeded into
 * `ctx.previousSteps`. The fields were stamped by `stampApprovedPlan()` before
 * the pipeline started, so no re-normalization is needed — this just surfaces
 * them for the in-pipeline consumers that would otherwise only see a planner
 * that ran inside the loop.
 */
function normalizedFromSeededPlanner(seeded: AgentStepResult[]): NormalizedPlannerOutput | undefined {
  const plannerStep = seeded.find(s => s.role === 'planner');
  if (!plannerStep) return undefined;

  const normalized = normalizePlannerOutput(plannerStep.output, getActiveBackendId());

  // The stamped values win. `stampApprovedPlan()` writes exactly what the admin
  // signed off on onto the step, whereas the normalizer's codex branch rebuilds
  // planMarkdown from a `plan` array that a stamped step doesn't carry — which
  // would drop the approved plan all over again.
  const stampedMarkdown = plannerStep.output.planMarkdown;
  if (typeof stampedMarkdown === 'string' && stampedMarkdown.trim().length > 0) {
    normalized.planMarkdown = stampedMarkdown.trim();
  }
  const stampedFiles = plannerStep.output.affectedFiles;
  if (Array.isArray(stampedFiles) && stampedFiles.length > 0) {
    normalized.affectedFiles = stampedFiles.filter((f): f is string => typeof f === 'string');
  }
  return normalized;
}

export async function runAgentPipeline(params: {
  ctx: AgentContext;
  slack: WebClient;
  logStep: WorkflowStepLogger;
  store?: PipelineStore;
  jobId?: string;
  introMessage?: string;
  signal?: AbortSignal;
}): Promise<PipelineResult> {
  const { ctx, slack, logStep, store, jobId, introMessage, signal } = params;
  const {
    agents,
    maxRetryLoops,
    perAgentTimeoutMs: _perAgentTimeoutMs,
    totalTimeoutMs,
    abortOnCriticalFinding,
  } = ctx.pipelineConfig;

  const pipelineStart = Date.now();
  // Steps produced by THIS run. Kept separate from `ctx.previousSteps` so the
  // persisted steps_json and the returned `result.steps` stay scoped to this
  // pipeline — but every prompt is built from BOTH via promptSteps() below.
  // #413: prompts used to be built from `steps` alone, which silently dropped
  // the admin-approved planner step that implementationWorkflow seeds into
  // ctx.previousSteps. Every coder run since #126 was told "No plan markdown
  // available." and re-derived the task from raw Slack text.
  const steps: AgentStepResult[] = [];
  const seededSteps: AgentStepResult[] = ctx.previousSteps ?? [];
  const promptSteps = (): AgentStepResult[] => [...seededSteps, ...steps];
  let retryLoops = 0;
  let aborted = false;
  let pendingNeedsInput = false;
  let needsInputQuestion: string | undefined;
  let usageLimitHit = false;
  let usageLimitResetsAt: string | undefined;
  // The coder's whole change was outside the repository (issue #432).
  let externalOnly = false;
  let budgetExhausted: PipelineResult['budgetExhausted'];
  // Interruptions — a dropped connection (issue #439) or a process killed from
  // outside (issue #445): the time they cost is kept off the pipeline's clock,
  // and one that outlasts its retries stops the run. Neither is ever a verdict.
  let infraWaitMs = 0;
  let interrupted: PipelineResult['interrupted'];
  const stopOnInterruption = (
    role: AgentRole,
    errorKind: InterruptionKind,
    retries: number,
    durationMs: number,
  ): void => {
    const killed = errorKind === 'EXTERNAL_KILL';
    interrupted = { kind: killed ? 'killed' : 'connection_lost', role, retries };
    logStep({
      stage: killed ? 'pipeline.killed' : 'pipeline.api_error',
      message: killed
        ? `The ${role} was killed from outside, and so was the retry — stopping the pipeline. This is not a ${role} verdict.`
        : `Lost the connection to the model API during ${role}; ${retries} retries did not bring it back — stopping the pipeline.`,
      level: 'ERROR',
      data: { role, retries, infraWaitMs },
    });
    steps.push({
      role,
      status: 'failed',
      output: {
        status: 'error',
        summary: killed
          ? 'The agent process was killed from outside; this step did not complete.'
          : 'The model API could not be reached; this step did not complete.',
      },
      findings: [],
      durationMs,
    });
  };

  const pipelineRunId = randomUUID();
  if (store && jobId) {
    try {
      store.createPipelineRun({
        id: pipelineRunId,
        jobId,
        pipelineConfigJson: JSON.stringify(ctx.pipelineConfig),
        status: 'running',
        stepsJson: '[]',
      });
    } catch {
      // Non-fatal: persistence failure should not block pipeline execution
    }
  }

  logStep({
    stage: 'pipeline.start',
    message: `Starting multi-agent pipeline with ${agents.length} agents.`,
    data: { agents, maxRetryLoops, totalTimeoutMs },
  });

  const introText = buildPipelineIntroMessage(agents, introMessage);
  await postSlackProgress({ slack, ctx, text: introText });

  // Track plan message so we can append a completion marker after the coder runs.
  let planMessageTs: string | undefined;
  // Seeded from an externally-approved planner step when there is one (the
  // approval-gated implementation path plans BEFORE the pipeline starts), so the
  // needs-input question can quote the plan the admin actually signed off on.
  let plannerNormalized: NormalizedPlannerOutput | undefined = normalizedFromSeededPlanner(seededSteps);

  // Captured just-in-time before the first coder run; reused to diff against
  // the worktree afterwards so a hallucinated coder JSON can't pass the guard.
  let coderBaseSha: string | undefined;

  // The coder's actual diff (vs coderBaseSha), captured after each coder run and
  // fed to the reviewer/verifier so they assess the real changes against the
  // approved plan rather than the coder's self-reported summary (#388).
  let coderDiff: { diff: string; truncated: boolean } | undefined;

  for (let i = 0; i < agents.length; i++) {
    if (totalTimeoutMs) {
      // Time lost to a dead connection is not the pipeline's: a run that sat
      // offline for an hour has not used an hour of its budget (issue #439).
      const elapsed = Date.now() - pipelineStart - infraWaitMs;
      if (elapsed >= totalTimeoutMs) {
        // The budget is checked between steps, so it often runs out just
        // after a coder pass: that pass's changes were never reviewed (issue #333).
        const lastCoderPassUnreviewed = steps.length > 0 && steps[steps.length - 1].role === 'coder';
        logStep({
          stage: 'pipeline.timeout',
          message: 'Pipeline total timeout exceeded.',
          level: 'ERROR',
          data: { elapsed, totalTimeoutMs, lastCoderPassUnreviewed },
        });
        budgetExhausted = { elapsedMs: elapsed, limitMs: totalTimeoutMs, lastCoderPassUnreviewed };
        aborted = true;
        break;
      }
    }

    const role = agents[i];
    const agentStart = Date.now();

    logStep({
      stage: `pipeline.agent.${role}.start`,
      message: `Starting ${role} agent (step ${i + 1}/${agents.length}).`,
    });

    await postSlackProgress({
      slack,
      ctx,
      text: `[${i + 1}/${agents.length}] ${ROLE_START_MESSAGES[role]}`,
    });

    const prompt = buildPromptForRole(role, {
      ...ctx,
      previousSteps: promptSteps(),
      coderDiff,
    });

    const backendId = getActiveBackendId();
    const profile = profileForAgentRole(role, backendId);
    const planMode = role === 'planner' && backendId === 'claude-code';
    const schemaFile = SCHEMA_MAP[role];
    const schemaPath = planMode
      ? undefined
      : schemaFile
        ? path.resolve(process.cwd(), `schemas/${schemaFile}`)
        : undefined;

    if (role === 'coder' && coderBaseSha === undefined) {
      try {
        coderBaseSha = await currentHead(ctx.repoPath);
      } catch {
        coderBaseSha = undefined;
      }
    }

    // The planner and the coder keep the change's connectors (a design to
    // read, an asset to upload). A role that only reviews gets none.
    const roleConnectors = role === 'planner' || role === 'coder' ? currentConnectors() : NO_CONNECTORS;
    const result = await withAgentCallContext({ pipelineRunId, role }, () =>
      withConnectors(roleConnectors, () =>
        runWithInfraRetry(
          {
            cwd: ctx.repoPath,
            prompt,
            outputSchemaPath: schemaPath,
            githubToken: ctx.githubToken,
            planMode,
            // Every agent sees the thread's screenshots and PDFs. None did, so a
            // coder shipped the wrong PDF and plans said "could not open" (#595).
            imagePaths: ctx.imagePaths && ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
            ...profile,
            // timeoutMs: perAgentTimeoutMs,
            onLog: logStep,
            signal,
          },
          // The coder's work is on disk and costly to redo: pick its session back up.
          { label: role, resume: role === 'coder', logStep },
        ),
      ),
    );
    infraWaitMs += result.infraWaitMs;

    const durationMs = Date.now() - agentStart;

    // Still interrupted after the retries. Not an agent verdict: stop here
    // rather than hand the next agent a step that did not happen (#439), or
    // read a dead reviewer as "rejected" and send the coder round again (#445).
    if (isInterruption(result.errorKind)) {
      stopOnInterruption(role, result.errorKind, result.infraRetries, durationMs);
      break;
    }

    // Usage-limit hit: the CLI died pre-API with a known reset time. This is
    // not an agent verdict — abort the whole run instead of letting the
    // feedback loop burn more doomed spawns (issue #342; RCA: job 264ea287
    // failed coder→reviewer→2 loops→verifier in 23s, all 0-token exits).
    if (result.errorKind === 'USAGE_LIMIT') {
      usageLimitHit = true;
      usageLimitResetsAt = result.limitResetsAtText;
      logStep({
        stage: 'pipeline.usage_limit',
        message: `Claude usage limit hit during ${role} — aborting the pipeline${usageLimitResetsAt ? ` (resets ${usageLimitResetsAt})` : ''}.`,
        level: 'ERROR',
        data: { role, resetsAtText: usageLimitResetsAt },
      });
      steps.push({
        role,
        status: 'failed',
        output: result.parsedJson ?? { status: 'error', summary: result.lastMessage.slice(0, 300) },
        findings: [],
        durationMs,
      });
      break;
    }

    const output = result.parsedJson ?? {};
    const findings = extractFindings(output);
    let status = result.ok ? determineStepStatus(output, findings) : 'failed';

    // #413: a coder that cannot map the request to a concrete change declares
    // `status: "blocked"` instead of returning a passed-looking summary whose
    // text happens to start with "Blocked:". Route it to the needs-input loop —
    // which asks the requester in-thread and resumes on their answer — so the
    // refusal can never become a commit message, a PR title, or a SUCCESS.
    if (role === 'coder' && coderDeclaredBlocked(output)) {
      const reason = coderBlockedReason(output);
      status = 'failed';
      findings.push({
        severity: 'high',
        category: 'coder-blocked',
        message: `Coder declared itself blocked: ${reason || 'no reason given'}`,
        suggestion: 'Answer the question in-thread, or re-run with a concrete file/function scope.',
      });
      logStep({
        stage: 'pipeline.agent.coder.blocked',
        message: `Coder declared itself blocked — asking the requester instead of shipping. ${reason}`.trim(),
        level: 'WARN',
        data: { reason },
      });
      pendingNeedsInput = true;
      needsInputQuestion = reason
        ? buildCoderBlockedQuestion(reason)
        : buildCoderFollowUpQuestion(
            ctx,
            plannerNormalized?.planMarkdown ?? '',
            plannerNormalized?.affectedFiles ?? [],
          );
    }

    // Ground-truth check: self-reported JSON can be hallucinated. The coder
    // only "passed" if the worktree actually has new commits, uncommitted
    // changes, or a moved HEAD since we captured the base SHA.
    if (role === 'coder' && status === 'passed' && coderBaseSha) {
      try {
        const changes = await checkCoderProducedChanges({
          repoPath: ctx.repoPath,
          baseSha: coderBaseSha,
        });
        const external = parseExternalChanges(output);
        const plannedOutsideRepo = planListsOutsideChanges(plannerNormalized?.planMarkdown ?? '');
        if (!changes.producedChanges && external.length > 0) {
          // The change was outside the repository, and the coder says what
          // and how it checked it: nothing to review as a diff, no PR to
          // open. Used to be failed as "a hallucinated response" while the
          // dashboard had in fact been updated (issue #432).
          externalOnly = true;
          logStep({
            stage: 'pipeline.agent.coder.external_only',
            message: `Coder changed ${external.length} thing(s) outside the repository and nothing in it; skipping the diff review.`,
            level: plannedOutsideRepo ? 'INFO' : 'WARN',
            data: { external, inApprovedPlan: plannedOutsideRepo },
          });
        } else if (!changes.producedChanges) {
          status = 'failed';
          findings.push({
            severity: 'critical',
            category: 'coder-empty-output',
            message:
              'Coder reported success but the worktree has no new commits, no uncommitted changes, and HEAD has not moved. Either nothing was done, or the work was done outside the repository.',
            suggestion:
              'Gather missing context (error text, failing request, explicit file scope) and re-run with concrete targets.',
          });
          logStep({
            stage: 'pipeline.agent.coder.empty_output',
            message: 'Coder passed but git state shows no changes — marking as failed.',
            level: 'ERROR',
            data: {
              baseSha: coderBaseSha,
              filesChanged: changes.filesChanged.length,
              newCommits: changes.newCommits,
              hasUncommitted: changes.hasUncommitted,
              headMoved: changes.headMoved,
            },
          });
          pendingNeedsInput = true;
          needsInputQuestion = buildCoderNoDiffQuestion(
            plannerNormalized?.planMarkdown ?? '',
            plannerNormalized?.affectedFiles ?? [],
            typeof output.summary === 'string' ? output.summary : '',
          );
        } else {
          output.filesChanged = changes.filesChanged;
          // Capture the real diff for the downstream reviewer/verifier (#388).
          coderDiff = await getDiffVsBase(ctx.repoPath, coderBaseSha);
        }
      } catch (err) {
        logStep({
          stage: 'pipeline.agent.coder.empty_output_check_failed',
          message: `Could not verify coder output against git state: ${err instanceof Error ? err.message : String(err)}`,
          level: 'WARN',
        });
      }
    }

    const stepResult: AgentStepResult = {
      role,
      status,
      output,
      findings,
      durationMs,
    };

    steps.push(stepResult);

    logStep({
      stage: `pipeline.agent.${role}.finish`,
      message: `${role} agent finished: ${status} (${durationMs}ms, ${findings.length} findings).`,
      level: status === 'failed' ? 'WARN' : 'INFO',
      data: { status, durationMs, findings: findings.length },
    });

    // Nothing in the repository to review: the reviewer and verifier read diffs (issue #432).
    if (externalOnly) break;

    const nextRole = i < agents.length - 1 ? agents[i + 1] : undefined;
    await postSlackProgress({
      slack,
      ctx,
      text: `[${i + 1}/${agents.length}] ${buildCompletionMessage(role, status, nextRole)}`,
    });

    // After planner completes: normalize the output and post the plan as a formatted message
    if (role === 'planner' && status === 'passed') {
      plannerNormalized = normalizePlannerOutput(output, backendId);
      // Surface the normalized fields on the step output so downstream consumers
      // (implementationWorkflow.ts, resume contexts, tests) can read a consistent shape
      // regardless of which backend produced the plan.
      output.planMarkdown = plannerNormalized.planMarkdown;
      output.scope = plannerNormalized.scope;
      output.requiresCodeChanges = plannerNormalized.requiresCodeChanges;
      output.clarificationNeeded = plannerNormalized.clarificationNeeded;
      output.affectedFiles = plannerNormalized.affectedFiles;

      if (plannerNormalized.planMarkdown.length > 0) {
        try {
          planMessageTs = await postPlanForApproval({
            slack,
            channelId: ctx.task.event.channelId,
            threadTs: ctx.task.event.threadTs,
            planMarkdown: plannerNormalized.planMarkdown,
            affectedFiles: plannerNormalized.affectedFiles,
            scope: plannerNormalized.scope,
            repoPath: ctx.repoPath,
            logStep,
          });
        } catch {
          // Non-fatal, as for any other progress post.
        }
      }

      // Approval gate: wait for an admin to confirm the plan before proceeding
      if (ctx.pipelineConfig.requireApproval && planMessageTs) {
        const approvalPromptTs = await postSlackProgress({
          slack,
          ctx,
          text: 'Here\'s my plan. An admin needs to approve before I proceed:\n• "yes" or "go" — I\'ll start coding\n• "no" or "stop" — I\'ll cancel\n• Or reply with changes you\'d like and I\'ll adjust',
        });

        if (approvalPromptTs) {
          const adminUserIds = getAdminUserIds(ctx.config);
          const approval = await waitForApproval({
            slack,
            channelId: ctx.task.event.channelId,
            threadTs: ctx.task.event.threadTs,
            approverUserIds: adminUserIds,
            triggerUserId: ctx.task.event.userId,
            approvalPromptTs,
            logStep,
            botUserId: ctx.config.botUserId,
            signal,
          });

          if (approval.outcome === 'cancelled') {
            aborted = true;
            break;
          }
          if (approval.outcome === 'rejected') {
            await postSlackProgress({ slack, ctx, text: 'Got it, cancelling.' });
            aborted = true;
            break;
          }
        }
      }
    }

    // After coder completes: append a completion marker to the plan message.
    if (role === 'coder' && planMessageTs && plannerNormalized) {
      await updateSlackMessage({
        slack,
        ctx,
        ts: planMessageTs,
        text: formatPlanMessage(
          plannerNormalized.planMarkdown,
          plannerNormalized.affectedFiles,
          plannerNormalized.scope,
          ctx.repoPath,
          true,
        ),
      });
    }

    // Short-circuit: coder produced no diff → don't retry, ask user for more info
    if (pendingNeedsInput) {
      logStep({
        stage: 'pipeline.needs_input',
        message: 'Coder produced no diff — pausing for user input instead of retrying.',
        level: 'WARN',
        data: { question: needsInputQuestion },
      });
      break;
    }

    // A coder that failed leaves nothing to assess. The reviewer and verifier
    // used to run anyway, on whatever was on disk, and the run still ended
    // "failed" (issue #439).
    if (role === 'coder' && status === 'failed') {
      logStep({
        stage: 'pipeline.coder_failed',
        message: 'Coder failed — stopping the pipeline: there is nothing for the next agents to assess.',
        level: 'ERROR',
      });
      break;
    }

    // Abort on critical security/reviewer finding
    if (abortOnCriticalFinding && hasCriticalFinding(findings)) {
      logStep({
        stage: 'pipeline.abort',
        message: `Pipeline aborted due to critical finding from ${role}.`,
        level: 'ERROR',
        data: { role, criticalFindings: findings.filter(f => f.severity === 'critical') },
      });
      aborted = true;
      break;
    }

    // Feedback loop: reviewer rejects → re-run coder → re-run reviewer
    if (role === 'reviewer' && status === 'failed' && retryLoops < maxRetryLoops) {
      const coderIndex = agents.indexOf('coder');
      if (coderIndex !== -1 && coderIndex < i) {
        retryLoops++;
        logStep({
          stage: 'pipeline.feedback_loop',
          message: `Reviewer rejected; re-running coder (loop ${retryLoops}/${maxRetryLoops}).`,
          level: 'WARN',
          data: { retryLoops, maxRetryLoops },
        });

        await postSlackProgress({
          slack,
          ctx,
          text: `Reviewer flagged issues — sending feedback to the coding agent for revision (attempt ${retryLoops}/${maxRetryLoops}).`,
        });

        // Re-run coder with reviewer feedback in context (and the approved plan —
        // a revision that forgets what it was building is worse than the first try).
        const coderPrompt = buildPromptForRole('coder', {
          ...ctx,
          previousSteps: promptSteps(),
        });
        const coderProfile = profileForAgentRole('coder', getActiveBackendId());
        const coderSchemaPath = undefined; // coder has no dedicated schema
        const coderStart = Date.now();

        const coderRetryResult = await withAgentCallContext({ pipelineRunId, role: 'coder' }, () =>
          runWithInfraRetry(
            {
              cwd: ctx.repoPath,
              prompt: coderPrompt,
              outputSchemaPath: coderSchemaPath,
              githubToken: ctx.githubToken,
              imagePaths: ctx.imagePaths && ctx.imagePaths.length > 0 ? ctx.imagePaths : undefined,
              ...coderProfile,
              onLog: logStep,
              signal,
            },
            { label: 'coder', resume: true, logStep },
          ),
        );
        infraWaitMs += coderRetryResult.infraWaitMs;

        const coderRetryDuration = Date.now() - coderStart;

        if (isInterruption(coderRetryResult.errorKind)) {
          stopOnInterruption('coder', coderRetryResult.errorKind, coderRetryResult.infraRetries, coderRetryDuration);
          break;
        }

        if (coderRetryResult.errorKind === 'USAGE_LIMIT') {
          usageLimitHit = true;
          usageLimitResetsAt = coderRetryResult.limitResetsAtText;
          logStep({
            stage: 'pipeline.usage_limit',
            message: `Claude usage limit hit during coder retry — aborting the pipeline${usageLimitResetsAt ? ` (resets ${usageLimitResetsAt})` : ''}.`,
            level: 'ERROR',
            data: { role: 'coder', retryLoops, resetsAtText: usageLimitResetsAt },
          });
          steps.push({
            role: 'coder',
            status: 'failed',
            output: coderRetryResult.parsedJson ?? {
              status: 'error',
              summary: coderRetryResult.lastMessage.slice(0, 300),
            },
            findings: [],
            durationMs: coderRetryDuration,
          });
          break;
        }

        const coderOutput = coderRetryResult.parsedJson ?? {};
        const coderFindings = extractFindings(coderOutput);
        let coderStatus = coderRetryResult.ok ? determineStepStatus(coderOutput, coderFindings) : 'failed';

        if (coderStatus === 'passed' && coderBaseSha) {
          try {
            const changes = await checkCoderProducedChanges({
              repoPath: ctx.repoPath,
              baseSha: coderBaseSha,
            });
            if (!changes.producedChanges) {
              coderStatus = 'failed';
              coderFindings.push({
                severity: 'critical',
                category: 'coder-empty-output',
                message:
                  'Coder retry reported success but the worktree still shows no changes. Retrying will not help — new context is needed.',
                suggestion:
                  'Gather missing context (error text, failing request, explicit file scope) and re-run with concrete targets.',
              });
              logStep({
                stage: 'pipeline.agent.coder.empty_output',
                message: 'Coder retry passed but git state shows no changes — marking as failed.',
                level: 'ERROR',
                data: { retryLoops },
              });
              pendingNeedsInput = true;
              needsInputQuestion = buildCoderNoDiffQuestion(
                plannerNormalized?.planMarkdown ?? '',
                plannerNormalized?.affectedFiles ?? [],
                typeof coderOutput.summary === 'string' ? coderOutput.summary : '',
              );
            } else {
              coderOutput.filesChanged = changes.filesChanged;
              // Refresh the diff so the re-running reviewer sees the corrected changes (#388).
              coderDiff = await getDiffVsBase(ctx.repoPath, coderBaseSha);
            }
          } catch (err) {
            logStep({
              stage: 'pipeline.agent.coder.empty_output_check_failed',
              message: `Could not verify coder retry output against git state: ${err instanceof Error ? err.message : String(err)}`,
              level: 'WARN',
            });
          }
        }

        steps.push({
          role: 'coder',
          status: coderStatus,
          output: coderOutput,
          findings: coderFindings,
          durationMs: coderRetryDuration,
        });

        if (pendingNeedsInput) {
          logStep({
            stage: 'pipeline.needs_input',
            message: 'Coder retry produced no diff — pausing for user input instead of looping further.',
            level: 'WARN',
            data: { question: needsInputQuestion, retryLoops },
          });
          break;
        }

        // Re-run reviewer
        i--; // Will increment back to reviewer on next iteration
        continue;
      }
    }
  }

  const totalDurationMs = Date.now() - pipelineStart;
  const aggregatedFindings = steps.flatMap(s => s.findings);

  // Check only the latest step for each role (feedback loops may produce
  // earlier failed steps that were subsequently superseded by retries).
  const latestByRole = new Map<string, AgentStepResult>();
  for (const step of steps) {
    latestByRole.set(step.role, step);
  }
  const hasFailedStep = Array.from(latestByRole.values()).some(s => s.status === 'failed');
  const finalStatus: PipelineResult['finalStatus'] = usageLimitHit
    ? 'usage-limit'
    : pendingNeedsInput
      ? 'needs-input'
      : aborted
        ? 'aborted'
        : hasFailedStep
          ? 'failed'
          : 'passed';

  logStep({
    stage: 'pipeline.finish',
    message: `Pipeline finished: ${finalStatus} (${totalDurationMs}ms, ${retryLoops} retry loops, ${aggregatedFindings.length} total findings).`,
    level: finalStatus === 'passed' ? 'INFO' : 'WARN',
    data: { finalStatus, totalDurationMs, retryLoops, totalFindings: aggregatedFindings.length },
  });

  const durationSec = Math.round(totalDurationMs / 1000);
  const finishText =
    finalStatus === 'passed'
      ? `Done in ${durationSec}s. Preparing the summary.`
      : finalStatus === 'needs-input'
        ? `Paused after ${durationSec}s — I need a bit more info before I can code a fix.`
        : finalStatus === 'usage-limit'
          ? `Paused — Claude usage limit hit${usageLimitResetsAt ? ` (resets ${usageLimitResetsAt})` : ''}. No code was lost.`
          : interrupted?.kind === 'connection_lost'
            ? `Stopped after ${durationSec}s — I lost my connection to the model and retrying didn't bring it back.`
            : interrupted
              ? `Stopped after ${durationSec}s — the ${interrupted.role} was killed from outside, twice.`
              : budgetExhausted
                ? `Stopped after ${durationSec}s: this run's time limit ran out${budgetExhausted.lastCoderPassUnreviewed ? ' before the latest changes were reviewed again' : ''}.`
                : finalStatus === 'aborted'
                  ? `Stopped after ${durationSec}s: a check found a critical issue.`
                  : `Finished in ${durationSec}s, but the checks did not pass.`;
  await postSlackProgress({ slack, ctx, text: finishText });

  if (store && jobId) {
    try {
      store.updatePipelineRun(pipelineRunId, {
        status: finalStatus,
        stepsJson: JSON.stringify(steps),
        retryLoops,
        totalDurationMs,
      });
    } catch {
      // Non-fatal
    }
  }

  return {
    steps,
    finalStatus,
    totalDurationMs,
    retryLoops,
    aggregatedFindings,
    needsInputQuestion,
    usageLimitResetsAt,
    ...(interrupted ? { interrupted } : {}),
    ...externalChangesResult(latestByRole.get('coder'), externalOnly, plannerNormalized?.planMarkdown ?? ''),
    ...(budgetExhausted ? { budgetExhausted } : {}),
  };
}
