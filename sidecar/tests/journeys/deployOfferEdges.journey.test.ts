import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, startJourney, stages, threadWithPr, type Journey } from './drive.js';
import { ADMIN, BUILDER, COPY_EDIT, edge, prUrl, routerReads } from './harness.js';

// Journey 5 (issue #703): what the deploy offer does with people after a
// builder's content-only merge, when it isn't a clean tap: the requester
// holds it back (and core-dev's tap right after doesn't count), someone
// deploys from GitHub while nobody taps, and the requester asks whether it is
// live yet before core-dev taps.

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
const OFFER = `Merged ${PR_URL}: it only changes text and numbers, so it went in without the usual review. It isn't live yet: someone from core-dev can reply \`deploy it\` here in the next 2 hours to put it on newtonschool.co.`;
const OFFER_POSTED = /deploy it` here/;

function mergedThread(opts: { offerDeadlineMs?: number } = {}): { journey: Journey; threadTs: string } {
  const journey = startJourney(opts);
  journey.world.addPr({ number: PR, head: 'ubuilder/agentic-copy', files: { [COPY_EDIT.path]: COPY_EDIT } });
  const threadTs = threadWithPr(journey, BUILDER, '<@UBOT1> change "from top companies" to "at top companies"', PR_URL);
  routerReads([
    ['merge', 'change_code'],
    ['deploy', 'deploy'],
  ]);
  return { journey, threadTs };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('journey 5: the deploy offer when it is not a clean tap', () => {
  it('holds the deploy when the requester says wait, and ignores core-dev’s tap right after', async () => {
    const { journey, threadTs } = mergedThread();
    const { world, slack } = journey;
    // Both show up together, the hold first.
    slack.willReply(threadTs, BUILDER, 'wait, the hero image is broken', OFFER_POSTED);
    slack.willReply(threadTs, ADMIN, 'deploy it', OFFER_POSTED);

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([OFFER, 'Okay, not deploying it now.']);
    expect(stages(merge)).toContain('deploy_offer.declined');
    expect(stages(merge)).not.toContain('deploy_offer.tapped');
    expect(world.prs.get(PR)?.merged).toBe(true);
    expect(world.dispatches('deploy-prod.yml')).toEqual([]);
    expect(merge.result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SUCCESS' });

    // Later, core-dev replies "deploy it" in the thread without mentioning miniOG: the offer is
    // closed and no job is waiting, so nothing happens.
    slack.reply(threadTs, ADMIN, 'deploy it');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(world.dispatches('deploy-prod.yml')).toEqual([]);
    expect(slack.said(threadTs)).toEqual(merge.said);
  });

  it('asks for the typed confirmation when core-dev later mentions miniOG to deploy it', async () => {
    const { journey, threadTs } = mergedThread();
    const { world, slack } = journey;
    slack.willReply(threadTs, BUILDER, 'wait, the hero image is broken', OFFER_POSTED);
    await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    // A new ask, after the offer closed: the prod deploy command, with its own confirmation.
    const deploy = await ask(journey, threadTs, ADMIN, '<@UBOT1> image is fixed now, deploy marketing to prod');

    expect(deploy.said[0]).toBe(
      `Deploy *newton-marketing-web* to production? <@${ADMIN}>, reply \`confirm deploy\` within 10 minutes and I'll start. Without that, nothing is deployed.`,
    );
    expect(world.dispatches('deploy-prod.yml')).toEqual([]);
    expect(deploy.result).toMatchObject({ workflow: 'DEPLOY', status: 'SKIPPED' });
  });

  it('says it is already live when someone deployed from GitHub and nobody tapped', async () => {
    const { journey, threadTs } = mergedThread({ offerDeadlineMs: 60 });
    const { world, slack } = journey;
    // While the offer is up, someone runs the prod deploy from GitHub.
    let byHand: { url: string } | undefined;
    slack.onPost = post => {
      if (OFFER_POSTED.test(post.text) && !byHand) {
        byHand = world.addRun({
          workflow: 'deploy-prod.yml',
          branch: 'main',
          status: 'completed',
          conclusion: 'success',
        });
      }
    };

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([OFFER, `Already live: ${byHand?.url}`]);
    expect(stages(merge)).toContain('deploy_offer.expired');
    expect(world.dispatches('deploy-prod.yml')).toEqual([]);
  });

  it('expires with no deploy when nobody taps and nothing was deployed', async () => {
    const { journey, threadTs } = mergedThread({ offerDeadlineMs: 60 });

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([
      OFFER,
      "No deploy tap in 2 hours, so it isn't live yet. When it should go live, someone from core-dev can ask me to deploy marketing to prod.",
    ]);
    expect(journey.world.dispatches()).toEqual([]);
  });

  it('holds the deploy and asks for the rest again when the requester holds it with another ask', async () => {
    const { journey, threadTs } = mergedThread();
    const { world, slack } = journey;
    slack.willReply(threadTs, BUILDER, '<@UBOT1> wait, can you also change the footer link to /apply?', OFFER_POSTED);

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([
      OFFER,
      "Okay, not deploying it now. Mention me again with the rest of your message and I'll pick it up.",
    ]);
    expect(world.dispatches()).toEqual([]);
  });

  it('lets thanks and a bystander’s question pass, and still deploys on core-dev’s tap', async () => {
    const { journey, threadTs } = mergedThread();
    const { world, slack } = journey;
    slack.willReply(threadTs, BUILDER, '<@UBOT1> thanks!', OFFER_POSTED);
    slack.willReply(threadTs, 'UVIEWER', "<@UBOT1> what's the program fee on this page?", OFFER_POSTED);
    slack.willReply(threadTs, ADMIN, 'Looks good! Deploy it.', /holding this thread for a deploy tap/);

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([
      OFFER,
      "<@UVIEWER> I'm holding this thread for a deploy tap, so I can't take new asks here for now. Ask me in a new thread.",
      ':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…',
      expect.stringMatching(/^:white_check_mark: newton-marketing-web production deploy succeeded/),
    ]);
    expect(world.dispatches('deploy-prod.yml')).toHaveLength(1);
  });

  it('answers "is it live yet?" and keeps the offer open for core-dev', async () => {
    const { journey, threadTs } = mergedThread();
    const { world, slack } = journey;
    slack.willReply(threadTs, BUILDER, '<@UBOT1> is it live yet?', OFFER_POSTED);
    slack.willReply(threadTs, ADMIN, 'deploy it', /waiting for a tap from core-dev/);

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> merge it');

    expect(merge.said).toEqual([
      OFFER,
      `<@${BUILDER}> Not yet: it's waiting for a tap from core-dev.`,
      ':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…',
      expect.stringMatching(/^:white_check_mark: newton-marketing-web production deploy succeeded/),
    ]);
    expect(world.dispatches('deploy-prod.yml')).toHaveLength(1);
    expect(edge.runCodex).not.toHaveBeenCalled();
  });
});
