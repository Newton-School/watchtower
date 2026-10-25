import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logging/logger.js';
import { discardInBackground } from './depCache.js';

const execFileAsync = promisify(execFile);

const WORKSPACES_ROOT = path.join(os.homedir(), '.watchtower', 'workspaces');
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Run a git command without blocking the event loop. Replaces the old
 * `execSync` calls: those froze the single-threaded sidecar for the full
 * duration of every git invocation — up to 30s for a network `git fetch` —
 * stalling all concurrent jobs, Slack acks and the cancel poller. Args are
 * passed as a list (no shell), so paths with spaces need no quoting and there's
 * no shell-injection surface. Mirrors the previous semantics: stdout/stderr are
 * piped, a per-call timeout kills the process, and a non-zero exit rejects.
 */
async function git(args: string[], opts: { cwd: string; timeoutMs: number; raw?: boolean }): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  // `raw` keeps the output as git wrote it: trimming eats the leading space of a `-z` status entry.
  return opts.raw ? stdout.toString() : stdout.toString().trim();
}

/**
 * Hide the symlinked node_modules from git inside a worktree.
 *
 * A `.gitignore` pattern that ends in a slash — `node_modules/`, which is what
 * most repos ship — matches directories only. Our node_modules is a SYMLINK, so
 * git sees an untracked file and reports `?? node_modules`. That single line did
 * real damage in #413: `git add -A` committed the symlink (mode 120000, holding
 * an absolute path from this machine) into a company PR, and it also made
 * `checkCoderProducedChanges` believe a coder that touched nothing had been
 * productive, defeating the empty-output guard.
 *
 * `.git/info/exclude` is local-only and never pushed. It lives in the common git
 * dir, so this also covers the parent clone — harmless, since every repo we work
 * in ignores node_modules anyway; the pattern is only doing the job the trailing
 * slash prevented.
 */
async function excludeNodeModulesFromGit(wsPath: string): Promise<void> {
  const PATTERN = '/node_modules';
  try {
    const commonDir = await git(['rev-parse', '--git-common-dir'], { cwd: wsPath, timeoutMs: 10_000 });
    const resolvedCommonDir = path.isAbsolute(commonDir) ? commonDir : path.join(wsPath, commonDir);
    const excludePath = path.join(resolvedCommonDir, 'info', 'exclude');

    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').some(line => line.trim() === PATTERN)) return;

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(
      excludePath,
      `${separator}# watchtower (#413): the worktree node_modules is a symlink, which "node_modules/" does not ignore\n${PATTERN}\n`,
    );
    logger.info({ wsPath, excludePath }, 'excluded node_modules symlink from git');
  } catch (error) {
    logger.warn({ wsPath, error: String(error) }, 'failed to exclude node_modules from git');
  }
}

function hasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function sanitizeThreadTs(threadTs: string): string {
  return threadTs.replace(/[^a-zA-Z0-9.-]/g, '_');
}

function repoNameFromPath(repoPath: string): string {
  return path.basename(repoPath);
}

function workspacePath(repoPath: string, threadTs: string): string {
  const repoName = repoNameFromPath(repoPath);
  const safeThread = sanitizeThreadTs(threadTs);
  return path.join(WORKSPACES_ROOT, repoName, safeThread);
}

async function resolveDefaultRemoteBranch(repoPath: string): Promise<string> {
  try {
    // ref is like "origin/master" or "origin/main"
    return await git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd: repoPath, timeoutMs: 10_000 });
  } catch {
    return 'origin/master';
  }
}

/**
 * `resolveWorkspace` could not make an isolated worktree. The message is for
 * the person who asked: nothing ran in the shared clone.
 */
export class WorkspaceSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSetupError';
  }
}

/**
 * Resolves an isolated workspace for the given repo + thread.
 * Uses `git worktree` to create a lightweight checkout starting from
 * the default remote branch (origin/master or origin/main), NOT from
 * the local HEAD which may be on an unrelated feature branch.
 *
 * Throws `WorkspaceSetupError` when the worktree cannot be made. It used to
 * return the shared `repoPath` instead, and the PR checkout, the coder or the
 * review then ran in the owner's real clone.
 */
