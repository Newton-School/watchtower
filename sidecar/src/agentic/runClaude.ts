import { getActiveBackendId } from '../codex/runCodex.js';
import {
  connectionLostReply,
  killedFromOutsideReply,
  usageLimitReply,
  runWithInfraRetry,
  cleanResetText,
} from '../codex/infraRetry.js';
import { highReasoningProfile, lightweightProfile } from '../codex/modelProfiles.js';
import { extractReplyFromCodexResult } from '../workflows/shared/workflowUtils.js';
import type { WorkflowStepLogger, CodexReasoningEffort } from '../types/contracts.js';
import type { AgentBackendId } from '../backends/types.js';

/**
 * Told to a run that only reads, so it does not spend turns on commands it
 * will be refused (issue #443). Matches `READ_ONLY_ALLOW_RULES`.
 */
export const READ_ONLY_RUN_NOTE = `This run is read-only. You can read and search the repos under the current directory, run read-only commands there (grep, sed -n, cat, ls, find, git log / show / grep / diff, gh pr view), use the connectors you were given, and write files under /tmp to attach to your reply. Anything else is refused without asking: editing files in the repos, scripts (python, node), network calls (curl), reading outside the repos. If a command is refused, find a read-only way instead (for example \`cd newton-web && git log\`, not \`git -C newton-web log\`).`;

/** A usage-limit notice is one line; a failed run that wrote more than this was answering. */
const USAGE_LIMIT_LINE_MAX = 300;

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
  /**
   * Model tier for the run, resolved against whichever backend is active —
   * callers pick a tier, never a model id, so the choice stays correct when
   * the backend flips. Defaults to 'high' (the pre-existing behavior).
   */
  tier?: 'light' | 'high';
  /**
   * Reasoning-effort override on top of the tier's default. Effort values are
   * backend-portable, unlike model ids. See docs/model-effort-audit.md.
   */
  effort?: CodexReasoningEffort;
  /**
   * Images from the Slack thread, already downloaded. The backend names them
   * in the prompt and lets the Read tool open their folder. Pass them only for
   * a backend that supports image input.
   */
  imagePaths?: string[];
  /**
   * What the run is doing, read after "while" in the reply when the
   * connection never comes back: "answering this", "testing the page".
   */
  doing?: string;
  /** The run only reads: no bypassed permissions, an allow-list instead (issue #443). */
  readOnly?: boolean;
  /** False for a run the shell sandbox breaks, such as browser QA (issue #445). */
  sandbox?: boolean;
}

export interface RunClaudeAgenticResult {
  ok: boolean;
  reason: 'ok' | 'error' | 'aborted';
  /** Final reply text, ready to post to Slack. */
  reply: string;
  error?: string;
  /** Set when the run died of something outside the agent: the network, a kill from outside, or the usage limit. */
  interrupted?: 'API_ERROR' | 'EXTERNAL_KILL' | 'USAGE_LIMIT';
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
  const {
    systemPrompt,
    userMessage,
    cwd,
    githubToken,
    logStep,
    signal,
    forceBackend,
    timeoutMs,
    tier,
    effort,
    imagePaths,
    doing = 'answering this',
    readOnly,
    sandbox,
  } = request;

  const prompt = `${readOnly ? `${systemPrompt}\n\n${READ_ONLY_RUN_NOTE}` : systemPrompt}\n\n---\n\nUser message:\n${userMessage}`;
  const backendId = forceBackend ?? getActiveBackendId();
  const profile = tier === 'light' ? lightweightProfile(backendId) : highReasoningProfile(backendId);

  try {
    // A dropped connection or a kill from outside is waited out and retried,
    // as for the change pipeline. Before, a lookup that lost its connection
    // posted the CLI's "API Error: Can't reach the API server" into the
    // thread as its answer (issue #439).
    const result = await runWithInfraRetry(
      {
        cwd,
        prompt,
        githubToken,
        ...profile,
        reasoningEffort: effort ?? profile.reasoningEffort,
        backendOverride: forceBackend,
        timeoutMs,
        imagePaths: imagePaths && imagePaths.length > 0 ? imagePaths : undefined,
        readOnly,
        sandbox,
        onLog: logStep,
        signal,
      },
      { label: 'the answer', logStep },
    );

    if (signal?.aborted) {
      return { ok: false, reason: 'aborted', reply: '' };
    }

    if (!result.ok && (result.errorKind === 'API_ERROR' || result.errorKind === 'EXTERNAL_KILL')) {
      return {
        ok: false,
        reason: 'error',
        reply:
          result.errorKind === 'API_ERROR'
            ? connectionLostReply(doing, { changesCode: false })
            : killedFromOutsideReply('My run', { changesCode: false }),
        error: `${result.errorKind}: ${result.apiErrorDetail ?? result.killSignal ?? 'interrupted'} (after ${result.infraRetries} retries)`,
        interrupted: result.errorKind,
      };
    }

    const reply = extractReplyFromCodexResult(result).trim();

    // The account's usage limit: the CLI's own limit text is not an answer, and
    // asking again before the reset fails the same way (issue #592). The limit
    // detection reads the run's last words, so a long failed answer that only
    // talks about rate limits is not taken for one: it needs a reset time, or
    // nothing else said.
    if (
      !result.ok &&
      result.errorKind === 'USAGE_LIMIT' &&
      (result.limitResetsAtText || reply.length < USAGE_LIMIT_LINE_MAX)
    ) {
      return {
        ok: false,
        reason: 'error',
        reply: usageLimitReply('do this', result.limitResetsAtText),
        error: `USAGE_LIMIT${result.limitResetsAtText ? `; resets at ${cleanResetText(result.limitResetsAtText)}` : ''}`,
        interrupted: 'USAGE_LIMIT',
      };
    }

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
