import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The owner's Claude Code sessions that left work unfinished: ended on an
 * unanswered question, or left files uncommitted or commits unpushed. Worked
 * out from the transcripts and git, with no model involved. Only sessions he
 * ran himself: `sdk-cli` ones are headless, such as miniOG's own agents.
 * Transcripts can be 100 MB, so they are streamed and never held in memory.
 */

export interface SessionFacts {
  sessionId: string;
  /** Where the session started: where `claude --resume` finds it. */
  cwd: string;
  /** Where it ended up, which may be a worktree: where its work is. */
  workDir: string;
  /** Files it edited with the file tools, to tell its changes from others' in a shared clone. */
  editedFiles: string[];
  title: string;
  branch?: string;
  lastActivityAt: string;
  lastReply: string;
  endedOnQuestion: boolean;
}

export interface UnfinishedSession extends SessionFacts {
  /** What's unfinished, in words. */
  reasons: string[];
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NOISE_PREFIXES = [
  '<local-command',
  '<command-message>',
  '<task-notification>',
  '<system-reminder>',
  '[Request interrupted',
  'This session is being continued',
];

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      const entry = part as { type?: unknown; text?: unknown };
      return entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : '';
    })
    .join('\n');
}

function isRealPrompt(content: unknown): boolean {
  if (Array.isArray(content) && content.some(part => (part as { type?: unknown })?.type === 'tool_result')) {
    return false;
  }
  const text = textOf(content).trim();
  return Boolean(text) && !NOISE_PREFIXES.some(prefix => text.startsWith(prefix));
}

/** One session's facts, if it is the owner's own and he prompted it since `sinceIso`. */
export async function readSession(transcript: string, sinceIso: string): Promise<SessionFacts | undefined> {
  const sessionId = path.basename(transcript, '.jsonl');
  if (!SESSION_ID.test(sessionId)) return undefined;
  let cwd: string | undefined;
  let workDir: string | undefined;
  const editedFiles = new Set<string>();
  let entrypoint: string | undefined;
  let branch: string | undefined;
  let title: string | undefined;
  let firstPromptInWindow: string | undefined;
  let lastActivityAt = '';
  let lastReply = '';
  let lastTool: string | undefined;

  const input = fs.createReadStream(transcript);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: {
      type?: string;
      aiTitle?: string;
      timestamp?: string;
      cwd?: string;
      entrypoint?: string;
      gitBranch?: string;
      isSidechain?: boolean;
      isMeta?: boolean;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.aiTitle) title = entry.aiTitle;
    cwd ??= entry.cwd;
    if (entry.cwd) workDir = entry.cwd;
    entrypoint ??= entry.entrypoint;
    // Most transcripts are headless runs, and some are huge: stop reading as soon as that shows.
    if (entrypoint && entrypoint !== 'cli') {
      // `close` alone leaves the file open, and this happens hundreds of times a night.
      lines.close();
      input.destroy();
      return undefined;
    }
    if (entry.gitBranch) branch = entry.gitBranch;
    if (entry.timestamp) lastActivityAt = entry.timestamp;
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    if (entry.type === 'user' && !entry.isMeta && isRealPrompt(content)) {
      if (entry.timestamp && entry.timestamp >= sinceIso) firstPromptInWindow ??= textOf(content).trim();
      lastTool = undefined;
      lastReply = '';
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const part of content as Array<{
        type?: string;
        name?: string;
        text?: string;
        input?: { file_path?: unknown; notebook_path?: unknown };
      }>) {
        if (part.type === 'text' && part.text?.trim()) {
          lastReply = part.text.trim();
          lastTool = undefined;
        } else if (part.type === 'tool_use') {
          lastTool = part.name;
          const edited = part.input?.file_path ?? part.input?.notebook_path;
          if (part.name && EDIT_TOOLS.has(part.name) && typeof edited === 'string') editedFiles.add(edited);
        }
      }
    }
  }

  if (entrypoint !== 'cli' || !cwd || !firstPromptInWindow) return undefined;
  return {
    sessionId,
    cwd,
    workDir: workDir ?? cwd,
    editedFiles: [...editedFiles],
    title: (title ?? firstPromptInWindow).replace(/\s+/g, ' ').slice(0, 140),
    branch,
    lastActivityAt,
    lastReply: lastReply.slice(-500),
    endedOnQuestion: lastReply.endsWith('?') || (lastTool !== undefined && QUESTION_TOOLS.has(lastTool)),
  };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    // `git status` otherwise rewrites the index, and these are the owner's working clones.
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: 20_000 });
    return stdout;
  } catch {
    return undefined;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Uncommitted paths in `git status --porcelain` output, made absolute. */
export function dirtyPaths(porcelain: string, root: string): string[] {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const entry = line.slice(3);
      const target = entry.includes(' -> ') ? (entry.split(' -> ').pop() ?? entry) : entry;
      return path.resolve(root, target.replace(/^"|"$/g, ''));
    });
}

