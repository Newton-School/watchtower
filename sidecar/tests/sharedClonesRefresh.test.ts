import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSharedRepoToDefaultBranch } from '../src/workspaces/workspaceManager.js';
import { refreshRepoClones, refreshSharedClones } from '../src/workspaces/staleCheckout.js';
import type { AppConfig } from '../src/types/contracts.js';

vi.mock('../src/workspaces/workspaceManager.js', () => ({ refreshSharedRepoToDefaultBranch: vi.fn() }));

const config = {
  repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' },
  miniOgRepoRoot: '/repos',
} as unknown as AppConfig;

const current = { branch: 'master', head: 'ac56c6935', upstream: 'origin/master', behind: 0 };
const stuck = {
  branch: 'master',
  head: 'eae5d68bb',
  upstream: 'origin/master',
  behind: 731,
  staleReason: 'dirty_tree' as const,
  dirtyFiles: ['package.json'],
};

// Issue #446: lookups, owner-request planners and broad investigations all
// read the shared clones in place; only lookups were told when one was stale.
describe('refreshSharedClones', () => {
  beforeEach(() => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockReset();
  });

  it('logs each clone under the given stage and returns the warning for a stale one', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockImplementation(async (repoPath: string) =>
      repoPath.endsWith('newton-web') ? stuck : current,
    );
    const logStep = vi.fn();

    const block = await refreshSharedClones({ config, stage: 'pipeline.repo_refresh', logStep });

    expect(block).toContain('newton-web');
    expect(block).toContain('origin/master');
    const rows = logStep.mock.calls.map(call => call[0]);
    expect(rows.map(row => row.stage)).toEqual(['pipeline.repo_refresh', 'pipeline.repo_refresh']);
    expect(rows[0]).toMatchObject({ level: 'WARN', data: { behind: 731, staleReason: 'dirty_tree' } });
  });

  it("asks for stray changes to be set aside: these are miniOG's own clones (issue #709)", async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockResolvedValue(current);

    await refreshSharedClones({ config, stage: 's' });

    expect(vi.mocked(refreshSharedRepoToDefaultBranch).mock.calls).toEqual([
      ['/repos/newton-web', { setAsideStrayChanges: true }],
      ['/repos/newton-api', { setAsideStrayChanges: true }],
    ]);
  });

  it('returns nothing when every clone is current', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockResolvedValue(current);
    expect(await refreshSharedClones({ config, stage: 's' })).toBeUndefined();
  });

  it('does not stop the run when a refresh throws', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockRejectedValue(new Error('git exploded'));
    const logStep = vi.fn();

    // The run goes on, told the files may be out of date (issue #709).
    const block = await refreshSharedClones({ config, stage: 's', logStep });
    expect(block).toContain('- newton-web: the update check failed, so the files may be out of date.');
    expect(logStep).toHaveBeenCalledTimes(2);
  });
});

// Issue #610: a run in one repo's worktree reads the other clones beside it.
describe('refreshRepoClones', () => {
  beforeEach(() => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockReset();
  });

  it('leaves out the repo the run has a worktree of, and only fetches when asked to', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockResolvedValue(current);
    const logStep = vi.fn();

    const refreshed = await refreshRepoClones({
      config,
      stage: 's',
      logStep,
      except: '/repos/newton-web/',
      fetchOnly: true,
    });

    expect(refreshed).toEqual([{ name: 'newton-api', path: '/repos/newton-api', state: current }]);
    expect(vi.mocked(refreshSharedRepoToDefaultBranch).mock.calls).toEqual([
      ['/repos/newton-api', { fetchOnly: true }],
    ]);
    expect(logStep.mock.calls[0][0].message).toBe('Fetched newton-api; its files (master @ ac56c6935) are current.');
  });

  it('refreshes the clones at the same time, and logs them in repo order', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.mocked(refreshSharedRepoToDefaultBranch).mockImplementation(async (repoPath: string) => {
      started.push(repoPath);
      // newton-web only finishes once newton-api has started: one at a time would never get there.
      if (repoPath.endsWith('newton-web')) await gate;
      else release();
      return current;
    });
    const logStep = vi.fn();

    await refreshRepoClones({ config, stage: 's', logStep });

    expect(started).toEqual(['/repos/newton-web', '/repos/newton-api']);
    expect(logStep.mock.calls.map(call => call[0].data.repoPath)).toEqual(['/repos/newton-web', '/repos/newton-api']);
  });
});
