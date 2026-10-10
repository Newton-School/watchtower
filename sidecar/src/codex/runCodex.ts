import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  CodexRunRequest,
  CodexRunResult,
  CostSource,
  WorkflowIntent,
  WorkflowStepLog,
} from '../types/contracts.js';
import type { AgentBackend, AgentBackendId } from '../backends/types.js';
import { getBackend } from '../backends/registry.js';
import { computeCostUsd } from '../pricing/modelPrices.js';
import { agentCallContext } from '../state/runContext.js';
import { createStreamDecoder } from './streamEvents.js';
import type { DossierStore } from '../state/dossierStore.js';

/**
 * Upper bound on retained raw stdout. With stream-json the child emits an event
 * per tool call, so an unbounded buffer would hold tens of MB per running job.
 * The decoder owns the authoritative final message; this tail is diagnostic.
 */
const MAX_RETAINED_STDOUT = 256 * 1024;

let activeBackendId: AgentBackendId = 'codex';

export function setActiveBackend(id: AgentBackendId): void {
  activeBackendId = id;
}

export function getActiveBackendId(): AgentBackendId {
  return activeBackendId;
}

/**
 * Pick a backend for a specific user, biased by their dossier. Today this is
 * a single conservative rule — users with a 7-day failure rate above 40% on
 * IMPLEMENTATION jobs get routed to claude-code (typically more thorough).
 * Everything else falls back to the global active backend. Decisions are
 * advisory and reversible; callers may pass an `onSelect` hook to log the
 * choice for offline review.
 */
export function selectBackendForUser(opts: {
  userId: string;
  workflow: WorkflowIntent;
  dossierStore: DossierStore;
  onSelect?: (info: {
    backend: AgentBackendId;
    reason: 'fallback' | 'high-failure-rate-implementation';
    failureRate7d?: number;
  }) => void;
}): AgentBackendId {
  const fallback = activeBackendId;
  if (!opts.userId) {
    opts.onSelect?.({ backend: fallback, reason: 'fallback' });
    return fallback;
  }

  let dossier;
  try {
    dossier = opts.dossierStore.getDossier(opts.userId);
  } catch {
    opts.onSelect?.({ backend: fallback, reason: 'fallback' });
    return fallback;
  }

  const fp = dossier.metrics['failure_fingerprint'] as { failureRate7d?: number; samples?: number } | undefined;
  const samples = fp?.samples ?? 0;
  const rate = fp?.failureRate7d;

  if (opts.workflow === 'IMPLEMENTATION' && typeof rate === 'number' && rate > 0.4 && samples >= 3) {
    opts.onSelect?.({
      backend: 'claude-code',
      reason: 'high-failure-rate-implementation',
      failureRate7d: rate,
    });
    return 'claude-code';
  }

  opts.onSelect?.({ backend: fallback, reason: 'fallback' });
  return fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error('CODex_TIMEOUT'));
    }, timeoutMs);

    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

type ParsedCodexOutput = {
  parsedJson?: Record<string, unknown>;
  strategy?: 'direct' | 'fenced_block' | 'first_object';
  attempts: Array<'direct' | 'fenced_block' | 'first_object'>;
  preview: string;
};

function previewOutput(raw: string, maxChars = 220): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function extractFencedJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function extractFirstTopLevelJsonObject(raw: string): string | undefined {
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(start, index + 1).trim();
        }
      }
    }
  }

  return undefined;
}

