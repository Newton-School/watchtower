import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, startJourney, stages, threadWithPr, type Journey } from './drive.js';
import { ADMIN, BUILDER, COPY_EDIT, edge, OWNER, prUrl, routerReads, SLUG, STAGING } from './harness.js';

// Journey 1 (issues #701, #702, #703): a builder asks for a one-word copy
// change on the marketing site, checks it on staging, merges it on their own
// word because it only changes copy, and core-dev puts it live with a tap.

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
const BRANCH = 'ubuilder/agentic-mentorship-copy-1800000000-000001';
const PR_URL = prUrl(PR);

let journey: Journey;
let threadTs: string;

beforeEach(() => {
  journey = startJourney();
  journey.world.addPr({ number: PR, head: BRANCH, files: { [COPY_EDIT.path]: COPY_EDIT } });
  threadTs = threadWithPr(
    journey,
    BUILDER,
    '<@UBOT1> on the Agentic AI course page change "from top companies" to "at top companies"',
    PR_URL,
  );
  routerReads([
    ['testing link', 'deploy_staging'],
    ['merge', 'change_code'],
  ]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('journey 1: a builder takes a copy change from staging to live', () => {
  it('stages it, merges it on their word, refuses their tap, and deploys on core-dev’s', async () => {
    const { world, slack } = journey;

    // 1. A testing link: the PR's branch goes on staging, linked to the page it changes.
    const staging = await ask(journey, threadTs, BUILDER, '<@UBOT1> can you give me a testing link?');
    expect(staging.result).toMatchObject({ workflow: 'STAGING_DEPLOY', status: 'SUCCESS' });
    expect(staging.said).toEqual([
      `Putting \`${BRANCH}\` on staging, about 3 minutes.`,
      `\`${BRANCH}\` is on staging: <${STAGING}/agentic-ai-course>. Staging is shared, so the next staging deploy replaces it.`,
    ]);
    expect(world.dispatches()).toEqual([
      expect.objectContaining({ workflow: 'deploy-staging.yml', branch: BRANCH, conclusion: 'success' }),
    ]);

    // 2. People reply once the merge offer is up: the builder taps (not allowed), then core-dev taps.
    slack.willReply(threadTs, BUILDER, 'deploy it', /deploy it` here/);
    slack.willReply(threadTs, ADMIN, 'deploy it', /only someone from core-dev can put it live/);

    // 3. "looks good, merge it": copy only, so it merges on the builder's word, past the missing review.
    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> looks good, merge it');

    expect(world.mergeCalls).toEqual([
      ['pr', 'merge', String(PR), '--repo', SLUG, '--squash', '--match-head-commit', `sha-${PR}`, '--admin'],
    ]);
    expect(world.prs.get(PR)?.merged).toBe(true);
    expect(stages(merge)).toEqual(
      expect.arrayContaining([
        'implementation.quick_action.no_planner',
        'implementation.quick_action.content_merge',
        'deploy_offer.asked',
        'deploy_offer.unauthorized',
        'deploy_offer.tapped',
      ]),
    );
    expect(stages(merge)).not.toContain('implementation.quick_action.confirm.asked');
    expect(edge.runCodex).not.toHaveBeenCalled();

    // What the thread saw, in order: a merge-only ask gets no "On it" line, the merge reply comes first.
    expect(merge.said).toEqual([
      `Merged ${PR_URL}: it only changes text and numbers, so it went in without the usual review. It isn't live yet: someone from core-dev can reply \`deploy it\` here in the next 2 hours to put it on newtonschool.co.`,
      'Staging is back on main.',
      `<@${BUILDER}> only someone from core-dev can put it live.`,
      ':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…',
      expect.stringMatching(
        /^:white_check_mark: newton-marketing-web production deploy succeeded — live on www\.newtonschool\.co\. Run: https:\/\/github\.com\/.+\/actions\/runs\/\d+$/,
      ),
    ]);

    // Exactly one prod deploy, of main; staging got main back after the merge.
    expect(world.dispatches('deploy-prod.yml')).toEqual([
      expect.objectContaining({ branch: 'main', conclusion: 'success' }),
    ]);
    expect(world.dispatches('deploy-staging.yml').map(run => run.branch)).toEqual([BRANCH, 'main']);
    const prodDispatch = world.ghCalls.find(args => args[0] === 'workflow' && args[2] === 'deploy-prod.yml');
    expect(prodDispatch).toEqual(['workflow', 'run', 'deploy-prod.yml', '--ref', 'main', '-f', 'confirm=deploy']);
    expect(merge.result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SUCCESS' });

    // Nobody but the requester was tagged anywhere.
    for (const text of slack.said(threadTs)) {
      expect(text.match(/<@U[A-Z0-9]+>/g) ?? []).toEqual(expect.not.arrayContaining([`<@${ADMIN}>`, `<@${OWNER}>`]));
    }
  });

  // A natural way to say it right after testing: "looks good on staging, merge it". The gate
  // takes a short approval before one of its sentences (#719), so it is only a merge and takes
  // the content-only merge (#701) on the builder's word, with no planner and no owner.
  it('merges on the builder’s word when they say "looks good on staging, merge it"', async () => {
    const { world } = journey;
    // The planner, asked about a merge, finds no code to change.
    edge.runCodex.mockResolvedValue({
      ok: true,
      exitCode: 0,
      parsedJson: { summary: 'Merge the PR.', planMarkdown: 'Merge it.', requiresCodeChanges: false },
    });

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> looks good on staging, merge it');

    expect(stages(merge)).not.toContain('implementation.quick_action.confirm.asked');
    expect(world.prs.get(PR)?.merged).toBe(true);
  });

  // The same ask's first line must not promise a plan ("I'll post a plan for approval in a few
  // minutes"): the opening line reads the message with `readPrActionAsk`, which now sees it as
  // a merge (#719).
  it('does not promise a plan for "looks good on staging, merge it"', async () => {
    edge.runCodex.mockResolvedValue({
      ok: true,
      exitCode: 0,
      parsedJson: { summary: 'Merge the PR.', planMarkdown: 'Merge it.', requiresCodeChanges: false },
    });

    const merge = await ask(journey, threadTs, BUILDER, '<@UBOT1> looks good on staging, merge it');

    expect(merge.said.some(text => text.includes('post a plan for approval'))).toBe(false);
  });
});
