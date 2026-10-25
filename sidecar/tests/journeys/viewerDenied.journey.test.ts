import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, startJourney, stages, threadWithPr, type Journey } from './drive.js';
import { BUILDER, COPY_EDIT, edge, prUrl, routerReads, VIEWER } from './harness.js';

// Journey 3 (issues #701, #702): a viewer, who may ask questions but not
// start changes, asks for a testing link and then to merge the same copy PR a
// builder could merge. Both are refused with the access copy, and nothing is
// deployed, read or merged on GitHub.

vi.mock('../../src/router/toolRouter.js', async importOriginal => {
  const { edge } = await import('./harness.js');
  return {
    ...(await importOriginal<typeof import('../../src/router/toolRouter.js')>()),
    decideTool: edge.decideTool,
  };
});
vi.mock('../../src/codex/runCodex.js', async importOriginal => {
  const { edge } = await import('./harness.js');
  return {
    ...(await importOriginal<typeof import('../../src/codex/runCodex.js')>()),
    runCodex: edge.runCodex,
    getActiveBackendId: () => 'claude-code',
  };
});
vi.mock('../../src/github/prReviewComments.js', async () => {
  const { edge } = await import('./harness.js');
  return {
    fetchMergeState: edge.fetchMergeState,
    fetchUnresolvedReviewThreadCount: edge.fetchUnresolvedReviewThreadCount,
    fetchChecksState: edge.fetchChecksState,
  };
});
vi.mock('../../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue('ghs_test'),
  githubAuthModeHint: vi.fn().mockReturnValue('token'),
}));
vi.mock('../../src/agentic/agenticEntry.js', () => ({
  runAgenticEntry: vi.fn().mockRejectedValue(new Error('No lookup was expected in this journey.')),
}));
vi.mock('../../src/notify/desktopNotifier.js', () => ({ notifyDesktop: vi.fn() }));
vi.mock('../../src/workspaces/workspaceManager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/workspaces/workspaceManager.js')>()),
  resolveWorkspace: vi.fn(async (repoPath: string) => repoPath),
  refreshSharedRepoToDefaultBranch: vi.fn(async () => null),
}));
vi.mock('../../src/slack/imageDownloader.js', () => ({ downloadSlackImages: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/slack/threadAttachments.js', () => ({
  collectThreadAttachments: vi.fn(async () => ({ imagePaths: [], documentContext: '', unreadableNote: '' })),
}));
vi.mock('../../src/router/repoClassifier.js', () => ({
  classifyRepo: vi.fn().mockReturnValue({ selectedRepo: 'newton-marketing-web', confidence: 0.95, uncertain: false }),
}));

const PR = 1488;
const PR_URL = prUrl(PR);
const DENIED =
  'Sorry, this kind of request needs a higher access level than your role allows. Please contact an admin.';

let journey: Journey;
let threadTs: string;

beforeEach(() => {
  journey = startJourney();
  journey.world.addPr({ number: PR, head: 'ubuilder/agentic-copy', files: { [COPY_EDIT.path]: COPY_EDIT } });
  // A builder's change run opened the PR; the viewer follows up in the thread.
  threadTs = threadWithPr(journey, BUILDER, '<@UBOT1> change "from top companies" to "at top companies"', PR_URL);
  routerReads([
    ['testing link', 'deploy_staging'],
    ['merge', 'change_code'],
  ]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('journey 3: a viewer asks for a testing link and a merge', () => {
  it('refuses both with the access copy and touches nothing on GitHub', async () => {
    const { world } = journey;

    const staging = await ask(journey, threadTs, VIEWER, '<@UBOT1> can I get a testing link for this?');
    expect(staging.said).toEqual([DENIED]);
    expect(staging.result).toMatchObject({ status: 'SKIPPED' });
    expect(stages(staging)).toContain('access.enforce.denied');

    const merge = await ask(journey, threadTs, VIEWER, '<@UBOT1> merge it');
    expect(merge.said).toEqual([DENIED]);
    expect(merge.result).toMatchObject({ status: 'SKIPPED' });
    expect(stages(merge)).toContain('access.enforce.denied');
    expect(stages(merge)).not.toContain('implementation.start');

    expect(world.ghCalls).toEqual([]);
    expect(world.mergeCalls).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(world.prs.get(PR)?.merged).toBe(false);
    expect(edge.fetchMergeState).not.toHaveBeenCalled();
    expect(edge.runCodex).not.toHaveBeenCalled();
  });
});
