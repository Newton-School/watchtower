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
    default:
      return 'git would not fast-forward it';
  }
}

const commits = (count: number): string => `${count} commit${count === 1 ? '' : 's'}`;

/** The job-log line for one clone after a refresh attempt. `level` is WARN whenever it is not known to be current. */
export function describeRepoRefresh(
  repoName: string,
  state: SharedRepoState | null,
): { message: string; level: 'INFO' | 'WARN' } {
  if (!state) {
    return { message: `Could not inspect ${repoName}; it may not be a git checkout.`, level: 'WARN' };
  }
  if (isStaleCheckout(state)) {
    return {
      message: `${repoName} is ${commits(state.behind ?? 0)} behind ${state.upstream} and was not updated: ${staleReasonText(state)}. The files on disk are from ${state.head}; the agent is told to read ${state.upstream} instead.`,
      level: 'WARN',
    };
  }
  if (state.staleReason === 'fetch_failed') {
    return {
      message: `Could not fetch ${repoName}; answering from ${state.branch} @ ${state.head} as of the last fetch.`,
      level: 'WARN',
    };
  }
  return { message: `Refreshed ${repoName} to ${state.branch} @ ${state.head}.`, level: 'INFO' };
}

/** The block added to the agent's instructions for the clones it must read from git. Empty when none is stale. */
export function buildStaleCheckoutBlock(repos: Array<{ name: string; state: SharedRepoState | null }>): string {
  const stale = repos.filter((repo): repo is { name: string; state: SharedRepoState & { upstream: string } } =>
    isStaleCheckout(repo.state),
  );
  if (stale.length === 0) return '';
  const lines = stale.map(
    ({ name, state }) =>
      `- ${name}: the files on disk are ${commits(state.behind ?? 0)} behind ${state.upstream} (${staleReasonText(state)}). Read it from ${state.upstream}.`,
  );
  const example = stale[0];
  return [
    'STALE CHECKOUTS — for these repos the files on disk are OUT OF DATE. Do not read, grep or glob them from disk:',
    ...lines,
    // `cd … &&`, not `git -C`: a read-only run allows the first and refuses the second (issue #443).
    'Read the up-to-date tree through git instead, for example:',
    `  cd ${example.name} && git grep -n "<pattern>" ${example.state.upstream} -- <path>`,
    `  cd ${example.name} && git show ${example.state.upstream}:<path>`,
    `  cd ${example.name} && git log -5 ${example.state.upstream} -- <path>`,
    'Never conclude that something "does not exist" or "is not there" in such a repo from the files on disk.',
    `Say in your answer that you read ${stale
      .map(repo => repo.state.upstream)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' / ')}, not the local files.`,
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
  const { config, stage, logStep } = params;
  const refreshed: Array<{ name: string; state: SharedRepoState | null }> = [];
  for (const { path: repoPath } of enabledRepoPaths(config)) {
    // A refresh that throws must not stop the run that wanted it: the clone
    // is reported as not refreshed and the run reads what is on disk.
    let state: SharedRepoState | null = null;
    try {
      state = await refreshSharedRepoToDefaultBranch(repoPath);
    } catch {
      state = null;
    }
    const name = path.basename(repoPath);
    refreshed.push({ name, state });
    // Says what happened, not what was attempted: a clone that could not be
    // updated is a WARN with how far behind it is and why.
    const { message, level } = describeRepoRefresh(name, state);
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
      },
    });
  }
  // A stale clone still has origin's refs: point the agent at those.
  return buildStaleCheckoutBlock(refreshed) || undefined;
}
