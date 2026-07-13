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
import { normalizePlannerOutput, type NormalizedPlannerOutput } from './normalizePlannerOutput.js';
import { REPO_KEYS, type RepoKey } from '../repos/registry.js';
import { withAgentCallContext } from '../state/runContext.js';
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

export function formatPlanMessage(
  planMarkdown: string,
  affectedFiles: string[],
  scope: string,
  repoPath?: string,
  completed?: boolean,
): string {
  const header = `*Plan* (scope: ${scope}, ${affectedFiles.length} files affected)`;
  const displayFiles = repoPath ? affectedFiles.map(f => stripRepoPrefix(f, repoPath)) : affectedFiles;
  const filesSection =
    displayFiles.length > 0 ? `\n\n*Affected files:*\n${displayFiles.map(f => `• \`${f}\``).join('\n')}` : '';
  const body = planMarkdown.trim();
  const completedSuffix = completed ? '\n\n_✅ Plan executed._' : '';
  return `${header}${body ? `\n${body}` : ''}${filesSection}${completedSuffix}`;
}

const APPROVE_PATTERNS = /^(yes|go|proceed|do it|go ahead|ship it|lgtm)$/i;
const REJECT_PATTERNS = /^(no|stop|cancel|abort|nevermind|never mind)\b/i;
// Strict pause patterns: pause word must be the entire message (modulo punctuation).
// "wait, that's wrong" / "wait, also include X" → feedback, not pause.
const PAUSE_PATTERNS =
  /^(wait|hold on|hold up|pause|brb|one sec|one moment|stand by|i'?ll get back to you|(give me|gimme) (a )?(sec|second|minute|moment|min)|pause for (now|a bit|a sec)|stop for now)[.! ]*$/i;

export type ApprovalOutcome = 'approved' | 'rejected' | 'feedback' | 'paused';
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
      prompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 15_000,
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

export async function waitForApproval(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  approverUserIds: string[];
  triggerUserId: string;
  approvalPromptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
}): Promise<ApprovalResult> {
  const { slack, channelId, threadTs, approverUserIds, approvalPromptTs, logStep, botUserId } = params;
  const pollIntervalMs = 5_000;
  const notifiedUsers = new Set<string>();
  // Per-call cache: messages we've already classified (and got non-actionable
  // intent for) — avoids re-classifying the same ts every 5s poll cycle.
  const classifiedTs = new Set<string>();

  while (true) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

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
      const isApprover = approverUserIds.includes(reply.user);

      // Pause detection runs on EVERY non-bot reply (not admin-gated). Anyone in
      // the thread can park miniOG with a "wait" message; the workflow returns
      // PAUSED, releases its slot, and resumes on the next @miniOG mention.
      if (isQuickPauseMessage(text)) {
        logStep({
          stage: 'pipeline.approval.paused',
          message: `<@${reply.user}> asked miniOG to wait: "${text}"`,
        });
        return { outcome: 'paused', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

      if (APPROVE_PATTERNS.test(text)) {
        if (!isApprover) {
          if (!notifiedUsers.has(reply.user)) {
            notifiedUsers.add(reply.user);
            logStep({
              stage: 'pipeline.approval.unauthorized',
              message: `Non-admin user <@${reply.user}> attempted to approve.`,
              level: 'WARN',
            });
            slack.chat
              .postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `<@${reply.user}> Only admins can approve plans. Waiting for an admin to respond.`,
              })
              .catch(() => {});
          }
          continue;
        }
        logStep({
          stage: 'pipeline.approval.approved',
          message: `Core-dev member <@${reply.user}> approved the plan: "${text}"`,
        });
        return { outcome: 'approved', userReply: text, approverId: reply.user, replyTs: reply.ts };
      }

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
          logStep({
            stage: 'pipeline.approval.approved',
            message: `Core-dev member <@${reply.user}> approved the plan: "${text}"`,
          });
          return { outcome: 'approved', userReply: text, approverId: reply.user, replyTs: reply.ts };
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
// against any future de-anchoring of these regexes.
const MARKETING_SHORTHAND =
  /^(marketing|mweb|nmw|mkt|marketing[- ]?(web|site)|newton[- ]?marketing([- ]?web)?|landing([- ]?pages?)?)$/i;
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

  // The LLM prompt only describes the repos this host can actually resolve —
  // on a two-repo host it stays byte-compatible with the pre-marketing copy.
  const marketingChoiceLine = marketingAllowed
    ? `\n- "newton-marketing-web" — the PUBLIC MARKETING site (newtonschool.co landing pages, Webflow migration, Tailwind, Cloudflare)`
    : '';
  const marketingCategory = marketingAllowed
    ? `

