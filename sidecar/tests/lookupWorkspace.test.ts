import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __lookupWorkspaces, createLookupWorkspace, sweepLookupWorkspaces } from '../src/workspaces/lookupWorkspace.js';
import type { AppConfig } from '../src/types/contracts.js';

const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function commit(clone: string, file: string, content: string): Promise<void> {
  fs.writeFileSync(path.join(clone, file), content);
  await git(clone, ['add', file]);
  await git(clone, ['commit', '-q', '-m', `${file}: ${content}`]);
  await git(clone, ['push', '-q', 'origin', 'master']);
}

const worktrees = async (clone: string): Promise<string[]> =>
  (await git(clone, ['worktree', 'list', '--porcelain']))
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));

// Issue #446: a lookup clone with two uncommitted files could not be
// fast-forwarded, so lookups read code 707 commits old.
describe('a lookup reads its own copy of the repos', () => {
  let tmp: string;
  let web: string;
  let api: string;
  let seed: string;
  let config: AppConfig;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lookup-ws-')));
    __lookupWorkspaces.root = path.join(tmp, 'lookups');
    for (const name of ['web', 'api']) {
      await git(tmp, ['init', '-q', '--bare', '-b', 'master', `${name}.git`]);
    }
    seed = path.join(tmp, 'seed');
    await git(tmp, ['clone', '-q', path.join(tmp, 'web.git'), seed]);
    await commit(seed, 'a.txt', 'v1');
    const apiSeed = path.join(tmp, 'api-seed');
    await git(tmp, ['clone', '-q', path.join(tmp, 'api.git'), apiSeed]);
    await commit(apiSeed, 'views.py', 'v1');

    // The owner's clones, as miniOG finds them.
    web = path.join(tmp, 'mini-og', 'newton-web');
    api = path.join(tmp, 'mini-og', 'newton-api');
    await git(tmp, ['clone', '-q', path.join(tmp, 'web.git'), web]);
    await git(tmp, ['clone', '-q', path.join(tmp, 'api.git'), api]);
    fs.writeFileSync(path.join(web, 'a.txt'), 'uncommitted edit');
    // Then origin moves on.
    await commit(seed, 'a.txt', 'v2');
    await commit(seed, 'b.txt', 'new file');

    config = {
      repoPaths: { newtonWeb: web, newtonApi: api },
      miniOgRepoRoot: path.join(tmp, 'mini-og'),
    } as unknown as AppConfig;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads origin's head, while the dirty clone behind it is left exactly as it was", async () => {
    const headBefore = await git(web, ['rev-parse', 'HEAD']);
    const logStep = vi.fn();

    const workspace = await createLookupWorkspace({ config, stage: 'agentic.repo_refresh', logStep });

    expect(workspace?.cwd).toBe(path.join(tmp, 'lookups', 'lookup-1'));
    expect(fs.readFileSync(path.join(workspace!.cwd, 'newton-web', 'a.txt'), 'utf8')).toBe('v2');
    expect(fs.existsSync(path.join(workspace!.cwd, 'newton-web', 'b.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(workspace!.cwd, 'newton-api', 'views.py'), 'utf8')).toBe('v1');
    expect(fs.readFileSync(path.join(web, 'a.txt'), 'utf8')).toBe('uncommitted edit');
    expect(await git(web, ['rev-parse', 'HEAD'])).toBe(headBefore);
    const originHead = await git(web, ['rev-parse', '--short', 'origin/master']);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.repo_refresh',
        level: 'INFO',
        message: `The lookup reads newton-web at origin/master @ ${originHead}, in its own copy.`,
      }),
    );

    await workspace!.cleanup();
  });

  it('is removed afterwards, worktree list included, and the slot is used again', async () => {
    const first = await createLookupWorkspace({ config, stage: 's' });
    await first!.cleanup();
    await first!.cleanup();

    expect(fs.existsSync(first!.cwd)).toBe(false);
    expect(await worktrees(web)).toEqual([web]);
    expect(await worktrees(api)).toEqual([api]);
    const second = await createLookupWorkspace({ config, stage: 's' });
    expect(second?.cwd).toBe(first!.cwd);
    await second!.cleanup();
  });

  it('gives two lookups at once a slot each', async () => {
    const [one, two] = await Promise.all([
      createLookupWorkspace({ config, stage: 's' }),
      createLookupWorkspace({ config, stage: 's' }),
    ]);

    expect([one?.cwd, two?.cwd].sort()).toEqual([
      path.join(tmp, 'lookups', 'lookup-1'),
      path.join(tmp, 'lookups', 'lookup-2'),
    ]);
    await Promise.all([one!.cleanup(), two!.cleanup()]);
    expect(await worktrees(web)).toEqual([web]);
  });

  it('reads the last fetched origin, with a warning, when the fetch fails', async () => {
    await git(web, ['remote', 'set-url', 'origin', path.join(tmp, 'gone.git')]);
    const logStep = vi.fn();

    const workspace = await createLookupWorkspace({ config, stage: 's', logStep });

    // The clone last fetched before v2 was pushed.
    expect(fs.readFileSync(path.join(workspace!.cwd, 'newton-web', 'a.txt'), 'utf8')).toBe('v1');
    expect(workspace!.repos.find(repo => repo.name === 'newton-web')?.fetchFailed).toBe(true);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'WARN', message: expect.stringContaining('Could not fetch newton-web') }),
    );
    await workspace!.cleanup();
  });

  it('gives up, leaving nothing behind, when a repo cannot be checked out', async () => {
    fs.rmSync(path.join(api, '.git'), { recursive: true, force: true });
    const logStep = vi.fn();

    const workspace = await createLookupWorkspace({ config, stage: 's', logStep });

    expect(workspace).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'lookups', 'lookup-1'))).toBe(false);
    expect(await worktrees(web)).toEqual([web]);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'WARN', message: expect.stringContaining('reading the shared clones instead') }),
    );
  });

  it('sweeps at startup what a stopped sidecar left, and nothing a running lookup uses', async () => {
    const leftover = path.join(tmp, 'lookups', 'lookup-7');
    fs.mkdirSync(leftover, { recursive: true });
    await git(web, ['worktree', 'add', '-q', '--detach', path.join(leftover, 'newton-web'), 'origin/master']);
    const running = await createLookupWorkspace({ config, stage: 's' });

    expect(await sweepLookupWorkspaces(config)).toBe(1);

    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(running!.cwd)).toBe(true);
    expect(await worktrees(web)).toEqual([web, path.join(running!.cwd, 'newton-web')]);
    await running!.cleanup();
  });
});
