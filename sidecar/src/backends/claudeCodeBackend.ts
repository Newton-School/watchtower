import fsSync from 'node:fs';
import os from 'node:os';
import path, { delimiter as pathDelimiter } from 'node:path';
import type { AgentBackend, AgentRunRequest, ParsedBackendOutput } from './types.js';
import type { TokenUsage } from '../types/contracts.js';
import { parseStructuredOutput } from './codexBackend.js';

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * In plan mode (`--permission-mode plan`), Claude Code surfaces the
 * ExitPlanMode invocation under `permission_denials[]`, with the plan markdown
 * carried as `tool_input.plan`. Returns the most recent such plan, or
 * `undefined` if no ExitPlanMode call is present. The envelope's typical shape:
 *
 *   {
 *     ...,
 *     "permission_denials": [
 *       {
 *         "tool_name": "ExitPlanMode",
 *         "tool_use_id": "toolu_...",
 *         "tool_input": { "plan": "# Plan ...", "planFilePath": "..." }
 *       }
 *     ]
 *   }
 */
function extractExitPlanModePlan(denials: unknown): string | undefined {
  if (!Array.isArray(denials)) return undefined;
  // Walk back-to-front so a later ExitPlanMode call (e.g. after a clarification
  // round) wins over an earlier one in the same session.
  for (let i = denials.length - 1; i >= 0; i--) {
    const entry = denials[i];
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.tool_name !== 'ExitPlanMode') continue;
    const toolInput = record.tool_input;
    if (!toolInput || typeof toolInput !== 'object') continue;
    const plan = (toolInput as Record<string, unknown>).plan;
    if (typeof plan !== 'string') continue;
    const trimmed = plan.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function extractClaudeUsage(envelope: Record<string, unknown>): TokenUsage | undefined {
  const usageRaw = envelope.usage;
  if (!usageRaw || typeof usageRaw !== 'object') return undefined;
  const usage = usageRaw as Record<string, unknown>;
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  const cacheReadTokens = asFiniteNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = asFiniteNumber(usage.cache_creation_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(binary: string): string | undefined {
  const sourcePath = process.env.PATH ?? '';
  for (const dir of sourcePath.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, binary);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function resolveClaudeCodeBinary(): string {
  const fromPath = findInPath('claude');
  if (fromPath) return fromPath;

  const home = process.env.HOME?.trim() || os.homedir();
  const absoluteCandidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    home ? path.join(home, '.claude', 'bin', 'claude') : '',
    home ? path.join(home, '.local', 'bin', 'claude') : '',
  ].filter(Boolean);

  for (const candidate of absoluteCandidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return 'claude';
}

export const claudeCodeBackend: AgentBackend = {
  id: 'claude-code',
  displayName: 'Claude Code (Anthropic)',

  resolveBinary(): string {
    return resolveClaudeCodeBinary();
  },

  isAvailable(): boolean {
    try {
      const binary = resolveClaudeCodeBinary();
      if (binary !== 'claude') return true;
      return Boolean(findInPath('claude'));
    } catch {
      return false;
    }
  },

  supportsImages(): boolean {
    return true;
  },

  buildArgs(request: AgentRunRequest, _outputPath: string): string[] {
    const args: string[] = [];
    if (request.resumeSessionId) {
      args.push('--resume', request.resumeSessionId, '-p', request.prompt);
    } else {
      args.push('-p', request.prompt);
    }
    args.push('--output-format', 'json');
    // `--dangerously-skip-permissions` is equivalent to `--permission-mode bypassPermissions`
    // and silently wins over `--permission-mode plan`, so passing both leaves the model
    // without the ExitPlanMode tool. Choose one or the other.
    if (request.planMode) {
      args.push('--permission-mode', 'plan');
    } else {
      args.push('--dangerously-skip-permissions');
    }
    if (request.sessionId) {
      args.push('--session-id', request.sessionId);
    }
    if (request.model) {
      args.push('--model', request.model);
    }
    if (request.reasoningEffort) {
      args.push('--effort', request.reasoningEffort);
    }
    if (request.imagePaths) {
      for (const imagePath of request.imagePaths) {
        args.push('--image', imagePath);
      }
    }
    // Claude Code writes JSON to stdout when --output-format json is set.
    // The generic runner captures stdout and falls back to it when the
    // output file is missing, so we do not pass an --output flag here.
    return args;
  },

  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    env.PATH = basePath;
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    if (request.githubToken) {
      env.GITHUB_TOKEN = request.githubToken;
      env.GH_TOKEN = request.githubToken;
    }
    return env;
  },

  parseOutput(raw: string): ParsedBackendOutput {
    // Claude Code with --output-format json wraps the response in:
    // {"type":"result","subtype":"success","result":"<actual AI text>","session_id":"...","cost_usd":...,"usage":{...}}
    // We need to unwrap the "result" field first, then parse the inner content.
    // Cost and usage are extracted from the OUTER envelope before unwrapping.
    const outerParsed = parseStructuredOutput(raw);
    if (
      outerParsed.parsedJson &&
      outerParsed.parsedJson.type === 'result' &&
      typeof outerParsed.parsedJson.result === 'string'
    ) {
      const envelope = outerParsed.parsedJson;
      const costUsd = asFiniteNumber(envelope.cost_usd);
      const usage = extractClaudeUsage(envelope);
      const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : undefined;

      // Plan mode (`--permission-mode plan`): when the model invokes
      // ExitPlanMode, Claude Code records it under `permission_denials` (because
      // exiting plan mode requires user approval, which is granted out-of-band
      // by Watchtower's own admin gate). The plan markdown lives in
      // `tool_input.plan` — not in `result`. The `result` field is just the
      // assistant's final text (often a one-line "Plan written to ..." summary,
      // and sometimes empty when the model goes straight to ExitPlanMode).
      // Extract the plan from the denied ExitPlanMode call so the planner
      // workflow gets the actual plan instead of failing the
      // `Planner returned no plan content` gate. Captured the schema by running
      // `claude -p '...' --output-format json --permission-mode plan` locally.
      const planFromExitPlanMode = extractExitPlanModePlan(envelope.permission_denials);
      if (planFromExitPlanMode) {
        return {
          parsedJson: {
            status: 'success',
            planMarkdown: planFromExitPlanMode,
            summary: planFromExitPlanMode,
            actions: [],
            prUrl: '',
          },
          strategy: 'claude_unwrap+exit_plan_mode',
          usage,
          costUsd,
          sessionId,
        };
      }

      const innerText = (envelope.result as string).trim();
      // Try to parse the inner text as the structured JSON we asked the model to produce
      const innerParsed = parseStructuredOutput(innerText);
      if (innerParsed.parsedJson) {
        return {
          parsedJson: innerParsed.parsedJson,
          strategy: `claude_unwrap+${innerParsed.strategy}`,
          usage,
          costUsd,
          sessionId,
        };
      }
      // Inner text is plain text (not JSON) — surface it as a summary so
      // workflows can use it. Honor the envelope's own error signals: a
      // failed run (e.g. a usage-limit hit) must not persist as
      // status:"success" with the error text as its summary (issue #342).
      const envelopeIsError =
        envelope.is_error === true || (typeof envelope.subtype === 'string' && envelope.subtype !== 'success');
      return {
        parsedJson: { status: envelopeIsError ? 'error' : 'success', summary: innerText, actions: [], prUrl: '' },
        strategy: 'claude_unwrap+plain_text',
        usage,
        costUsd,
        sessionId,
      };
    }
    // Fallback: not a Claude Code wrapper — try parsing raw output directly
    return outerParsed;
  },

  availableModels(): string[] {
    return ['claude-sonnet-4-6', 'claude-opus-4-7'];
  },

  defaultModel(): string {
    return 'claude-sonnet-4-6';
  },
};
