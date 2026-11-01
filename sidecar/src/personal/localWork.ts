import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Whether the owner has work on a branch that only exists on this Mac, in any of
 * his clones or their worktrees. He keeps several separate clones of a repo, so
 * looking at one isn't enough. Pushing a fix over such a branch would fork his
 * work. Read-only, and takes no locks: these are his working copies.
 */

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: 20_000 });
    return stdout;
  } catch {
    return undefined;
  }
}

function subfolders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function originMatches(url: string | undefined, repo: string): boolean {
  const slug = url
    ?.trim()
    .replace(/\.git$/, '')
    .toLowerCase();
  return Boolean(slug?.endsWith(`/${repo.toLowerCase()}`) || slug?.endsWith(`:${repo.toLowerCase()}`));
}

/** His clones of `repo` under the usual folders. `roots` is for tests. */
export async function clonesOf(repo: string, roots?: string[]): Promise<string[]> {
  const code = path.join(os.homedir(), 'code');
  const folders = (roots ?? [code, path.join(code, 'dupli')]).flatMap(subfolders);
  const clones: string[] = [];
  for (const folder of folders) {
    if (!fs.existsSync(path.join(folder, '.git'))) continue;
    if (originMatches(await git(folder, ['remote', 'get-url', 'origin']), repo)) clones.push(folder);
  }
  return clones;
}

/** Reasons a push to `branch` could fork his work: unpushed commits, or uncommitted changes on it. */
export async function localWorkOnBranch(repo: string, branch: string, roots?: string[]): Promise<string[]> {
  const reasons: string[] = [];
  for (const clone of await clonesOf(repo, roots)) {
    const local = `refs/heads/${branch}`;
    if ((await git(clone, ['rev-parse', '--verify', '--quiet', local])) === undefined) continue;
    const remote = `refs/remotes/origin/${branch}`;
    const hasRemote = (await git(clone, ['rev-parse', '--verify', '--quiet', remote])) !== undefined;
    const ahead = await git(clone, [
      'rev-list',
      '--count',
      local,
      hasRemote ? `^${remote}` : '--not',
      ...(hasRemote ? [] : ['--remotes']),
    ]);
    const count = Number(ahead?.trim() ?? 0);
    if (count > 0) reasons.push(`${count} unpushed commit${count === 1 ? '' : 's'} in ${clone}`);
    const worktrees = await git(clone, ['worktree', 'list', '--porcelain']);
    let current: string | undefined;
    for (const line of `${worktrees ?? ''}`.split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
      if (line === `branch ${local}` && current) {
        const status = await git(current, ['status', '--porcelain', '--untracked-files=no']);
        if (status?.trim()) reasons.push(`uncommitted changes in ${current}`);
      }
    }
  }
  return reasons;
}
