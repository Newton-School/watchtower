import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sanitizeStatusFragment } from '../slack/statusNarrator.js';

const execFileAsync = promisify(execFile);

/**
 * Processes an agent run leaves running (issue #608).
 *
 * Every shell command an agent runs gets a sandbox of its own, and Seatbelt
 * allows signals only inside one sandbox. A dev server started in one command
 * therefore cannot be stopped from a later one (`kill` says "operation not
 * permitted"); started with `&` or `nohup`, it outlives the command's shell,
 * is re-parented to launchd and keeps running after the run. Agents then told
 * the requester to "run `kill 43469`".
 *
 * By the time the run ends, the parent chain and process group are gone, but
 * the environment is not: every process the run starts inherits
 * `WATCHTOWER_AGENT_RUN=<run id>`, and `ps -E` shows it. When the run ends,
 * the sidecar stops every process carrying its id, and their descendants.
 * Measured on CLI 2.1.310: three background processes left by a sandboxed run
 * (re-parented to launchd, each in its own process group) all carried it.
 *
 * Limits: macOS hides the environment of its own binaries (`/bin/sleep`,
 * `/bin/sh`), so one of those left running on its own is not found; its
 * children and parents that are not Apple's are. Dev servers (node, Homebrew
 * and Xcode binaries) are found. Shared servers are spared (below). A run cut
 * short by the sidecar itself stopping is not cleaned up. Kill switch:
 * `WATCHTOWER_STOP_LEFTOVER_PROCESSES=0`.
 */
export const AGENT_RUN_ENV = 'WATCHTOWER_AGENT_RUN';

export function isLeftoverSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'darwin' && env.WATCHTOWER_STOP_LEFTOVER_PROCESSES !== '0';
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The command line; with `ps -E`, followed by the environment. */
  command: string;
}

/** Lines of `ps -o pid=,ppid=,command=`. */
export function parsePsRows(raw: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
  }
  return rows;
}

/**
 * Servers a run may start that other sessions then use, spared with
 * everything under them, whatever started them:
 * - Claude Code's daemon and the hosts it keeps (`claude daemon run`,
 *   `--bg-pty-host`, `bg-spare`), whatever the program is called: a
 *   development build runs as `node …/cli.js`, a release as `…/versions/<v>`.
 *   Sessions it hosts carry `CLAUDE_BG_*` variables; spares inherit the
 *   environment of whichever CLI started the daemon.
 * - tmux and screen servers.
 * - Apps (`/Applications/<app>.app/Contents/MacOS/…`): VS Code, Chrome.
 *   Playwright's browsers live under `~/Library/Caches` and are stopped.
 * A dev server an agent starts inside one of these is left running too.
 */
const SHARED_SERVER_ARG_RE = /(?:^|\s)(?:daemon\s+run|--bg-pty-host|--bg-spare|bg-pty-host|bg-spare)(?=\s|$)/;
const SHARED_SERVER_PROGRAM_RE =
  /^(?:\S*\/)?(?:tmux|screen)(?:\s|$)|^(?:\/Users\/[^/]+)?\/Applications\/.+?\.app\/Contents\/MacOS\//;

function isSharedServer(row: ProcessRow): boolean {
  return SHARED_SERVER_ARG_RE.test(row.command) || SHARED_SERVER_PROGRAM_RE.test(row.command);
}

function tokensOf(command: string): string[] {
  return command.split(/\s+/);
}

function carriesRunId(row: ProcessRow, runId: string): boolean {
  return tokensOf(row.command).includes(`${AGENT_RUN_ENV}=${runId}`);
}

/**
 * The processes a run left: those carrying its id, and their descendants.
 * Never the sidecar or anything above it, never a shared server (above) or
 * anything under it; the walk never passes through any of them. The app and
 * any tmux or Claude Code session the sidecar itself runs under are only
 * spared as its ancestors: the agents it starts are under them too.
 */
