import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, startJourney, threadWithPr, type Journey } from './drive.js';
import { BUILDER, BUILDER2, CHANNEL, COPY_EDIT, prUrl, routerReads, STAGING } from './harness.js';

// Journey 4 (issue #702): staging is one shared site. Two builders ask for
// testing links for different PRs in their own threads; the second deploy
// replaces the first, and the first thread is told, with a link to where the
// new deploy was asked for and no one tagged.

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

const FIRST = { pr: 1488, branch: 'ubuilder/agentic-mentorship-copy' };
const SECOND = { pr: 1492, branch: 'ubuilder2/agentic-community-copy' };

let journey: Journey;
let firstThread: string;
let secondThread: string;

beforeEach(() => {
  journey = startJourney();
  for (const { pr, branch } of [FIRST, SECOND]) {
    journey.world.addPr({ number: pr, head: branch, files: { [COPY_EDIT.path]: COPY_EDIT } });
  }
  firstThread = threadWithPr(journey, BUILDER, '<@UBOT1> change the mentorship line', prUrl(FIRST.pr));
  secondThread = threadWithPr(journey, BUILDER2, '<@UBOT1> change the community line', prUrl(SECOND.pr));
  routerReads([['testing link', 'deploy_staging']]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('journey 4: two builders share staging', () => {
  it('puts the second branch on staging and tells the first thread, linking the second, tagging nobody', async () => {
    const { world, slack } = journey;

    const first = await ask(journey, firstThread, BUILDER, '<@UBOT1> testing link please');
    expect(first.said.at(-1)).toBe(
      `\`${FIRST.branch}\` is on staging: <${STAGING}/agentic-ai-course>. Staging is shared, so the next staging deploy replaces it.`,
    );

    const second = await ask(journey, secondThread, BUILDER2, '<@UBOT1> can I have a testing link?');
    expect(second.said).toEqual([
      `Putting \`${SECOND.branch}\` on staging, about 3 minutes.`,
      `\`${SECOND.branch}\` is on staging: <${STAGING}/agentic-ai-course>. Staging is shared, so the next staging deploy replaces it.`,
    ]);

    // The first thread hears that its branch is gone, with a link to the second thread.
    const headsUp = slack.said(firstThread).slice(first.said.length);
    expect(headsUp).toHaveLength(1);
    expect(headsUp[0]).toMatch(
      new RegExp(
        `^Heads-up: staging now shows \`${SECOND.branch.replace(/[/.]/g, '\\$&')}\` \\(asked in <https://[^|>]+/archives/${CHANNEL}/p${secondThread.replace('.', '')}\\|another thread>\\)\\. Ask me again when you need your link\\.$`,
      ),
    );
    expect(headsUp[0]).not.toMatch(/<@/);

    // Two deploys, in order, and the record now names the second thread.
    expect(world.dispatches('deploy-staging.yml').map(run => run.branch)).toEqual([FIRST.branch, SECOND.branch]);
    expect(JSON.parse(journey.store.state.get('staging_deploy:newton-marketing-web') ?? '{}')).toMatchObject({
      branch: SECOND.branch,
      threadTs: secondThread,
    });
  });

  it('leaves staging alone when the first builder merges after the second branch replaced theirs', async () => {
    journey = startJourney({ offerDeadlineMs: 60 });
    for (const { pr, branch } of [FIRST, SECOND]) {
      journey.world.addPr({ number: pr, head: branch, files: { [COPY_EDIT.path]: COPY_EDIT } });
    }
    firstThread = threadWithPr(journey, BUILDER, '<@UBOT1> change the mentorship line', prUrl(FIRST.pr));
    secondThread = threadWithPr(journey, BUILDER2, '<@UBOT1> change the community line', prUrl(SECOND.pr));
    routerReads([
      ['testing link', 'deploy_staging'],
      ['merge', 'change_code'],
    ]);
    const { world, slack } = journey;

    await ask(journey, firstThread, BUILDER, '<@UBOT1> testing link please');
    await ask(journey, secondThread, BUILDER2, '<@UBOT1> testing link please');
    const merge = await ask(journey, firstThread, BUILDER, '<@UBOT1> looks good, merge it');

    expect(world.prs.get(FIRST.pr)?.merged).toBe(true);
    expect(merge.said[0]).toMatch(/^Merged .+ It isn't live yet: someone from core-dev can reply `deploy it` here/);
    // The second builder is still testing their branch: main does not go back on staging.
    expect(merge.said).not.toContain('Staging is back on main.');
    expect(world.dispatches('deploy-staging.yml').map(run => run.branch)).toEqual([FIRST.branch, SECOND.branch]);
    expect(slack.said(secondThread).some(text => text.startsWith('Heads-up'))).toBe(false);
  });

  it('says nothing to the first thread when its builder puts their own branch up again', async () => {
    const { slack } = journey;

    const first = await ask(journey, firstThread, BUILDER, '<@UBOT1> testing link please');
    const again = await ask(journey, firstThread, BUILDER, '<@UBOT1> one more testing link, I pushed a fix');

    expect(again.said.at(-1)).toContain('is on staging');
    expect(slack.said(firstThread)).toHaveLength(first.said.length + again.said.length);
    expect(slack.said(firstThread).some(text => text.startsWith('Heads-up'))).toBe(false);
  });
});
