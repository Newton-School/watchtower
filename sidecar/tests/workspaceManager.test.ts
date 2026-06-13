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

const { resolveWorkspace, cleanupThreadWorkspaces, refreshSharedRepoToDefaultBranch } =
  await import('../src/workspaces/workspaceManager.js');

const WS_ROOT = path.join(TEST_HOME, '.watchtower', 'workspaces');
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

describe('cleanupThreadWorkspaces', () => {
  beforeEach(() => {
    fs.rmSync(WS_ROOT, { recursive: true, force: true });
  });

  function mkWorkspace(repo: string, key: string) {
    fs.mkdirSync(path.join(WS_ROOT, repo, key), { recursive: true });
  }

  it('removes the thread worktree and its per-PR variants across repos, keeping other threads', () => {
    mkWorkspace('newton-web', '111.22');
    mkWorkspace('newton-web', '111.22--pr-5');
    mkWorkspace('newton-api', '111.22');
    mkWorkspace('newton-web', '999.88'); // unrelated thread

    cleanupThreadWorkspaces('111.22');

    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '111.22'))).toBe(false);
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '111.22--pr-5'))).toBe(false);
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-api', '111.22'))).toBe(false);
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '999.88'))).toBe(true);
  });

  it('does not match a different thread that merely shares a string prefix', () => {
    mkWorkspace('newton-web', '111.222'); // not '111.22' and not '111.22--*'
    cleanupThreadWorkspaces('111.22');
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '111.222'))).toBe(true);
  });

  it('is a safe no-op when the workspaces root does not exist', () => {
    fs.rmSync(WS_ROOT, { recursive: true, force: true });
    expect(() => cleanupThreadWorkspaces('111.22')).not.toThrow();
  });
});

describe('resolveWorkspace refresh-on-reuse', () => {
  let bare: string;
  let seed: string;
  let repo: string;
  const thread = '777.1';

  beforeEach(async () => {
    fs.rmSync(WS_ROOT, { recursive: true, force: true });

    // Bare "remote" + a seed clone that pushes the first commit.
    bare = await mkdtemp(path.join(os.tmpdir(), 'wt-bare-'));
    await git(bare, ['init', '--bare', '-q', '-b', 'main']);

    seed = await mkdtemp(path.join(os.tmpdir(), 'wt-seed-'));
    await git(seed, ['init', '-q', '-b', 'main']);
    await git(seed, ['config', 'user.email', 'test@example.com']);
    await git(seed, ['config', 'user.name', 'Test']);
    await writeFile(path.join(seed, 'file.txt'), 'A\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'commit A']);
    await git(seed, ['remote', 'add', 'origin', bare]);
    await git(seed, ['push', '-q', '-u', 'origin', 'main']);

    // The repo miniOG operates on: a clone of the bare remote.
    repo = await mkdtemp(path.join(os.tmpdir(), 'wt-repo-'));
    await git(path.dirname(repo), ['clone', '-q', bare, repo]);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
  });

  afterEach(async () => {
    await Promise.all([bare, seed, repo].map(d => rm(d, { recursive: true, force: true })));
  });

  it('first call branches from origin/main; reuse refreshes to the advanced origin/main', async () => {
    const commitA = await git(seed, ['rev-parse', 'HEAD']);

    // First task: creates the worktree from origin/main @ A.
    const ws1 = resolveWorkspace(repo, thread);
    expect(ws1).not.toBe(repo); // worktree created, not the fallback shared path
    expect(await git(ws1, ['rev-parse', 'HEAD'])).toBe(commitA);

    // origin/main advances to B (a teammate merged something).
    await writeFile(path.join(seed, 'file.txt'), 'B\n');
    await git(seed, ['commit', '-aqm', 'commit B']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    const commitB = await git(seed, ['rev-parse', 'HEAD']);
    expect(commitB).not.toBe(commitA);

    // Second task in the same thread reuses the worktree — it MUST refresh to B,
    // not stay pinned at A (the stale-base bug).
    const ws2 = resolveWorkspace(repo, thread);
    expect(ws2).toBe(ws1);
    expect(await git(ws2, ['rev-parse', 'HEAD'])).toBe(commitB);
  });

  it('discards an un-refreshable existing workspace and recreates it fresh', async () => {
    // A path that exists but isn't a valid worktree (refresh will throw).
    const commitA = await git(seed, ['rev-parse', 'HEAD']);
    const wsPath = path.join(WS_ROOT, path.basename(repo), thread);
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'junk.txt'), 'not a git repo\n');

    const ws = resolveWorkspace(repo, thread);

    expect(ws).toBe(wsPath); // recreated, not the shared-repo fallback
    expect(fs.existsSync(path.join(ws, 'junk.txt'))).toBe(false); // junk discarded
    expect(await git(ws, ['rev-parse', 'HEAD'])).toBe(commitA); // fresh worktree at origin/main
  });

  it('reuse discards stale tracked + untracked leftovers from a prior run', async () => {
    const ws1 = resolveWorkspace(repo, thread);
    // Simulate a prior coder run that dirtied the worktree.
    await writeFile(path.join(ws1, 'file.txt'), 'locally edited\n');
    await writeFile(path.join(ws1, 'scratch.tmp'), 'untracked junk\n');

    const ws2 = resolveWorkspace(repo, thread);
    expect(ws2).toBe(ws1);
    // reset --hard restored the tracked file; clean -fd removed the untracked one.
    expect(fs.readFileSync(path.join(ws2, 'file.txt'), 'utf8')).toBe('A\n');
    expect(fs.existsSync(path.join(ws2, 'scratch.tmp'))).toBe(false);
  });
});

