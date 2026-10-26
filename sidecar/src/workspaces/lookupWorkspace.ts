import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig, WorkflowStepLogger } from '../types/contracts.js';
import { enabledRepoPaths, REPO_REGISTRY } from '../repos/registry.js';

const execFileAsync = promisify(execFile);

/**
 * A lookup's own copy of the repos (issue #446).
 *
 * Lookups used to read the owner's shared clones in place. One had two
 * uncommitted files, so it could never be fast-forwarded and lookups read
 * code months old. Now each lookup reads a directory of worktrees, one per
 * repo, checked out at origin's default branch right after a fetch, and
 * removed when the lookup is done. The shared clones' working trees are never
 * touched: only their objects (the fetch) and their worktree list.
 *
 * The directories are a few fixed slots (`lookup-1`, `lookup-2`, …), not a
 * new name per lookup: Claude Code keeps a transcript folder per working
 * directory, and a fresh name every time would leave one behind per lookup.
 */

/** Where the slots live. Tests point it at a temp dir. */
export const __lookupWorkspaces = { root: path.join(os.homedir(), '.watchtower', 'lookup-workspaces') };

/** Slots in use by a lookup in this process. Only this process creates them (the sidecar lock). */
const claimedSlots = new Set<number>();

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return stdout.toString().trim();
}

export interface LookupRepo {
  name: string;
  /** What the lookup reads: origin's default branch, e.g. "origin/master". */
  upstream: string;
  head: string;
  /** The fetch failed: `upstream` is as of the last successful fetch. */
  fetchFailed: boolean;
}

export interface LookupWorkspace {
  cwd: string;
  repos: LookupRepo[];
  /** Removes the worktrees and frees the slot. Never throws; safe to call twice. */
  cleanup(): Promise<void>;
}

/**
 * Removes a slot directory and the worktrees in it. `git worktree remove`
 * keeps each clone's worktree list right; whatever it could not remove is
 * deleted from disk and pruned from the list.
 */
async function removeSlotDir(dir: string, repoPaths: string[]): Promise<void> {
  if (!fs.existsSync(dir)) return;
  for (const repoPath of repoPaths) {
    const worktree = path.join(dir, path.basename(repoPath));
    if (!fs.existsSync(worktree)) continue;
    try {
      await git(repoPath, ['worktree', 'remove', '--force', worktree], 60_000);
    } catch {
      // deleted below, then pruned
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  for (const repoPath of repoPaths) {
    try {
      await git(repoPath, ['worktree', 'prune'], 30_000);
    } catch {
      // not a git checkout, or busy: the next sweep prunes it
    }
  }
}

/**
 * Sets up a lookup's copy of the repos. Returns undefined when it could not:
 * the caller then reads the shared clones the way it did before.
 */
export async function createLookupWorkspace(params: {
  config: AppConfig;
  stage: string;
  logStep?: WorkflowStepLogger;
}): Promise<LookupWorkspace | undefined> {
  const { config, stage, logStep } = params;
  const sources = enabledRepoPaths(config);
  const repoPaths = sources.map(source => source.path);
  let slot = 1;
  while (claimedSlots.has(slot)) slot++;
  claimedSlots.add(slot);
  const dir = path.join(__lookupWorkspaces.root, `lookup-${slot}`);

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await removeSlotDir(dir, repoPaths);
    } catch {
      // the startup sweep removes it
    } finally {
      claimedSlots.delete(slot);
    }
  };

  try {
    // Loaded here, not at the top: the test setup imports this module, and
    // workspaceManager fixes its folders from HOME when it loads, before a
    // test can point HOME elsewhere.
    const { fetchClone } = await import('./workspaceManager.js');
    // A slot left behind by a cleanup that failed.
    await removeSlotDir(dir, repoPaths);
    fs.mkdirSync(dir, { recursive: true });
    const repos: LookupRepo[] = [];
    for (const { key, path: repoPath } of sources) {
      const name = path.basename(repoPath);
      // Shares a fetch already running in the clone, and waits out its ref lock (issue #610).
      const fetchFailed = !(await fetchClone(repoPath));
      let upstream: string;
      try {
        upstream = await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], 10_000);
      } catch {
        upstream = `origin/${REPO_REGISTRY[key].expectedDefaultBranch}`;
      }
      const worktree = path.join(dir, name);
      await git(repoPath, ['worktree', 'add', '--detach', '--quiet', worktree, upstream], 120_000);
      const head = await git(worktree, ['rev-parse', '--short', 'HEAD'], 10_000);
      repos.push({ name, upstream, head, fetchFailed });
      logStep?.({
        stage,
        level: fetchFailed ? 'WARN' : 'INFO',
        message: fetchFailed
          ? `Could not fetch ${name}; the lookup reads ${upstream} @ ${head} as of the last fetch.`
          : `The lookup reads ${name} at ${upstream} @ ${head}, in its own copy.`,
        data: { repoPath, upstream, head, fetchFailed, workspace: dir },
      });
    }
    return { cwd: dir, repos, cleanup };
  } catch (error) {
    logStep?.({
      stage,
      level: 'WARN',
      message: `Could not set up the lookup's own copy of the repos; reading the shared clones instead. ${String(error).slice(0, 300)}`,
    });
    await cleanup();
    return undefined;
  }
}

/**
 * Removes every slot. Run at startup, when no lookup is running: whatever is
 * there was left by a sidecar that stopped mid-lookup.
 */
export async function sweepLookupWorkspaces(config: AppConfig): Promise<number> {
  const root = __lookupWorkspaces.root;
  if (!fs.existsSync(root)) return 0;
  const repoPaths = enabledRepoPaths(config).map(source => source.path);
  let removed = 0;
  for (const entry of fs.readdirSync(root)) {
    if (!/^lookup-\d+$/.test(entry) || claimedSlots.has(Number(entry.slice('lookup-'.length)))) continue;
    try {
      await removeSlotDir(path.join(root, entry), repoPaths);
      removed++;
    } catch {
      // tried again next start
    }
  }
  return removed;
}
