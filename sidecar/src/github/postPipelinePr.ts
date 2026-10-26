import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPullRequest } from './createPr.js';
import { toolchainEnv } from '../backends/codexBackend.js';
import { logger } from '../logging/logger.js';
import { sanitizeForBranch, buildSlackThreadLink } from '../workflows/shared/workflowUtils.js';
import { git, hasUncommittedChanges, getDefaultBranch, hasCommitsAheadOfBase } from '../workspaces/gitState.js';

const execFileAsync = promisify(execFile);

/**
 * Paths that must never ride along in a miniOG PR even when they show up dirty.
 * Symlinks are handled separately (see `unstageUnsafePaths`) — this list catches
 * the ones that are real files/dirs in some repos.
 */
const NEVER_COMMIT_PREFIXES = ['node_modules', '.next', '.env'];

function isNeverCommit(relPath: string): boolean {
  return NEVER_COMMIT_PREFIXES.some(prefix => relPath === prefix || relPath.startsWith(`${prefix}/`));
}

/**
 * Drop anything from the index that a workspace PR has no business carrying.
 *
 * `git add -A` stages whatever `git status` reports, and inside a worktree that
 * includes the node_modules SYMLINK we create for tooling — a repo whose
 * .gitignore says `node_modules/` (trailing slash, directories only) does not
 * ignore it. #413 shipped exactly that to a company repo: a mode-120000 blob
 * holding an absolute path from the maintainer's laptop.
 *
 * Returns the paths it unstaged so the caller can log them.
 */
async function unstageUnsafePaths(repoPath: string): Promise<string[]> {
  const staged = await git(repoPath, ['diff', '--cached', '--name-only']);
  const paths = staged
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean);

  const unsafe = paths.filter(relPath => {
    if (isNeverCommit(relPath)) return true;
    try {
      return fs.lstatSync(path.join(repoPath, relPath)).isSymbolicLink();
    } catch {
      // Deleted or unreadable — a legitimate deletion, leave it staged.
      return false;
    }
  });

  if (unsafe.length > 0) {
    await git(repoPath, ['restore', '--staged', '--', ...unsafe]);
  }
  return unsafe;
}

/**
 * The PR a run left behind and its state (issue #333): the URL the coder
 * reported, or the PR for the workspace's branch. A reported URL whose state
 * cannot be read is returned as UNKNOWN rather than dropped.
 */
export async function findRunPr(
  cwd: string,
  reportedUrl?: string,
): Promise<{ url: string; state: string } | undefined> {
  try {
    let target = reportedUrl;
    if (!target) {
      const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!branch || branch === 'HEAD') return undefined;
      target = branch;
    }
    const { stdout } = await execFileAsync('gh', ['pr', 'view', target, '--json', 'url,state'], {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: toolchainEnv(),
    });
    const parsed = JSON.parse(stdout) as { url?: string; state?: string };
    return parsed.url ? { url: parsed.url, state: parsed.state ?? 'UNKNOWN' } : undefined;
  } catch {
    return reportedUrl ? { url: reportedUrl, state: 'UNKNOWN' } : undefined;
  }
}

/** Check if a PR already exists for the current branch. */
async function existingPrUrl(cwd: string): Promise<string | undefined> {
  try {
    const url = await git(cwd, ['ls-remote', '--get-url', 'origin']);
    if (!url) return undefined;
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') return undefined;
    const { stdout } = await execFileAsync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: toolchainEnv(),
    });
    const prUrl = stdout.trim();
    return prUrl || undefined;
  } catch {
    return undefined;
  }
}

export type FollowUpPush =
  /**
   * The change is on the PR's branch. `ontoNewerCommits`: someone else had
   * pushed meanwhile, and this change was replayed on top of their commits.
   */
  | { kind: 'pushed'; ontoNewerCommits: boolean }
  /** The run left nothing new on top of the PR. */
  | { kind: 'nothing' }
  /**
   * Someone else pushed to the PR's branch meanwhile and this change conflicts
   * with it: nothing was pushed over it. The change went to a new branch and a
   * PR into that branch, to be merged before the original.
   */
  | { kind: 'stacked'; prUrl: string }
  /** The coder rewrote the PR's history instead of adding a commit: nothing was pushed. */
  | { kind: 'rewritten'; wipBranch?: string }
  | { kind: 'failed'; reason: string; wipBranch?: string };

