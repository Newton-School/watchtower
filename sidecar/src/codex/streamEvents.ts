import { sanitizeStatusFragment, summarizeCommand } from '../slack/statusNarrator.js';
import type { WorkflowStepLog } from '../types/contracts.js';

/**
 * Guard against a pathological single line (a huge tool result echoed inline)
 * growing the partial-line buffer without bound. Past this, the buffer is
 * dropped and decoding resynchronizes at the next newline.
 */
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Streaming decoder for a CLI backend's stdout.
 *
 * Both CLIs can emit newline-delimited JSON — `claude --output-format
 * stream-json --verbose` and `codex exec --json` — which turns an otherwise
 * opaque multi-minute agent run into a live event feed. Feed it stdout chunks;
 * it returns the `WorkflowStepLog`s to emit, which flow through the existing
 * `onLog` → `logStep` path into both `job_logs` and the Slack status line.
 */
export interface StreamDecoder {
  /** Feed a raw stdout chunk. Returns step logs to emit, possibly empty. */
  push(chunk: string): WorkflowStepLog[];
  /** Decode any trailing line left without a newline at process exit. */
  flush(): WorkflowStepLog[];
  /**
   * The backend's final message, recovered from the stream:
   * the raw `{"type":"result",…}` line for Claude Code (which `parseOutput`
   * unwraps), or the last agent message text for Codex.
   */
  finalMessage(): string | undefined;
  /**
   * Concatenated assistant prose. Used as a fallback when no result event
   * arrived — strictly better than handing raw JSONL to a summary parser.
   */
  assistantText(): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Hostname only — a full URL is too long and can carry query-string secrets. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return sanitizeStatusFragment(url, 40);
  }
}

/**
 * Reduce a Claude `tool_use` input to one short, safe descriptor. Returns
 * undefined when the tool needs no detail (MCP tools are described by their
 * server name, which the narrator reads off the tool name itself).
 */
export function describeToolInput(tool: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;

  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const filePath = asString(input.file_path) ?? asString(input.notebook_path);
      return filePath ? sanitizeStatusFragment(filePath, 60) : undefined;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = asString(input.pattern);
      return pattern ? sanitizeStatusFragment(`"${pattern}"`, 50) : undefined;
    }
    case 'Bash':
    case 'BashOutput': {
      const command = asString(input.command);
      return command ? summarizeCommand(command) : undefined;
    }
    case 'Skill':
      return asString(input.skill) ? sanitizeStatusFragment(String(input.skill), 40) : undefined;
    case 'Agent':
    case 'Task': {
      // `subagent_type` is absent when the caller takes the default agent, so
      // fall back to the human description the CLI also supplies.
      const subagent = asString(input.subagent_type);
      const description = asString(input.description);
      const detail = subagent ?? description;
      return detail ? sanitizeStatusFragment(detail, 40) : undefined;
    }
    case 'WebFetch': {
      const url = asString(input.url);
      return url ? hostOf(url) : undefined;
    }
    case 'WebSearch': {
      const query = asString(input.query);
      return query ? sanitizeStatusFragment(`"${query}"`, 50) : undefined;
    }
    default:
      return undefined;
  }
}

function toolStep(tool: string, detail: string | undefined): WorkflowStepLog {
  return {
    stage: 'agent.tool.use',
    message: detail ? `Agent used ${tool}: ${detail}` : `Agent used ${tool}.`,
    data: detail ? { tool, detail } : { tool },
  };
}

/**
 * Claude Code `--output-format stream-json --verbose`.
 *
 * Observed event stream (probe, CLI 2.1.220):
 *   system/init → assistant(content[] of text | tool_use) → user(tool_result)
 *   → … → result/success
 * Also emitted and safely ignored: system/hook_started, system/hook_response,
 * rate_limit_event.
 */
function decodeClaudeLine(raw: string, state: DecoderState): WorkflowStepLog[] {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(event)) return [];

  const type = asString(event.type);

  if (type === 'system' && asString(event.subtype) === 'init') {
    const tools = Array.isArray(event.tools) ? event.tools.length : undefined;
    const skills = Array.isArray(event.skills) ? event.skills.length : undefined;
    const mcpServers = Array.isArray(event.mcp_servers) ? event.mcp_servers.length : undefined;
    return [
      {
        stage: 'agent.session.init',
        message: 'Agent session initialized.',
        data: {
          model: asString(event.model),
          tools,
          skills,
          mcpServers,
          permissionMode: asString(event.permissionMode),
        },
      },
    ];
  }

  if (type === 'assistant') {
    const message = isRecord(event.message) ? event.message : undefined;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const steps: WorkflowStepLog[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const blockType = asString(block.type);
      if (blockType === 'tool_use') {
        const tool = asString(block.name);
        if (!tool) continue;
        steps.push(toolStep(tool, describeToolInput(tool, block.input)));
      } else if (blockType === 'text') {
        const text = asString(block.text);
        if (!text) continue;
        state.assistantText.push(text);
        steps.push({
          stage: 'agent.message',
          message: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        });
      }
    }
    return steps;
  }

  if (type === 'result') {
    // Retain the raw line: parseOutput unwraps this exact envelope (including
    // `permission_denials`, which carries the plan-mode harvest).
    state.finalMessage = raw;
    return [
      {
        stage: 'agent.result',
        message: 'Agent run completed.',
        data: {
          subtype: asString(event.subtype),
          numTurns: typeof event.num_turns === 'number' ? event.num_turns : undefined,
          durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
          costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        },
      },
    ];
  }

  // system/hook_*, rate_limit_event, user/tool_result and anything the CLI adds
  // later: no status value, and silently ignoring keeps the decoder
  // forward-compatible with CLI changes.
  return [];
}

