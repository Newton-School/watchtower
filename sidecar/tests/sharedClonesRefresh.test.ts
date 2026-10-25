import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSharedRepoToDefaultBranch } from '../src/workspaces/workspaceManager.js';
import { refreshSharedClones } from '../src/workspaces/staleCheckout.js';
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