"marketing" — the reply identifies newton-marketing-web. Examples: "marketing", "mweb", "nmw", "the marketing site", "landing pages", "the webflow one", "the tailwind one", "the public site".
IMPORTANT: "marketing web", "marketing site", and "landing" mean newton-marketing-web, NOT newton-web. Classify as "web" only when the reply points at the product app.`
    : '';
  const categoryCount = marketingAllowed ? 'six' : 'five';
  const bothExamples = marketingAllowed
    ? `"both", "both repos", "web and api", "api and web", "web and marketing", "dono", "it's a cross-repo change", "frontend + backend"`
    : `"both", "both repos", "web and api", "api and web", "dono", "it's a cross-repo change", "frontend + backend"`;
  const intentUnion = marketingAllowed
    ? `"web" | "api" | "marketing" | "both" | "cancel" | "unclear"`
    : `"web" | "api" | "both" | "cancel" | "unclear"`;

  const prompt = `You are a classifier for miniOG, a developer bot. miniOG asked an admin which repo to work in for an ambiguous task. The choices are:
- "newton-web" — the PRODUCT frontend (React/JavaScript, the logged-in app at my.newtonschool.co: pages, components, UI)
- "newton-api" — the backend repo (Python/Django, endpoints, models, serializers)${marketingChoiceLine}

Classify the admin's reply into one of ${categoryCount} categories:

"web" — the reply identifies newton-web. Examples: "web", "newton-web", "frontend", "the react one", "UI", "it's a frontend change", "the product app".

"api" — the reply identifies newton-api. Examples: "api", "newton-api", "backend", "the django one", "it's in python".${marketingCategory}

"both" — the reply says the task spans MULTIPLE repos. Examples: ${bothExamples}.

"cancel" — the reply tells miniOG to stop / skip / abort. Examples: "cancel", "nevermind", "don't bother", "stop".

"unclear" — the reply doesn't pick a repo and isn't a cancel or "both". Examples: "not sure", a question, unrelated chat, or anything that doesn't map to a category above.

Recent thread messages (for context):
${recentThread.map((m, i) => `[${i + 1}] ${m}`).join('\n')}

New message to classify:
"${message}"

