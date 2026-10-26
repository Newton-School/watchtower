import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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
 * and Xcode binaries) are found. Kill switch:
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
 * Claude Code's shared daemon and the hosts it keeps: an agent's CLI may be
 * the one that starts it, but the owner's own sessions use it afterwards.
 * Seen as `…/claude daemon run …`, `…/claude --bg-pty-host …`,
 * `claude bg-pty-host …` and `claude bg-spare …`.
 */
const SHARED_DAEMON_RE = /^(?:\S*\/)?claude\s+(?:daemon\b|--bg-|bg-)/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The processes a run left: those carrying its id, and their descendants.
 * Never the sidecar or anything above it, and never Claude Code's shared
 * daemon or anything under it.
 */
export function leftoverProcesses(params: {
  runId: string;
  /** `ps` without the environment: what is running, and who started what. */
  rows: ProcessRow[];
  /** `ps -E`: the same with each process's environment. */
  envRows: ProcessRow[];
  selfPid: number;
}): ProcessRow[] {
  const marker = new RegExp(`(?:^|\\s)${escapeRegExp(`${AGENT_RUN_ENV}=${params.runId}`)}(?=\\s|$)`);
  const byPid = new Map(params.rows.map(row => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of params.rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  }
  const subtree = (roots: number[]): Set<number> => {
    const seen = new Set<number>();
    const queue = [...roots];
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return seen;
  };

  const spared = subtree(params.rows.filter(row => SHARED_DAEMON_RE.test(row.command)).map(row => row.pid));
  for (let pid: number | undefined = params.selfPid; pid !== undefined && pid > 1 && !spared.has(pid); ) {
    spared.add(pid);
    pid = byPid.get(pid)?.ppid;
  }

  const marked = params.envRows.filter(row => marker.test(row.command)).map(row => row.pid);
  return [...subtree(marked)]
    .filter(pid => pid > 1 && !spared.has(pid))
    .map(pid => byPid.get(pid))
    .filter((row): row is ProcessRow => row !== undefined);
}

/** The executable's name and its first two arguments: enough to recognise, never a token further along. */
export function processLabel(command: string): string {
  const [executable = '', ...args] = command.split(/\s+/);
  return [path.basename(executable), ...args.slice(0, 2)].join(' ').slice(0, 100);
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

export interface StopLeftoverDeps {
  listProcesses?: (withEnv: boolean) => Promise<string>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
  selfPid?: number;
}

/** Stop what a run left running: SIGTERM, then SIGKILL for what is still there after the grace period. */
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
  const find = async (): Promise<ProcessRow[]> => {
    const envRows = parsePsRows(await list(true));
    const rows = parsePsRows(await list(false));
    return leftoverProcesses({ runId, rows, envRows, selfPid });
  };

  const stopped = await find();
  if (stopped.length === 0) return { stopped, forced: [] };
  for (const row of stopped) signal(row.pid, 'SIGTERM');
  for (let waited = 0; waited < graceMs && stopped.some(row => alive(row.pid)); waited += 100) {
    await sleep(100);
  }
  const survivors = stopped.filter(row => alive(row.pid));
  if (survivors.length === 0) return { stopped, forced: [] };
  // Only what is still this run's: a pid that exited may have been reused.
  const stillLeft = new Set((await find()).map(row => row.pid));
  const forced = survivors.filter(row => stillLeft.has(row.pid));
  for (const row of forced) signal(row.pid, 'SIGKILL');
  return { stopped, forced };
}
