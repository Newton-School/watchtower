import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logging/logger.js';
import { toolchainEnv } from '../backends/codexBackend.js';
import type { WorkflowStepLogger } from '../types/contracts.js';

const execFileAsync = promisify(execFile);

/**
 * Installed dependencies for the worktrees agents work in (issue #611).
 *
 * Worktrees used to get a symlink to the shared clone's node_modules. The
 * marketing clone's was an empty directory and newton-web's matched a lockfile
 * from June, so reviews skipped their typecheck, lint and build gates, and
 * change runs ran a full `npm ci` of their own. Now each lockfile is installed
 * once, into a cache keyed by its hash, before the agents start; each worktree
 * gets its own copy-on-write clone of that install (APFS `cp -c`: seconds, and
 * no extra disk until something writes), so an agent's own install or build
 * cache never reaches the cache or another run.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

const LOCKFILES: Array<{ file: string; manager: PackageManager }> = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
];

const COMMANDS: Record<PackageManager, string[]> = {
  npm: ['npm', 'ci', '--no-audit', '--no-fund', '--loglevel=error'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile'],
  yarn: ['yarn', 'install', '--frozen-lockfile', '--non-interactive'],
};

/** Config files beside the lockfile that change what an install produces. */
const CONFIG_FILES = ['.npmrc', '.yarnrc'];

/** Written into each install's node_modules, so a worktree's copy says which lockfile it is for. */
const MARKER = '.watchtower-deps.json';
/** Touched in a cache entry on every use; the least recently used entries are pruned. */
const LAST_USED = '.last-used';

async function runInstall(dir: string, command: string[], timeoutMs: number): Promise<void> {
  const [bin, ...args] = command;
  await execFileAsync(bin, args, {
    cwd: dir,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    // CI quiets progress output; HUSKY=0 stops a `prepare` hook installer
    // looking for a .git the cache directory doesn't have.
    env: { ...toolchainEnv(), CI: '1', HUSKY: '0', DISABLE_OPENCOLLECTIVE: '1', ADBLOCK: '1' },
  });
}

/**
 * Gives the worktree its own copy-on-write clone of an install. Where that
 * can't be done (not APFS), a symlink to the cache instead: shared, so a
 * sandboxed agent can read it but not write through it.
 */
async function copyTree(
  source: string,
  target: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<'clone' | 'symlink'> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('/bin/cp', ['-Rc', source, target], { timeout: timeoutMs, signal });
      return 'clone';
    } catch (error) {
      logger.warn({ source, target, error: String(error) }, 'could not clone the dependency cache; linking it instead');
      discard(target);
    }
  }
  fs.symlinkSync(source, target, 'junction');
  return 'symlink';
}

/** Settings; tests point them at temp dirs and stub the install and the copy. */
export const __depCache = {
  root: path.join(os.homedir(), '.watchtower', 'dep-cache'),
  /** Only worktrees miniOG made are given deps; never a shared clone. */
  workspacesRoot: path.join(os.homedir(), '.watchtower', 'workspaces'),
  /** Installs kept per repo, the most recently used first. newton-web's is about 2.5 GB. */
  keepPerRepo: 2,
  installTimeoutMs: 10 * 60_000,
  copyTimeoutMs: 5 * 60_000,
  /** A failed install is not retried for this long: it would fail again, slowly. */
  failureHoldMs: 30 * 60_000,
  /** No new install below this much free disk. */
  minFreeBytes: 10 * 1024 ** 3,
  install: runInstall,
  copy: copyTree,
};

export type DepsPlan =
  /** Not a JavaScript project: nothing to install. */
  | { kind: 'none' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'install'; manager: PackageManager; lockfile: string; key: string; inputs: string[]; command: string[] };

/**
 * What an install for this checkout would be, and its cache key: the
 * lockfile and the config beside it, the package manager, the Node major
 * version and the platform (native modules are built for both).
 */