/** Test seams for the follow-up push. */
export const __followUpPushDeps = {
  git,
  createPullRequest,
  commentOnPr: async (repoPath: string, prUrl: string, body: string): Promise<void> => {
    await execFileAsync('gh', ['pr', 'comment', prUrl, '--body', body], {
      cwd: repoPath,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: toolchainEnv(),
    });
  },
};

/** A Slack event ts as a branch-name suffix. */
function branchTs(ts: string): string {
  return ts.replace(/[^a-zA-Z0-9]/g, '-');
}

function titleOf(summary: string): string {
  return summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
}

/** Commits what the coder left uncommitted, never symlinks or never-commit paths. */
async function commitLeftovers(repoPath: string, message: string, onLog?: (msg: string) => void): Promise<void> {
  if (!(await hasUncommittedChanges(repoPath))) return;
  const run = (args: string[]) => __followUpPushDeps.git(repoPath, args);
  await run(['add', '-A']);
  const skipped = await unstageUnsafePaths(repoPath);
  if (skipped.length > 0) onLog?.(`Left out of the commit (symlink or never-commit path): ${skipped.join(', ')}.`);
  const staged = await run(['diff', '--cached', '--name-only']);
  if (staged.length > 0) {
    await run(['commit', '-m', titleOf(message)]);
    onLog?.('Committed the follow-up change.');
  }
}

async function isAncestor(repoPath: string, ancestor: string, of: string): Promise<boolean> {
  return __followUpPushDeps.git(repoPath, ['merge-base', '--is-ancestor', ancestor, of]).then(
    () => true,
    () => false,
  );
}

/**
 * Pushes unreviewed or unpushable work to a branch with no PR, so it isn't
 * lost with the worktree. Returns its name, or undefined when that failed too.
 */
async function saveWorkInProgress(
  repoPath: string,
  uniqueTs: string,
  onLog?: (msg: string) => void,
): Promise<string | undefined> {
  const wip = `miniog/followup-wip-${branchTs(uniqueTs)}`;
  try {
    await __followUpPushDeps.git(repoPath, ['push', 'origin', `HEAD:refs/heads/${wip}`]);
    onLog?.(`Kept the unpushed work on ${wip} (no pull request).`);
    return wip;
  } catch (error) {
    logger.warn({ repoPath, wip, error: String(error) }, 'could not keep follow-up work on a side branch');
    return undefined;
  }
}

/**
 * Lands a follow-up change (issue #730) on the open PR's branch once the
 * pipeline has passed: the only push of a follow-up. The worktree was
 * detached at the branch's head (`startHead`) before the coder ran, and the
 * coder only commits. What's uncommitted is committed; the commits are pushed
 * with a plain fast-forward push, never forced.
 *
 * - Our commits don't descend from `startHead` (the coder amended or rebased
 *   the PR's own commits): nothing is pushed.
 * - The branch moved since `startHead` (someone else pushed): our commits are
 *   replayed onto its new tip and pushed normally. Only when that conflicts do
 *   they go to their own branch with a PR into the original one.
 */
