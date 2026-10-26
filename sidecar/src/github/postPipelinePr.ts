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
  /** The change is on the PR's branch, pushed by the coder or here. */
  | { kind: 'pushed' }
  /** The run left nothing new on top of the PR. */
  | { kind: 'nothing' }
  /**
   * Someone else pushed to the PR's branch meanwhile: nothing was pushed over
   * it. The change went to a new branch and a PR into that branch instead.
   */
  | { kind: 'stacked'; prUrl: string }
  | { kind: 'failed'; reason: string };

/** Test seams for the follow-up push. */
export const __followUpPushDeps = {
  git,
  createPullRequest,
};

/**
 * Lands a follow-up change (issue #730) on the open PR's branch. The worktree
 * was detached at the branch's head (`startHead`) before the coder ran.
 * Uncommitted changes are committed; the commits are pushed with a plain
 * fast-forward push, never forced. When the branch moved under us and the
 * push can't fast-forward, the work goes to a new branch with a PR into the
 * original branch, so it shows only this change and nobody's commits are
 * overwritten.
 */
export async function pushFollowUpToPr(params: {
  repoPath: string;
  branch: string;
  prUrl: string;
  startHead: string;
  threadTs: string;
  summary: string;
  requestedBy?: string;
  onLog?: (msg: string) => void;
}): Promise<FollowUpPush> {
  const { repoPath, branch, prUrl, startHead, threadTs, summary, requestedBy, onLog } = params;
  const run = (args: string[]) => __followUpPushDeps.git(repoPath, args);
  try {
    if (await hasUncommittedChanges(repoPath)) {
      await run(['add', '-A']);
      const skipped = await unstageUnsafePaths(repoPath);
      if (skipped.length > 0) onLog?.(`Left out of the commit (symlink or never-commit path): ${skipped.join(', ')}.`);
      const staged = await run(['diff', '--cached', '--name-only']);
      if (staged.length > 0) {
        const title = summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
        await run(['commit', '-m', title]);
        onLog?.('Committed the follow-up change.');
      }
    }
    const head = await run(['rev-parse', 'HEAD']);
    await run(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const remote = await run(['rev-parse', `origin/${branch}`]);
    if (head === startHead) {
      onLog?.('Nothing new on top of the pull request.');
      return { kind: 'nothing' };
    }
    const isAncestor = async (ancestor: string, of: string) =>
      run(['merge-base', '--is-ancestor', ancestor, of]).then(
        () => true,
        () => false,
      );
    // The coder pushed already.
    if (await isAncestor(head, remote)) return { kind: 'pushed' };
    // A plain push fast-forwards the branch.
    if (await isAncestor(remote, head)) {
      await run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      onLog?.(`Pushed the follow-up to origin/${branch}.`);
      return { kind: 'pushed' };
    }
    // The branch moved under us: never push over it.
    const safeTs = threadTs.replace(/[^a-zA-Z0-9.-]/g, '-');
    const stackedBranch = `${branch}-followup-${safeTs}`;
    await run(['push', 'origin', `HEAD:refs/heads/${stackedBranch}`]);
    const rawTitle = summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
    const { prUrl: stackedUrl } = await __followUpPushDeps.createPullRequest({
      repoPath,
      title: requestedBy ? `[${requestedBy} via miniOG] ${rawTitle}` : rawTitle,
      body: [
        `Follow-up to ${prUrl}. That branch moved while this change was being made, so it goes in as its own PR into \`${branch}\` instead of being pushed over it.`,
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
    onLog?.(`The branch moved; opened ${stackedUrl} into ${branch} instead.`);
    return { kind: 'stacked', prUrl: stackedUrl };
  } catch (error) {
    logger.warn({ repoPath, branch, error: String(error) }, 'failed to push a follow-up to its PR');
    return { kind: 'failed', reason: String(error).split('\n')[0] };
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
