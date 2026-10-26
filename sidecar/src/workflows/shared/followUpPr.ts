import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildUnfinishedRunMessage, prLine } from '../../agents/unfinishedRun.js';
import type { PipelineResult } from '../../agents/types.js';
import { toolchainEnv } from '../../backends/codexBackend.js';
import { repoKeyFromGithubRepoName, type RepoKey } from '../../repos/registry.js';
import type { NormalizedTask, WorkflowStepLogger } from '../../types/contracts.js';
import { parsePrUrl } from '../prFollowUp.js';
import { STAGING_HEADS_UP_WINDOW_MS, STAGING_STATE_KEY } from '../stagingDeployWorkflow.js';

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
  /** The PR's diff for the planner, bounded; undefined when GitHub didn't give one. */
  diff?: string;
  /** Who the change run that opened it was for. */
  requesterId?: string;
}

export type FollowUpLookup =
  | { kind: 'none' }
  | { kind: 'followup'; pr: FollowUpPr }
  /** More than one open PR from earlier change runs: the person picks one. */
  | { kind: 'several'; prUrls: string[] }
  /** The thread's earlier PR is merged or closed: this change gets a new PR, and the reply says why. */
  | { kind: 'ended'; prUrl: string; state: 'MERGED' | 'CLOSED' }
  /** Someone else asked for the open PR: this change gets its own PR, and the reply says why. */
  | { kind: 'others'; pr: FollowUpPr }
  /** GitHub couldn't say what the thread's PR is now: a new PR, and the reply says so. */
  | { kind: 'unreadable'; prUrl: string };

export interface PrView {
  url?: string;
  number?: number;
  state?: string;
  headRefName?: string;
  headRefOid?: string;
  isCrossRepository?: boolean;
  files?: Array<{ path?: string }>;
}

/** The planner gets at most this much of the PR's diff. */
export const FOLLOW_UP_DIFF_MAX_BYTES = 35_000;
const FILE_LIST_MAX = 20;

/** Test seams: GitHub reads and git commands. */
export const __followUpDeps = {
  viewPr: async (url: string): Promise<PrView> => {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', url, '--json', 'url,number,state,headRefName,headRefOid,isCrossRepository,files'],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env: toolchainEnv() },
    );
    return JSON.parse(stdout) as PrView;
  },
  prDiff: async (url: string): Promise<string> => {
    const { stdout } = await execFileAsync('gh', ['pr', 'diff', url], {
      timeout: 20_000,
      maxBuffer: 20 * 1024 * 1024,
      env: toolchainEnv(),
    });
    return stdout.toString();
  },
  git: async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    return stdout.toString().trim();
  },
};

export type ThreadChangePr = { prUrl: string; requesterId?: string };

/**
 * Which PR, if any, a change asked in this thread adds to. Only PRs earlier
 * change runs in this thread opened count (the job store's record of them),
 * never a link someone pasted. When several are open, a link to one of them
 * in the message picks it; otherwise the person is asked. A PR someone else
 * asked for is added to only by its requester, the owner or an admin
 * (`mayAddToOthers`); anyone else's change gets its own PR.
 */
