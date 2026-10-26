import path from 'node:path';
import type { AppConfig, WorkflowStepLogger } from '../types/contracts.js';
import { enabledRepoPaths } from '../repos/registry.js';
import { refreshSharedRepoToDefaultBranch, type SharedRepoState } from './workspaceManager.js';

/**
 * What to say, and what to tell the agent, when a shared clone is behind
 * origin (issue #446).
 *
 * Lookups read the owner's clones in place. One of them had two uncommitted
 * files, so every fast-forward was refused and it sat on a commit from four
 * months earlier, 707 commits behind, while each run logged "Refreshed". A PM
 * was told a query parameter "doesn't exist anywhere: zero hits" three weeks
 * after it had shipped.
 *
 * The fetch still succeeds on such a clone, so the current code is one git
 * command away: the agent is told to read `origin/<branch>` instead of the
 * files on disk.
 */

/** A clone the agent must not read from disk: it is known to be behind, and the up-to-date tree is known. */
export function isStaleCheckout(state: SharedRepoState | null): state is SharedRepoState & { upstream: string } {
  return Boolean(state && state.upstream && state.behind && state.behind > 0);
}

/** Why the clone was not updated, as a clause. */
export function staleReasonText(state: SharedRepoState): string {
  switch (state.staleReason) {
    case 'dirty_tree':
      return `it has uncommitted changes to ${(state.dirtyFiles ?? []).join(', ') || 'tracked files'}`;
    case 'other_branch':
      return `it is checked out on ${state.branch}, not the default branch`;
    case 'diverged':
      return `it has local commits that are not on ${state.upstream ?? 'origin'}`;
    case 'fetch_failed':
      return 'git fetch failed, so this is as of the last successful fetch';
    case 'unverified':
      return "I couldn't tell how far it is behind GitHub";
    case 'not_updated':
      return 'it was only fetched, and its files were left as they were';
    default:
      return 'git would not fast-forward it';
  }
}

const commits = (count: number): string => `${count} commit${count === 1 ? '' : 's'}`;

/**
 * A clone whose files may be old with no newer tree to read instead: the
 * fetch failed, how far behind it is is unknown, or the refresh failed
 * outright (null).
 */
function isUnconfirmedCheckout(state: SharedRepoState | null): boolean {
  if (!state) return true;
  return !isStaleCheckout(state) && (state.staleReason === 'fetch_failed' || state.staleReason === 'unverified');
}

/** " as of 2026-05-26", or nothing when the HEAD date is unknown. */
const asOf = (state: SharedRepoState): string => (state.headDate ? ` as of ${state.headDate}` : '');