/**
 * Codex `exec --json`.
 *
 * Observed event stream (probe): thread.started → turn.started →
 * item.started/item.completed (item.type: agent_message | command_execution |
 * …) → turn.completed.
 *
 * Only known item types produce steps — an unrecognized item is skipped rather
 * than narrated as garbage.
 */
function decodeCodexLine(raw: string, state: DecoderState): WorkflowStepLog[] {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(event)) return [];

  const type = asString(event.type);

  if (type === 'turn.completed') {
    const usage = isRecord(event.usage) ? event.usage : undefined;
    return [
      {
        stage: 'agent.result',
        message: 'Agent turn completed.',
        data: usage ? { usage } : undefined,
      },
    ];
  }

  if (type !== 'item.started' && type !== 'item.completed') return [];
  const item = isRecord(event.item) ? event.item : undefined;
  if (!item) return [];
  const itemType = asString(item.type);

  if (itemType === 'agent_message') {
    const text = asString(item.text);
    if (!text || type !== 'item.completed') return [];
    state.assistantText.push(text);
    // Codex has no result envelope; the last agent message IS the final answer.
    state.finalMessage = text;
    return [{ stage: 'agent.message', message: text.length > 500 ? `${text.slice(0, 500)}…` : text }];
  }

  if (itemType === 'command_execution') {
    // Emit when the command starts — that is when the work begins. The matching
    // item.completed would double-report it.
    if (type !== 'item.started') return [];
    const command = asString(item.command);
    return [toolStep('Bash', command ? summarizeCommand(command) : undefined)];
  }

  if (itemType === 'file_change' || itemType === 'patch_apply') {
    if (type !== 'item.started') return [];
    const path = asString(item.path);
    return [toolStep('Edit', path ? sanitizeStatusFragment(path, 60) : undefined)];
  }

  if (itemType === 'mcp_tool_call') {
    if (type !== 'item.started') return [];
    const server = asString(item.server) ?? 'mcp';
    const tool = asString(item.tool) ?? 'call';
    return [toolStep(`mcp__${server}__${tool}`, undefined)];
  }

  if (itemType === 'web_search') {
    if (type !== 'item.started') return [];
    const query = asString(item.query);
    return [toolStep('WebSearch', query ? sanitizeStatusFragment(`"${query}"`, 50) : undefined)];
  }

  return [];
}

interface DecoderState {
  finalMessage?: string;
  assistantText: string[];
}

/**
 * Build a decoder for a backend id. Unknown backends get a decoder that emits
 * nothing but still buffers safely, so adding a backend cannot crash the run.
 */
export function createStreamDecoder(backendId: string): StreamDecoder {
  const state: DecoderState = { assistantText: [] };
  const decodeLine =
    backendId === 'claude-code' ? decodeClaudeLine : backendId === 'codex' ? decodeCodexLine : undefined;

  let buffer = '';

  function consume(text: string, isFinal: boolean): WorkflowStepLog[] {
    if (!decodeLine) return [];
    buffer += text;

    if (Buffer.byteLength(buffer) > MAX_PARTIAL_LINE_BYTES && !buffer.includes('\n')) {
      // One absurdly long line: drop it and resynchronize at the next newline.
      buffer = '';
      return [];
    }

    const lines = buffer.split('\n');
    // Unless this is the final flush, the last element is an incomplete line.
    buffer = isFinal ? '' : (lines.pop() ?? '');

    const steps: WorkflowStepLog[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      steps.push(...decodeLine(trimmed, state));
    }
    return steps;
  }

  return {
    push(chunk: string): WorkflowStepLog[] {
      return consume(chunk, false);
    },
    flush(): WorkflowStepLog[] {
      return consume('', true);
    },
    finalMessage(): string | undefined {
      return state.finalMessage;
    },
    assistantText(): string | undefined {
      const joined = state.assistantText.join('\n').trim();
      return joined.length > 0 ? joined : undefined;
    },
  };
}