describe('refreshSharedRepoToDefaultBranch', () => {
  let bare: string;
  let seed: string;
  let repo: string;

  beforeEach(async () => {
    // Bare "remote" + a seed clone that pushes the first commit.
    bare = await mkdtemp(path.join(os.tmpdir(), 'wt-bare-'));
    await git(bare, ['init', '--bare', '-q', '-b', 'main']);

    seed = await mkdtemp(path.join(os.tmpdir(), 'wt-seed-'));
    await git(seed, ['init', '-q', '-b', 'main']);
    await git(seed, ['config', 'user.email', 'test@example.com']);
    await git(seed, ['config', 'user.name', 'Test']);
    await writeFile(path.join(seed, 'file.txt'), 'A\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'commit A']);
    await git(seed, ['remote', 'add', 'origin', bare]);
    await git(seed, ['push', '-q', '-u', 'origin', 'main']);

    // The shared clone miniOG reads directly (no worktree).
    repo = await mkdtemp(path.join(os.tmpdir(), 'wt-repo-'));
    await git(path.dirname(repo), ['clone', '-q', bare, repo]);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
  });

  afterEach(async () => {
    await Promise.all([bare, seed, repo].map(d => rm(d, { recursive: true, force: true })));
  });

  it('fast-forwards a clone that has drifted behind origin to the latest default branch', async () => {
    // origin/main advances to B after the clone was made.
    await writeFile(path.join(seed, 'file.txt'), 'B\n');
    await git(seed, ['commit', '-aqm', 'commit B']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    const commitB = await git(seed, ['rev-parse', 'HEAD']);

    const state = refreshSharedRepoToDefaultBranch(repo);

    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(commitB);
    expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('B\n');
    expect(state?.branch).toBe('main');
    expect(commitB.startsWith(state!.head)).toBe(true); // short SHA is a prefix of B
  });

  it('never clobbers an unpushed local commit (refuses a non-fast-forward)', async () => {
    // Local commit C on the clone, not pushed.
    await writeFile(path.join(repo, 'local.txt'), 'local work\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'commit C (local, unpushed)']);
    const commitC = await git(repo, ['rev-parse', 'HEAD']);

    // origin/main diverges to B.
    await writeFile(path.join(seed, 'file.txt'), 'B\n');
    await git(seed, ['commit', '-aqm', 'commit B']);
    await git(seed, ['push', '-q', 'origin', 'main']);

    const state = refreshSharedRepoToDefaultBranch(repo);

    // ff-only refused: the local commit survives, HEAD unchanged.
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(commitC);
    expect(fs.existsSync(path.join(repo, 'local.txt'))).toBe(true);
    expect(state?.branch).toBe('main');
  });

  it('is a non-throwing no-op for a directory that is not a git repo', () => {
    expect(refreshSharedRepoToDefaultBranch(TEST_HOME)).toBeNull();
  });
});
