import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, startJourney, stages, threadWithPr, type Journey } from './drive.js';
import { BUILDER, COPY_EDIT, edge, OWNER, prUrl, routerReads } from './harness.js';

// Journey 6 (issue #605): "close it" in a thread with one PR skips the
// planner. Asked by a builder, the owner confirms first, since the close runs
// under the owner's GitHub identity (#429); asked by the owner, it just closes.

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

let journey: Journey;
let threadTs: string;

beforeEach(() => {
  journey = startJourney();
  journey.world.addPr({ number: PR, head: 'ubuilder/agentic-copy', files: { [COPY_EDIT.path]: COPY_EDIT } });
  threadTs = threadWithPr(journey, BUILDER, '<@UBOT1> change "from top companies" to "at top companies"', PR_URL);
  routerReads([['close', 'change_code']]);
  // The agent that carries out a close: it closes the PR on GitHub.
  edge.runCodex.mockImplementation(async () => {
    const pr = journey.world.prs.get(PR)!;
    pr.state = 'closed';
    return { ok: true, exitCode: 0, lastMessage: '', stdout: '', parsedJson: { summary: `Closed ${PR_URL}.` } };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('journey 6: closing a PR from its thread', () => {
  it('asks the owner when a builder says "close it", and closes once the owner confirms, with no planner', async () => {
    const { world, slack } = journey;
    slack.willReply(threadTs, OWNER, 'confirm close', /reply `confirm close`/);

    const close = await ask(journey, threadTs, BUILDER, '<@UBOT1> close it');

    expect(close.said).toEqual([
      `<@${BUILDER}> asked me to close ${PR_URL}. <@${OWNER}>, reply \`confirm close\` within 10 minutes and I'll do it. Without that, nothing changes.`,
      `Closed ${PR_URL}.`,
    ]);
    expect(stages(close)).toEqual(
      expect.arrayContaining([
        'implementation.quick_action.no_planner',
        'implementation.quick_action.confirm.asked',
        'implementation.quick_action.confirm.confirmed',
      ]),
    );
    expect(stages(close)).not.toContain('pipeline.agent.planner.start');
    // One agent run, the close itself, told which operation was confirmed.
    expect(edge.runCodex).toHaveBeenCalledTimes(1);
    expect(String(edge.runCodex.mock.calls[0][0].prompt)).toContain(
      'The confirmed operation is `close`; perform no other pull-request operation.',
    );
    expect(world.prs.get(PR)).toMatchObject({ state: 'closed', merged: false });
    // A close is not a merge: no deploy offer, no deploys.
    expect(close.said.some(text => text.includes('deploy it'))).toBe(false);
    expect(world.runs).toEqual([]);
  });

  it('closes nothing when the owner does not confirm a builder’s "close it"', async () => {
    const close = await ask(journey, threadTs, BUILDER, '<@UBOT1> close it');

    expect(close.said.at(-1)).toBe(
      `No \`confirm close\` from <@${OWNER}> in 10 minutes, so nothing was changed. Ask again when they're around.`,
    );
    expect(edge.runCodex).not.toHaveBeenCalled();
    expect(journey.world.prs.get(PR)?.state).toBe('open');
  });

  it('closes straight away when the owner says "close it", with no planner and no confirmation', async () => {
    const { world } = journey;

    const close = await ask(journey, threadTs, OWNER, '<@UBOT1> close it');

    expect(close.said).toEqual([`Closed ${PR_URL}.`]);
    expect(stages(close)).toContain('implementation.quick_action.no_planner');
    expect(stages(close)).not.toContain('implementation.quick_action.confirm.asked');
    expect(stages(close)).not.toContain('pipeline.agent.planner.start');
    expect(edge.runCodex).toHaveBeenCalledTimes(1);
    expect(world.prs.get(PR)?.state).toBe('closed');
  });
});