export async function resolveWorkspace(repoPath: string, threadTs: string): Promise<string> {
  const wsPath = workspacePath(repoPath, threadTs);

  // If workspace already exists, refresh it to the current default branch
  // before reuse. Worktrees are keyed by (repo, thread) and the fresh-fetch
  // on first creation does NOT run on reuse, so a follow-up task in the same
  // thread (or a paused→resumed job) would otherwise branch from the base
  // commit captured days earlier. Reset is safe here: resumes re-run the
  // pipeline fresh, one-active-job-per-thread prevents concurrent work, and
  // any prior task's commits live on its already-pushed PR branch. `git clean
  // -fd` drops untracked leftovers but NOT ignored paths (the symlinked
  // node_modules survives).
  if (fs.existsSync(wsPath)) {
    try {
      await git(['fetch', 'origin', '--quiet'], { cwd: wsPath, timeoutMs: 30_000 });
      const defaultBranch = await resolveDefaultRemoteBranch(repoPath);
      await git(['reset', '--hard', defaultBranch], { cwd: wsPath, timeoutMs: 15_000 });
      await git(['clean', '-fd'], { cwd: wsPath, timeoutMs: 15_000 });
      // Worktrees created before #413 have an un-excluded symlink; fix on reuse.
      await excludeNodeModulesFromGit(wsPath);
      logger.info(
        { repoPath, threadTs, wsPath, startPoint: defaultBranch },
        'refreshed reused workspace to default branch',
      );
      return wsPath;
    } catch (error) {
      // Couldn't guarantee a clean, current base (fetch or reset failed).
      // Don't hand back a possibly-stale/dirty worktree — discard it and fall
      // through to fresh creation below, which is itself fetch-guarded. If the
      // teardown also fails, creation fails and says so.
      logger.warn(
        { repoPath, threadTs, wsPath, error: String(error) },
        'failed to refresh reused workspace; recreating it fresh',
      );
      await removeWorktreeByPath(wsPath);
    }
  }

  try {
    fs.mkdirSync(path.dirname(wsPath), { recursive: true });

    // Fetch latest from origin so the worktree starts from up-to-date code
    try {
      await git(['fetch', 'origin', '--quiet'], { cwd: repoPath, timeoutMs: 30_000 });
    } catch {
      logger.warn({ repoPath }, 'git fetch failed before worktree creation, proceeding with local state');
    }

    // A worktree whose directory is gone but which is still registered (a
    // removal that was cut short) makes `worktree add` refuse its path:
    // "missing but already registered".
    await git(['worktree', 'prune'], { cwd: repoPath, timeoutMs: 30_000 }).catch(error =>
      logger.warn({ repoPath, error: String(error) }, 'git worktree prune failed before worktree creation'),
    );

    // Create a detached worktree from the default remote branch (not local HEAD)
    const defaultBranch = await resolveDefaultRemoteBranch(repoPath);
    await git(['worktree', 'add', '--detach', wsPath, defaultBranch], { cwd: repoPath, timeoutMs: 30_000 });

    // Symlink parent node_modules so tools (Jest, ESLint, etc.) are available in the worktree.
    // Runs that execute the repo's gates replace it with an install for the
    // worktree's own lockfile (depCache.ts, issue #611). Not an empty one: a link
    // to an empty directory only told agents the deps were "installed".
    const parentNodeModules = path.join(repoPath, 'node_modules');
    const worktreeNodeModules = path.join(wsPath, 'node_modules');
    if (hasEntries(parentNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      try {
        fs.symlinkSync(parentNodeModules, worktreeNodeModules, 'junction');
        logger.info({ wsPath }, 'symlinked node_modules into worktree');
      } catch (symlinkError) {
        logger.warn({ wsPath, error: String(symlinkError) }, 'failed to symlink node_modules into worktree');
      }
    }
    // Unconditional: the exclude must exist even when the symlink was created by
    // an earlier run, and it costs nothing when there's no node_modules at all.
    await excludeNodeModulesFromGit(wsPath);

    logger.info({ repoPath, threadTs, wsPath, startPoint: defaultBranch }, 'created workspace via git worktree');
    return wsPath;
  } catch (error) {
    // The cause (git's own words, with local paths) goes to the log, not Slack.
    logger.error({ repoPath, threadTs, wsPath, error: String(error) }, 'failed to create workspace');
    throw new WorkspaceSetupError(
      `I couldn't set up my own copy of ${repoNameFromPath(repoPath)} to work in, so I stopped here. Ask me again in a few minutes.`,
    );
  }
}

export type WorktreeRefresh =
  | { ok: true; base: string; head: string }
  /** Left as it was. `skipped`: not one of miniOG's worktrees, so never reset. */
  | { ok: false; reason: string; skipped?: true };

/**
 * Moves an existing worktree to origin's latest default branch: fetch, then
 * `reset --hard` to the fetched base and `clean -fd`, which leaves ignored
 * paths (node_modules and the deps marker inside it) alone. Unlike
 * `resolveWorkspace` it never removes or recreates anything: when a step
 * fails (a fetch that can't reach origin, usually, before anything moved),
 * the worktree stays where it was and the reason comes back, so a caller with
 * approved work can carry on. Only a worktree under the workspaces root
 * is touched; a shared clone is never reset.
 */
export async function refreshWorktreeToBase(wsPath: string): Promise<WorktreeRefresh> {
  if (!path.resolve(wsPath).startsWith(`${WORKSPACES_ROOT}${path.sep}`)) {
    return { ok: false, reason: 'not a miniOG worktree', skipped: true };
  }
  try {
    await git(['fetch', 'origin', '--quiet'], { cwd: wsPath, timeoutMs: 30_000 });
    const base = await resolveDefaultRemoteBranch(wsPath);
    await git(['reset', '--hard', base], { cwd: wsPath, timeoutMs: 15_000 });
    await git(['clean', '-fd'], { cwd: wsPath, timeoutMs: 15_000 });
    const head = await git(['rev-parse', 'HEAD'], { cwd: wsPath, timeoutMs: 10_000 });
    return { ok: true, base, head };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** Why a shared clone could not be brought up to date with origin. */
export type SharedRepoStaleReason =
  /** `git fetch` failed: everything below is as of the last successful fetch. */
  | 'fetch_failed'
  /** Tracked files have uncommitted changes that the update would overwrite. */
  | 'dirty_tree'
  /** The clone is checked out on something other than the default branch. */
  | 'other_branch'
  /** The clone has commits that are not on origin's default branch. */
  | 'diverged'
  | 'not_fast_forwardable'
  /** How far behind origin the clone is could not be worked out, so it is not known to be current. */
  | 'unverified';

/** Uncommitted changes moved out of a shared clone's way so it could be updated (issue #709). */
export interface SetAsideChanges {
  /** The files that were in the way: tracked edits, and untracked files the update adds. */
  files: string[];
  /** The stash commit holding them: `git stash apply <stash>` in the clone brings them back. */
  stash: string;
  /** The stash message, so the entry can be found in `git stash list`. */
  label: string;
}

/** Where a shared clone stands after a refresh attempt. */
export interface SharedRepoState {
  branch: string;
  head: string;
  /** The HEAD commit's date (YYYY-MM-DD): how old the files on disk are. */
  headDate?: string;
  /** origin's default branch, e.g. "origin/master". */
  upstream?: string;
  /** Commits the working tree is behind `upstream`. 0 when current; absent when it could not be counted. */
  behind?: number;
  /** Set when the working tree is not known to be current. */
  staleReason?: SharedRepoStaleReason;
  /** For `dirty_tree`: the files in the way (the first few). */
  dirtyFiles?: string[];
  /** Set when uncommitted changes were set aside so the clone could be updated. */
  setAside?: SetAsideChanges;
  /** For `dirty_tree`: why the changes in the way were left where they are. */
  setAsideSkipped?: 'recent_edits' | 'failed';
}

/** A change in the way is only set aside once nothing has touched it for this long. */
export const SET_ASIDE_QUIET_MS = 15 * 60 * 1000;

export interface SharedRepoRefreshOptions {
  /**
   * Move uncommitted changes that block the update into a stash, then
   * update. Only for miniOG's own shared clones (the configured repo paths):
   * the changes are kept, but they leave the working tree.
   */
  setAsideStrayChanges?: boolean;
  /** Test seam: how long a change must sit untouched before it is set aside. */
  quietMs?: number;
  /** Test seam for the clock. */
  now?: () => number;
}

/** One refresh per clone at a time: two runs starting together would race on the index and the stash. */
const refreshLocks = new Map<string, Promise<unknown>>();

async function withRefreshLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoPath);
  const previous = refreshLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const settled = run.catch(() => undefined);
  refreshLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (refreshLocks.get(key) === settled) refreshLocks.delete(key);
  }
}

