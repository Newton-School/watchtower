import fsSync from 'node:fs';
import os from 'node:os';
import path, { delimiter as pathDelimiter } from 'node:path';
import type { AgentBackend, AgentRunRequest, ParseOutputOptions, ParsedBackendOutput } from './types.js';
import type { TokenUsage } from '../types/contracts.js';
import { parseStructuredOutput } from './codexBackend.js';

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) ? value : undefined;
}

/** Upper bound for reading an agent-written plan file into memory. */
const MAX_PLAN_FILE_BYTES = 256 * 1024;

/** Bounded, non-throwing read of a plan file the agent wrote. */
function readPlanFile(filePath: string): string | undefined {
  try {
    const resolved = filePath.startsWith('~/') ? path.join(os.homedir(), filePath.slice(2)) : filePath;
    const stat = fsSync.statSync(resolved);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PLAN_FILE_BYTES) return undefined;
    const content = fsSync.readFileSync(resolved, 'utf8').trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plan-file reference in the agent's final text, e.g.
 * "I've written the plan to `/Users/x/.claude/plans/user-context-auto-generated-foo.md`".
 * Newer Claude Code CLIs (observed on 2.1.209) run headless plan mode through
 * a plan FILE instead of the ExitPlanMode tool — the file the agent names is
 * the authoritative plan. Never glob "newest file"; only trust the named path.
 * NOTE: the segment class excludes `/` so segmentation is unambiguous — with
 * `/` included, `(?:[^…]+\/)*?` backtracks exponentially on slash-dense
 * tokens (S3 URLs, base64 blobs) and a single result text can hang the
 * event loop for seconds (#408 review).
 */
const PLAN_FILE_REF_RE = /(?:~\/|\/(?:[^\s`'"/]+\/)*?)\.claude\/plans\/[^\s`'"]+\.md/;

/**
 * Harvest the plan from a plan-mode result envelope.
 *
 * CLI behavior differs by version:
 * - Claude Code ~2.1.142 (fixtures in tests): the model calls ExitPlanMode,
 *   which headless mode records under `permission_denials[]` with the plan
 *   markdown in `tool_input.plan` (sometimes only `tool_input.planFilePath`).
 * - Claude Code ≥~2.1.2xx (observed 2.1.209): ExitPlanMode is NOT registered
 *   in headless `-p --permission-mode plan` sessions at all; the model writes
 *   the plan to `~/.claude/plans/<slug>.md` and mentions that path in its
 *   final text (issue #408).
 *
 * Harvest order: denial `tool_input.plan` → denial `tool_input.planFilePath`
 * (file read) → plan-file path referenced in the final text (file read).
 * Returns undefined when none yields content.
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
    const input = toolInput as Record<string, unknown>;
    const plan = input.plan;
    if (typeof plan === 'string' && plan.trim().length > 0) return plan.trim();
    // Some envelopes carry only the plan-file path — recover from disk.
    if (typeof input.planFilePath === 'string' && input.planFilePath.trim().length > 0) {
      const fromFile = readPlanFile(input.planFilePath.trim());
      if (fromFile) return fromFile;
    }
  }
  return undefined;
}

/** Recover the plan from a plan-file path the agent named in its final text. */
function extractPlanFromReferencedFile(finalText: string): string | undefined {
  const match = finalText.match(PLAN_FILE_REF_RE);
  if (!match) return undefined;
  return readPlanFile(match[0]);
}

/**
 * Strip harness meta-commentary (tool availability, plan-file bookkeeping)
 * from a PLAN-MODE agent's final text before it becomes a user-facing
 * summary. Deliberately narrow — only bookkeeping-sentence shapes, so a plan
 * or answer that legitimately DISCUSSES ExitPlanMode / permission modes
 * (e.g. about this repo's own backend code) is never mutilated.
 * Fail-open: if stripping would leave nothing, return the original text.
 */
const META_LINE_RE = new RegExp(
  [
    /written the plan to\s+\S*\.claude\/plans\//.source,
    /\bExitPlanMode\b[^\n]*\b(?:isn'?t|is not|not)\s+(?:available|registered|callable)/.source,
    /\bisn'?t registered as a deferred tool\b/.source,
  ].join('|'),
  'i',
);

/** Strict variant: may return '' when the whole text is bookkeeping. */
function stripMetaLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !META_LINE_RE.test(line))
    .join('\n')
    .trim();
}

export function stripPlanHarnessMeta(text: string): string {
  const stripped = stripMetaLines(text);
  return stripped.length > 0 ? stripped : text;
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
    // `stream-json` (which requires `--verbose` under `--print`) emits one JSON
    // event per line as the run progresses instead of a single blob at exit.
    // That is what makes live tool/skill/MCP narration possible; runCodex's
    // stream decoder recovers the final `{"type":"result",…}` envelope from the
    // stream, so parseOutput below still sees exactly what it saw before.
    args.push('--output-format', 'stream-json', '--verbose');
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
    // Expose only the requested MCP servers (issue: scoped investigation
    // reaching Metabase). `--strict-mcp-config` makes the headless run ignore
    // the user's global/project MCP config and load ONLY these — so a bug
    // investigation can't accidentally pull in unrelated servers. Inline JSON
    // avoids a temp file. `--dangerously-skip-permissions` (set above in
    // non-plan mode) auto-allows the MCP tools; OAuth HTTP servers reuse the
    // CLI's Keychain-cached token, which requires HOME in buildEnv.
    if (request.mcpServers && Object.keys(request.mcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: request.mcpServers }), '--strict-mcp-config');
    }
    // Claude Code writes JSON to stdout when --output-format json is set.
    // The generic runner captures stdout and falls back to it when the
    // output file is missing, so we do not pass an --output flag here.
    return args;
  },

  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string> {
    const env: Record<string, string> = {};
    env.PATH = basePath;
    // HOME (and USER) are required for Claude Code to find its config and the
    // Keychain/credentials store where MCP OAuth tokens live — without HOME an
    // HTTP/OAuth MCP server (e.g. Metabase) silently fails to connect in the
    // headless spawn. Passing them is also more correct for every other run.
    const home = process.env.HOME;
    if (home) {
      env.HOME = home;
    }
    if (process.env.USER) {
      env.USER = process.env.USER;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    if (request.githubToken) {
      env.GITHUB_TOKEN = request.githubToken;
      env.GH_TOKEN = request.githubToken;
    }
    return env;
  },

  parseOutput(raw: string, opts?: ParseOutputOptions): ParsedBackendOutput {
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
      // The installed CLI reports `total_cost_usd`; older builds (and the test
      // fixtures written against them) used `cost_usd`. Reading only the legacy
      // key meant real claude-code runs recorded no cost at all in agent_calls.
      const costUsd = asFiniteNumber(envelope.total_cost_usd) ?? asFiniteNumber(envelope.cost_usd);
      const usage = extractClaudeUsage(envelope);
      const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : undefined;

      // Plan mode (`--permission-mode plan`): on older CLIs (~2.1.142) the
      // model invokes ExitPlanMode, which headless mode records under
      // `permission_denials` (exiting plan mode requires user approval,
      // granted out-of-band by Watchtower's own admin gate) — the plan
      // markdown lives in `tool_input.plan`/`tool_input.planFilePath`, not in
      // `result`. On newer CLIs (observed 2.1.209) ExitPlanMode is NOT
      // registered in headless plan sessions at all; the model writes the
      // plan to `~/.claude/plans/<slug>.md` and only mentions that path in
      // its final text (issue #408). Try the denial harvest first, then the
      // referenced plan file, so the planner workflow gets the actual plan
      // instead of harness meta-text.
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
      // Plan-file recovery is PLAN-MODE ONLY, and only when the final text is
      // meta-shaped (short after stripping bookkeeping). Two failure modes it
      // must never cause (#408 review): (a) an ordinary run whose result
      // merely mentions a plans path getting its output replaced by a stale
      // file; (b) a real final-message plan that cites an older plan file
      // being displaced by that file's content.
      if (opts?.planMode) {
        // Strict strip (may be empty): the gate must see how much REAL
        // content remains, so the fail-open wrapper is wrong here.
        const looksMetaOnly = stripMetaLines(innerText).length < 200;
        if (looksMetaOnly) {
          const planFromReferencedFile = extractPlanFromReferencedFile(innerText);
          if (planFromReferencedFile) {
            return {
              parsedJson: {
                status: 'success',
                planMarkdown: planFromReferencedFile,
                summary: planFromReferencedFile,
                actions: [],
                prUrl: '',
              },
              strategy: 'claude_unwrap+plan_file',
              usage,
              costUsd,
              sessionId,
            };
          }
        }
      }
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
      // workflows can use it; in plan mode, minus any harness bookkeeping
      // lines (#408). Honor the envelope's own error signals: a failed run
      // (e.g. a usage-limit hit) must not persist as status:"success" with
      // the error text as its summary (issue #342).
      const envelopeIsError =
        envelope.is_error === true || (typeof envelope.subtype === 'string' && envelope.subtype !== 'success');
      return {
        parsedJson: {
          status: envelopeIsError ? 'error' : 'success',
          summary: opts?.planMode ? stripPlanHarnessMeta(innerText) : innerText,
          actions: [],
          prUrl: '',
        },
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