export async function findFollowUpPr(params: {
  task: NormalizedTask;
  store?: { changeRunPrsInThread?: (channelId: string, threadTs: string) => ThreadChangePr[] };
  /** Who the change is for (`requesterOf`). */
  requesterId: string;
  /** The owner or an admin may add to anyone's PR. */
  mayAddToOthers: boolean;
  logStep?: WorkflowStepLogger;
}): Promise<FollowUpLookup> {
  const { task, store, requesterId, mayAddToOthers, logStep } = params;
  let prs: ThreadChangePr[];
  try {
    prs = store?.changeRunPrsInThread?.(task.event.channelId, task.event.threadTs) ?? [];
  } catch (error) {
    logStep?.({
      stage: 'implementation.followup.lookup_failed',
      message: "Couldn't read the thread's earlier change runs; planning a new PR.",
      level: 'WARN',
      data: { error: String(error) },
    });
    return { kind: 'none' };
  }
  if (prs.length === 0) return { kind: 'none' };

  const open: FollowUpPr[] = [];
  let ended: { prUrl: string; state: 'MERGED' | 'CLOSED' } | undefined;
  let unreadable: string | undefined;
  for (const { prUrl: url, requesterId: prRequester } of prs) {
    const parsed = parsePrUrl(url);
    if (!parsed) continue;
    let view: PrView;
    try {
      view = await __followUpDeps.viewPr(url);
    } catch (error) {
      unreadable ??= parsed.url;
      logStep?.({
        stage: 'implementation.followup.lookup_failed',
        message: `Couldn't read ${parsed.url} on GitHub.`,
        level: 'WARN',
        data: { prUrl: parsed.url, error: String(error).split('\n')[0] },
      });
      continue;
    }
    if (view.state === 'OPEN') {
      if (view.isCrossRepository || !view.headRefName) continue;
      const files = (view.files ?? []).map(file => file.path ?? '').filter(Boolean);
      open.push({
        url: parsed.url,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        branch: view.headRefName,
        repoKey: repoKeyFromGithubRepoName(parsed.repo),
        files,
        ...(prRequester ? { requesterId: prRequester } : {}),
      });
    } else if (!ended && (view.state === 'MERGED' || view.state === 'CLOSED')) {
      ended = { prUrl: parsed.url, state: view.state };
    }
  }

  let chosen: FollowUpPr | undefined;
  if (open.length === 1) chosen = open[0];
  else if (open.length > 1) {
    // A link to one of them in the message itself says which.
    const named = open.filter(pr => linksPr(task.event.text ?? '', pr));
    if (named.length !== 1) return { kind: 'several', prUrls: open.map(pr => pr.url) };
    chosen = named[0];
  }
  if (chosen) {
    if (!mayAddToOthers && chosen.requesterId && chosen.requesterId !== requesterId) {
      return { kind: 'others', pr: chosen };
    }
    return { kind: 'followup', pr: { ...chosen, ...(await boundedDiff(chosen.url, logStep)) } };
  }
  if (ended) return { kind: 'ended', ...ended };
  return unreadable ? { kind: 'unreadable', prUrl: unreadable } : { kind: 'none' };
}

function linksPr(text: string, pr: FollowUpPr): boolean {
  return text.toLowerCase().includes(`${pr.owner}/${pr.repo}/pull/${pr.number}`.toLowerCase());
}

async function boundedDiff(url: string, logStep?: WorkflowStepLogger): Promise<{ diff?: string }> {
  try {
    const diff = await __followUpDeps.prDiff(url);
    if (Buffer.byteLength(diff, 'utf8') <= FOLLOW_UP_DIFF_MAX_BYTES) return { diff };
    const cut = Buffer.from(diff, 'utf8').subarray(0, FOLLOW_UP_DIFF_MAX_BYTES).toString('utf8');
    return { diff: `${cut}\n[… the rest of the diff is cut: it is longer than ${FOLLOW_UP_DIFF_MAX_BYTES} bytes]` };
  } catch (error) {
    logStep?.({
      stage: 'implementation.followup.lookup_failed',
      message: `Couldn't read the diff of ${url}; the planner gets its file list only.`,
      level: 'WARN',
      data: { prUrl: url, error: String(error).split('\n')[0] },
    });
    return {};
  }
}

/** The PR as it is on GitHub now, or undefined when GitHub can't say. */
export async function readPrNow(
  url: string,
): Promise<{ state: string; branch?: string; head?: string; crossRepo: boolean } | undefined> {
  try {
    const view = await __followUpDeps.viewPr(url);
    if (!view.state) return undefined;
    return {
      state: view.state,
      ...(view.headRefName ? { branch: view.headRefName } : {}),
      ...(view.headRefOid ? { head: view.headRefOid } : {}),
      crossRepo: Boolean(view.isCrossRepository),
    };
  } catch {
    return undefined;
  }
}

/** The question when several open PRs from this thread could take the change. */
export function whichPrQuestion(prUrls: string[]): string {
  return `This thread has ${prUrls.length} open pull requests I made: ${prUrls.map(url => `<${url}>`).join(', ')}. Mention me again with the link of the one this change belongs to and the change, in one message, so I add it there.`;
}

/** Why a change gets a new PR instead of going onto the thread's PR, for the reply. */
export function followUpNoteFor(lookup: FollowUpLookup): string {
  switch (lookup.kind) {
    case 'ended':
      return `${lookup.prUrl} is already ${lookup.state === 'MERGED' ? 'merged' : 'closed'}, so this change is in a new pull request.`;
    case 'others':
      return `${lookup.pr.url} was asked for by someone else, so this change is in its own pull request. Merging both may need a sync.`;
    case 'unreadable':
      return `I couldn't check ${lookup.prUrl} on GitHub, so this change is in a new pull request.`;
    default:
      return '';
  }
}

