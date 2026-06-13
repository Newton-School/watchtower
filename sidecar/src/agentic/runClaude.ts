import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { extractReplyFromCodexResult } from '../workflows/shared/workflowUtils.js';
import type { WorkflowStepLogger } from '../types/contracts.js';
import type { AgentBackendId } from '../backends/types.js';

export interface RunClaudeAgenticRequest {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  githubToken?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  /**
   * Pin a backend for this run instead of the global active backend. The
   * webapp-QA mode forces `claude-code` so it can shell out to Playwright and
   * accept image input regardless of the deployed default (often `codex`).
   */
  forceBackend?: AgentBackendId;
  /** Hard timeout for the spawned agent. Defaults to none (outer signal only). */
  timeoutMs?: number;
}

export interface RunClaudeAgenticResult {
  ok: boolean;
  reason: 'ok' | 'error' | 'aborted';
  /** Final reply text, ready to post to Slack. */
  reply: string;
  error?: string;
}

/**
 * Agentic Claude run via the existing `runCodex` infrastructure. Spawns the
 * claude CLI subprocess (OAuth via cmux-bundled binary — no API key needed)
 * inside `cwd` so the agent can use its native Read / Grep / Bash tools to
 * explore the repos. Returns the final stdout parsed to a Slack-ready
 * string.
 *
 * No custom tool surface — the agent does its own tool use internally.
 * agent_calls telemetry comes for free via `runCodex`'s `agentCallContext`
 * wrapping.
 */
export async function runClaudeAgentic(request: RunClaudeAgenticRequest): Promise<RunClaudeAgenticResult> {
  const { systemPrompt, userMessage, cwd, githubToken, logStep, signal, forceBackend, timeoutMs } = request;

  const prompt = `${systemPrompt}\n\n---\n\nUser message:\n${userMessage}`;
  const backendId = forceBackend ?? getActiveBackendId();

  try {
    const result = await runCodex({
      cwd,
      prompt,
      githubToken,
      ...highReasoningProfile(backendId),
      backendOverride: forceBackend,
      timeoutMs,
      onLog: logStep,
      signal,
    });

    if (signal?.aborted) {
      return { ok: false, reason: 'aborted', reply: '' };
    }

    const reply = extractReplyFromCodexResult(result).trim();

    if (!result.ok) {
      return {
        ok: false,
        reason: 'error',
        reply: reply || 'Agent finished with no output.',
        error: `runCodex returned ok=false (exitCode=${result.exitCode ?? 'unknown'})`,
      };
    }

    if (!reply) {
      return {
        ok: false,
        reason: 'error',
        reply: 'Agent finished with no output.',
        error: 'empty reply from codex',
      };
    }

    return { ok: true, reason: 'ok', reply };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      reply: `Agent crashed: ${String(err)}`,
      error: String(err),
    };
  }
}