/** Where set-aside changes are saved: the private ref (or the stash list), and the patch copy when there is one. */
const savedAt = (kept: { ref?: string; patch?: string; stashLabel?: string }): string =>
  `${kept.ref ?? `the clone's stash list as "${kept.stashLabel ?? 'miniog-autostash'}"`}${
    kept.patch ? ` (patch copy: ${kept.patch})` : ''
  }`;

/** An index.lock older than this is reported as probably left by a git command that crashed. */
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

/** "3 minutes", "2 hours". */
function age(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** What happened to the changes in the way when they were not set aside, as a sentence, or nothing. */
function setAsideSkippedText(state: SharedRepoState): string {
  switch (state.setAsideSkipped) {
    case 'recent_edits':
      return ' They changed in the last 15 minutes, so they were left in place.';
    case 'busy': {
      const lockAge = state.indexLockAgeMs;
      if (lockAge !== undefined && lockAge > STALE_INDEX_LOCK_MS) {
        return ` The clone has an index.lock from ${age(lockAge)} ago, probably left by a git command that crashed, so they were left in place; delete it if nothing is running there.`;
      }
      return ` A git command was running in the clone${lockAge !== undefined ? ` (its index.lock is ${age(lockAge)} old)` : ''}, so they were left in place.`;
    }
    case 'other_staged':
      return ' Other files have staged changes, so nothing was moved.';
    case 'update_failed':
      return ' They were set aside, but the update still failed for another reason, so they were put back.';
    case 'failed': {
      const kept = state.setAsideKept;
      if (kept?.restored === 'no') {
        return ` Setting them aside did not finish and putting them back failed: they are NOT in the working tree, they are saved at ${savedAt(kept)}.`;
      }
      if (kept?.restored === 'unstaged') {
        return ` Setting them aside did not finish; they are back in the working tree, unstaged, and a copy is saved at ${savedAt(kept)}.`;
      }
      return ' Setting them aside did not work, so they were left in place.';
    }
    default:
      return '';
  }
}

/** "2 files", "1 file". */
const files = (count: number): string => `${count} file${count === 1 ? '' : 's'}`;

/** The job-log line for one clone after a refresh attempt. `level` is WARN whenever it is not known to be current. */
export function describeRepoRefresh(
  repoName: string,
  state: SharedRepoState | null,
  opts: { fetchOnly?: boolean } = {},
): { message: string; level: 'INFO' | 'WARN' } {
  if (!state) {
    return { message: `Could not inspect ${repoName}; it may not be a git checkout.`, level: 'WARN' };
  }
  if (isStaleCheckout(state)) {
    return {
      message: `${repoName} is ${commits(state.behind ?? 0)} behind ${state.upstream} and was not updated: ${staleReasonText(state)}.${setAsideSkippedText(state)} The files on disk are from ${state.head}${asOf(state)}; the agent is told to read ${state.upstream} instead.`,
      level: 'WARN',
    };
  }
  if (state.staleReason === 'fetch_failed') {
    return {
      message: `Could not fetch ${repoName}; answering from ${state.branch} @ ${state.head}${state.headDate ? ` (${state.headDate})` : ''} as of the last fetch${state.lastFetched ? ` (${state.lastFetched})` : ''}.`,
      level: 'WARN',
    };
  }
  if (state.staleReason === 'unverified') {
    return {
      message: `Could not confirm ${repoName} is up to date with ${state.upstream ?? 'origin'}; answering from ${state.branch} @ ${state.head}${asOf(state)}.`,
      level: 'WARN',
    };
  }
  if (state.setAside) {
    const set = state.setAside;
    const shown = set.files.slice(0, 5).join(', ') + (set.files.length > 5 ? ` and ${set.files.length - 5} more` : '');
    const others = state.leftInPlaceCount
      ? ` ${files(state.leftInPlaceCount)} the update didn't touch stayed as they were (${(state.leftInPlace ?? []).join(', ')}${state.leftInPlaceCount > (state.leftInPlace ?? []).length ? ', …' : ''}).`
      : '';
    return {
      message: `Refreshed ${repoName} to ${state.branch} @ ${state.head} after setting aside ${files(set.files.length)} with uncommitted changes in the way (${shown}). They are saved at ${savedAt(set)}; \`git stash show -p --include-untracked ${set.ref}\` in the clone shows them.${others}`,
      level: 'WARN',
    };
  }
  if (opts.fetchOnly) {
    return { message: `Fetched ${repoName}; its files (${state.branch} @ ${state.head}) are current.`, level: 'INFO' };
  }
  return { message: `Refreshed ${repoName} to ${state.branch} @ ${state.head}.`, level: 'INFO' };
}

/**
 * The block added to the agent's instructions for the clones it must read
 * from git. Empty when none is stale. `path` is where to `cd` when the clone
 * is not below the run's working directory.
 */
