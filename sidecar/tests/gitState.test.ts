import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkCoderProducedChanges,
  currentHead,
  diffFilesVsBase,
  getDiffVsBase,
  hasUncommittedChanges,
} from '../src/workspaces/gitState.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitstate-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

describe('gitState', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo();
  });

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('currentHead returns the tip SHA', async () => {
    const head = await currentHead(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('hasUncommittedChanges detects uncommitted edits', async () => {
    expect(await hasUncommittedChanges(repo)).toBe(false);
    await writeFile(path.join(repo, 'new.txt'), 'x');
    expect(await hasUncommittedChanges(repo)).toBe(true);
  });

  it('diffFilesVsBase lists committed file changes', async () => {
    const base = await currentHead(repo);
    await writeFile(path.join(repo, 'added.txt'), 'content');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'add file']);
    const diff = await diffFilesVsBase(repo, base);
    expect(diff).toContain('added.txt');
  });

  it('checkCoderProducedChanges returns false on clean worktree at base', async () => {
    const base = await currentHead(repo);
    const check = await checkCoderProducedChanges({ repoPath: repo, baseSha: base });
    expect(check.producedChanges).toBe(false);
    expect(check.filesChanged).toHaveLength(0);
    expect(check.headMoved).toBe(false);
    expect(check.newCommits).toBe(0);
    expect(check.hasUncommitted).toBe(false);
  });

  it('checkCoderProducedChanges detects an uncommitted file', async () => {
    const base = await currentHead(repo);
    await writeFile(path.join(repo, 'scratch.ts'), 'export {};');
    const check = await checkCoderProducedChanges({ repoPath: repo, baseSha: base });
    expect(check.producedChanges).toBe(true);
    expect(check.hasUncommitted).toBe(true);
    expect(check.filesChanged).toContain('scratch.ts');
  });

  it('checkCoderProducedChanges detects a new commit ahead of base', async () => {
    const base = await currentHead(repo);
    await writeFile(path.join(repo, 'committed.ts'), 'export {};');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'add committed.ts']);
    const check = await checkCoderProducedChanges({ repoPath: repo, baseSha: base });
    expect(check.producedChanges).toBe(true);
    expect(check.headMoved).toBe(true);
    expect(check.newCommits).toBe(1);
    expect(check.filesChanged).toContain('committed.ts');
  });

  it('getDiffVsBase returns the textual diff for committed and uncommitted changes', async () => {
    const base = await currentHead(repo);
    await writeFile(path.join(repo, 'seed.txt'), 'seed\nmore\n');
    const { diff, truncated } = await getDiffVsBase(repo, base);
    expect(truncated).toBe(false);
    expect(diff).toContain('seed.txt');
    expect(diff).toContain('+more');
  });

  it('getDiffVsBase truncates a large diff past maxBytes', async () => {
    const base = await currentHead(repo);
    // Modify a tracked file so the change shows in `git diff <base>`.
    await writeFile(path.join(repo, 'seed.txt'), 'x\n'.repeat(5000));
    const { diff, truncated } = await getDiffVsBase(repo, base, 200);
    expect(truncated).toBe(true);
    expect(diff.length).toBe(200);
  });

  it('checkCoderProducedChanges handles a mix of committed and uncommitted files', async () => {
    const base = await currentHead(repo);
    await writeFile(path.join(repo, 'a.ts'), 'a');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'a']);
    await mkdir(path.join(repo, 'sub'), { recursive: true });
    await writeFile(path.join(repo, 'sub', 'b.ts'), 'b');
    const check = await checkCoderProducedChanges({ repoPath: repo, baseSha: base });
    expect(check.producedChanges).toBe(true);
    expect(check.hasUncommitted).toBe(true);
    expect(check.newCommits).toBe(1);
    expect(check.filesChanged).toEqual(expect.arrayContaining(['a.ts', 'sub/b.ts']));
  });
});
