import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logging/logger.js';

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
async function git(args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.toString().trim();
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
 * Resolves an isolated workspace for the given repo + thread.
 * Uses `git worktree` to create a lightweight checkout starting from
 * the default remote branch (origin/master or origin/main), NOT from
 * the local HEAD which may be on an unrelated feature branch.
 * Returns the original repoPath if worktree creation fails.
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
      logger.info(
        { repoPath, threadTs, wsPath, startPoint: defaultBranch },
        'refreshed reused workspace to default branch',
      );
      return wsPath;
    } catch (error) {
      // Couldn't guarantee a clean, current base (fetch or reset failed).
      // Don't hand back a possibly-stale/dirty worktree — discard it and fall
      // through to fresh creation below, which is itself fetch-guarded. If the
      // teardown also fails, the creation path's own failure handling returns
      // the shared repo path.
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

    // Create a detached worktree from the default remote branch (not local HEAD)
    const defaultBranch = await resolveDefaultRemoteBranch(repoPath);
    await git(['worktree', 'add', '--detach', wsPath, defaultBranch], { cwd: repoPath, timeoutMs: 30_000 });

    // Symlink parent node_modules so tools (Jest, ESLint, etc.) are available in the worktree
    const parentNodeModules = path.join(repoPath, 'node_modules');
    const worktreeNodeModules = path.join(wsPath, 'node_modules');
    if (fs.existsSync(parentNodeModules) && !fs.existsSync(worktreeNodeModules)) {
      try {
        fs.symlinkSync(parentNodeModules, worktreeNodeModules, 'junction');
        logger.info({ wsPath }, 'symlinked node_modules into worktree');
      } catch (symlinkError) {
        logger.warn({ wsPath, error: String(symlinkError) }, 'failed to symlink node_modules into worktree');
      }
    }

    logger.info({ repoPath, threadTs, wsPath, startPoint: defaultBranch }, 'created workspace via git worktree');
    return wsPath;
  } catch (error) {
    logger.warn(
      { repoPath, threadTs, wsPath, error: String(error) },
      'failed to create workspace, falling back to shared repo path',
    );
    return repoPath;
  }
}

/**
 * Fast-forwards a SHARED repo clone to its default remote branch so an agent
 * that reads the clone directly — the informational Q&A path, which (unlike the
 * PR/implementation pipeline) does NOT operate in an isolated worktree — sees
 * freshly-merged code instead of a checkout that has drifted behind origin.
 *
 * Safety: this mutates the user's real clone, so it ONLY ever fast-forwards.
 * `git merge --ff-only` advances the working tree when the local branch is a
 * strict ancestor of origin's, and refuses (non-fatal) on divergence, a feature
 * branch, or a dirty tree that would be overwritten — so uncommitted edits and
 * unpushed local commits are never clobbered. The `reset --hard` used for the
 * throwaway worktrees in `resolveWorkspace` would NOT be safe on a shared clone.
 *
 * Best-effort: returns the resolved `{ branch, head }` for telemetry, or null if
 * the repo couldn't be inspected. Never throws.
 */
export async function refreshSharedRepoToDefaultBranch(
  repoPath: string,
): Promise<{ branch: string; head: string } | null> {
  try {
    await git(['fetch', 'origin', '--quiet'], { cwd: repoPath, timeoutMs: 30_000 });
    const defaultBranch = await resolveDefaultRemoteBranch(repoPath);
    try {
      await git(['merge', '--ff-only', defaultBranch], { cwd: repoPath, timeoutMs: 30_000 });
    } catch {
      // Not fast-forwardable (feature branch, diverged history, or a dirty tree
      // that would be overwritten) — leave the checkout untouched and answer
      // against it rather than risk the user's local work.
      logger.warn(
        { repoPath, defaultBranch },
        'could not fast-forward shared repo to default branch; answering against current checkout',
      );
    }
  } catch (error) {
    logger.warn(
      { repoPath, error: String(error) },
      'git fetch failed before agent read; answering against local repo state',
    );
  }
  try {
    const head = await git(['rev-parse', '--short', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, timeoutMs: 10_000 });
    return { branch, head };
  } catch {
    return null;
  }
}

/**
 * Removes a single managed worktree directory. Prefers `git worktree remove`
 * via the parent repo (resolved from the worktree's `.git` gitdir pointer) so
 * git's worktree registry stays consistent; falls back to a plain recursive
 * delete. Best-effort — returns true if the directory is gone afterwards.
 */
async function removeWorktreeByPath(wsPath: string): Promise<boolean> {
  try {
    const gitDir = path.join(wsPath, '.git');
    if (fs.existsSync(gitDir)) {
      const gitContent = fs.readFileSync(gitDir, 'utf8').trim();
      const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/);
      if (gitdirMatch) {
        // <repo>/.git/worktrees/<name> → up three levels is the parent repo root.
        const parentGitDir = path.resolve(gitdirMatch[1], '..', '..', '..');
        if (fs.existsSync(parentGitDir)) {
          await git(['worktree', 'remove', '--force', wsPath], { cwd: parentGitDir, timeoutMs: 15_000 });
          return true;
        }
      }
    }
    fs.rmSync(wsPath, { recursive: true, force: true });
    return true;
  } catch {
    // Last resort: a plain delete so the stale dir can't be reused stale.
    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
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
