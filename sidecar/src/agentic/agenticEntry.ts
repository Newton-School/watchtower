import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { runClaudeAgentic } from './runClaude.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { refreshSharedRepoToDefaultBranch } from '../workspaces/workspaceManager.js';

export type AgenticMode = 'informational' | 'conversational';

export interface RunAgenticEntryParams {
  mode: AgenticMode;
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}

const INFORMATIONAL_SYSTEM_PROMPT = `You are miniOG, a Slack assistant. The user has asked an informational question — code lookup, "where is X", "how does Y work", documentation, table schemas, data sources.

Your job:
1. Use your native tools (Read, Grep, Bash, Glob) to find the answer in the repos under the current working directory. The repos you have access to typically include newton-web (frontend), newton-api (backend), and watchtower (the bot itself).
2. Be efficient — don't grep for tangential things. Find the answer and stop.
3. Compose a concise Slack reply citing file:line refs. Use Slack markdown: \`code\`, *bold*, _italic_, bullets.
4. Output ONLY the final Slack reply text as your last message — no JSON, no code fences around the reply, no preamble like "Here's what I found:" or "Based on my search:".

Constraints:
- If you can't find what they asked about, say so directly — don't speculate.
- Stay terse. The user reads on Slack; long answers get skipped.
- Never fabricate file paths or line numbers — only cite things you actually opened.`;

const CONVERSATIONAL_SYSTEM_PROMPT = `You are miniOG, a Slack assistant. The user is making a conversational request — greeting, status check, casual chat, or a question about miniOG itself.

Your job:
1. Produce a short, human reply.
2. Output ONLY the final Slack reply text as your last message — no JSON, no code fences, no preamble.

FORBIDDEN: You are NOT permitted to claim that code work was performed, that a PR was opened, that a deploy ran, or that a fix shipped. If the user is asking about an in-flight task, your only allowed response is to acknowledge ("on it", "checking", "will share when ready") or to defer. NEVER assert completion of work you did not do.

Keep replies short — one or two sentences usually. Slack markdown is fine but optional.`;

/**
 * Unified agentic entry point that replaces the legacy informationalWorkflow
 * and conversationalWorkflow. Spawns Claude Code via runCodex (OAuth, no API
 * key needed) with a per-mode system prompt; the agent uses its native tools
 * to explore the repos; the final stdout is parsed and posted to Slack.
 */
export async function runAgenticEntry(params: RunAgenticEntryParams): Promise<WorkflowResult> {
  const { mode, task, config, slack, store, logStep, signal } = params;

  logStep?.({
    stage: 'agentic.start',
    message: `Agentic entry starting in ${mode} mode.`,
    data: { mode, userId: task.event.userId, channelId: task.event.channelId },
  });

  const systemPromptBase = mode === 'informational' ? INFORMATIONAL_SYSTEM_PROMPT : CONVERSATIONAL_SYSTEM_PROMPT;

  // Conversational guardrail: when investigation findings are pending for
  // this thread, prepend a steer so the agent does NOT claim work is done.
  let systemPrompt = systemPromptBase;
  if (mode === 'conversational') {
    try {
      const pending = store.investigationStore?.()?.getForThread(task.event.threadTs);
      if (pending) {
        systemPrompt = `${systemPromptBase}\n\nIMPORTANT: This thread has pending investigation findings from a prior turn. The user may be following up on a fix. Do NOT claim the fix is done. Steer ("on it", "starting now", "will share the PR shortly") and defer to the implementation pipeline.`;
        logStep?.({
          stage: 'agentic.conversational_steer',
          message: 'Pending investigation findings detected; injected fake-completion guardrail.',
        });
      }
    } catch {
      // investigationStore may not be wired in some contexts; non-fatal.
    }
  }

  const githubToken = await resolveGithubTokenForCodex();

  // Informational answers read the shared newton-web / newton-api clones
  // directly (the cwd below is their parent, NOT an isolated worktree), so the
  // clones must be fast-forwarded to origin first — otherwise a clone that has
  // drifted behind origin yields answers that contradict freshly-merged code
  // (e.g. "feature X isn't implemented" the day after the PR adding it merged).
  // Conversational replies don't read code, so we skip the fetch cost there.
  if (mode === 'informational') {
    for (const repoPath of [config.repoPaths.newtonWeb, config.repoPaths.newtonApi]) {
      const state = refreshSharedRepoToDefaultBranch(repoPath);
      logStep?.({
        stage: 'agentic.repo_refresh',
        message: `Refreshed ${path.basename(repoPath)} to ${state?.branch ?? 'unknown'} @ ${state?.head ?? 'unknown'}.`,
        data: { repoPath, branch: state?.branch, head: state?.head },
      });
    }
  }

  const cwd = config.miniOgRepoRoot ?? config.repoPaths.newtonWeb;

  const result = await runClaudeAgentic({
    systemPrompt,
    userMessage: task.event.text || '(empty message)',
    cwd,
    githubToken,
    logStep,
    signal,
  });

  logStep?.({
    stage: 'agentic.done',
    message: `Agentic run finished: ${result.reason}.`,
    level: result.ok ? 'INFO' : 'WARN',
    data: { reason: result.reason, error: result.error, replyLength: result.reply.length },
  });

  // Post the reply (or the error message) to Slack from TS.
  let slackPosted = false;
  try {
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: result.reply,
    });
    slackPosted = true;
  } catch (err) {
    logStep?.({
      stage: 'agentic.slack_post_failed',
      level: 'ERROR',
      message: `Could not post agentic reply to Slack: ${String(err)}`,
    });
  }

  return {
    workflow: mode === 'informational' ? 'INFORMATIONAL' : 'CONVERSATIONAL',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: result.ok ? result.reply : (result.error ?? `Agentic ${mode} run failed.`),
    notifyDesktop: !result.ok,
    slackPosted,
  };
}
