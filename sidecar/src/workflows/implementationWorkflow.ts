import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  ImplementationApprovalResume,
  NormalizedTask,
  ResumeContext,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { getAdminUserIds } from '../access/control.js';
import { runCodex, getActiveBackendId, selectBackendForUser } from '../codex/runCodex.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { githubAuthModeHint } from '../github/githubAuth.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { getBackend } from '../backends/registry.js';
import type { AgentBackendId } from '../backends/types.js';
import {
  runAgentPipeline,
  formatPlanMessage,
  waitForApproval,
  buildApprovalMessage,
  coderDeclaredBlocked,
} from '../agents/pipeline.js';
import { normalizePlannerOutput } from '../agents/normalizePlannerOutput.js';
import { inferRepoFromAffectedFiles, readRepoAffinity, repoPathFor, resolveRepoOrAsk } from './shared/repoResolver.js';
import { enabledRepoKeys, getRepo, repoKeyForWorkspacePath } from '../repos/registry.js';
import type { RepoAffinity } from '../router/repoClassifier.js';
import { waitForClarificationWithIdle, detectClarificationLoop } from './shared/clarificationGuards.js';
import type { ClarificationRound } from './shared/clarificationGuards.js';
import { profileForAgentRole } from '../codex/modelProfiles.js';
import { buildPlannerPrompt, buildPlannerPlanModePrompt } from '../agents/prompts.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';
import { createPrFromWorkspace } from '../github/postPipelinePr.js';
import { fetchUnresolvedReviewThreadCount } from '../github/prReviewComments.js';
import type { PipelineStore } from '../agents/pipeline.js';
import type { AgentStepResult, PipelineConfig } from '../agents/types.js';
import type { InvestigationStore } from '../state/investigationStore.js';
import { prepareWorkflowContext, sanitizeOwnerSummary, extractReplyFromCodexResult } from './shared/workflowUtils.js';
import { assertThreadParentExists } from '../slack/threadContext.js';
import { runAgenticEntry } from '../agentic/agenticEntry.js';
import type { JobStore } from '../state/jobStore.js';

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
async function runApprovalLoop(input: {
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
  } = input;

  const adminUserIds = getAdminUserIds(config);
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
          ? 'Here\'s my plan. An admin needs to approve before I proceed:\n• "yes" or "go" — I\'ll start coding\n• "no" or "stop" — I\'ll cancel\n• Or reply with changes you\'d like and I\'ll adjust'
          : 'Here\'s the revised plan. "yes" to proceed, "no" to cancel, or reply with more changes.';

      try {
        const promptResult = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: promptText,
        });
        approvalPromptTs = promptResult.ts ?? undefined;
      } catch {
        // Non-fatal
      }
      if (!approvalPromptTs) {
        return { kind: 'exhausted' };
      }
    }

    logStep?.({
      stage: 'implementation.approval.waiting',
      message: `Waiting for admin approval of plan (iteration ${iteration + 1}).`,
    });

    let approval = await waitForApproval({
      slack,
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      approverUserIds: adminUserIds,
      triggerUserId: task.event.userId,
      approvalPromptTs,
      logStep: logStep ?? (() => {}),
      botUserId: config.botUserId,
    });

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
          text: 'Got it. Would you like to change the task or the approach? Reply with what you\'d like different, or say "cancel" to stop.',
        });
        askReviseTs = askResult.ts ?? undefined;
      } catch {
        // Non-fatal
      }

      if (!askReviseTs) {
        return { kind: 'rejected_then_cancelled', message: 'Plan rejected by admin.' };
      }

      const followUp = await waitForApproval({
        slack,
        channelId: task.event.channelId,
        threadTs: task.event.threadTs,
        approverUserIds: adminUserIds,
        triggerUserId: task.event.userId,
        approvalPromptTs: askReviseTs,
        logStep: logStep ?? (() => {}),
        botUserId: config.botUserId,
      });

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
        return { kind: 'rejected_then_cancelled', message: 'Plan rejected by admin after revision prompt.' };
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
      const feedbackPrompt = `You previously produced this plan:
${JSON.stringify(plannerOutput, null, 2)}

The admin reviewed it and provided this feedback:

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

      const revisedResult = await runCodex({
        cwd: pipelineCwd,
        prompt: feedbackPrompt,
        outputSchemaPath: plannerSchemaPath,
        githubToken,
        ...plannerProfile,
        // No per-agent timeoutMs — see investigationWorkflow.ts for rationale.
        // Outer abort signal remains the safety net.
        onLog: logStep,
      });

      // Even though we no longer resume, capture sessionId so a later coder
      // step or follow-up logging can reference this revision's session.
      plannerSessionId = revisedResult.sessionId ?? plannerSessionId;

      if (!(revisedResult.ok && revisedResult.parsedJson)) {
        // Re-plan failed (model output wasn't valid JSON, or runCodex errored).
        // Pre-fix, the workflow silently fell through to "post the revised plan
        // as a new message" using the unchanged old plan — making "Here's the
        // revised plan" a lie. Tell the user instead and let them rephrase.
        logStep?.({
          stage: 'implementation.approval.revising.failed',
          message: 'Revised plan generation produced non-JSON output; surfacing recovery prompt to the user.',
          level: 'WARN',
          data: { feedbackRounds, ok: revisedResult.ok, hasParsedJson: Boolean(revisedResult.parsedJson) },
        });
        try {
          const recoveryPosted = await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: 'I had trouble revising the plan from that feedback — the planner returned non-JSON output. Reply with rephrased feedback, `yes` to proceed with the original plan, or `no` to cancel.',
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

      plannerOutput = revisedResult.parsedJson;
      // Normalize per the backend the planner actually ran on. On claude-code the
      // revision schema is unenforced (buildArgs ignores outputSchemaPath), so a
      // prose/markdown revision must go through the claude-code branch — the codex
      // branch would yield an empty planMarkdown and silently keep the stale plan.
      const revisedNormalized = normalizePlannerOutput(plannerOutput, plannerBackend);
      planMarkdown = revisedNormalized.planMarkdown || planMarkdown;
      planAffectedFiles =
        revisedNormalized.affectedFiles.length > 0 ? revisedNormalized.affectedFiles : planAffectedFiles;
      planScope = revisedNormalized.scope || planScope;

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
        const revisedPosted = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: formatPlanMessage(planMarkdown, planAffectedFiles, planScope, pipelineCwd),
        });
        planMessageTs = revisedPosted.ts ?? planMessageTs;
      } catch {
        // Non-fatal
      }
      // Loop back to post next approval prompt
    }
  }

  return { kind: 'exhausted' };
}

export async function runImplementationWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: PipelineStore & {
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

  const ctx = await prepareWorkflowContext({ task, config, slack, store, logStep });

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

    // Cheap pre-flight: if the user has already deleted the source mention,
    // skip the 5-minute planner call. Slack would silently promote any post
    // we make into an orphan channel-root message (see processMessageDeleted
    // doc-comment in index.ts for the RCA). One ~50ms API call to save
    // minutes of compute and a confusing channel artifact.
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

    logStep?.({ stage: 'pipeline.agent.planner.start', message: 'Starting planner agent.' });

    let plannerRunResult = await runCodex({
      cwd: ctx.cwd,
      prompt: plannerPrompt,
      outputSchemaPath: plannerPlanMode ? undefined : plannerSchemaPath,
      githubToken: ctx.githubToken,
      planMode: plannerPlanMode,
      ...plannerProfile,
      // No per-agent timeoutMs — see investigationWorkflow.ts for rationale.
      // Outer abort signal remains the safety net.
      onLog: logStep,
    });

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

      const allowedAnswerers = [...new Set([task.event.userId, ...getAdminUserIds(config)])];
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

      const followUpPrompt = plannerSessionId
        ? `The user answered your clarifying question ("${question}") with:\n\n"${answer}"\n\nNow produce the final plan. Return the same JSON schema with \`clarificationNeeded\` set to null.`
        : `You previously asked: "${question}"\nThe user answered: "${answer}"\n\nOriginal plan so far:\n${JSON.stringify(plannerOutput, null, 2)}\n\nNow produce the final plan. Return the same JSON schema with \`clarificationNeeded\` set to null.`;

      plannerRunResult = await runCodex({
        cwd: ctx.cwd,
        prompt: followUpPrompt,
        ...(plannerSessionId ? { resumeSessionId: plannerSessionId } : {}),
        outputSchemaPath: plannerSchemaPath,
        githubToken: ctx.githubToken,
        ...plannerProfile,
        // No per-agent timeoutMs — see investigationWorkflow.ts for rationale.
        // Outer abort signal remains the safety net.
        onLog: logStep,
      });
      plannerSessionId = plannerRunResult.sessionId ?? plannerSessionId;
      if (plannerRunResult.ok && plannerRunResult.parsedJson) {
        plannerOutput = plannerRunResult.parsedJson;
      } else {
        break;
      }
    }

    const plannerRequiresCodeChanges = Boolean(plannerOutput.requiresCodeChanges);

    // Quick-action fast path: if the planner says no code changes are needed
    // (e.g., "merge this PR", "close PR", "deploy", "run tests"), skip the full
    // pipeline and execute directly with a single codex call. No approval gate needed.
    if (!plannerRequiresCodeChanges) {
      logStep?.({
        stage: 'implementation.quick_action',
        message: 'Planner says no code changes needed — executing as quick action (no approval, no pipeline).',
        data: { plan: plannerOutput.plan },
      });

      // For merge requests: check for unresolved review comments before proceeding
      const mergeIntent = /\bmerge\b/i.test(task.event.text);
      if (mergeIntent && task.prContext && ctx.githubToken) {
        const adminUserIds = getAdminUserIds(config);
        const { unresolvedCount } = await fetchUnresolvedReviewThreadCount({
          owner: task.prContext.owner,
          repo: task.prContext.repo,
          pullNumber: task.prContext.number,
          githubToken: ctx.githubToken,
        });

        if (unresolvedCount > 0) {
          const confirmMsg = `This PR has ${unresolvedCount} unresolved review comment${unresolvedCount > 1 ? 's' : ''}. Should I still merge? Reply *yes* to proceed or *no* to cancel.`;
          const confirmResult = await slack.chat.postMessage({
            channel: task.event.channelId,
            thread_ts: task.event.threadTs,
            text: confirmMsg,
          });

          if (confirmResult.ts) {
            const approval = await waitForApproval({
              slack,
              channelId: task.event.channelId,
              threadTs: task.event.threadTs,
              approverUserIds: adminUserIds,
              triggerUserId: task.event.userId,
              approvalPromptTs: confirmResult.ts,
              logStep: logStep ?? (() => {}),
              botUserId: config.botUserId,
            });

            if (approval.outcome === 'rejected') {
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
        /\b(merge|close|reopen|revert|deploy|release|ship|rollback|restart|rerun|re-run|run (?:the )?tests?|approve|assign)\b/i.test(
          task.event.text,
        );
      if (!operationalAction) {
        logStep?.({
          stage: 'implementation.no_code_needed.informational',
          message: 'Planner says no code changes and this is not an operational action — answering as informational.',
          data: { plan: plannerOutput.plan },
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

      const quickPrompt = `
${buildMentionSystemPrompt({ task, workflow: 'IMPLEMENTATION', toneMode: task.toneMode })}

Context:
- You are miniOG, a developer assistant bot in a Slack workspace.
- Your response will be posted DIRECTLY into a Slack thread as-is.
- Working directory: ${ctx.cwd}
- GitHub auth mode: ${githubAuthModeHint(Boolean(ctx.githubToken))}

Task:
Execute this request directly. No code changes are needed — this is a quick operational action (merge PR, deploy, run command, etc.).

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
      const quickResult = await runCodex({
        cwd: ctx.cwd,
        prompt: quickPrompt,
        githubToken: ctx.githubToken,
        ...highReasoningProfile(quickBackend),
        // timeoutMs: Math.floor(workflowTimeoutMs * 0.5),
        onLog: logStep,
        signal,
      });

      const reply = extractReplyFromCodexResult(quickResult) || 'Quick action completed.';

      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: reply,
      });

      return {
        workflow: 'IMPLEMENTATION',
        status: quickResult.ok ? 'SUCCESS' : 'FAILED',
        message: reply,
        notifyDesktop: false,
        slackPosted: true,
      };
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
      });

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
        const planResult = await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: formatPlanMessage(planMarkdown, planAffectedFiles, planScope, pipelineCwd),
        });
        planMessageTs = planResult.ts ?? undefined;
      } catch (error) {
        planPostError = error;
      }
    }

    // Fail closed: admin approval is mandatory for fresh implementation runs,
    // and the only thread the admin can react to is the plan message. If the
    // planner produced no plan content, or the plan post failed, we have no
    // reviewable artifact and no approval prompt \u2014 proceeding would let the
    // coder/reviewer/verifier write code unsupervised.
    if (!planMessageTs) {
      const reason =
        planMarkdown.length === 0
          ? 'Planner returned no plan content \u2014 cannot proceed without a reviewable plan.'
          : 'Failed to post the plan to Slack \u2014 cannot proceed without an admin approval prompt.';
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
          text: `Couldn't reach an admin approval gate \u2014 ${reason} Cancelling.`,
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
      workflowIntent: task.intent === 'OWNER_AUTOPILOT' ? 'OWNER_AUTOPILOT' : 'IMPLEMENTATION',
      logStep,
    });

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
    });

    let currentThreadContext = ctx.threadContext;
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
      const allowedIds = Array.from(new Set([task.event.userId, ...adminUserIds, ...config.coreDevSlackUserIds]));

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

      const failureSummary = `Pipeline finished with status: ${fullResult.finalStatus}. Not opening a PR.`;
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

    const coderStep = fullResult.steps.find(s => s.role === 'coder');
    const rawCoderSummary = coderStep?.output?.summary ? sanitizeOwnerSummary(String(coderStep.output.summary)) : '';
    const summary =
      rawCoderSummary || 'Pipeline completed but the agent did not return a summary. Check the repo for changes.';

    let prUrl = coderStep?.output?.prUrl ? String(coderStep.output.prUrl) : '';

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

    const prBlock = prUrl ? `\n${prUrl}` : '';

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${summary}${prBlock}`.trim(),
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
