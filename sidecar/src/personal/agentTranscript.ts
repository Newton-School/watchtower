import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What an agent actually did, from Claude Code's own transcript of its run. An
 * agent's reply is only its word, and these two have text from Slack in their
 * context, so what they claim about Slack is checked against the calls they made.
 */

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Answered, and not with an error. */
  ok: boolean;
  text: string;
}

const PERSISTED_OUTPUT = /Full output saved to: (\S+)/;

/** Where the CLI keeps the transcripts of runs in `cwd`. */
export function transcriptDir(cwd: string, projectsDir = path.join(os.homedir(), '.claude', 'projects')): string {
  return path.join(projectsDir, fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function resultText(content: unknown, dir: string): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  // A long result is kept beside the transcript, with only a preview inside it.
  const persisted = PERSISTED_OUTPUT.exec(text)?.[1];
  if (!persisted) return text;
  const file = path.resolve(persisted);
  if (!file.startsWith(`${path.resolve(dir)}${path.sep}`)) return text;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return text;
  }
}

/**
 * Every tool call of every run in `cwd`, retries included, once each: a transcript
 * can hold one call on several lines. A call with no answer counts as not ok.
 */
export function readToolCalls(cwd: string, projectsDir?: string): ToolCall[] {
  const dir = transcriptDir(cwd, projectsDir);
  const calls = new Map<string, ToolCall>();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.jsonl')) : [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      let content: unknown;
      try {
        content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
      } catch {
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content as Array<{
        type?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>) {
        if (part.type === 'tool_use' && part.id && part.name && !calls.has(part.id)) {
          calls.set(part.id, { name: part.name, input: part.input ?? {}, ok: false, text: '' });
        } else if (part.type === 'tool_result' && part.tool_use_id) {
          const call = calls.get(part.tool_use_id);
          if (call) {
            call.ok = !part.is_error;
            call.text = resultText(part.content, dir);
          }
        }
      }
    }
  }
  return [...calls.values()];
}

/** Whether the agent's Slack reads showed it this message in this channel. */
export function sawSlackMessage(calls: ToolCall[], channelId: string, ts: string): boolean {
  const permalinkForm = `p${ts.replace('.', '')}`;
  return calls.some(
    call =>
      call.ok &&
      call.name.includes('__slack_') &&
      (call.input.channel_id === channelId || call.text.includes(channelId)) &&
      (call.input.message_ts === ts || call.text.includes(ts) || call.text.includes(permalinkForm)),
  );
}
