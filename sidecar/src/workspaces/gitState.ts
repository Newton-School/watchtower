import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain']);
  return status.length > 0;
}

export async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const ref = await git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
    return ref.replace('origin/', '');
  } catch {
    return 'main';
  }
}

export async function hasCommitsAheadOfBase(cwd: string, baseBranch: string): Promise<boolean> {
  try {
    const count = await git(cwd, ['rev-list', '--count', `origin/${baseBranch}..HEAD`]);
    return Number(count) > 0;
  } catch {
    return false;
  }
}

export async function currentHead(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function diffFilesVsBase(cwd: string, baseSha: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['diff', '--name-only', baseSha]);
    return out.length > 0 ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Full textual diff from `baseSha` to the current working tree (committed +
 * uncommitted), capped at `maxBytes` so a large change can't blow the agent
 * prompt budget. Used to feed the reviewer/verifier the ACTUAL changes instead
 * of relying on the coder's self-reported summary (#388).
 */
export async function getDiffVsBase(
  cwd: string,
  baseSha: string,
  maxBytes = 60_000,
): Promise<{ diff: string; truncated: boolean }> {
  try {
    const out = await git(cwd, ['diff', baseSha]);
    if (out.length <= maxBytes) return { diff: out, truncated: false };
    return { diff: out.slice(0, maxBytes), truncated: true };
  } catch {
    return { diff: '', truncated: false };
  }
}

export type CoderChangesCheck = {
  producedChanges: boolean;
  filesChanged: string[];
  newCommits: number;
  hasUncommitted: boolean;
  headMoved: boolean;
};

export async function checkCoderProducedChanges(params: {
  repoPath: string;
  baseSha: string;
}): Promise<CoderChangesCheck> {
  const { repoPath, baseSha } = params;

  const [headSha, uncommitted, committedFiles, aheadCountRaw] = await Promise.all([
    currentHead(repoPath).catch(() => baseSha),
    hasUncommittedChanges(repoPath).catch(() => false),
    diffFilesVsBase(repoPath, baseSha).catch(() => [] as string[]),
    git(repoPath, ['rev-list', '--count', `${baseSha}..HEAD`]).catch(() => '0'),
  ]);

  const headMoved = headSha !== baseSha;
  const newCommits = Number(aheadCountRaw) || 0;

  let uncommittedFiles: string[] = [];
  if (uncommitted) {
    try {
      // `-u` (alias for `-uall`) expands untracked directories into individual
      // files so filesChanged reflects actual paths, not `sub/` placeholders.
      const porcelain = await git(repoPath, ['status', '--porcelain', '-u']);
      uncommittedFiles = porcelain
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(3).trim())
        .filter(Boolean);
    } catch {
      uncommittedFiles = [];
    }
  }

  const combined = new Set<string>([...committedFiles, ...uncommittedFiles]);
  const filesChanged = Array.from(combined);

  const producedChanges = filesChanged.length > 0 || newCommits > 0 || uncommitted || headMoved;

  return {
    producedChanges,
    filesChanged,
    newCommits,
    hasUncommitted: uncommitted,
    headMoved,
  };
}