Return strict JSON:
{
  "intent": ${intentUnion},
  "reasoning": "one sentence explaining why"
}`;

  try {
    const profile = lightweightProfile(getActiveBackendId());
    const result = await runCodex({
      cwd: os.tmpdir(),
      prompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 15_000,
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
export async function waitForRepoChoice(params: {
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

export async function waitForClarification(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  allowedUserIds: string[];
  promptTs: string;
  logStep: WorkflowStepLogger;
  botUserId?: string;
}): Promise<ClarificationResult> {
  const { slack, channelId, threadTs, allowedUserIds, promptTs, logStep, botUserId } = params;
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
export function buildCoderFollowUpQuestion(
  ctx: AgentContext,
  planMarkdown: string,
  planAffectedFiles: string[],
): string {
  const trimmed = planMarkdown.trim();
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200).trim()}…` : trimmed;
  const filePreview = planAffectedFiles.slice(0, 3).join(', ');

  const lines = ["I couldn't pin down a concrete change from the info I have, so I haven't touched any files."];
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
  const steps: AgentStepResult[] = [];
  let retryLoops = 0;
  let aborted = false;
  let pendingNeedsInput = false;
  let needsInputQuestion: string | undefined;
  let usageLimitHit = false;
  let usageLimitResetsAt: string | undefined;

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
  let plannerNormalized: NormalizedPlannerOutput | undefined;

  // Captured just-in-time before the first coder run; reused to diff against
  // the worktree afterwards so a hallucinated coder JSON can't pass the guard.
  let coderBaseSha: string | undefined;

  // The coder's actual diff (vs coderBaseSha), captured after each coder run and
  // fed to the reviewer/verifier so they assess the real changes against the
  // approved plan rather than the coder's self-reported summary (#388).
  let coderDiff: { diff: string; truncated: boolean } | undefined;

  for (let i = 0; i < agents.length; i++) {
    if (totalTimeoutMs) {
      const elapsed = Date.now() - pipelineStart;
      if (elapsed >= totalTimeoutMs) {
        logStep({
          stage: 'pipeline.timeout',
          message: 'Pipeline total timeout exceeded.',
          level: 'ERROR',
          data: { elapsed, totalTimeoutMs },
        });
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
      previousSteps: steps,
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

    const result = await withAgentCallContext({ pipelineRunId, role }, () =>
      runCodex({
        cwd: ctx.repoPath,
        prompt,
        outputSchemaPath: schemaPath,
        githubToken: ctx.githubToken,
        planMode,
        ...profile,
        // timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
        signal,
      }),
    );

    const durationMs = Date.now() - agentStart;

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

    // Ground-truth check: self-reported JSON can be hallucinated. The coder
    // only "passed" if the worktree actually has new commits, uncommitted
    // changes, or a moved HEAD since we captured the base SHA.
    if (role === 'coder' && status === 'passed' && coderBaseSha) {
      try {
        const changes = await checkCoderProducedChanges({
          repoPath: ctx.repoPath,
          baseSha: coderBaseSha,
        });
        if (!changes.producedChanges) {
          status = 'failed';
          findings.push({
            severity: 'critical',
            category: 'coder-empty-output',
            message:
              'Coder reported success but the worktree has no new commits, no uncommitted changes, and HEAD has not moved. Likely a hallucinated response with no actual tool use.',
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
          needsInputQuestion = buildCoderFollowUpQuestion(
            ctx,
            plannerNormalized?.planMarkdown ?? '',
            plannerNormalized?.affectedFiles ?? [],
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
        planMessageTs = await postSlackProgress({
          slack,
          ctx,
          text: formatPlanMessage(
            plannerNormalized.planMarkdown,
            plannerNormalized.affectedFiles,
            plannerNormalized.scope,
            ctx.repoPath,
          ),
        });
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
          });

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

        // Re-run coder with reviewer feedback in context
        const coderPrompt = buildPromptForRole('coder', {
          ...ctx,
          previousSteps: steps,
        });
        const coderProfile = profileForAgentRole('coder', getActiveBackendId());
        const coderSchemaPath = undefined; // coder has no dedicated schema
        const coderStart = Date.now();

        const coderRetryResult = await withAgentCallContext({ pipelineRunId, role: 'coder' }, () =>
          runCodex({
            cwd: ctx.repoPath,
            prompt: coderPrompt,
            outputSchemaPath: coderSchemaPath,
            githubToken: ctx.githubToken,
            ...coderProfile,
            onLog: logStep,
            signal,
          }),
        );

        const coderRetryDuration = Date.now() - coderStart;

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
              needsInputQuestion = buildCoderFollowUpQuestion(
                ctx,
                plannerNormalized?.planMarkdown ?? '',
                plannerNormalized?.affectedFiles ?? [],
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
          : finalStatus === 'aborted'
            ? `Finished in ${durationSec}s. Review flagged some concerns — see the summary below.`
            : `Finished in ${durationSec}s with some issues flagged — details below.`;
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
  };
}