/**
 * What a session left unfinished, checked against the repo as it is now. Only
 * the files it edited count as its uncommitted work: a shared clone is often
 * dirty for other reasons, and that says nothing about this session.
 */
export async function unfinishedReasons(facts: SessionFacts): Promise<string[]> {
  const reasons: string[] = [];
  if (facts.endedOnQuestion) reasons.push('Ended on a question you never answered.');
  if (!fs.existsSync(facts.workDir)) return reasons;
  const [status, root] = await Promise.all([
    git(facts.workDir, ['status', '--porcelain', '--untracked-files=all']),
    git(facts.workDir, ['rev-parse', '--show-toplevel']),
  ]);
  if (status && root) {
    const edited = new Set(facts.editedFiles.map(file => path.resolve(facts.workDir, file)));
    const dirty = dirtyPaths(status, root.trim()).filter(file => edited.has(file)).length;
    if (dirty > 0) reasons.push(`${plural(dirty, 'uncommitted file', 'uncommitted files')} in ${facts.workDir}.`);
  }
  if (facts.branch && facts.branch !== 'HEAD') {
    const count = await git(facts.workDir, ['rev-list', '--count', facts.branch, '--not', '--remotes']);
    const unpushed = Number(count?.trim() ?? 0);
    if (unpushed > 0) reasons.push(`${plural(unpushed, 'commit', 'commits')} on ${facts.branch} not pushed.`);
  }
  return reasons;
}

/**
 * Sessions active since `sinceIso` that still have something unfinished, plus
 * the `recheckIds` from earlier nights however old. `finishedIds` are the
 * rechecked ones with nothing left; one whose transcript is gone is in neither,
 * since nothing shows it was finished.
 */
export async function findUnfinishedSessions(params: {
  sinceIso: string;
  recheckIds?: string[];
  projectsDir?: string;
}): Promise<{ unfinished: UnfinishedSession[]; finishedIds: string[] }> {
  const projectsDir = params.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const sinceMs = Date.parse(params.sinceIso);
  const recheck = new Set(params.recheckIds ?? []);
  const unfinished: UnfinishedSession[] = [];
  const finishedIds: string[] = [];
  const projects = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir, { withFileTypes: true }) : [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const transcript = path.join(dir, file);
      const rechecking = recheck.has(path.basename(file, '.jsonl'));
      try {
        // A session not written to since the window started had no prompt in it.
        if (!rechecking && fs.statSync(transcript).mtimeMs < sinceMs) continue;
        const facts = await readSession(transcript, rechecking ? '' : params.sinceIso);
        if (!facts) continue;
        const reasons = await unfinishedReasons(facts);
        if (reasons.length > 0) unfinished.push({ ...facts, reasons });
        else if (rechecking) finishedIds.push(facts.sessionId);
      } catch {
        // A transcript that vanished or can't be read is not worth failing the run for.
      }
    }
  }
  unfinished.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { unfinished, finishedIds };
}
