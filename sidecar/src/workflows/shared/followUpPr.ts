import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { toolchainEnv } from '../../backends/codexBackend.js';
import { repoKeyFromGithubRepoName, type RepoKey } from '../../repos/registry.js';
import type { NormalizedTask } from '../../types/contracts.js';
import { parsePrUrl } from '../prFollowUp.js';
import { STAGING_STATE_KEY } from '../stagingDeployWorkflow.js';

const execFileAsync = promisify(execFile);

/**
 * A change asked in a thread where an earlier change run opened a PR that is
 * still open goes onto that PR (issue #730). A PM's "also change the other
 * page" used to become a second branch and a second PR, which often
 * conflicted with the first. The plan is still approved as usual; only where
 * the coder works and where the change lands differ.
 */

export interface FollowUpPr {
  url: string;
  owner: string;
  repo: string;
  number: number;
  /** The PR's head branch, on the same repository (a fork's PR is never followed up). */
  branch: string;
  /** The registry repo, when the PR is in one miniOG knows. */
  repoKey: RepoKey | null;
  /** Files the PR changes already, for the planner. */
  files: string[];
}

export type FollowUpLookup =
  | { kind: 'none' }
  | { kind: 'followup'; pr: FollowUpPr }
  /** More than one open PR from earlier change runs: the person picks one. */
  | { kind: 'several'; prUrls: string[] }
  /** The thread's earlier PR is merged or closed: this change gets a new PR, and the reply says why. */
  | { kind: 'ended'; prUrl: string; state: 'MERGED' | 'CLOSED' };

interface PrView {
  url?: string;
  number?: number;
  state?: string;
  headRefName?: string;
  isCrossRepository?: boolean;
  files?: Array<{ path?: string }>;
}

/** Test seams: GitHub reads and git commands. */
export const __followUpDeps = {
  viewPr: async (url: string): Promise<PrView> => {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', url, '--json', 'url,number,state,headRefName,isCrossRepository,files'],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env: toolchainEnv() },
    );
    return JSON.parse(stdout) as PrView;
  },
  git: async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.toString().trim();
  },
};

/**
 * Which PR, if any, a change asked in this thread adds to. Only PRs earlier
 * change runs in this thread opened count (the job store's record of them),
 * never a link someone pasted. When several are open, a link to one of them
 * in the message picks it; otherwise the person is asked.
 */
export async function findFollowUpPr(params: {
  task: NormalizedTask;
  store?: { changeRunPrUrlsInThread?: (channelId: string, threadTs: string) => string[] };
}): Promise<FollowUpLookup> {
  const { task, store } = params;
  let urls: string[];
  try {
    urls = store?.changeRunPrUrlsInThread?.(task.event.channelId, task.event.threadTs) ?? [];
  } catch {
    return { kind: 'none' };
  }
  if (urls.length === 0) return { kind: 'none' };

  const open: FollowUpPr[] = [];
  let ended: { prUrl: string; state: 'MERGED' | 'CLOSED' } | undefined;
  for (const url of urls) {
    const parsed = parsePrUrl(url);
    if (!parsed) continue;
    let view: PrView;
    try {
      view = await __followUpDeps.viewPr(url);
    } catch {
      // GitHub can't say whether it's open: not a PR to push to.
      continue;
    }
    if (view.state === 'OPEN') {
      if (view.isCrossRepository || !view.headRefName) continue;
      open.push({
        url: parsed.url,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        branch: view.headRefName,
        repoKey: repoKeyFromGithubRepoName(parsed.repo),
        files: (view.files ?? []).map(file => file.path ?? '').filter(Boolean),
      });
    } else if (!ended && (view.state === 'MERGED' || view.state === 'CLOSED')) {
      ended = { prUrl: parsed.url, state: view.state };
    }
  }

  if (open.length === 1) return { kind: 'followup', pr: open[0] };
  if (open.length > 1) {
    // A link to one of them in the message itself says which.
    const named = open.filter(pr => (task.event.text ?? '').includes(`/pull/${pr.number}`) && sameRepoIn(task, pr));
    if (named.length === 1) return { kind: 'followup', pr: named[0] };
    return { kind: 'several', prUrls: open.map(pr => pr.url) };
  }
  return ended ? { kind: 'ended', ...ended } : { kind: 'none' };
}

function sameRepoIn(task: NormalizedTask, pr: FollowUpPr): boolean {
  return (task.event.text ?? '').toLowerCase().includes(`${pr.owner}/${pr.repo}/pull/${pr.number}`.toLowerCase());
}

/** The question when several open PRs from this thread could take the change. */
export function whichPrQuestion(prUrls: string[]): string {
  return `This thread has ${prUrls.length} open pull requests I made: ${prUrls.map(url => `<${url}>`).join(', ')}. Mention me again with the link of the one this change belongs to, so I add it there.`;
}

/** What the planner is told about the PR this change adds to. */
export function followUpPlannerBlock(pr: FollowUpPr): string {
  const files = pr.files.length > 0 ? ` It already changes ${pr.files.map(file => `\`${file}\``).join(', ')}.` : '';
  return [
    '',
    '=== FOLLOW-UP ON AN OPEN PULL REQUEST ===',
    `An earlier request in this thread opened ${pr.url} (${pr.owner}/${pr.repo}, branch \`${pr.branch}\`), and it is still open.${files}`,
    "If this request is a further change to that work in the same repository, plan ONLY the new change: the coder adds it as a new commit on that branch, so do not repeat what the pull request already does. The code you read is the default branch; the pull request's changes are not in it.",
    'If this request is for a different repository, plan it normally.',
    '=== END FOLLOW-UP ===',
    '',
  ].join('\n');
}

const WORKSPACES_ROOT = path.join(os.homedir(), '.watchtower', 'workspaces');

/**
 * Moves the run's worktree onto the PR's branch, detached at its latest
 * commit: fetched fresh, never reset to the default branch, nothing merged.
 * Detached, so a branch checked out somewhere else never blocks it; the coder
 * pushes with `git push origin HEAD:<branch>`. Only miniOG's own worktrees.
 */
export async function checkoutFollowUpBranch(
  wsPath: string,
  branch: string,
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  if (!path.resolve(wsPath).startsWith(`${WORKSPACES_ROOT}${path.sep}`)) {
    return { ok: false, reason: 'not a miniOG worktree' };
  }
  try {
    await __followUpDeps.git(wsPath, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await __followUpDeps.git(wsPath, ['checkout', '--detach', '--force', `origin/${branch}`]);
    await __followUpDeps.git(wsPath, ['clean', '-fd']);
    const head = await __followUpDeps.git(wsPath, ['rev-parse', 'HEAD']);
    return { ok: true, head };
  } catch (error) {
    return { ok: false, reason: String(error).split('\n')[0] };
  }
}

/** Whether the marketing staging site last showed this branch (#702's record). */
export function stagingShowsBranch(store: { getState?(key: string): string | undefined } | undefined, branch: string) {
  try {
    const raw = store?.getState?.(STAGING_STATE_KEY);
    if (!raw) return false;
    return (JSON.parse(raw) as { branch?: unknown }).branch === branch;
  } catch {
    return false;
  }
}

export const STAGING_STILL_OLD = 'Staging still shows the previous version — ask me for a new testing link.';
