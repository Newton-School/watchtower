import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSharedRepoToDefaultBranch } from '../src/workspaces/workspaceManager.js';
import { prepareSiblingRepos } from '../src/workspaces/siblingRepos.js';
import type { AppConfig } from '../src/types/contracts.js';

vi.mock('../src/workspaces/workspaceManager.js', () => ({ refreshSharedRepoToDefaultBranch: vi.fn() }));

const config = {
  repoPaths: {
    newtonWeb: '/code/mini-og/newton-web',
    newtonApi: '/code/mini-og/newton-api',
    newtonMarketingWeb: '/code/mini-og/newton-marketing-web',
  },
  miniOgRepoRoot: '/code/mini-og',
} as unknown as AppConfig;

const current = {
  branch: 'master',
  head: 'ac56c6935',
  headDate: '2026-10-27',
  upstream: 'origin/master',
  behind: 0,
};
// A review only fetches: the files stay where they were, behind origin.
const notUpdated = {
  branch: 'main',
  head: '9f8e7d6',
  headDate: '2026-10-20',
  upstream: 'origin/main',
  behind: 12,
  staleReason: 'not_updated' as const,
};
const fetchFailed = {
  branch: 'master',
  head: '1a2b3c4',
  headDate: '2026-10-14',
  lastFetched: '2026-10-14',
  upstream: 'origin/master',
  behind: 0,
  staleReason: 'fetch_failed' as const,
};

// Issue #610: a follow-up review read a companion PR from a clone fetched days
// earlier, and a scoped investigation could not read the other repo at all.
describe('prepareSiblingRepos', () => {
  beforeEach(() => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockReset();
  });

  it("lists the other repos with where they are and how current each one is, never the run's own repo", async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockImplementation(async (repoPath: string) =>
      repoPath.endsWith('newton-api') ? current : notUpdated,
    );

    const siblings = await prepareSiblingRepos({
      config,
      currentRepoPath: '/code/mini-og/newton-web',
      mode: 'fetch',
      stage: 's',
    });

    expect(siblings.dirs).toEqual(['/code/mini-og/newton-api', '/code/mini-og/newton-marketing-web']);
    expect(vi.mocked(refreshSharedRepoToDefaultBranch).mock.calls).toEqual([
      ['/code/mini-og/newton-api', { fetchOnly: true }],
      ['/code/mini-og/newton-marketing-web', { fetchOnly: true }],
    ]);
    const { block } = siblings;
    expect(block).toContain(
      '- newton-api (Newton-School/newton-api on GitHub): /code/mini-og/newton-api — master @ ac56c6935 (2026-10-27), current with GitHub.',
    );
    expect(block).toContain(
      '- newton-marketing-web (Newton-School/newton-marketing-web on GitHub): /code/mini-og/newton-marketing-web — its files are main @ 9f8e7d6 (2026-10-20), 12 commits behind origin/main: read origin/main instead (below).',
    );
    expect(block).not.toContain('- newton-web');
    // Another PR is read from GitHub, not from a clone's branch.
    expect(block).toContain('gh pr view <number> --repo Newton-School/newton-api --json commits,files');
    expect(block).toContain("Never judge a pull request from a local clone's branch");
    // How to read the clone that is behind, from its own path.
    expect(block).toContain('STALE CHECKOUTS');
    expect(block).toContain('  cd /code/mini-og/newton-marketing-web\n  git show origin/main:<path>');
  });

  it('fast-forwards the clones for a run that reads their files', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockResolvedValue(current);

    const siblings = await prepareSiblingRepos({
      config,
      currentRepoPath: '/code/mini-og/newton-api',
      mode: 'refresh',
      stage: 's',
    });

    expect(vi.mocked(refreshSharedRepoToDefaultBranch).mock.calls).toEqual([
      ['/code/mini-og/newton-web', { setAsideStrayChanges: true }],
      ['/code/mini-og/newton-marketing-web', { setAsideStrayChanges: true }],
    ]);
    expect(siblings.block).not.toContain('STALE CHECKOUTS');
  });

  it('says a clone it could not refresh is as of its last fetch, and goes on', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockImplementation(async (repoPath: string) => {
      if (repoPath.endsWith('newton-api')) return fetchFailed;
      throw new Error('git exploded');
    });
    const logStep = vi.fn();

    const { block, dirs } = await prepareSiblingRepos({
      config,
      currentRepoPath: '/code/mini-og/newton-web',
      mode: 'fetch',
      stage: 'agentic.pr_review.sibling_repos',
      logStep,
    });

    expect(dirs).toHaveLength(2);
    expect(block).toContain(
      "/code/mini-og/newton-api — couldn't be refreshed; it is as of its last fetch on 2026-10-14: master @ 1a2b3c4 (2026-10-14).",
    );
    expect(block).toContain(
      "/code/mini-og/newton-marketing-web — couldn't be checked against GitHub just now, so its files may be out of date.",
    );
    expect(block).toContain('say the code you read may be out of date');
    expect(logStep.mock.calls.map(call => call[0].level)).toEqual(['WARN', 'WARN']);
  });

  it('is empty when no other repo is configured', async () => {
    const single = { repoPaths: { newtonWeb: '/r/newton-web', newtonApi: '' } } as unknown as AppConfig;

    expect(
      await prepareSiblingRepos({ config: single, currentRepoPath: '/r/newton-web', mode: 'fetch', stage: 's' }),
    ).toEqual({ dirs: [], block: '' });
    expect(refreshSharedRepoToDefaultBranch).not.toHaveBeenCalled();
  });
});
