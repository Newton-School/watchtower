import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const {
  resolveWorkspace,
  cleanupThreadWorkspaces,
  refreshSharedRepoToDefaultBranch,
  removeWorktreeByPath,
  WorkspaceSetupError,
} = await import('../src/workspaces/workspaceManager.js');

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

  it('removes the thread worktree and its per-PR variants across repos, keeping other threads', async () => {
    mkWorkspace('newton-web', '111.22');
    mkWorkspace('newton-web', '111.22--pr-5');
    mkWorkspace('newton-api', '111.22');
    mkWorkspace('newton-web', '999.88'); // unrelated thread

    await cleanupThreadWorkspaces('111.22');

    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '111.22'))).toBe(false);
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '111.22--pr-5'))).toBe(false);
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-api', '111.22'))).toBe(false);
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '999.88'))).toBe(true);
  });

  it('does not match a different thread that merely shares a string prefix', async () => {
    mkWorkspace('newton-web', '111.222'); // not '111.22' and not '111.22--*'
    await cleanupThreadWorkspaces('111.22');
    expect(fs.existsSync(path.join(WS_ROOT, 'newton-web', '111.222'))).toBe(true);
  });

  it('is a safe no-op when the workspaces root does not exist', async () => {
    fs.rmSync(WS_ROOT, { recursive: true, force: true });
    await expect(cleanupThreadWorkspaces('111.22')).resolves.toBeUndefined();
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
    const ws1 = await resolveWorkspace(repo, thread);
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
    const ws2 = await resolveWorkspace(repo, thread);
    expect(ws2).toBe(ws1);
    expect(await git(ws2, ['rev-parse', 'HEAD'])).toBe(commitB);
  });

  it('discards an un-refreshable existing workspace and recreates it fresh', async () => {
    // A path that exists but isn't a valid worktree (refresh will throw).
    const commitA = await git(seed, ['rev-parse', 'HEAD']);
    const wsPath = path.join(WS_ROOT, path.basename(repo), thread);
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'junk.txt'), 'not a git repo\n');

    const ws = await resolveWorkspace(repo, thread);

    expect(ws).toBe(wsPath); // recreated, not the shared-repo fallback
    expect(fs.existsSync(path.join(ws, 'junk.txt'))).toBe(false); // junk discarded
    expect(await git(ws, ['rev-parse', 'HEAD'])).toBe(commitA); // fresh worktree at origin/main
  });

  it('keeps a symlinked node_modules invisible to git even when .gitignore says "node_modules/" (#413)', async () => {
    // The repo ships the trailing-slash pattern, which matches directories only.
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-qm', 'add gitignore']);
    await git(repo, ['push', '-q', 'origin', 'main']);
    // Parent clone needs a populated node_modules for the worktree symlink to be created.
    fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });

    const ws = await resolveWorkspace(repo, thread);

    expect(fs.lstatSync(path.join(ws, 'node_modules')).isSymbolicLink()).toBe(true);
    // The whole point: git must not see it. Untracked here meant `git add -A`
    // committed a mode-120000 blob holding a local absolute path into a PR.
    expect(await git(ws, ['status', '--porcelain'])).toBe('');
  });

  it('survives the clean -fd on reuse, so tooling keeps its node_modules (#413)', async () => {
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-qm', 'add gitignore']);
    await git(repo, ['push', '-q', 'origin', 'main']);
    fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });

    const ws1 = await resolveWorkspace(repo, thread);
    expect(fs.existsSync(path.join(ws1, 'node_modules'))).toBe(true);

    // Reuse runs `git clean -fd`, which deletes UNTRACKED paths. Before the fix
    // the symlink was untracked in a trailing-slash repo, so the second task in
    // a thread lost node_modules entirely and every npm command in the worktree
    // broke. Excluded paths are left alone.
    const ws2 = await resolveWorkspace(repo, thread);

    expect(ws2).toBe(ws1);
    expect(fs.lstatSync(path.join(ws2, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(await git(ws2, ['status', '--porcelain'])).toBe('');
  });

  it('moves a real node_modules out before removing a worktree, and leaves no registration behind (#611)', async () => {
    const ws = await resolveWorkspace(repo, thread);
    // A worktree's own install (depCache.ts): newton-web's is 200k files, more than git deletes in its timeout.
    fs.mkdirSync(path.join(ws, 'node_modules', 'next'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'node_modules', 'next', 'index.js'), 'x');
    const rename = vi.spyOn(fs, 'renameSync');

    try {
      expect(await removeWorktreeByPath(ws)).toBe(true);
      expect(rename).toHaveBeenCalledWith(
        path.join(ws, 'node_modules'),
        expect.stringContaining(path.join(TEST_HOME, '.watchtower', 'dep-cache', '.trash') + path.sep),
      );
    } finally {
      rename.mockRestore();
    }
    expect(fs.existsSync(ws)).toBe(false);
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(ws);
  });

  it('when git cannot remove a worktree, deletes the directory and prunes its registration (#611)', async () => {
    const ws = await resolveWorkspace(repo, thread);
    // A `git` first on PATH that fails `worktree remove`, as a timed-out one did.
    const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'wt-fakegit-'));
    const script = [
      '#!/bin/sh',
      'if [ "$1" = worktree ] && [ "$2" = remove ]; then echo "fatal: killed" >&2; exit 1; fi',
      `exec "${realGit}" "$@"`,
    ].join('\n');
    fs.writeFileSync(path.join(fakeBin, 'git'), `${script}\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    try {
      expect(await removeWorktreeByPath(ws)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      await rm(fakeBin, { recursive: true, force: true });
    }

    expect(fs.existsSync(ws)).toBe(false);
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(ws);
  });

  it('a removal cut short does not stop the next run in the thread, nor send it to the shared clone (#611)', async () => {
    const ws = await resolveWorkspace(repo, thread);
    // What a killed `git worktree remove` left: the directory gone, the registration still there.
    fs.rmSync(ws, { recursive: true, force: true });
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).toContain(ws);

    const again = await resolveWorkspace(repo, thread);

    expect(again).toBe(ws);
    expect(fs.existsSync(path.join(again, 'file.txt'))).toBe(true);
  });

  it('throws instead of handing back the shared clone when it cannot make a worktree', async () => {
    const notARepo = await mkdtemp(path.join(os.tmpdir(), 'wt-plain-'));
    try {
      await expect(resolveWorkspace(notARepo, thread)).rejects.toBeInstanceOf(WorkspaceSetupError);
      await expect(resolveWorkspace(notARepo, thread)).rejects.toThrow(
        /couldn't set up my own copy of wt-plain-\w+ to work in, so I stopped here/,
      );
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it('does not link an empty node_modules: agents read it as "installed" (#611)', async () => {
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });

    const ws = await resolveWorkspace(repo, thread);

    expect(fs.existsSync(path.join(ws, 'node_modules'))).toBe(false);
  });

  it('reuse discards stale tracked + untracked leftovers from a prior run', async () => {
    const ws1 = await resolveWorkspace(repo, thread);
    // Simulate a prior coder run that dirtied the worktree.
    await writeFile(path.join(ws1, 'file.txt'), 'locally edited\n');
    await writeFile(path.join(ws1, 'scratch.tmp'), 'untracked junk\n');

    const ws2 = await resolveWorkspace(repo, thread);
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

    const state = await refreshSharedRepoToDefaultBranch(repo);

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

    const state = await refreshSharedRepoToDefaultBranch(repo);

    // ff-only refused: the local commit survives, HEAD unchanged.
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(commitC);
    expect(fs.existsSync(path.join(repo, 'local.txt'))).toBe(true);
    expect(state?.branch).toBe('main');
    // And it says so: one behind, because of local commits (issue #446).
    expect(state).toMatchObject({ upstream: 'origin/main', behind: 1, staleReason: 'diverged' });
  });

  describe('reports where the clone ended up (issue #446)', () => {
    const advanceOrigin = async (times = 1) => {
      for (let i = 0; i < times; i++) {
        await writeFile(path.join(seed, 'file.txt'), `B${i}\n`);
        await git(seed, ['commit', '-aqm', `commit B${i}`]);
      }
      await git(seed, ['push', '-q', 'origin', 'main']);
    };

    it('reports a current clone as zero behind, with no reason to distrust it', async () => {
      await advanceOrigin();

      const state = await refreshSharedRepoToDefaultBranch(repo);

      expect(state).toMatchObject({ branch: 'main', upstream: 'origin/main', behind: 0 });
      expect(state?.staleReason).toBeUndefined();
    });

    it('reports a clone stuck behind uncommitted changes: how far, why, and which files', async () => {
      // The incident: two edited tracked files, so every fast-forward was refused for four months.
      await writeFile(path.join(repo, 'file.txt'), 'local edit, never committed\n');
      const before = await git(repo, ['rev-parse', 'HEAD']);
      await advanceOrigin(3);

      const state = await refreshSharedRepoToDefaultBranch(repo);

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('local edit, never committed\n');
      expect(state).toMatchObject({
        branch: 'main',
        upstream: 'origin/main',
        behind: 3,
        staleReason: 'dirty_tree',
        dirtyFiles: ['file.txt'],
      });
      // The fetch still worked, so the current code is readable from origin's ref.
      expect(await git(repo, ['show', 'origin/main:file.txt'])).toBe('B2');
    });

    it('reports a clone left on another branch', async () => {
      await git(repo, ['switch', '-q', '-c', 'feature/x']);
      await writeFile(path.join(repo, 'feature.txt'), 'wip\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-qm', 'wip']);
      await advanceOrigin();

      const state = await refreshSharedRepoToDefaultBranch(repo);

      expect(state).toMatchObject({ branch: 'feature/x', behind: 1, staleReason: 'other_branch' });
    });

    it('reports a failed fetch instead of passing off the last one as fresh', async () => {
      await git(repo, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'wt-no-such-remote')]);

      const state = await refreshSharedRepoToDefaultBranch(repo);

      expect(state).toMatchObject({ branch: 'main', staleReason: 'fetch_failed' });
    });
  });

  it('is a non-throwing no-op for a directory that is not a git repo', async () => {
    expect(await refreshSharedRepoToDefaultBranch(TEST_HOME)).toBeNull();
  });

  it('says it could not confirm the clone is current when the upstream ref is a guess', async () => {
    // No origin/HEAD: the default branch falls back to origin/master, which this repo doesn't have.
    // (Newer git re-creates origin/HEAD on fetch unless told not to.)
    await git(repo, ['config', 'remote.origin.followRemoteHEAD', 'never']);
    await git(repo, ['remote', 'set-head', 'origin', '-d']);

    const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

    expect(state).toMatchObject({ branch: 'main', staleReason: 'unverified' });
    expect(state?.behind).toBeUndefined();
  });

  it('records the date of the commit the files on disk are from', async () => {
    const state = await refreshSharedRepoToDefaultBranch(repo);
    expect(state?.headDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('records when the clone last fetched, from FETCH_HEAD', async () => {
    const state = await refreshSharedRepoToDefaultBranch(repo);
    expect(state?.lastFetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('retries a fetch that failed on a ref lock, so a fetch racing another one is not reported as failed', async () => {
    // origin moves on, and another fetch holds the lock on the ref it must update.
    await writeFile(path.join(seed, 'file.txt'), 'B\n');
    await git(seed, ['commit', '-aqm', 'commit B']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    const lock = path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const refreshing = refreshSharedRepoToDefaultBranch(repo, { fetchRetryMs: 400 });
    // The first try fails on the lock at once; the other fetch is done before the retry.
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.rmSync(lock, { force: true });

    const state = await refreshing;

    expect(state?.staleReason).toBeUndefined();
    expect(state).toMatchObject({ behind: 0 });
    expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('B\n');
  });

  it('does not retry a fetch that failed for any other reason', async () => {
    await git(repo, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'wt-no-such-remote')]);
    const started = Date.now();

    const state = await refreshSharedRepoToDefaultBranch(repo, { fetchRetryMs: 5_000 });

    expect(state?.staleReason).toBe('fetch_failed');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('starts a fresh refresh for a call made right after one finished', async () => {
    const first = await refreshSharedRepoToDefaultBranch(repo);
    const second = await refreshSharedRepoToDefaultBranch(repo);
    expect(second).not.toBe(first);
  });

  // Issue #709: an agent's leftover package.json edit held newton-web's clone
  // on a May commit, 783 commits behind, until someone stashed it by hand.
  describe('sets aside stray changes in the way (issue #709)', () => {
    const HOUR_AGO = (Date.now() - 60 * 60 * 1000) / 1000;
    const age = (file: string) => fs.utimesSync(path.join(repo, file), HOUR_AGO, HOUR_AGO);
    const advanceOrigin = async (files: Record<string, string>, remove: string[] = []) => {
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(seed, name)), { recursive: true });
        await writeFile(path.join(seed, name), content);
      }
      if (remove.length > 0) await git(seed, ['rm', '-q', ...remove]);
      await git(seed, ['add', '.']);
      await git(seed, ['commit', '-qm', 'origin moves on']);
      await git(seed, ['push', '-q', 'origin', 'main']);
      return git(seed, ['rev-parse', 'HEAD']);
    };
    const stashList = async () => (await git(repo, ['stash', 'list', '--format=%H %gs'])).split('\n').filter(Boolean);
    const autostashRefs = async () =>
      (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/miniog/autostash'])).split('\n').filter(Boolean);
    const caseInsensitiveFs = (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-case-'));
      fs.writeFileSync(path.join(dir, 'A'), '');
      const insensitive = fs.existsSync(path.join(dir, 'a'));
      fs.rmSync(dir, { recursive: true, force: true });
      return insensitive;
    })();

    it('sets aside an old uncommitted edit under a private ref and a patch, updates, and says where it went', async () => {
      await writeFile(path.join(repo, 'file.txt'), 'agent leftover\n');
      age('file.txt');
      const latest = await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('B\n');
      expect(state).toMatchObject({ branch: 'main', behind: 0 });
      expect(state?.staleReason).toBeUndefined();
      const setAside = state!.setAside!;
      expect(setAside.files).toEqual(['file.txt']);
      expect(setAside.label).toMatch(
        /^miniog-autostash \S+ \(#709\): 1 uncommitted file set aside so the clone could update: file\.txt$/,
      );
      // Kept under a private ref, out of the stash list the clone's worktrees share.
      expect(setAside.ref).toMatch(/^refs\/miniog\/autostash\//);
      expect(await git(repo, ['rev-parse', setAside.ref])).toBe(setAside.stash);
      expect(await stashList()).toEqual([]);
      expect(await git(repo, ['show', `${setAside.ref}:file.txt`])).toBe('agent leftover');
      // And a patch copy under ~/.watchtower/autostash/<repo>/.
      expect(setAside.patch).toContain(path.join(TEST_HOME, '.watchtower', 'autostash'));
      expect(fs.readFileSync(setAside.patch!, 'utf8')).toContain('+agent leftover');
      // `git stash show -p <ref>` shows what was set aside.
      expect(await git(repo, ['stash', 'show', '-p', setAside.ref])).toContain('+agent leftover');
    });

    it("never hands the set-aside changes to a worktree's `git stash pop`", async () => {
      // Job worktrees are made from these clones and share their stash list.
      const wt = await mkdtemp(path.join(os.tmpdir(), 'wt-job-'));
      fs.rmSync(wt, { recursive: true, force: true });
      await git(repo, ['worktree', 'add', '-q', '-b', 'job', wt]);
      try {
        await writeFile(path.join(repo, 'file.txt'), 'agent leftover\n');
        age('file.txt');
        await advanceOrigin({ 'file.txt': 'B\n' });

        const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

        expect(state?.setAside).toBeDefined();
        expect(await git(wt, ['stash', 'list'])).toBe('');
        await expect(git(wt, ['stash', 'pop'])).rejects.toThrow();
        expect(fs.readFileSync(path.join(wt, 'file.txt'), 'utf8')).toBe('A\n');
      } finally {
        await git(repo, ['worktree', 'remove', '--force', wt]).catch(() => undefined);
      }
    });

    it('sets aside an untracked file the update would add, and leaves other untracked files alone', async () => {
      await writeFile(path.join(repo, 'new.txt'), 'local copy\n');
      await writeFile(path.join(repo, 'notes.txt'), 'unrelated scratch\n');
      age('new.txt');
      age('notes.txt');
      const latest = await advanceOrigin({ 'new.txt': 'from origin\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(state?.setAside?.files).toEqual(['new.txt']);
      expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('from origin\n');
      expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe('unrelated scratch\n');
      // An untracked file is kept in the stash commit's third parent, and in the patch.
      expect(await git(repo, ['show', `${state!.setAside!.ref}^3:new.txt`])).toBe('local copy');
      expect(fs.readFileSync(state!.setAside!.patch!, 'utf8')).toContain('+local copy');
    });

    it('only moves edits to files the update changes; the rest stay and are named', async () => {
      await writeFile(path.join(repo, 'other.txt'), 'O\n');
      await git(repo, ['add', 'other.txt']);
      await git(repo, ['commit', '-qm', 'other']);
      await git(repo, ['push', '-q', 'origin', 'main']);
      await git(seed, ['pull', '-q', 'origin', 'main']);
      await writeFile(path.join(repo, 'file.txt'), 'in the way\n');
      await writeFile(path.join(repo, 'other.txt'), 'not in the way\n');
      age('file.txt');
      age('other.txt');
      const latest = await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(state?.setAside?.files).toEqual(['file.txt']);
      expect(fs.readFileSync(path.join(repo, 'other.txt'), 'utf8')).toBe('not in the way\n');
      expect(state).toMatchObject({ leftInPlace: ['other.txt'], leftInPlaceCount: 1 });
      // The patch copy holds only what was set aside.
      const patch = fs.readFileSync(state!.setAside!.patch!, 'utf8');
      expect(patch).toContain('+in the way');
      expect(patch).not.toContain('other.txt');
    });

    it("moves nothing while another file has staged changes: that's someone's work in progress", async () => {
      await writeFile(path.join(repo, 'other.txt'), 'O\n');
      await git(repo, ['add', 'other.txt']);
      await git(repo, ['commit', '-qm', 'other']);
      await git(repo, ['push', '-q', 'origin', 'main']);
      await git(seed, ['pull', '-q', 'origin', 'main']);
      await writeFile(path.join(repo, 'file.txt'), 'in the way\n');
      await writeFile(path.join(repo, 'other.txt'), 'staged elsewhere\n');
      await git(repo, ['add', 'other.txt']);
      age('file.txt');
      age('other.txt');
      const before = await git(repo, ['rev-parse', 'HEAD']);
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(state).toMatchObject({
        staleReason: 'dirty_tree',
        setAsideSkipped: 'other_staged',
        dirtyFiles: ['file.txt'],
      });
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('in the way\n');
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('other.txt');
      expect(await autostashRefs()).toEqual([]);
    });

    it('puts the changes back when it cannot save them under a private ref', async () => {
      // A ref named refs/miniog/autostash: a ref can't also be a folder, so the private ref can't be made.
      await git(repo, ['update-ref', 'refs/miniog/autostash', await git(repo, ['rev-parse', 'HEAD'])]);
      await writeFile(path.join(repo, 'file.txt'), 'staged leftover\n');
      await git(repo, ['add', 'file.txt']);
      age('file.txt');
      const before = await git(repo, ['rev-parse', 'HEAD']);
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('staged leftover\n');
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('file.txt');
      expect(state).toMatchObject({ staleReason: 'dirty_tree', setAsideSkipped: 'failed' });
      expect(state?.setAside).toBeUndefined();
      expect(state?.setAsideKept).toBeUndefined();
      // Not left in the shared stash list either.
      expect(await stashList()).toEqual([]);
    });

    it('handles a staged deletion of a file the update changes', async () => {
      await git(repo, ['rm', '-q', 'file.txt']);
      const latest = await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('B\n');
      expect(state?.setAside?.files).toEqual(['file.txt']);
      // The deletion is what was saved.
      await expect(git(repo, ['show', `${state!.setAside!.ref}:file.txt`])).rejects.toThrow();
    });

    it('sees a file origin renamed into place as in the way', async () => {
      await writeFile(path.join(repo, 'moved.txt'), 'local file with the new name\n');
      age('moved.txt');
      await git(seed, ['mv', 'file.txt', 'moved.txt']);
      const latest = await advanceOrigin({});

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(state?.setAside?.files).toEqual(['moved.txt']);
    });

    it.skipIf(!caseInsensitiveFs)('matches paths without case on a case-insensitive disk', async () => {
      await writeFile(path.join(repo, 'New.txt'), 'local, different case\n');
      age('New.txt');
      const latest = await advanceOrigin({ 'new.txt': 'from origin\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(state?.setAside?.files).toEqual(['New.txt']);
    });

    it('leaves a change made in the last 15 minutes where it is', async () => {
      await writeFile(path.join(repo, 'file.txt'), 'someone is editing this right now\n');
      const before = await git(repo, ['rev-parse', 'HEAD']);
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('someone is editing this right now\n');
      expect(state).toMatchObject({ staleReason: 'dirty_tree', setAsideSkipped: 'recent_edits', behind: 1 });
      expect(await stashList()).toEqual([]);
      expect(await autostashRefs()).toEqual([]);
    });

    it('names a recently added untracked file that is in the way', async () => {
      await writeFile(path.join(repo, 'new.txt'), 'just written\n');
      await advanceOrigin({ 'new.txt': 'from origin\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(state).toMatchObject({
        staleReason: 'dirty_tree',
        dirtyFiles: ['new.txt'],
        setAsideSkipped: 'recent_edits',
      });
      expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('just written\n');
    });

    it('leaves the clone alone while a git command holds its index', async () => {
      await writeFile(path.join(repo, 'file.txt'), 'leftover\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });
      fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
      try {
        const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

        expect(state).toMatchObject({ staleReason: 'dirty_tree', setAsideSkipped: 'busy' });
        expect(state?.indexLockAgeMs).toBeLessThan(60_000);
        expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('leftover\n');
        expect(await autostashRefs()).toEqual([]);
      } finally {
        fs.rmSync(path.join(repo, '.git', 'index.lock'), { force: true });
      }
    });

    it('reports how old a leftover index.lock is', async () => {
      await writeFile(path.join(repo, 'file.txt'), 'leftover\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });
      const lock = path.join(repo, '.git', 'index.lock');
      fs.writeFileSync(lock, '');
      const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(lock, twoHoursAgo, twoHoursAgo);
      try {
        const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

        expect(state?.setAsideSkipped).toBe('busy');
        expect(state?.indexLockAgeMs).toBeGreaterThan(110 * 60 * 1000);
      } finally {
        fs.rmSync(lock, { force: true });
      }
    });

    it('never touches a clone with local commits', async () => {
      await writeFile(path.join(repo, 'local.txt'), 'local work\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-qm', 'local, unpushed']);
      const local = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(path.join(repo, 'file.txt'), 'and an edit\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(local);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('and an edit\n');
      expect(state?.setAside).toBeUndefined();
      expect(await autostashRefs()).toEqual([]);
    });

    it('never touches a clone checked out on another branch', async () => {
      await git(repo, ['switch', '-q', '-c', 'feature/x']);
      await writeFile(path.join(repo, 'file.txt'), 'wip\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(state).toMatchObject({ branch: 'feature/x', staleReason: 'other_branch' });
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('wip\n');
      expect(await autostashRefs()).toEqual([]);
    });

    it('only acts on the clone itself, not on a folder inside it', async () => {
      fs.mkdirSync(path.join(repo, 'sub'));
      await writeFile(path.join(repo, 'file.txt'), 'leftover\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(path.join(repo, 'sub'), { setAsideStrayChanges: true });

      expect(state?.setAside).toBeUndefined();
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('leftover\n');
      expect(await autostashRefs()).toEqual([]);
    });

    it('does nothing unless asked: other callers keep the old report', async () => {
      await writeFile(path.join(repo, 'file.txt'), 'leftover\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo);

      expect(state).toMatchObject({ staleReason: 'dirty_tree', dirtyFiles: ['file.txt'] });
      expect(state?.setAsideSkipped).toBeUndefined();
      expect(await stashList()).toEqual([]);
    });

    it('puts the changes back, staged work still staged, when the update still fails', async () => {
      // A local untracked FILE named `dir` blocks origin's new `dir/x.txt`; that
      // file/folder clash isn't one it sets aside, so the retry fails too.
      await writeFile(path.join(repo, 'file.txt'), 'staged leftover\n');
      await git(repo, ['add', 'file.txt']);
      await writeFile(path.join(repo, 'dir'), 'a file where origin has a folder\n');
      age('file.txt');
      age('dir');
      const before = await git(repo, ['rev-parse', 'HEAD']);
      await advanceOrigin({ 'file.txt': 'B\n', 'dir/x.txt': 'x\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before);
      expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('staged leftover\n');
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('file.txt');
      expect(state).toMatchObject({
        staleReason: 'dirty_tree',
        setAsideSkipped: 'update_failed',
        dirtyFiles: ['file.txt'],
      });
      expect(state?.setAside).toBeUndefined();
      expect(state?.setAsideKept).toBeUndefined();
      // Fully restored, so nothing is left saved.
      expect(await stashList()).toEqual([]);
      expect(await autostashRefs()).toEqual([]);
    });

    it('prunes set-aside refs and patches older than 30 days, and keeps newer ones', async () => {
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const oldId = '2026-01-01T00-00-00-000Z';
      const recentId = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().replace(/[:.]/g, '-');
      await git(repo, ['update-ref', `refs/miniog/autostash/${oldId}`, head]);
      await git(repo, ['update-ref', `refs/miniog/autostash/${recentId}`, head]);
      const patchDir = path.join(TEST_HOME, '.watchtower', 'autostash', path.basename(fs.realpathSync(repo)));
      fs.mkdirSync(patchDir, { recursive: true });
      fs.writeFileSync(path.join(patchDir, `${oldId}.patch`), 'old');
      fs.writeFileSync(path.join(patchDir, `${recentId}.patch`), 'recent');
      await writeFile(path.join(repo, 'file.txt'), 'leftover\n');
      age('file.txt');
      await advanceOrigin({ 'file.txt': 'B\n' });

      const state = await refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true });

      const refs = await autostashRefs();
      expect(refs).not.toContain(`refs/miniog/autostash/${oldId}`);
      expect(refs).toContain(`refs/miniog/autostash/${recentId}`);
      expect(refs).toContain(state!.setAside!.ref);
      expect(fs.existsSync(path.join(patchDir, `${oldId}.patch`))).toBe(false);
      expect(fs.existsSync(path.join(patchDir, `${recentId}.patch`))).toBe(true);
    });

    it('shares one refresh between runs that start together, so the changes are set aside once', async () => {
      await writeFile(path.join(repo, 'file.txt'), 'leftover\n');
      age('file.txt');
      const latest = await advanceOrigin({ 'file.txt': 'B\n' });

      const [a, b, c] = await Promise.all([
        refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true }),
        refreshSharedRepoToDefaultBranch(repo, { setAsideStrayChanges: true }),
        // A plain caller shares a run that sets aside, too.
        refreshSharedRepoToDefaultBranch(repo),
      ]);

      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(latest);
      expect(b).toBe(a);
      expect(c).toBe(a);
      expect(a).toMatchObject({ behind: 0 });
      expect(await autostashRefs()).toHaveLength(1);
      expect(await stashList()).toEqual([]);
    });
  });
});