/**
 * What a follow-up that didn't finish left on its PR (issue #730): nothing of
 * it was pushed, so normally the PR is as it was, and the unreviewed work is
 * on a side branch.
 */
export function unfinishedFollowUpLine(
  prUrl: string,
  settled: { prUntouched?: boolean; landed: string[]; wipBranch?: string },
): string {
  const prPart =
    settled.prUntouched === true
      ? `Nothing was added to ${prUrl}; it's as it was.`
      : settled.prUntouched === false
        ? `${prUrl} has commits that weren't there when I started (${settled.landed.join('; ') || 'see the pull request'}); this run didn't review them.`
        : `I couldn't check ${prUrl} on GitHub; nothing from this run was pushed to it.`;
  const wip = settled.wipBranch
    ? ` The unreviewed change is on branch \`${settled.wipBranch}\`, with no pull request.`
    : '';
  return `${prPart}${wip}`;
}

/**
 * The message for a follow-up whose checks didn't pass: why it stopped and
 * what's still open, as for any run, with what happened to the PR instead of
 * "I did not open a PR".
 */
export function unfinishedFollowUpSummary(
  result: PipelineResult,
  reason: string | undefined,
  prUrl: string,
  settled: { prUntouched?: boolean; landed: string[]; wipBranch?: string },
): string {
  return buildUnfinishedRunMessage({ result, reason }).replace(
    prLine(undefined),
    unfinishedFollowUpLine(prUrl, settled),
  );
}

/** The line added to the plan message for a follow-up. */
export function followUpPlanNote(pr: FollowUpPr): string {
  return `This goes onto ${pr.url} as a new commit.`;
}

/** What the planner is told about the PR this change adds to. */
export function followUpPlannerBlock(pr: FollowUpPr): string {
  const shown = pr.files.slice(0, FILE_LIST_MAX).map(file => `\`${file}\``);
  const more = pr.files.length > FILE_LIST_MAX ? ` and ${pr.files.length - FILE_LIST_MAX} more` : '';
  const files = shown.length > 0 ? ` It already changes ${shown.join(', ')}${more}.` : '';
  return [
    '',
    '=== FOLLOW-UP ON AN OPEN PULL REQUEST ===',
    `An earlier request in this thread opened ${pr.url} (${pr.owner}/${pr.repo}, branch \`${pr.branch}\`), and it is still open.${files}`,
    `If this request is a further change to that work, it belongs in ${pr.owner}/${pr.repo}: plan ONLY the new change. The coder adds it as a new commit on that branch, so do not repeat what the pull request already does. The code you read is the default branch; the pull request's changes are in the diff below, not in the files.`,
    'If this request is for a different repository, plan it normally.',
    ...(pr.diff ? ['', "The pull request's diff:", '```diff', pr.diff, '```'] : []),
    '=== END FOLLOW-UP ===',
    '',
  ].join('\n');
}

const WORKSPACES_ROOT = path.join(os.homedir(), '.watchtower', 'workspaces');

/**
 * Moves the run's worktree onto the PR's branch, detached at its latest
 * commit: fetched fresh, never reset to the default branch, nothing merged.
 * Detached, so a branch checked out somewhere else never blocks it. Only
 * miniOG's own worktrees.
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

/** `owner/repo` of a clone's origin, lowercased, or undefined when it can't be read. */
export async function originSlug(cwd: string): Promise<string | undefined> {
  try {
    const url = await __followUpDeps.git(cwd, ['remote', 'get-url', 'origin']);
    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the marketing staging site shows this PR's branch, by #702's record
 * of the last staging deploy miniOG ran: the same branch (and PR, when the
 * record names one), deployed in the last two hours.
 */
export function stagingShowsBranch(
  store: { getState?(key: string): string | undefined } | undefined,
  pr: { branch: string; url: string },
  nowMs = Date.now(),
): boolean {
  try {
    const raw = store?.getState?.(STAGING_STATE_KEY);
    if (!raw) return false;
    const record = JSON.parse(raw) as { branch?: unknown; prUrl?: unknown; atMs?: unknown };
    if (record.branch !== pr.branch) return false;
    if (typeof record.prUrl === 'string' && record.prUrl && record.prUrl !== pr.url) return false;
    return typeof record.atMs === 'number' && nowMs - record.atMs <= STAGING_HEADS_UP_WINDOW_MS;
  } catch {
    return false;
  }
}

export const STAGING_STILL_OLD = 'Staging still shows the previous version — ask me for a new testing link.';
