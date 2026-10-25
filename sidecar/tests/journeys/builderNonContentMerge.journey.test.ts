import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, startJourney, stages, threadWithPr, type Journey } from './drive.js';
import { ADMIN, BUILDER, edge, OWNER, prUrl, routerReads, STYLE_EDIT } from './harness.js';

// Journey 2 (issue #701): a builder asks to merge a marketing PR that changes
// a class list, not copy. That is not theirs to merge alone: the owner is
// asked, with the file that makes it more than copy, and nothing merges
// without them. Once the owner confirms, the merge goes through and the prod
// deploy is offered as for any marketing merge (#703).

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

const PR = 1491;
const BRANCH = 'ubuilder/agentic-hero-bigger-title';
const PR_URL = prUrl(PR);

let journey: Journey;
let threadTs: string;

beforeEach(() => {
  journey = startJourney();
  journey.world.addPr({ number: PR, head: BRANCH, files: { [STYLE_EDIT.path]: STYLE_EDIT } });
  threadTs = threadWithPr(journey, BUILDER, '<@UBOT1> make the Agentic AI course hero title bigger and bolder', PR_URL);
  routerReads([['merge', 'change_code']]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const OWNER_PROMPT =
  `<@${BUILDER}> asked me to merge ${PR_URL}. It still needs an approving review, so merging now uses admin rights. ` +
  `It changes more than text (\`${STYLE_EDIT.path}\`), so an owner has to confirm. ` +
  `<@${OWNER}>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`;

describe('journey 2: a builder asks to merge a PR that is more than copy', () => {
  it('asks the owner, naming the file, and merges nothing when the owner does not answer', async () => {
    const { world, slack } = journey;

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([
      OWNER_PROMPT,
      `No \`confirm merge\` from <@${OWNER}> in 10 minutes, so nothing was changed. Ask again when they're around.`,
    ]);
    expect(stages(merge)).toEqual(
      expect.arrayContaining([
        'implementation.quick_action.no_planner',
        'implementation.quick_action.content_check',
        'implementation.quick_action.confirm.asked',
        'implementation.quick_action.confirm.expired',
      ]),
    );
    expect(merge.result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SKIPPED' });
    expect(world.mergeCalls).toEqual([]);
    expect(world.prs.get(PR)?.merged).toBe(false);
    expect(world.dispatches()).toEqual([]);
    expect(edge.runCodex).not.toHaveBeenCalled();
    expect(slack.said(threadTs).some(text => text.includes('deploy it'))).toBe(false);
  });

  it('merges once the owner confirms, then offers the deploy for core-dev to tap', async () => {
    const { world, slack } = journey;
    // The owner confirms; then core-dev taps the offer.
    slack.willReply(threadTs, OWNER, 'confirm merge', /reply `confirm merge`/);
    slack.willReply(threadTs, ADMIN, 'deploy it', /deploy it` here/);
    // The agent that carries out a confirmed merge: it merges the PR on GitHub.
    edge.runCodex.mockImplementation(async () => {
      const pr = world.prs.get(PR)!;
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = new Date().toISOString();
      return { ok: true, exitCode: 0, lastMessage: '', stdout: '', parsedJson: { summary: `Merged ${PR_URL}.` } };
    });

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([
      OWNER_PROMPT,
      `Merged ${PR_URL}.`,
      "It isn't live yet: someone from core-dev can reply `deploy it` here in the next 2 hours to put it on newtonschool.co.",
      ':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…',
      expect.stringMatching(/^:white_check_mark: newton-marketing-web production deploy succeeded/),
    ]);
    expect(edge.runCodex).toHaveBeenCalledTimes(1);
    // The agent is told which operation was confirmed, and nothing else.
    expect(String(edge.runCodex.mock.calls[0][0].prompt)).toContain(
      'The confirmed operation is `merge`; perform no other pull-request operation.',
    );
    expect(world.mergeCalls).toEqual([]);
    expect(world.dispatches('deploy-prod.yml')).toHaveLength(1);
    // The branch was never on staging, so staging was left alone.
    expect(world.dispatches('deploy-staging.yml')).toEqual([]);
    expect(merge.result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SUCCESS' });
  });
});
