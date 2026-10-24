import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WORKSPACES_ROOT is `os.homedir()/.watchtower/workspaces`, computed at module
// load. Point HOME at a sandbox BEFORE importing so the tests never touch the
// real workspaces dir.
const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-home-'));
process.env.HOME = TEST_HOME;

const { refreshWorktreeToBase, resolveWorkspace } = await import('../src/workspaces/workspaceManager.js');

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

afterAll(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  await rm(TEST_HOME, { recursive: true, force: true });
});

// The refresh right before the coder (issue #602): the worktree moves to the
// latest origin base, and nothing is torn down when it can't.
describe('refreshWorktreeToBase', () => {
  let bare: string;
  let seed: string;
  let repo: string;
  let ws: string;

  beforeEach(async () => {
    bare = await mkdtemp(path.join(os.tmpdir(), 'wt-bare-'));
    await git(bare, ['init', '--bare', '-q', '-b', 'main']);
    seed = await mkdtemp(path.join(os.tmpdir(), 'wt-seed-'));
    await git(seed, ['init', '-q', '-b', 'main']);
    await git(seed, ['config', 'user.email', 'test@example.com']);
    await git(seed, ['config', 'user.name', 'Test']);
    await writeFile(path.join(seed, 'file.txt'), 'A\n');
    await writeFile(path.join(seed, '.gitignore'), 'node_modules/\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'commit A']);
    await git(seed, ['remote', 'add', 'origin', bare]);
    await git(seed, ['push', '-q', '-u', 'origin', 'main']);

    repo = await mkdtemp(path.join(os.tmpdir(), 'wt-repo-'));
    await git(path.dirname(repo), ['clone', '-q', bare, repo]);
    ws = await resolveWorkspace(repo, '555.1');
  });

  afterEach(async () => {
    await Promise.all([bare, seed, repo].map(dir => rm(dir, { recursive: true, force: true })));
    fs.rmSync(path.join(TEST_HOME, '.watchtower'), { recursive: true, force: true });
  });

  it('moves to the new base: untracked files go, ignored node_modules and its deps marker stay, HEAD detached', async () => {
    // origin/main moves on while the plan waits for approval.
    await writeFile(path.join(seed, 'file.txt'), 'B\n');
    await git(seed, ['commit', '-aqm', 'commit B']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    const commitB = await git(seed, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(ws, 'leftover.txt'), 'untracked\n');
    fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules', '.watchtower-deps.json'), '{"key":"abc"}\n');

    const result = await refreshWorktreeToBase(ws);

    expect(result).toEqual({ ok: true, base: 'origin/main', head: commitB });
    expect(await git(ws, ['rev-parse', 'HEAD'])).toBe(commitB);
    expect(fs.readFileSync(path.join(ws, 'file.txt'), 'utf8')).toBe('B\n');
    expect(fs.existsSync(path.join(ws, 'leftover.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(ws, 'node_modules', '.watchtower-deps.json'), 'utf8')).toBe('{"key":"abc"}\n');
    // Detached: `symbolic-ref` fails when HEAD is not on a branch.
    await expect(git(ws, ['symbolic-ref', '-q', 'HEAD'])).rejects.toThrow();
  });

  it('leaves the worktree exactly as it was when the fetch fails', async () => {
    const before = await git(ws, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(ws, 'leftover.txt'), 'untracked\n');
    await git(ws, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'wt-no-such-remote')]);

    const result = await refreshWorktreeToBase(ws);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(ws)).toBe(true);
    expect(await git(ws, ['rev-parse', 'HEAD'])).toBe(before);
    expect(fs.existsSync(path.join(ws, 'leftover.txt'))).toBe(true);
  });

  it('never resets a directory outside the workspaces root, such as a shared clone', async () => {
    fs.writeFileSync(path.join(repo, 'local-edit.txt'), 'mine\n');
    expect(await refreshWorktreeToBase(repo)).toEqual({ ok: false, reason: 'not a miniOG worktree', skipped: true });
    expect(fs.existsSync(path.join(repo, 'local-edit.txt'))).toBe(true);
  });
});