export function planDeps(dir: string, nodeVersion: string = process.versions.node): DepsPlan {
  const packageJson = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJson)) return { kind: 'none' };
  const found = LOCKFILES.find(({ file }) => fs.existsSync(path.join(dir, file)));
  if (!found) return { kind: 'unsupported', reason: 'the repo has no lockfile' };
  let manifest: { workspaces?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { workspaces?: unknown };
  } catch {
    return { kind: 'unsupported', reason: 'package.json does not parse' };
  }
  if (manifest.workspaces || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    return { kind: 'unsupported', reason: 'it is a workspaces monorepo' };
  }
  if (found.manager === 'yarn' && fs.existsSync(path.join(dir, '.yarnrc.yml'))) {
    return { kind: 'unsupported', reason: 'it uses Yarn 2 or later' };
  }
  const keyed = [found.file, ...CONFIG_FILES.filter(file => fs.existsSync(path.join(dir, file)))];
  const hash = crypto.createHash('sha256');
  hash.update(`${found.manager}\0node${nodeVersion.split('.')[0]}\0${process.platform}-${process.arch}\0`);
  for (const file of keyed) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update('\0');
  }
  return {
    kind: 'install',
    manager: found.manager,
    lockfile: found.file,
    key: hash.digest('hex').slice(0, 16),
    inputs: ['package.json', ...keyed],
    command: COMMANDS[found.manager],
  };
}

export type WorktreeDeps =
  /** Not a worktree miniOG made (a shared clone, a temp dir): left alone. */
  | { status: 'skipped' }
  /** Not a JavaScript project. */
  | { status: 'none' }
  | {
      status: 'ready';
      manager: PackageManager;
      lockfile: string;
      key: string;
      command: string;
      /** This call ran the install (a cache miss). */
      installed: boolean;
      /** How the worktree has it: its own clone, or a link to the shared cache. */
      linked: 'clone' | 'symlink';
      ms: number;
    }
  | { status: 'unavailable'; reason: string; command: string };

const inflight = new Map<string, Promise<void>>();
const failures = new Map<string, { at: number; reason: string }>();
const states = new Map<string, WorktreeDeps>();
const MAX_STATES = 500;
let swept = false;

function remember(wsPath: string, state: WorktreeDeps): WorktreeDeps {
  const key = path.resolve(wsPath);
  states.delete(key);
  states.set(key, state);
  if (states.size > MAX_STATES) states.delete(states.keys().next().value as string);
  return state;
}

/** What `prepareWorktreeDeps` last found for this worktree. */
export function worktreeDepsFor(wsPath: string): WorktreeDeps | undefined {
  return states.get(path.resolve(wsPath));
}

function isManagedWorkspace(dir: string): boolean {
  const root = path.resolve(__depCache.workspacesRoot);
  return path.resolve(dir).startsWith(`${root}${path.sep}`);
}

function readMarkerKey(nodeModules: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(nodeModules, MARKER), 'utf8')) as { key?: unknown };
    return typeof parsed.key === 'string' ? parsed.key : undefined;
  } catch {
    return undefined;
  }
}

function linkKind(nodeModules: string): 'clone' | 'symlink' {
  try {
    return fs.lstatSync(nodeModules).isSymbolicLink() ? 'symlink' : 'clone';
  } catch {
    return 'clone';
  }
}

/**
 * Removes a path without waiting on a big tree: a symlink is unlinked (never
 * its target), a directory is moved into the cache's trash and deleted in the
 * background.
 */
function discard(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    fs.rmSync(target, { force: true });
    return;
  }
  const trash = path.join(__depCache.root, '.trash', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(target, trash);
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  fs.rm(trash, { recursive: true, force: true }, error => {
    if (error) logger.warn({ trash, error: String(error) }, 'could not delete an old dependency install');
  });
}

/** Leftovers of a run that stopped mid-install, once per process. */
function sweepOnce(): void {
  if (swept) return;
  swept = true;
  try {
    for (const repo of fs.readdirSync(__depCache.root)) {
      const repoDir = path.join(__depCache.root, repo);
      if (repo.startsWith('.trash')) {
        // Out of the way first, so a discard made meanwhile gets a fresh trash.
        const old = path.join(__depCache.root, `.trash-old-${crypto.randomBytes(4).toString('hex')}`);
        try {
          fs.renameSync(repoDir, old);
          fs.rm(old, { recursive: true, force: true }, () => undefined);
        } catch {
          // gone already
        }
        continue;
      }
      if (repo.startsWith('.') || !fs.statSync(repoDir).isDirectory()) continue;
      for (const entry of fs.readdirSync(repoDir)) {
        if (entry.includes('.tmp-')) discard(path.join(repoDir, entry));
      }
    }
  } catch {
    // no cache yet
  }
}

function isComplete(entry: string): boolean {
  return readMarkerKey(path.join(entry, 'node_modules')) !== undefined;
}

