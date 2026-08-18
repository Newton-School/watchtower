import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrFromWorkspace } from '../src/github/postPipelinePr.js';
import { createPullRequest } from '../src/github/createPr.js';

vi.mock('../src/github/createPr.js', () => ({
  createPullRequest: vi.fn().mockResolvedValue({ prUrl: 'https://github.com/org/repo/pull/1' }),
}));

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('createPrFromWorkspace staging filter (#413)', () => {
  let bare: string;
  let repo: string;

  beforeEach(async () => {
    vi.mocked(createPullRequest).mockClear();

    bare = await mkdtemp(path.join(os.tmpdir(), 'wt-pr-bare-'));
    await git(bare, ['init', '--bare', '-q', '-b', 'main']);

    repo = await mkdtemp(path.join(os.tmpdir(), 'wt-pr-repo-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    // Trailing slash: matches directories, NOT the symlink we create below.
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
    await writeFile(path.join(repo, 'file.txt'), 'A\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'initial']);
    await git(repo, ['remote', 'add', 'origin', bare]);
    await git(repo, ['push', '-q', '-u', 'origin', 'main']);
    await git(repo, ['remote', 'set-head', 'origin', 'main']);
  });

  afterEach(async () => {
    await Promise.all([bare, repo].map(d => rm(d, { recursive: true, force: true })));
  });

  function run() {
    return createPrFromWorkspace({
      repoPath: repo,
      threadTs: '1785063489.340439',
      summary: 'Scale control cohort to 100%',
      requestedBy: 'Aditya Sisodia',
      channelId: 'C1',
      workflow: 'IMPLEMENTATION',
    });
  }

  it('commits real changes but never the node_modules symlink', async () => {
    fs.mkdirSync(path.join(repo, '..', 'shared_node_modules'), { recursive: true });
    fs.symlinkSync(path.join(repo, '..', 'shared_node_modules'), path.join(repo, 'node_modules'));
    await writeFile(path.join(repo, 'file.txt'), 'B\n');

    const prUrl = await run();

    expect(prUrl).toBe('https://github.com/org/repo/pull/1');
    const committed = (await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean);
    expect(committed).toEqual(['file.txt']);
    // Still on disk for tooling — just not in the commit.
    expect(fs.lstatSync(path.join(repo, 'node_modules')).isSymbolicLink()).toBe(true);
  });

  it('opens no PR at all when the symlink is the only thing dirty', async () => {
    // Exactly job 9c632322: the coder changed nothing, but the untracked symlink
    // made the workspace look dirty, so a "Blocked: …" PR got opened anyway.
    fs.mkdirSync(path.join(repo, '..', 'shared_node_modules2'), { recursive: true });
    fs.symlinkSync(path.join(repo, '..', 'shared_node_modules2'), path.join(repo, 'node_modules'));

    const prUrl = await run();

    expect(prUrl).toBeUndefined();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(await git(repo, ['rev-list', '--count', 'origin/main..HEAD'])).toBe('0');
  });

  it('drops never-commit paths that are real directories too', async () => {
    fs.mkdirSync(path.join(repo, '.next'), { recursive: true });
    await writeFile(path.join(repo, '.next', 'build-manifest.json'), '{}\n');
    await writeFile(path.join(repo, 'file.txt'), 'C\n');

    await run();

    const committed = (await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean);
    expect(committed).toEqual(['file.txt']);
  });
});