const USAGE_LIMIT_RE =
  /\b(?:you'?ve hit your (?:session|usage|weekly) limit|(?:session|usage) limit (?:reached|exceeded)|rate.?limit(?:ed| reached| exceeded))\b/i;
const LIMIT_RESETS_RE = /\bresets?\s+(?:at\s+)?([^"\n}]{1,80})/i;

/**
 * Classify a failed CLI run as a usage/session-limit hit (issue #342). The
 * limit envelope arrives as a normal JSON result whose text is e.g.
 * "You've hit your session limit · resets 9:40pm (Asia/Calcutta)" — exit
 * code 1, zero API tokens. Callers must treat this as retryable-at-a-known-
 * time, never as an agent verdict.
 */
export function detectUsageLimit(text: string): { resetsAtText?: string } | undefined {
  if (!text || !USAGE_LIMIT_RE.test(text)) return undefined;
  const resetsMatch = LIMIT_RESETS_RE.exec(text);
  const resetsAtText = resetsMatch?.[1]?.replace(/\\u00b7|·/g, '').trim();
  return { resetsAtText: resetsAtText && resetsAtText.length > 0 ? resetsAtText : undefined };
}

export function parseCodexStructuredOutput(raw: string): ParsedCodexOutput {
  const attempts: Array<'direct' | 'fenced_block' | 'first_object'> = [];
  const preview = previewOutput(raw);

  attempts.push('direct');
  try {
    const parsedJson = parseJsonObject(raw.trim());
    if (parsedJson) {
      return { parsedJson, strategy: 'direct', attempts, preview };
    }
  } catch {
    // fall through to salvage strategies
  }

  attempts.push('fenced_block');
  for (const candidate of extractFencedJsonCandidates(raw)) {
    try {
      const parsedJson = parseJsonObject(candidate);
      if (parsedJson) {
        return { parsedJson, strategy: 'fenced_block', attempts, preview };
      }
    } catch {
      // continue to next candidate
    }
  }

  attempts.push('first_object');
  const firstObjectCandidate = extractFirstTopLevelJsonObject(raw);
  if (firstObjectCandidate) {
    try {
      const parsedJson = parseJsonObject(firstObjectCandidate);
      if (parsedJson) {
        return { parsedJson, strategy: 'first_object', attempts, preview };
      }
    } catch {
      // final strategy failed
    }
  }

  return {
    attempts,
    preview,
  };
}

export async function runAgent(request: CodexRunRequest, backend: AgentBackend): Promise<CodexRunResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `watchtower-${backend.id}-`));
  const outputPath = path.join(tempDir, 'final-message.txt');

  const executable = backend.resolveBinary();

  request.onLog?.({
    stage: 'agent.prepare',
    message: `Preparing ${backend.displayName} command invocation.`,
    data: {
      backend: backend.id,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      schemaEnabled: Boolean(request.outputSchemaPath),
      model: request.model ?? 'default',
      reasoningEffort: request.reasoningEffort ?? 'default',
      githubTokenInjected: Boolean(request.githubToken),
      executable,
    },
  });

  const args = backend.buildArgs(request, outputPath);
  const envOverrides = backend.buildEnv(request, process.env.PATH ?? '');
  const env = { ...process.env, ...envOverrides };

  let timedOut = false;
  let cancelled = false;
  const modelUsed = request.model ?? backend.defaultModel();
  const spawnedAt = Date.now();
  const child = spawn(executable, args, {
    cwd: request.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Abort-signal handling for task cancellation. The force-kill timer and abort
  // listener are tracked at function scope so the finally block can release
  // them: otherwise a cancelled run leaves a 5s timer pending (holding a
  // reference to `child`), and the listener's closure keeps `child` reachable.
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  if (request.signal) {
    onAbort = (): void => {
      cancelled = true;
      request.onLog?.({
        stage: 'agent.cancelled',
        message: `${backend.displayName} execution cancelled by user request.`,
        level: 'WARN',
      });
      child.kill('SIGTERM');
      // Force kill after 5 seconds if SIGTERM doesn't work
      forceKillTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    };
    if (request.signal.aborted) {
      onAbort();
    } else {
      request.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  request.onLog?.({
    stage: 'agent.spawned',
    message: `${backend.displayName} process spawned.`,
    data: {
      pid: child.pid ?? null,
    },
  });

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutStarted = false;
  let stderrStarted = false;

  // Decodes the backend's JSONL event stream into step logs as the run
  // progresses. This is what turns an opaque multi-minute agent run into a live
  // trail of tool / skill / MCP / subagent activity in job_logs and the Slack
  // status line.
  const decoder = createStreamDecoder(backend.id);

  /** Emit decoded steps without ever letting a decode bug kill the run. */
  const emitSteps = (steps: WorkflowStepLog[]): void => {
    for (const step of steps) {
      try {
        request.onLog?.(step);
      } catch {
        // Non-fatal: progress reporting must not abort agent execution.
      }
    }
  };

  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    // Bounded: `--output-format stream-json --verbose` produces far more stdout
    // than the old single-blob JSON, and this string used to grow without
    // limit. The tail is what matters for post-mortem; the authoritative final
    // message comes from the decoder, not from this buffer.
    stdout = stdout.length > MAX_RETAINED_STDOUT ? stdout.slice(-MAX_RETAINED_STDOUT) + text : stdout + text;
    stdoutBytes += Buffer.byteLength(text);
    if (!stdoutStarted) {
      stdoutStarted = true;
      request.onLog?.({
        stage: 'agent.stdout.start',
        message: `${backend.displayName} started streaming stdout.`,
      });
    }
    try {
      emitSteps(decoder.push(text));
    } catch {
      // Non-fatal: a malformed stream must not abort the run.
    }
  });
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderr += text;
    stderrBytes += Buffer.byteLength(text);
    if (!stderrStarted) {
      stderrStarted = true;
      request.onLog?.({
        stage: 'agent.stderr.start',
        message: `${backend.displayName} started streaming stderr.`,
        level: 'WARN',
      });
    }
  });

  try {
    const childDone = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => resolve(code));
    });

    const exitCode = request.timeoutMs
      ? await withTimeout(childDone, request.timeoutMs, () => {
          timedOut = true;
          request.onLog?.({
            stage: 'agent.timeout',
            message: `${backend.displayName} execution exceeded timeout and was force-killed.`,
            level: 'ERROR',
            data: {
              timeoutMs: request.timeoutMs,
            },
          });
          child.kill('SIGKILL');
        })
      : await childDone;

    request.onLog?.({
      stage: 'agent.process.exit',
      message: `${backend.displayName} process exited.`,
      data: {
        exitCode,
        timedOut,
        stdoutBytes,
        stderrBytes,
      },
    });

    // Decode anything left in the buffer without a trailing newline.
    try {
      emitSteps(decoder.flush());
    } catch {
      // Non-fatal.
    }

    let lastMessage = '';
    // Claude Code streams JSONL to stdout, not a file. The authoritative final
    // output is the `{"type":"result",…}` line the decoder retained — handing
    // parseOutput the whole JSONL buffer would break the envelope unwrap and
    // the plan-mode permission_denials harvest with it. Fall back to the
    // concatenated assistant prose (still better than raw JSONL), then stdout.
    if (backend.id === 'claude-code') {
      lastMessage = decoder.finalMessage() ?? decoder.assistantText() ?? stdout;
    } else {
      try {
        lastMessage = await fs.readFile(outputPath, 'utf8');
        request.onLog?.({
          stage: 'agent.output.read',
          message: `Read deterministic final output file from ${backend.displayName}.`,
          data: {
            outputPath,
            bytes: Buffer.byteLength(lastMessage),
          },
        });
      } catch {
        // Output file not written — recover the last agent message from the
        // JSONL stream. Raw stdout is now events, not prose, so it is only the
        // last resort.
        lastMessage = decoder.finalMessage() ?? decoder.assistantText() ?? stdout;
        request.onLog?.({
          stage: 'agent.output.missing',
          message: lastMessage
            ? `${backend.displayName} output file missing; falling back to stdout.`
            : `${backend.displayName} final output file was not readable.`,
          level: 'WARN',
          data: {
            outputPath,
            stdoutFallback: Boolean(lastMessage),
          },
        });
      }
    }

    const parsedOutput = backend.parseOutput(lastMessage, { planMode: request.planMode });
    const parsedJson = parsedOutput.parsedJson;
    if (parsedJson) {
      request.onLog?.({
        stage: 'agent.output.parsed',
        message: `Parsed ${backend.displayName} final output as JSON.`,
        data: {
          strategy: parsedOutput.strategy,
        },
      });
      // CLI-drift telemetry (#408): a plan-mode run that did NOT yield an
      // ExitPlanMode harvest means the installed CLI no longer exposes the
      // tool in headless plan sessions — the layered fallbacks cover it, but
      // surface the drift instead of degrading silently for weeks.
      if (request.planMode && parsedOutput.strategy !== 'claude_unwrap+exit_plan_mode') {
        request.onLog?.({
          stage: 'agent.plan.harvest_fallback',
          level: 'WARN',
          message: `Plan-mode run harvested via "${parsedOutput.strategy}" (no ExitPlanMode denial) — installed CLI likely runs plan mode through plan files.`,
          data: { strategy: parsedOutput.strategy },
        });
      }
    } else {
      // Capture a bounded preview of the raw final message for post-mortem.
      // Pre-fix this log carried no payload, making it impossible to tell
      // whether the model returned prose, markdown, an HTTP error, or a
      // truncated JSON without re-running. 2 KB is enough to see the shape
      // without flooding job_logs.
      const rawPreview = (lastMessage ?? '').slice(0, 2048);
      request.onLog?.({
        stage: 'agent.output.parse_failed',
        message: `${backend.displayName} final output is not valid JSON.`,
        level: 'WARN',
        data: {
          rawLength: (lastMessage ?? '').length,
          rawPreview,
        },
      });
    }

    const durationMs = Date.now() - spawnedAt;
    const usage = parsedOutput.usage;
    let costUsd = parsedOutput.costUsd;
    let costSource: CostSource | undefined = costUsd !== undefined ? 'reported' : undefined;
    if (costUsd === undefined && usage) {
      const computed = computeCostUsd(usage, modelUsed);
      if (computed !== undefined) {
        costUsd = computed;
        costSource = 'computed';
      }
    }

    const ok = !timedOut && !cancelled && exitCode === 0;

    // Classify limit hits on failed runs so callers can pause/retry at the
    // stated reset instead of burning retries on doomed spawns (issue #342).
    const usageLimit = !ok && !timedOut && !cancelled ? detectUsageLimit(lastMessage) : undefined;
    if (usageLimit) {
      request.onLog?.({
        stage: 'agent.usage_limit',
        message: `${backend.displayName} hit the account usage limit${usageLimit.resetsAtText ? ` (resets ${usageLimit.resetsAtText})` : ''}.`,
        level: 'WARN',
        data: { resetsAtText: usageLimit.resetsAtText },
      });
    }

    const callContext = agentCallContext.getStore();
    if (callContext) {
      try {
        callContext.store.recordAgentCall({
          jobId: callContext.jobId,
          pipelineRunId: callContext.pipelineRunId,
          role: callContext.role,
          backend: backend.id,
          model: modelUsed,
          durationMs,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          cacheReadTokens: usage?.cacheReadTokens,
          cacheCreationTokens: usage?.cacheCreationTokens,
          costUsd,
          costSource,
          ok,
        });
      } catch {
        // Non-fatal: persistence failure should not block agent execution
      }
    }

    return {
      ok,
      exitCode,
      timedOut,
      cancelled,
      stdout,
      stderr,
      lastMessage,
      parsedJson,
      ...(usageLimit ? { errorKind: 'USAGE_LIMIT' as const, limitResetsAtText: usageLimit.resetsAtText } : {}),
      durationMs,
      usage,
      costUsd,
      costSource,
      backend: backend.id,
      modelUsed,
      sessionId: parsedOutput.sessionId,
    };
  } catch (error) {
    request.onLog?.({
      stage: 'agent.execution.error',
      message: `${backend.displayName} process execution threw before completion.`,
      level: 'ERROR',
      data: {
        error: String(error),
      },
    });

    const errorDurationMs = Date.now() - spawnedAt;

    const callContext = agentCallContext.getStore();
    if (callContext) {
      try {
        callContext.store.recordAgentCall({
          jobId: callContext.jobId,
          pipelineRunId: callContext.pipelineRunId,
          role: callContext.role,
          backend: backend.id,
          model: modelUsed,
          durationMs: errorDurationMs,
          ok: false,
        });
      } catch {
        // Non-fatal
      }
    }

    return {
      ok: false,
      exitCode: null,
      timedOut,
      cancelled,
      stdout,
      stderr: `${stderr}\n${String(error)}${
        String(error).includes('ENOENT')
          ? `\n${backend.displayName} executable not found. Ensure the CLI is installed and accessible from PATH.`
          : ''
      }`,
      lastMessage: '',
      durationMs: errorDurationMs,
      backend: backend.id,
      modelUsed,
    };
  } finally {
    // Release the abort wiring and per-process listeners. By the time we reach
    // here the child has already closed (the try awaited childDone), so the 5s
    // force-kill timer is moot — clearing it stops a dead-process SIGKILL and
    // frees the `child` reference it (and the abort listener) captured.
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    if (request.signal && onAbort) {
      request.signal.removeEventListener('abort', onAbort);
    }
    child.removeAllListeners();
    request.onLog?.({
      stage: 'agent.cleanup',
      message: `Cleaning up temporary ${backend.displayName} output directory.`,
      data: {
        tempDir,
      },
    });
    void fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function runCodex(request: CodexRunRequest): Promise<CodexRunResult> {
  // `backendOverride` lets a single run pin a backend (e.g. webapp-QA forces
  // `claude-code` for Bash-driven Playwright) without flipping the global
  // active backend that every other workflow relies on.
  return runAgent(request, getBackend(request.backendOverride ?? activeBackendId));
}