function touch(entry: string): void {
  try {
    const file = path.join(entry, LAST_USED);
    const now = new Date();
    if (fs.existsSync(file)) fs.utimesSync(file, now, now);
    else fs.writeFileSync(file, '');
  } catch {
    // recency is a hint for pruning, nothing more
  }
}

function lastUsed(entry: string): number {
  for (const file of [LAST_USED, path.join('node_modules', MARKER)]) {
    try {
      return fs.statSync(path.join(entry, file)).mtimeMs;
    } catch {
      // try the next
    }
  }
  return 0;
}

/** Keeps the most recently used installs of a repo; the rest go to the trash. */
function prune(repoDir: string): void {
  try {
    const entries = fs
      .readdirSync(repoDir)
      .filter(name => !name.includes('.tmp-'))
      .map(name => path.join(repoDir, name))
      .filter(isComplete)
      .sort((a, b) => lastUsed(b) - lastUsed(a));
    for (const old of entries.slice(__depCache.keepPerRepo)) {
      if (inflight.has(old)) continue;
      logger.info({ entry: old }, 'pruning an old dependency install');
      discard(old);
    }
  } catch (error) {
    logger.warn({ repoDir, error: String(error) }, 'could not prune old dependency installs');
  }
}

function freeBytes(dir: string): number | undefined {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/** Waits for `work`, or rejects as soon as the run is stopped (the work carries on for others). */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  const stopped = (): Error => Object.assign(new Error('stopped'), { name: 'AbortError' });
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(stopped());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Installs into a temp directory beside the entry, then renames it into place. */
async function install(entry: string, source: string, plan: Extract<DepsPlan, { kind: 'install' }>): Promise<void> {
  sweepOnce();
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const free = freeBytes(path.dirname(entry));
  if (free !== undefined && free < __depCache.minFreeBytes) {
    throw new Error(`only ${Math.round(free / 1024 ** 3)} GB of disk is free`);
  }
  const tmp = `${entry}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(tmp);
    for (const file of plan.inputs) fs.copyFileSync(path.join(source, file), path.join(tmp, file));
    await __depCache.install(tmp, plan.command, __depCache.installTimeoutMs);
    const nodeModules = path.join(tmp, 'node_modules');
    if (!fs.existsSync(nodeModules)) throw new Error('the install left no node_modules');
    fs.writeFileSync(
      path.join(nodeModules, MARKER),
      JSON.stringify({ key: plan.key, manager: plan.manager, lockfile: plan.lockfile, at: new Date().toISOString() }),
    );
    try {
      fs.renameSync(tmp, entry);
    } catch (error) {
      // Another install of the same lockfile finished first: use that one.
      if (!isComplete(entry)) throw error;
      discard(tmp);
    }
  } catch (error) {
    discard(tmp);
    throw error;
  }
  touch(entry);
  prune(path.dirname(entry));
}

function describeFailure(error: unknown): string {
  const err = error as { killed?: boolean; signal?: string; name?: string; stderr?: unknown; message?: string };
  if (err?.name === 'AbortError') return 'the run was stopped during the install';
  if (err?.killed) return `the install took longer than ${Math.round(__depCache.installTimeoutMs / 60_000)} min`;
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  const text = (stderr || err?.message || String(error)).replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `…${text.slice(-240)}` : text;
}

/**
 * Gives a worktree the dependencies its lockfile asks for, from the cache
 * (installing them there first on a miss). Concurrent calls for the same
 * lockfile share one install. Never throws: when it cannot, the worktree is
 * left as it was (a link to the shared clone's install, if it had one) and
 * the result says why, for the agents' prompts (`depsPromptLine`).
 */
export async function prepareWorktreeDeps(
  wsPath: string,
  options: { logStep?: WorkflowStepLogger; stage?: string; signal?: AbortSignal } = {},
): Promise<WorktreeDeps> {
  const { logStep, stage = 'workspace.deps', signal } = options;
  if (!isManagedWorkspace(wsPath)) return remember(wsPath, { status: 'skipped' });
  const plan = planDeps(wsPath);
  if (plan.kind === 'none') return remember(wsPath, { status: 'none' });
  if (plan.kind === 'unsupported') {
    logStep?.({
      stage,
      level: 'WARN',
      message: `Did not install dependencies for this worktree: ${plan.reason}.`,
    });
    return remember(wsPath, { status: 'unavailable', reason: plan.reason, command: 'npm install' });
  }

  const command = plan.command.join(' ');
  const target = path.join(wsPath, 'node_modules');
  if (readMarkerKey(target) === plan.key) {
    return remember(wsPath, {
      status: 'ready',
      manager: plan.manager,
      lockfile: plan.lockfile,
      key: plan.key,
      command,
      installed: false,
      linked: linkKind(target),
      ms: 0,
    });
  }

  const repoName = path.basename(path.dirname(path.resolve(wsPath)));
  const entry = path.join(__depCache.root, repoName, plan.key);
  const started = Date.now();
  try {
    let installed = false;
    if (!isComplete(entry)) {
      const failed = failures.get(entry);
      if (failed && Date.now() - failed.at < __depCache.failureHoldMs) throw new Error(failed.reason);
      let pending = inflight.get(entry);
      if (!pending) {
        installed = true;
        logStep?.({
          stage,
          message: `Installing ${repoName}'s dependencies for this ${plan.lockfile} (\`${command}\`), once; later runs reuse it.`,
          data: { key: plan.key, entry },
        });
        // Not tied to this run's signal: other runs may be waiting on the same install.
        pending = install(entry, wsPath, plan)
          .catch(error => {
            failures.set(entry, { at: Date.now(), reason: describeFailure(error) });
            throw error;
          })
          .finally(() => inflight.delete(entry));
        inflight.set(entry, pending);
      }
      await untilAborted(pending, signal);
      failures.delete(entry);
    }
    touch(entry);
    discard(target);
    const linked = await __depCache.copy(path.join(entry, 'node_modules'), target, __depCache.copyTimeoutMs, signal);
    const ms = Date.now() - started;
    logStep?.({
      stage,
      message: `The worktree has ${repoName}'s dependencies for its ${plan.lockfile} (${installed ? 'installed' : 'from the cache'}, ${linked === 'clone' ? 'its own copy' : 'linked'}, ${Math.round(ms / 1000)}s).`,
      data: { key: plan.key, installed, linked, ms },
    });
    return remember(wsPath, {
      status: 'ready',
      manager: plan.manager,
      lockfile: plan.lockfile,
      key: plan.key,
      command,
      installed,
      linked,
      ms,
    });
  } catch (error) {
    const reason = failures.get(entry)?.reason ?? describeFailure(error);
    logStep?.({
      stage,
      level: 'WARN',
      message: `Could not give the worktree its dependencies: ${reason}`,
      data: { key: plan.key, entry },
    });
    return remember(wsPath, { status: 'unavailable', reason, command });
  }
}