export function buildStaleCheckoutBlock(
  repos: Array<{ name: string; path?: string; state: SharedRepoState | null }>,
): string {
  const stale = repos.filter(
    (repo): repo is { name: string; path?: string; state: SharedRepoState & { upstream: string } } =>
      isStaleCheckout(repo.state),
  );
  // No newer tree to point at: the agent reads the files on disk and says they may be old.
  const unconfirmed = repos.filter(repo => isUnconfirmedCheckout(repo.state));
  const unconfirmedLine = (name: string, state: SharedRepoState | null): string => {
    if (!state) return `- ${name}: the update check failed, so the files may be out of date.`;
    const files = `the files are from ${state.head}${state.headDate ? ` (${state.headDate})` : ''}`;
    return state.staleReason === 'fetch_failed'
      ? `- ${name}: git fetch failed${state.lastFetched ? `; it last fetched on ${state.lastFetched}` : ''}, and ${files}.`
      : `- ${name}: I couldn't tell how far it is behind GitHub; ${files}.`;
  };
  const unconfirmedBlock = unconfirmed.length
    ? [
        'POSSIBLY OUT OF DATE — these repos could not be checked against GitHub just now:',
        ...unconfirmed.map(({ name, state }) => unconfirmedLine(name, state)),
        'If your answer depends on recent changes in them, say the code you read may be out of date.',
      ].join('\n')
    : '';
  if (stale.length === 0) return unconfirmedBlock;
  const lines = stale.map(
    ({ name, state }) =>
      `- ${name}: the files on disk are ${commits(state.behind ?? 0)} behind ${state.upstream} (${staleReasonText(state)}). Read it from ${state.upstream}.`,
  );
  const example = stale[0];
  return [
    'STALE CHECKOUTS — for these repos the files on disk are OUT OF DATE. Do not read, grep or glob them from disk:',
    ...lines,
    // A read-only run refuses `cd … && git …`, `git -C` and `git grep`
    // whatever its rules say (issue #622): `cd` on its own, then git.
    'Read the up-to-date tree through git instead: run `cd` into the repo as a command on its own, then each git command as its own call, for example:',
    `  cd ${example.path ?? example.name}`,
    `  git show ${example.state.upstream}:<path>`,
    `  git log -5 ${example.state.upstream} -- <path>`,
    `  git ls-tree -r --name-only ${example.state.upstream} -- <folder>`,
    'Never conclude that something "does not exist" or "is not there" in such a repo from the files on disk.',
    `Say in your answer that you read ${stale
      .map(repo => repo.state.upstream)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' / ')}, not the local files.`,
    ...(unconfirmedBlock ? ['', unconfirmedBlock] : []),
  ].join('\n');
}

/**
 * Refresh every shared clone a run is about to read, log where each one
 * really is, and return the block that tells the agent which ones are stale
 * (undefined when none are). Lookups, planners and broad investigations all
 * read these clones in place (issue #446).
 */
export async function refreshSharedClones(params: {
  config: AppConfig;
  stage: string;
  logStep?: WorkflowStepLogger;
}): Promise<string | undefined> {
  // A stale clone still has origin's refs: point the agent at those.
  return buildStaleCheckoutBlock(await refreshRepoClones(params)) || undefined;
}

/**
 * Refresh the shared clones, all at once, and log where each one really is.
 * `except` leaves out a clone the run already has a fresh worktree of;
 * `fetchOnly` updates origin's refs and leaves the files as they are.
 */
export async function refreshRepoClones(params: {
  config: AppConfig;
  stage: string;
  logStep?: WorkflowStepLogger;
  except?: string;
  fetchOnly?: boolean;
}): Promise<Array<{ name: string; path: string; state: SharedRepoState | null }>> {
  const { config, stage, logStep, except, fetchOnly } = params;
  const repoPaths = enabledRepoPaths(config)
    .map(repo => repo.path)
    .filter(repoPath => !except || path.resolve(repoPath) !== path.resolve(except));
  const refreshed = await Promise.all(
    repoPaths.map(async repoPath => {
      // A refresh that throws must not stop the run that wanted it: the clone
      // is reported as not refreshed and the run reads what is on disk.
      let state: SharedRepoState | null = null;
      try {
        // These are miniOG's own clones, so a stray change in the way is set aside (issue #709).
        state = await refreshSharedRepoToDefaultBranch(
          repoPath,
          fetchOnly ? { fetchOnly: true } : { setAsideStrayChanges: true },
        );
      } catch {
        state = null;
      }
      return { name: path.basename(repoPath), path: repoPath, state };
    }),
  );
  for (const { name, path: repoPath, state } of refreshed) {
    // Says what happened, not what was attempted: a clone that could not be
    // updated is a WARN with how far behind it is and why.
    const { message, level } = describeRepoRefresh(name, state, { fetchOnly });
    logStep?.({
      stage,
      message,
      level,
      data: {
        repoPath,
        branch: state?.branch,
        head: state?.head,
        upstream: state?.upstream,
        behind: state?.behind,
        staleReason: state?.staleReason,
        dirtyFiles: state?.dirtyFiles,
        headDate: state?.headDate,
        lastFetched: state?.lastFetched,
        setAside: state?.setAside,
        setAsideSkipped: state?.setAsideSkipped,
        setAsideKept: state?.setAsideKept,
        leftInPlace: state?.leftInPlace,
      },
    });
  }
  return refreshed;
}