export function leftoverProcesses(params: {
  runId: string;
  /** `ps` without the environment: what is running, and who started what. */
  rows: ProcessRow[];
  /** `ps -E`: the same with each process's environment. */
  envRows: ProcessRow[];
  selfPid: number;
  /** The sidecar's environment: `CLAUDE_BG_*` values it has, every agent inherits. */
  selfEnv?: NodeJS.ProcessEnv;
}): ProcessRow[] {
  const byPid = new Map(params.rows.map(row => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of params.rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  }
  const walk = (roots: number[], skip: Set<number>): Set<number> => {
    const seen = new Set<number>();
    const queue = roots.filter(pid => !skip.has(pid));
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      queue.push(...(children.get(pid) ?? []).filter(child => !skip.has(child)));
    }
    return seen;
  };

  const ancestors = new Set<number>([0, 1]);
  for (let pid: number | undefined = params.selfPid; pid !== undefined && !ancestors.has(pid); ) {
    ancestors.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  const inherited = new Set(
    Object.entries(params.selfEnv ?? {})
      .filter(([key]) => key.startsWith('CLAUDE_BG_'))
      .map(([key, value]) => `${key}=${value}`),
  );
  const hostedByDaemon = params.envRows
    .filter(row =>
      tokensOf(row.command).some(
        token => token.startsWith('CLAUDE_BG_') && token.includes('=') && !inherited.has(token),
      ),
    )
    .map(row => row.pid);
  const sharedRoots = [...params.rows.filter(isSharedServer).map(row => row.pid), ...hostedByDaemon];
  const spared = walk(
    sharedRoots.filter(pid => !ancestors.has(pid)),
    ancestors,
  );
  for (const pid of ancestors) spared.add(pid);

  const marked = params.envRows.filter(row => carriesRunId(row, params.runId)).map(row => row.pid);
  return [...walk(marked, spared)].map(pid => byPid.get(pid)).filter((row): row is ProcessRow => row !== undefined);
}

/**
 * The executable's name and its first two arguments, with secrets and paths
 * taken out as for the Slack status line, and credentials in URLs too.
 */
export function processLabel(command: string): string {
  const [executable = '', ...args] = tokensOf(command);
  const label = [path.basename(executable), ...args.slice(0, 2)].join(' ');
  return sanitizeStatusFragment(label.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@'), 100);
}

async function listProcesses(withEnv: boolean): Promise<string> {
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-ww', ...(withEnv ? ['-E'] : []), '-U', String(os.userInfo().uid), '-o', 'pid=,ppid=,command='],
    // Every process's environment, tokens included: read here, never logged.
    { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
  );
  return stdout;
}

/** Still there and still this user's: EPERM means the pid now belongs to someone else. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the signal was delivered. */
function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    // Gone, or no longer this user's.
    return false;
  }
}

export interface StopLeftoverDeps {
  listProcesses?: (withEnv: boolean) => Promise<string>;
  signal?: (pid: number, signal: NodeJS.Signals) => boolean;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
  selfPid?: number;
  selfEnv?: NodeJS.ProcessEnv;
}

/**
 * Stop what a run left running: SIGTERM, then after the grace period one more
 * listing, and SIGKILL for everything of the run's it finds, processes started
 * since included (a watcher restarting its worker). Returns the processes
 * actually signalled.
 */
export async function stopLeftoverProcesses(
  runId: string,
  deps: StopLeftoverDeps = {},
): Promise<{ stopped: ProcessRow[]; forced: ProcessRow[] }> {
  const list = deps.listProcesses ?? listProcesses;
  const signal = deps.signal ?? sendSignal;
  const alive = deps.isAlive ?? isAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const graceMs = deps.graceMs ?? 2_000;
  const selfPid = deps.selfPid ?? process.pid;
  const selfEnv = deps.selfEnv ?? process.env;
  const find = async (): Promise<ProcessRow[]> => {
    const envRows = parsePsRows(await list(true));
    // The usual case: nothing carries the id, and nothing else is listed.
    if (!envRows.some(row => carriesRunId(row, runId))) return [];
    const rows = parsePsRows(await list(false));
    return leftoverProcesses({ runId, rows, envRows, selfPid, selfEnv });
  };

  const terminated = (await find()).filter(row => signal(row.pid, 'SIGTERM'));
  if (terminated.length === 0) return { stopped: [], forced: [] };
  for (let waited = 0; waited < graceMs && terminated.some(row => alive(row.pid)); waited += 100) {
    await sleep(100);
  }
  if (!terminated.some(row => alive(row.pid))) return { stopped: terminated, forced: [] };
  // One more pass, and only one: what is still the run's (a pid that exited
  // may have been reused), and what it started meanwhile.
  const forced = (await find()).filter(row => signal(row.pid, 'SIGKILL'));
  const terminatedPids = new Set(terminated.map(row => row.pid));
  return { stopped: [...terminated, ...forced.filter(row => !terminatedPids.has(row.pid))], forced };
}