export async function pushFollowUpToPr(params: {
  repoPath: string;
  branch: string;
  prUrl: string;
  startHead: string;
  /** Makes side-branch names unique: the triggering message's ts. */
  uniqueTs: string;
  threadTs: string;
  summary: string;
  requestedBy?: string;
  onLog?: (msg: string) => void;
}): Promise<FollowUpPush> {
  const { repoPath, branch, prUrl, startHead, uniqueTs, threadTs, summary, requestedBy, onLog } = params;
  const run = (args: string[]) => __followUpPushDeps.git(repoPath, args);
  try {
    await commitLeftovers(repoPath, summary, onLog);
    const head = await run(['rev-parse', 'HEAD']);
    if (head === startHead) {
      onLog?.('Nothing new on top of the pull request.');
      return { kind: 'nothing' };
    }
    if (!(await isAncestor(repoPath, startHead, head))) {
      onLog?.("The commits don't build on the pull request's latest commit (its history was rewritten); not pushing.");
      return { kind: 'rewritten', wipBranch: await saveWorkInProgress(repoPath, uniqueTs, onLog) };
    }
    await run(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const remote = await run(['rev-parse', `origin/${branch}`]);
    // Already there (pushed by hand, or a retry).
    if (await isAncestor(repoPath, head, remote)) return { kind: 'pushed', ontoNewerCommits: false };
    if (remote === startHead || (await isAncestor(repoPath, remote, head))) {
      await run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      onLog?.(`Pushed the follow-up to origin/${branch}.`);
      return { kind: 'pushed', ontoNewerCommits: false };
    }

    // Someone else pushed meanwhile: replay our commits on top of theirs.
    const replayed = await run(['rebase', '--onto', `origin/${branch}`, startHead]).then(
      () => true,
      async () => {
        await run(['rebase', '--abort']).catch(() => undefined);
        return false;
      },
    );
    if (replayed) {
      await run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      onLog?.(`${branch} had moved; replayed the follow-up on top of it and pushed.`);
      return { kind: 'pushed', ontoNewerCommits: true };
    }

    // It conflicts with what they pushed: never push over it.
    const stackedBranch = `${branch}-followup-${branchTs(uniqueTs)}`;
    await run(['push', 'origin', `HEAD:refs/heads/${stackedBranch}`]);
    const rawTitle = titleOf(summary);
    const { prUrl: stackedUrl } = await __followUpPushDeps.createPullRequest({
      repoPath,
      title: requestedBy ? `[${requestedBy} via miniOG] ${rawTitle}` : rawTitle,
      body: [
        `Follow-up to ${prUrl}. Someone else pushed to \`${branch}\` while this change was being made and it conflicts with their commits, so it comes as its own PR into \`${branch}\` instead of being pushed over them. Merge this one first, then ${prUrl}.`,
        '',
        '## Summary',
        summary,
        '',
        '---',
        '**Raised by:** miniOG (Watchtower)',
        `**Thread:** ${threadTs}`,
      ].join('\n'),
      branch: stackedBranch,
      baseBranch: branch,
      labels: ['miniog'],
    });
    onLog?.(`The follow-up conflicts with new commits on ${branch}; opened ${stackedUrl} into it instead.`);
    return { kind: 'stacked', prUrl: stackedUrl };
  } catch (error) {
    logger.warn({ repoPath, branch, error: String(error) }, 'failed to push a follow-up to its PR');
    return {
      kind: 'failed',
      reason: String(error).split('\n')[0],
      wipBranch: await saveWorkInProgress(repoPath, uniqueTs, onLog),
    };
  }
}

export type FollowUpRelanded =
  | { kind: 'opened'; prUrl: string }
  | { kind: 'nothing' }
  | { kind: 'failed'; reason: string; wipBranch?: string };

/**
 * The PR a follow-up was meant for was merged or closed while it was being
 * made (issue #730). Pushing to its branch would land on a dead branch (the
 * marketing repo keeps branches after a merge), so the new commits are
 * cherry-picked onto the default branch in a fresh branch and opened as an
 * ordinary PR that says why.
 */
export async function relandFollowUpAsNewPr(params: {
  repoPath: string;
  startHead: string;
  uniqueTs: string;
  threadTs: string;
  summary: string;
  originalPrUrl: string;
  originalState: 'MERGED' | 'CLOSED';
  requestedBy?: string;
  channelId?: string;
  onLog?: (msg: string) => void;
}): Promise<FollowUpRelanded> {
  const { repoPath, startHead, uniqueTs, threadTs, summary, originalPrUrl, originalState, requestedBy, onLog } = params;
  const run = (args: string[]) => __followUpPushDeps.git(repoPath, args);
  try {
    await commitLeftovers(repoPath, summary, onLog);
    const head = await run(['rev-parse', 'HEAD']);
    if (head === startHead) return { kind: 'nothing' };
    const commits = (await run(['rev-list', '--reverse', `${startHead}..${head}`])).split('\n').filter(Boolean);
    const base = await getDefaultBranch(repoPath);
    await run(['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    await run(['checkout', '--detach', '--force', `origin/${base}`]);
    const picked = await run(['cherry-pick', ...commits]).then(
      () => true,
      async () => {
        await run(['cherry-pick', '--abort']).catch(() => undefined);
        return false;
      },
    );
    if (!picked) {
      await run(['checkout', '--detach', '--force', head]);
      return {
        kind: 'failed',
        reason: `the change conflicts with ${base}`,
        wipBranch: await saveWorkInProgress(repoPath, uniqueTs, onLog),
      };
    }
    const branchPrefix = requestedBy ? `${sanitizeForBranch(requestedBy)}/` : 'miniog/';
    const newBranch = `${branchPrefix}followup-${branchTs(uniqueTs)}`;
    await run(['push', 'origin', `HEAD:refs/heads/${newBranch}`]);
    const word = originalState === 'MERGED' ? 'merged' : 'closed';
    const slackLink = params.channelId ? buildSlackThreadLink(params.channelId, threadTs) : '';
    const rawTitle = titleOf(summary);
    const { prUrl } = await __followUpPushDeps.createPullRequest({
      repoPath,
      title: requestedBy ? `[${requestedBy} via miniOG] ${rawTitle}` : rawTitle,
      body: [
        `> Requested by **${requestedBy ?? 'Unknown'}** via Slack${slackLink ? ` · [View thread](${slackLink})` : ''}`,
        '',
        `Follow-up to ${originalPrUrl}, which was ${word} before this change was ready, so it comes as a new pull request.`,
        '',
        '## Summary',
        summary,
        '',
        '---',
        '**Raised by:** miniOG (Watchtower)',
        `**Thread:** ${threadTs}`,
      ].join('\n'),
      branch: newBranch,
      baseBranch: base,
      labels: ['miniog'],
    });
    onLog?.(`${originalPrUrl} was ${word}; opened ${prUrl} from ${base} instead.`);
    return { kind: 'opened', prUrl };
  } catch (error) {
    logger.warn({ repoPath, error: String(error) }, 'failed to reland a follow-up as a new PR');
    return {
      kind: 'failed',
      reason: String(error).split('\n')[0],
      wipBranch: await saveWorkInProgress(repoPath, uniqueTs, onLog),
    };
  }
}

/** What a follow-up that didn't pass left behind (issue #730). */
export interface UnfinishedFollowUp {
  /** The PR's branch still points where it did when the coder started; undefined when GitHub can't say. */
  prUntouched?: boolean;
  /** Commits on the PR's branch that weren't there when the coder started, `<sha> <subject>`. */
  landed: string[];
  /** The unreviewed work, kept on a branch with no PR. */
  wipBranch?: string;
}

/**
 * A follow-up whose checks didn't pass, or that was stopped: nothing of it was
 * pushed to the PR (the coder only commits). Says whether the PR's branch is
 * as it was, and keeps the unreviewed work on a side branch so it isn't lost
 * with the worktree.
 */
export async function settleUnfinishedFollowUp(params: {
  repoPath: string;
  branch: string;
  startHead: string;
  uniqueTs: string;
  onLog?: (msg: string) => void;
}): Promise<UnfinishedFollowUp> {
  const { repoPath, branch, startHead, uniqueTs, onLog } = params;
  const run = (args: string[]) => __followUpPushDeps.git(repoPath, args);
  const settled: UnfinishedFollowUp = { landed: [] };
  let remote: string | undefined;
  try {
    await commitLeftovers(repoPath, 'Unfinished follow-up (not reviewed)', onLog);
  } catch {
    // What can't be committed stays in the worktree.
  }
  try {
    await run(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    remote = await run(['rev-parse', `origin/${branch}`]);
    settled.prUntouched = remote === startHead;
    if (!settled.prUntouched) {
      const log = await run(['log', '--format=%h %s', '-n', '5', `${startHead}..${remote}`]).catch(() => '');
      settled.landed = log.split('\n').filter(Boolean);
    }
  } catch {
    // GitHub can't say: prUntouched stays undefined.
  }
  try {
    const head = await run(['rev-parse', 'HEAD']);
    const alreadyThere = remote ? await isAncestor(repoPath, head, remote) : false;
    if (head !== startHead && !alreadyThere) settled.wipBranch = await saveWorkInProgress(repoPath, uniqueTs, onLog);
  } catch {
    // Nothing to keep.
  }
  return settled;
}

/**
 * The engineering account of a follow-up, as a comment on the PR it was added
 * to (`gh pr comment` works where `gh pr edit` doesn't). True when posted.
 */
export async function commentFollowUpOnPr(params: {
  repoPath: string;
  prUrl: string;
  summary: string;
  requestedBy?: string;
  channelId: string;
  threadTs: string;
}): Promise<boolean> {
  const link = buildSlackThreadLink(params.channelId, params.threadTs);
  const body = [
    `**Follow-up added by miniOG** for ${params.requestedBy ?? 'Unknown'} via Slack · [View thread](${link})`,
    '',
    params.summary,
  ].join('\n');
  try {
    await __followUpPushDeps.commentOnPr(params.repoPath, params.prUrl, body);
    return true;
  } catch (error) {
    logger.warn({ prUrl: params.prUrl, error: String(error) }, 'could not comment the follow-up on its PR');
    return false;
  }
}

/**
 * After a pipeline run, detect changes in the workspace and ensure a PR exists.
 *
 * Handles three scenarios:
 * 1. Uncommitted changes → create branch, commit, push, open PR
 * 2. Committed but unpushed changes → push, open PR
 * 3. Pushed but no PR → open PR
 *
 * Returns the PR URL if successful, or undefined if no changes or on failure.
 */
export async function createPrFromWorkspace(params: {
  repoPath: string;
  threadTs: string;
  summary: string;
  requestedBy?: string;
  channelId?: string;
  workflow?: string;
  onLog?: (msg: string) => void;
}): Promise<string | undefined> {
  const { repoPath, threadTs, summary, requestedBy, channelId, workflow, onLog } = params;

  try {
    const baseBranch = await getDefaultBranch(repoPath);
    const currentBranch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    const hasUncommitted = await hasUncommittedChanges(repoPath);
    const hasAheadCommits = await hasCommitsAheadOfBase(repoPath, baseBranch);

    // Scenario: check if a PR already exists for the current branch
    if (!hasUncommitted && currentBranch !== 'HEAD' && currentBranch !== baseBranch) {
      const existing = await existingPrUrl(repoPath);
      if (existing) {
        onLog?.(`PR already exists for branch ${currentBranch}: ${existing}`);
        return existing;
      }
    }

    // No uncommitted changes AND no commits ahead of base → nothing to do
    if (!hasUncommitted && !hasAheadCommits) {
      onLog?.('No uncommitted or unpushed changes in workspace, skipping PR creation.');
      return undefined;
    }

    const safeBranchTs = threadTs.replace(/[^a-zA-Z0-9.-]/g, '-');
    let branchName = currentBranch;

    // If we need a new branch (detached HEAD or on base branch)
    if (currentBranch === 'HEAD' || currentBranch === baseBranch) {
      const branchPrefix = requestedBy ? `${sanitizeForBranch(requestedBy)}/` : '';
      branchName = `${branchPrefix}fix-${safeBranchTs}`;
      await git(repoPath, ['checkout', '-b', branchName]);
      onLog?.(`Created branch: ${branchName}`);
    }

    // Stage and commit any uncommitted changes
    if (hasUncommitted) {
      await git(repoPath, ['add', '-A']);
      const skipped = await unstageUnsafePaths(repoPath);
      if (skipped.length > 0) {
        onLog?.(`Left out of the commit (symlink or never-commit path): ${skipped.join(', ')}.`);
      }

      const stagedAfterFilter = await git(repoPath, ['diff', '--cached', '--name-only']);
      if (stagedAfterFilter.length === 0) {
        // Everything dirty was junk. Without this the commit below throws
        // ("nothing to commit") and we'd report a generic PR-creation failure.
        if (!hasAheadCommits) {
          onLog?.('Nothing to commit once symlinks and ignored paths were dropped — no PR opened.');
          return undefined;
        }
      } else {
        const commitTitle = summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
        await git(repoPath, ['commit', '-m', commitTitle]);
        onLog?.('Committed changes.');
      }
    }

    // Push the branch
    await git(repoPath, ['push', '-u', 'origin', branchName]);
    onLog?.(`Pushed to origin/${branchName}.`);

    // Check again if a PR already exists (coder may have pushed + created one)
    const existingAfterPush = await existingPrUrl(repoPath);
    if (existingAfterPush) {
      onLog?.(`PR already exists after push: ${existingAfterPush}`);
      return existingAfterPush;
    }

    // Create PR
    const rawTitle = summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
    const commitTitle = requestedBy ? `[${requestedBy} via miniOG] ${rawTitle}` : rawTitle;
    const slackLink = channelId ? buildSlackThreadLink(channelId, threadTs) : '';
    const threadLinkText = slackLink ? ` · [View thread](${slackLink})` : '';
    const prBody = [
      `> Requested by **${requestedBy ?? 'Unknown'}** via Slack${threadLinkText}`,
      '',
      '## Summary',
      summary,
      '',
      '---',
      '**Raised by:** miniOG (Watchtower)',
      ...(requestedBy ? [`**Triggered by:** ${requestedBy} via Slack`] : []),
      ...(channelId ? [`**Channel:** ${channelId}`] : []),
      ...(workflow ? [`**Workflow:** ${workflow}`] : []),
      `**Thread:** ${threadTs}`,
    ].join('\n');

    const { prUrl } = await createPullRequest({
      repoPath,
      title: commitTitle,
      body: prBody,
      branch: branchName,
      baseBranch,
      labels: ['miniog'],
    });

    onLog?.(`PR created: ${prUrl}`);
    return prUrl;
  } catch (error) {
    logger.warn({ repoPath, threadTs, error: String(error) }, 'failed to create PR from workspace changes');
    onLog?.(`PR creation failed: ${String(error)}`);
    return undefined;
  }
}