async function tryFastForward(repoPath: string, upstream: string): Promise<boolean> {
  try {
    await git(['merge', '--ff-only', upstream], { cwd: repoPath, timeoutMs: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Splits `-z` output into paths, dropping empties. */
function nulList(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** Tracked files with uncommitted changes, staged or not (`git status -z`; a rename lists both names). */
async function trackedChanges(repoPath: string): Promise<string[]> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=no'], {
    cwd: repoPath,
    timeoutMs: 10_000,
    raw: true,
  });
  const entries = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // "R  new\0old": the original name follows as its own entry.
    if (entry[0] === 'R' || entry[0] === 'C') {
      const original = entries[i + 1];
      if (original) files.push(original);
      i += 1;
    }
  }
  return files;
}

/**
 * Moves the uncommitted changes that stop a shared clone from updating into
 * a named stash (issue #709). On 2026-10-24 an agent's leftover edit to
 * newton-web's package.json had held that clone on a May commit, 783 commits
 * behind, and every lookup read five-month-old code.
 *
 * Only on the default branch with no local commits; only the files in the
 * way (tracked edits, and untracked files the update would add); and only
 * once none of them has been touched for `quietMs`, so a change someone is
 * making right now is left alone. Nothing is deleted: `git stash apply
 * <stash>` in the clone brings it back.
 */
async function setAsideStrayChanges(
  repoPath: string,
  upstream: string,
  opts: SharedRepoRefreshOptions,
): Promise<{ setAside?: SetAsideChanges; skipped?: 'recent_edits' | 'failed' }> {
  try {
    // The configured path must be the clone itself, not a folder inside some other repo.
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: repoPath, timeoutMs: 10_000 });
    if (fs.realpathSync(top) !== fs.realpathSync(repoPath)) return {};
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
    if (branch !== upstream.replace(/^origin\//, '')) return {};
    const ahead = await git(['rev-list', '--count', `${upstream}..HEAD`], { cwd: repoPath, timeoutMs: 10_000 });
    if (Number.parseInt(ahead, 10) !== 0) return {};

    const tracked = await trackedChanges(repoPath);
    const untracked = new Set(
      nulList(
        await git(['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd: repoPath,
          timeoutMs: 10_000,
          raw: true,
        }),
      ),
    );
    const incoming = nulList(
      await git(['diff', '--name-only', '-z', '--diff-filter=A', 'HEAD', upstream], {
        cwd: repoPath,
        timeoutMs: 10_000,
        raw: true,
      }),
    );
    const blockingUntracked = incoming.filter(file => untracked.has(file));
    const files = [...new Set([...tracked, ...blockingUntracked])];
    if (files.length === 0) return {};

    const now = (opts.now ?? Date.now)();
    const quietMs = opts.quietMs ?? SET_ASIDE_QUIET_MS;
    const recent = files.some(file => {
      try {
        return now - fs.lstatSync(path.join(repoPath, file)).mtimeMs < quietMs;
      } catch {
        return false; // a deleted file has no mtime; its deletion is what is in the way
      }
    });
    if (recent) return { skipped: 'recent_edits' };

    const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');
    const label = `miniog-autostash ${new Date(now).toISOString()} (#709): ${files.length} file${
      files.length === 1 ? '' : 's'
    } in the way of the update: ${shown}`;
    const before = await git(['rev-parse', '--quiet', '--verify', 'refs/stash'], {
      cwd: repoPath,
      timeoutMs: 10_000,
    }).catch(() => '');
    await git(
      [
        '--literal-pathspecs',
        'stash',
        'push',
        ...(blockingUntracked.length > 0 ? ['--include-untracked'] : []),
        '-m',
        label,
        '--',
        ...files,
      ],
      { cwd: repoPath, timeoutMs: 30_000 },
    );
    const stash = await git(['rev-parse', '--verify', 'refs/stash'], { cwd: repoPath, timeoutMs: 10_000 });
    const subject = await git(['log', '-1', '--format=%s', stash], { cwd: repoPath, timeoutMs: 10_000 });
    if (stash === before || !subject.includes(label)) return { skipped: 'failed' };
    return { setAside: { files, stash, label } };
  } catch (error) {
    logger.warn({ repoPath, error: String(error) }, 'could not set aside the changes blocking a shared clone update');
    return { skipped: 'failed' };
  }
}

/** Puts set-aside changes back when the update still failed, so the clone is left as it was found. */
async function restoreSetAside(repoPath: string, setAside: SetAsideChanges): Promise<void> {
  try {
    await git(['stash', 'apply', setAside.stash], { cwd: repoPath, timeoutMs: 30_000 });
    const entries = (await git(['stash', 'list', '--format=%H'], { cwd: repoPath, timeoutMs: 10_000 })).split('\n');
    const index = entries.indexOf(setAside.stash);
    if (index >= 0) await git(['stash', 'drop', `stash@{${index}}`], { cwd: repoPath, timeoutMs: 10_000 });
  } catch (error) {
    // The changes are still in the stash under their label; nothing is lost.
    logger.warn(
      { repoPath, stash: setAside.stash, error: String(error) },
      'could not put set-aside changes back after a failed update',
    );
  }
}

/**
 * Fast-forwards a SHARED repo clone to its default remote branch so an agent
 * that reads the clone directly — the informational Q&A path, which (unlike the
 * PR/implementation pipeline) does NOT operate in an isolated worktree — sees
 * freshly-merged code instead of a checkout that has drifted behind origin.
 *
 * Safety: this mutates a real clone, so it ONLY ever fast-forwards.
 * `git merge --ff-only` advances the working tree when the local branch is a
 * strict ancestor of origin's, and refuses (non-fatal) on divergence, a feature
 * branch, or a dirty tree that would be overwritten — so unpushed local
 * commits are never clobbered. The `reset --hard` used for the throwaway
 * worktrees in `resolveWorkspace` would NOT be safe on a shared clone. With
 * `setAsideStrayChanges` (miniOG's own clones only), uncommitted changes that
 * block the update are moved into a named stash first, and put back if the
 * update still fails.
 *
 * Best-effort: returns where the checkout ended up, including how far behind
 * origin it still is and why, or null if the repo couldn't be inspected.
 * Never throws.
 */
export async function refreshSharedRepoToDefaultBranch(
  repoPath: string,
  opts: SharedRepoRefreshOptions = {},
): Promise<SharedRepoState | null> {
  return withRefreshLock(repoPath, () => refreshSharedRepo(repoPath, opts));
}

async function refreshSharedRepo(repoPath: string, opts: SharedRepoRefreshOptions): Promise<SharedRepoState | null> {
  let fetchFailed = false;
  try {
    await git(['fetch', 'origin', '--quiet'], { cwd: repoPath, timeoutMs: 30_000 });
  } catch (error) {
    fetchFailed = true;
    logger.warn(
      { repoPath, error: String(error) },
      'git fetch failed before agent read; answering against local repo state',
    );
  }
  const upstream = await resolveDefaultRemoteBranch(repoPath);
  let setAside: SetAsideChanges | undefined;
  let setAsideSkipped: SharedRepoState['setAsideSkipped'];
  if (!fetchFailed && !(await tryFastForward(repoPath, upstream))) {
    if (opts.setAsideStrayChanges) {
      const outcome = await setAsideStrayChanges(repoPath, upstream, opts);
      setAsideSkipped = outcome.skipped;
      if (outcome.setAside) {
        if (await tryFastForward(repoPath, upstream)) {
          setAside = outcome.setAside;
        } else {
          await restoreSetAside(repoPath, outcome.setAside);
          setAsideSkipped = 'failed';
        }
      }
    }
    if (!setAside) {
      // Not fast-forwardable (feature branch, diverged history, or a dirty tree
      // that would be overwritten) — the checkout is left as it was. What that
      // leaves is reported below.
      logger.warn({ repoPath, upstream }, 'could not fast-forward shared repo to default branch');
    }
  }

  let head: string;
  let branch: string;
  try {
    head = await git(['rev-parse', '--short', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
  } catch {
    return null;
  }
  const headDate = await git(['log', '-1', '--format=%cs', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 }).catch(
    () => undefined,
  );

  // The truth about where that leaves the checkout. This used to return the
  // head and nothing else, and the caller logged "Refreshed" over a clone
  // that had not moved in four months (issue #446).
  const count = async (range: string): Promise<number | undefined> => {
    try {
      const out = await git(['rev-list', '--count', range], { cwd: repoPath, timeoutMs: 10_000 });
      const parsed = Number.parseInt(out, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const behind = await count(`HEAD..${upstream}`);
  const state: SharedRepoState = {
    branch,
    head,
    ...(headDate ? { headDate } : {}),
    upstream,
    behind,
    ...(setAside ? { setAside } : {}),
  };
  if (fetchFailed) {
    return { ...state, staleReason: 'fetch_failed' };
  }
  // Behind by an unknown amount is not current: the upstream ref may not
  // exist (a guessed "origin/master" on a main repo) or git refused to count.
  if (behind === undefined) {
    return { ...state, staleReason: 'unverified' };
  }
  if (behind === 0) {
    return state;
  }
  if (branch !== upstream.replace(/^origin\//, '')) {
    return { ...state, staleReason: 'other_branch' };
  }
  try {
    const dirty = await git(['status', '--porcelain', '--untracked-files=no'], { cwd: repoPath, timeoutMs: 10_000 });
    // Porcelain lines are "XY path". The status letters are dropped by pattern,
    // not by column: `git()` trims its output, which eats the first line's
    // leading space.
    const dirtyFiles = dirty
      .split('\n')
      .map(line => line.trim().replace(/^\S+\s+/, ''))
      .filter(Boolean);
    if (dirtyFiles.length > 0) {
      return {
        ...state,
        staleReason: 'dirty_tree',
        dirtyFiles: dirtyFiles.slice(0, 5),
        ...(setAsideSkipped ? { setAsideSkipped } : {}),
      };
    }
  } catch {
    // fall through to the reasons that need no status
  }
  const ahead = await count(`${upstream}..HEAD`);
  return { ...state, staleReason: ahead ? 'diverged' : 'not_fast_forwardable' };
}

/** The clone a worktree belongs to, from its `.git` gitdir pointer. */
function parentRepoOf(wsPath: string): string | undefined {
  try {
    const gitContent = fs.readFileSync(path.join(wsPath, '.git'), 'utf8').trim();
    const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/);
    if (!gitdirMatch) return undefined;
    // <repo>/.git/worktrees/<name> → up three levels is the parent repo root.
    const parentRepo = path.resolve(gitdirMatch[1], '..', '..', '..');
    return fs.existsSync(parentRepo) ? parentRepo : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes a single managed worktree directory. Prefers `git worktree remove`
 * via the parent repo so git's worktree registry stays consistent; falls back
 * to a plain recursive delete and then prunes the registration. Best-effort —
 * returns true if the directory is gone afterwards.
 *
 * A worktree can hold a real node_modules (depCache.ts, issue #611):
 * newton-web's is 200k files, which git could not delete within its timeout.
 * Git was killed, the synchronous fallback delete blocked the sidecar, and the
 * worktree stayed registered, so the thread's next run could not create it.
 * node_modules is moved out first and deleted in the background.
 */
export async function removeWorktreeByPath(wsPath: string): Promise<boolean> {
  await discardInBackground(path.join(wsPath, 'node_modules'));
  const parentRepo = parentRepoOf(wsPath);
  if (parentRepo) {
    try {
      await git(['worktree', 'remove', '--force', wsPath], { cwd: parentRepo, timeoutMs: 60_000 });
      return true;
    } catch (error) {
      logger.warn({ wsPath, error: String(error) }, 'git worktree remove failed; deleting the directory instead');
    }
  }
  try {
    await fs.promises.rm(wsPath, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ wsPath, error: String(error) }, 'could not delete a worktree directory');
    return false;
  }
  if (parentRepo) {
    // The directory is gone; drop its registration too, or `worktree add` refuses the path.
    await git(['worktree', 'prune'], { cwd: parentRepo, timeoutMs: 30_000 }).catch(() => undefined);
  }
  return !fs.existsSync(wsPath);
}

/**
 * Removes every managed worktree for a Slack thread once its job reaches a
 * terminal state — so the next task in the thread creates a fresh worktree
 * (which fetches and branches from the current default branch) instead of
 * reusing a base captured earlier. Matches both the plain `<thread>` key
 * (implementation / single-repo investigation) and per-PR `<thread>--pr-N`
 * keys (PR review), across both repo directories. Best-effort and non-fatal.
 */
export async function cleanupThreadWorkspaces(threadTs: string): Promise<void> {
  if (!fs.existsSync(WORKSPACES_ROOT)) {
    return;
  }
  const safeThread = sanitizeThreadTs(threadTs);
  let cleaned = 0;

  try {
    for (const repoDir of fs.readdirSync(WORKSPACES_ROOT)) {
      const repoWorkspacesDir = path.join(WORKSPACES_ROOT, repoDir);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(repoWorkspacesDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      for (const key of fs.readdirSync(repoWorkspacesDir)) {
        // Exact thread key, or a per-PR variant `<thread>--pr-N`. The `--`
        // boundary prevents matching a different thread that merely shares a
        // prefix.
        if (key === safeThread || key.startsWith(`${safeThread}--`)) {
          if (await removeWorktreeByPath(path.join(repoWorkspacesDir, key))) {
            cleaned++;
          }
        }
      }
    }
  } catch (error) {
    logger.warn({ threadTs, error: String(error) }, 'error during per-thread workspace cleanup');
  }

  if (cleaned > 0) {
    logger.info({ threadTs, cleaned }, 'cleaned up workspaces for completed thread');
  }
}

/**
 * Removes workspaces that haven't been modified in over 7 days. Backstop for
 * the per-thread cleanup above (e.g. threads that paused and never resumed, or
 * cleanup hooks that didn't run). Intended to be called periodically (e.g. on
 * startup).
 */
export async function cleanupStaleWorkspaces(): Promise<void> {
  if (!fs.existsSync(WORKSPACES_ROOT)) {
    return;
  }

  const now = Date.now();
  let cleaned = 0;

  try {
    for (const repoDir of fs.readdirSync(WORKSPACES_ROOT)) {
      const repoWorkspacesDir = path.join(WORKSPACES_ROOT, repoDir);
      const stat = fs.statSync(repoWorkspacesDir);
      if (!stat.isDirectory()) continue;

      for (const threadDir of fs.readdirSync(repoWorkspacesDir)) {
        const wsPath = path.join(repoWorkspacesDir, threadDir);
        const wsStat = fs.statSync(wsPath);
        if (!wsStat.isDirectory()) continue;

        if (now - wsStat.mtimeMs > STALE_THRESHOLD_MS) {
          if (await removeWorktreeByPath(wsPath)) {
            cleaned++;
          }
        }
      }
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'error during stale workspace cleanup');
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'cleaned up stale workspaces');
  }
}