/**
 * One line for an agent's prompt about the worktree's dependencies, or ''
 * when there is nothing to say (not a JavaScript project, not a worktree).
 */
export function depsPromptLine(wsPath: string, state: WorktreeDeps | undefined = worktreeDepsFor(wsPath)): string {
  if (!state) return '';
  if (state.status === 'ready') {
    const reinstall =
      state.linked === 'clone'
        ? 'reinstall only if you change package.json or the lockfile.'
        : `node_modules is shared with other runs: never install into it; if you change dependencies, \`rm node_modules\` and run \`${state.command}\` first.`;
    return `Dependencies: installed in node_modules for this checkout's ${state.lockfile} (with \`${state.command}\`, before you started). Run the repo's own typecheck, lint, test and build scripts directly; ${reinstall}`;
  }
  if (state.status === 'unavailable') {
    let linked = false;
    try {
      linked = fs.lstatSync(path.join(wsPath, 'node_modules')).isSymbolicLink();
    } catch {
      // no node_modules at all
    }
    return linked
      ? `Dependencies: miniOG could not install them for this checkout (${state.reason}). node_modules links to the shared clone's install, which may not match this lockfile: if typecheck, lint, build or tests fail on missing or wrong packages, run \`rm node_modules && ${state.command}\` first, or say which checks you skipped.`
      : `Dependencies: NOT installed; miniOG could not install them (${state.reason}). Typecheck, lint, build and tests need them: run \`${state.command}\` here first, or say which checks you skipped.`;
  }
  return '';
}

/** For tests: forget installs in flight, held failures and per-worktree results. */
export function __resetDepCacheState(): void {
  inflight.clear();
  failures.clear();
  states.clear();
  swept = false;
}
