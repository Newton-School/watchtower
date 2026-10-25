import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __contentMergeGh,
  __quickActionConfirm,
  contentOwnerReason,
  runImplementationWorkflow,
} from '../src/workflows/implementationWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { checkContentOnlyPr } from '../src/github/contentOnlyDiff.js';
import { fetchChecksState, fetchMergeState, fetchUnresolvedReviewThreadCount } from '../src/github/prReviewComments.js';

// Issue #701: the owner decided that admins and builders may merge a
// marketing PR that only changes content. "merge it" from one of them goes
// through on their word; anything else still waits for the owner.

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));
vi.mock('../src/agentic/agenticEntry.js', () => ({ runAgenticEntry: vi.fn() }));
vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn().mockResolvedValue([]),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue('ghs_test'),
  githubAuthModeHint: vi.fn().mockReturnValue('token'),
}));
vi.mock('../src/github/prReviewComments.js', () => ({
  fetchUnresolvedReviewThreadCount: vi.fn(),
  fetchMergeState: vi.fn(),
  fetchChecksState: vi.fn(),
}));
vi.mock('../src/github/contentOnlyDiff.js', () => ({ checkContentOnlyPr: vi.fn() }));
vi.mock('../src/notify/desktopNotifier.js', () => ({ notifyDesktop: vi.fn() }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
  refreshSharedRepoToDefaultBranch: vi.fn(async () => null),
}));
vi.mock('../src/slack/imageDownloader.js', () => ({ downloadSlackImages: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/backends/registry.js', () => ({
  getBackend: vi.fn().mockReturnValue({ supportsImages: () => false }),
}));
vi.mock('../src/slack/threadAttachments.js', () => ({
  collectThreadAttachments: vi.fn(async () => ({ imagePaths: [], documentContext: '', unreadableNote: '' })),
}));
vi.mock('../src/router/repoClassifier.js', () => ({
  classifyRepo: vi.fn().mockReturnValue({ selectedRepo: 'newton-web', confidence: 0.9, uncertain: false }),
}));

const bundle = (name: string, userId: string, capabilities: string[]) => ({
  name,
  manualUserIds: userId,
  resolvedUserIds: [userId],
  capabilities,
  allowedChannelIds: ['C1'],
  allowIm: false,
  allowMpim: false,
});

const config = {
  platformPolicy: 'macos_only' as const,
  bundleTargets: ['app', 'dmg'] as const,
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
    newtonMarketingWeb: '/Users/dipesh/code/newton-marketing-web',
  },
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: true,
  bugFixTimeoutMs: 2700000,
  accessControl: { mode: 'enforce' },
  bundles: [
    bundle('viewer', 'UVIEWER', ['query_codebase', 'chat']),
    bundle('builder', 'UBUILDER', ['query_codebase', 'chat', 'start_implementation']),
    bundle('admin', 'UADMIN', ['query_codebase', 'chat', 'start_implementation', 'deploy_prod']),
  ],
};

const MARKETING_PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1490';
const WEB_PR = 'https://github.com/Newton-School/newton-web/pull/9300';
const prOf = (url: string) => {
  const [, owner, repo, , number] = new URL(url).pathname.split('/');
  return { url, owner, repo, number: Number(number), source: 'thread' as const };
};

type RunOptions = {
  userId?: string;
  byOwner?: boolean;
  /** An owner's re-run of someone else's ask, from the app. */
  requestedFor?: string;
  pr?: string;
  channelId?: string;
  channelType?: string;
  signal?: AbortSignal;
};

async function run(text: string, options: RunOptions = {}) {
  const userId = options.byOwner || options.requestedFor ? 'UOWNER1' : (options.userId ?? 'UBUILDER');
  const pr = prOf(options.pr ?? MARKETING_PR);
  const slack = {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }) },
  };
  const logs: { stage: string; data?: Record<string, unknown> }[] = [];
  const task = {
    event: {
      eventId: 'EvMerge',
      channelId: options.channelId ?? 'C1',
      ...(options.channelType ? { channelType: options.channelType } : {}),
      threadTs: '111.22',
      eventTs: '111.22',
      userId,
      ...(options.requestedFor ? { requestedForUserId: options.requestedFor } : {}),
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot' as const,
    isOwnerAuthor: userId === 'UOWNER1',
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION' as const,
    prContext: pr,
    prContexts: [pr],
  };
  const result = await runImplementationWorkflow({
    task,
    config: config as never,
    slack: slack as unknown as import('@slack/web-api').WebClient,
    logStep: entry => logs.push(entry),
    signal: options.signal,
  });
  const posted = slack.chat.postMessage.mock.calls.map(call => call[0].text as string);
  return { result, posted, logs };
}

const ghExec = vi.fn();
const MERGED_PAST_REVIEW = `Merged ${MARKETING_PR}: it only changes text and numbers, so it went in without the usual review. It isn't live yet; someone from core-dev has to deploy it.`;

beforeEach(() => {
  vi.mocked(runCodex)
    .mockReset()
    // A planner that answers "no code changes" in so many words: one that
    // leaves the verdict out now counts as a change (#695).
    .mockResolvedValue({
      ok: true,
      exitCode: 0,
      parsedJson: { summary: 'Merged it.', requiresCodeChanges: false },
    } as never);
  __quickActionConfirm.wait = vi.fn().mockResolvedValue({ outcome: 'confirmed', userId: 'UOWNER1' });
  ghExec.mockReset().mockResolvedValue('');
  __contentMergeGh.exec = ghExec;
  vi.mocked(fetchUnresolvedReviewThreadCount).mockReset().mockResolvedValue({ unresolvedCount: 0, totalThreads: 0 });
  vi.mocked(fetchMergeState).mockReset().mockResolvedValue({
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'BLOCKED',
    isDraft: false,
    headSha: 'abc123',
    baseRef: 'main',
  });
  vi.mocked(fetchChecksState).mockReset().mockResolvedValue(null);
  vi.mocked(checkContentOnlyPr)
    .mockReset()
    .mockResolvedValue({
      contentOnly: true,
      files: ['src/features/agentic-ai-course/content.ts'],
      headSha: 'abc123',
      baseRef: 'main',
    });
});
afterEach(() => vi.clearAllMocks());

const confirmPrompt = (posted: string[]) => posted.find(text => text.includes('confirm merge'));
const mergeArgs = (...extra: string[]) => [
  'pr',
  'merge',
  '1490',
  '--repo',
  'Newton-School/newton-marketing-web',
  '--squash',
  // Only the commit the check read: a later push makes GitHub refuse it.
  '--match-head-commit',
  'abc123',
  ...extra,
];

describe('merging a content-only marketing PR (#701)', () => {
  it.each([
    ['a builder', 'UBUILDER'],
    ['an admin', 'UADMIN'],
  ])('merges on the word of %s, past the missing review, with no owner and no agent', async (_who, userId) => {
    const { result, posted, logs } = await run('<@UBOT1> merge it', { userId });

    expect(ghExec).toHaveBeenCalledTimes(1);
    expect(ghExec).toHaveBeenCalledWith(mergeArgs('--admin'), 'ghs_test');
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
    expect(posted).toEqual([MERGED_PAST_REVIEW]);
    const merge = logs.find(entry => entry.stage === 'implementation.quick_action.content_merge');
    expect(merge?.data).toMatchObject({
      requestedBy: userId,
      admin: true,
      headSha: 'abc123',
      files: ['src/features/agentic-ai-course/content.ts'],
    });
    expect(result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SUCCESS' });
  });

  it('reads the checks of the commit it read, after reading it', async () => {
    await run('<@UBOT1> merge it');

    expect(fetchChecksState).toHaveBeenCalledWith(expect.objectContaining({ sha: 'abc123' }));
    const checkedAt = vi.mocked(checkContentOnlyPr).mock.invocationCallOrder[0];
    expect(vi.mocked(fetchChecksState).mock.invocationCallOrder[0]).toBeGreaterThan(checkedAt);
  });

  it('reads the review threads and merge state again after reading the files', async () => {
    await run('<@UBOT1> merge it');

    const checkedAt = vi.mocked(checkContentOnlyPr).mock.invocationCallOrder[0];
    expect(vi.mocked(fetchMergeState).mock.invocationCallOrder[1]).toBeGreaterThan(checkedAt);
    expect(vi.mocked(fetchUnresolvedReviewThreadCount).mock.invocationCallOrder[1]).toBeGreaterThan(checkedAt);
  });

  it('asks the owner when someone pushed while the files were being read', async () => {
    vi.mocked(fetchMergeState)
      .mockResolvedValueOnce({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', headSha: 'abc123' })
      .mockResolvedValueOnce({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', headSha: 'def456' });

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toContain('Someone pushed to it while I was checking, so an owner has to confirm.');
  });

  it('asks the owner when the base branch changed while the files were being read', async () => {
    vi.mocked(fetchMergeState)
      .mockResolvedValueOnce({
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'BLOCKED',
        headSha: 'abc123',
        baseRef: 'main',
      })
      .mockResolvedValueOnce({
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'BLOCKED',
        headSha: 'abc123',
        baseRef: 'release',
      });

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toContain(
      'Its base branch changed while I was checking, so an owner has to confirm.',
    );
  });

  it('asks the owner when a review comment arrived while the files were being read', async () => {
    vi.mocked(fetchUnresolvedReviewThreadCount)
      .mockResolvedValueOnce({ unresolvedCount: 0, totalThreads: 0 })
      .mockResolvedValueOnce({ unresolvedCount: 1, totalThreads: 1 });

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBeDefined();
  });

  it('merges without admin rights, and says nothing about the review, when nothing blocks the merge', async () => {
    vi.mocked(fetchMergeState).mockResolvedValue({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      headSha: 'abc123',
      baseRef: 'main',
    });

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).toHaveBeenCalledWith(mergeArgs(), 'ghs_test');
    expect(posted).toEqual([
      `Merged ${MARKETING_PR}: it only changes text and numbers. It isn't live yet; someone from core-dev has to deploy it.`,
    ]);
  });

  it.each([
    ['with no review asked for, says nothing about the review', undefined, false],
    ['still needing its review, says it went in without it', 'REVIEW_REQUIRED', true],
  ])('uses admin rights for a branch behind its base and, %s', async (_case, reviewDecision, skipsReview) => {
    vi.mocked(fetchMergeState).mockResolvedValue({
      mergeStateStatus: 'BEHIND',
      reviewDecision,
      headSha: 'abc123',
      baseRef: 'main',
    });

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).toHaveBeenCalledWith(mergeArgs('--admin'), 'ghs_test');
    expect(posted[0].includes('without the usual review')).toBe(skipsReview);
  });

  it.each([
    ['approved but still blocked', { reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' }],
    ['blocked with no review asked for', { mergeStateStatus: 'BLOCKED' }],
  ])('asks the owner for a PR %s, since the block is something other than the review', async (_case, state) => {
    vi.mocked(fetchMergeState).mockResolvedValue(state);

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBeDefined();
  });

  it("asks the owner, saying why, when a builder's PR changes more than text", async () => {
    vi.mocked(checkContentOnlyPr).mockResolvedValue({
      contentOnly: false,
      kind: 'not_content',
      reason: 'It changes code, not only text, numbers or links.',
      offending: ['src/features/x/sections/hero.tsx', 'src/features/x/content.ts', 'src/features/x/nav.tsx'],
      fileCount: 3,
    });

    const { posted, result } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBe(
      `<@UBUILDER> asked me to merge ${MARKETING_PR}. It still needs an approving review, so merging now uses admin rights. It changes more than text (\`src/features/x/sections/hero.tsx\`, \`src/features/x/content.ts\` and 1 more), so an owner has to confirm. <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
    );
    // The owner confirmed (the default here), so the agent merges it as before.
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
  });

  it('asks the owner for a PR into a branch other than main', async () => {
    vi.mocked(checkContentOnlyPr).mockResolvedValue({
      contentOnly: false,
      kind: 'not_default_base',
      reason: 'It merges into release, not the default branch main.',
    });

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toContain("It doesn't merge into the main branch, so an owner has to confirm.");
  });

  it.each([
    ['a viewer', { userId: 'UVIEWER' }, 'UVIEWER'],
    ['a builder outside their channels', { channelId: 'C9' }, 'UBUILDER'],
    ['a builder in a DM', { channelId: 'D1', channelType: 'im' }, 'UBUILDER'],
  ] as Array<[string, RunOptions, string]>)(
    'asks the owner as before, with no reason, for %s',
    async (_who, options, asker) => {
      const { posted } = await run('<@UBOT1> merge it', options);

      expect(checkContentOnlyPr).not.toHaveBeenCalled();
      expect(ghExec).not.toHaveBeenCalled();
      expect(confirmPrompt(posted)).toBe(
        `<@${asker}> asked me to merge ${MARKETING_PR}. It still needs an approving review, so merging now uses admin rights. <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
      );
    },
  );

  it.each([
    ['a repo without a content policy', WEB_PR],
    ['a same-named repo in another org', 'https://github.com/Other-Org/newton-marketing-web/pull/1490'],
  ])('leaves %s exactly as it was', async (_case, url) => {
    const { posted } = await run('<@UBOT1> merge it', { pr: url });

    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBe(
      `<@UBUILDER> asked me to merge ${url}. It still needs an approving review, so merging now uses admin rights. <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
    );
  });

  it("leaves the owner's own merge as it was", async () => {
    const { posted } = await run('<@UBOT1> merge it', { byOwner: true });

    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(ghExec).not.toHaveBeenCalled();
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBeUndefined();
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it("merges an owner's re-run of a builder's ask on the builder's word", async () => {
    const { posted } = await run('<@UBOT1> merge it', { requestedFor: 'UBUILDER' });

    expect(ghExec).toHaveBeenCalledWith(mergeArgs('--admin'), 'ghs_test');
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(posted).toEqual([MERGED_PAST_REVIEW]);
  });

  it("asks for the owner's phrase on an owner's re-run of a viewer's ask", async () => {
    const { posted } = await run('<@UBOT1> merge it', { requestedFor: 'UVIEWER' });

    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toContain(`<@UVIEWER> asked me to merge ${MARKETING_PR}.`);
  });

  it('still refuses a PR with conflicts outright', async () => {
    vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'DIRTY', isDraft: false });

    const { posted, result } = await run('<@UBOT1> merge it');

    expect(posted).toEqual([
      `${MARKETING_PR} has conflicts with its base branch, so it can't be merged yet. Nothing was changed.`,
    ]);
    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(ghExec).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED');
  });

  it.each([
    [
      'unresolved review comments',
      () => vi.mocked(fetchUnresolvedReviewThreadCount).mockResolvedValue({ unresolvedCount: 1, totalThreads: 1 }),
    ],
    [
      'requested changes',
      () =>
        vi
          .mocked(fetchMergeState)
          .mockResolvedValue({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }),
    ],
    ['a draft', () => vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'DRAFT', isDraft: true })],
  ])(
    'asks the owner, before reading the diff, for a PR with %s, which the prompt already says',
    async (_case, arrange) => {
      arrange();

      const { posted, logs } = await run('<@UBOT1> merge it');

      expect(ghExec).not.toHaveBeenCalled();
      expect(checkContentOnlyPr).not.toHaveBeenCalled();
      expect(confirmPrompt(posted)).toBeDefined();
      expect(confirmPrompt(posted)).not.toContain('so an owner has to confirm');
      expect(logs.map(entry => entry.stage)).toContain('implementation.quick_action.content_check');
    },
  );

  it.each([
    [
      'review comments that could not be read',
      () =>
        vi
          .mocked(fetchUnresolvedReviewThreadCount)
          .mockResolvedValue({ unresolvedCount: 0, totalThreads: 0, failed: true }),
      "I couldn't read all of its review comments, so an owner has to confirm.",
    ],
    [
      'more review threads than were read',
      () =>
        vi
          .mocked(fetchUnresolvedReviewThreadCount)
          .mockResolvedValue({ unresolvedCount: 0, totalThreads: 140, incomplete: true }),
      "I couldn't read all of its review comments, so an owner has to confirm.",
    ],
    [
      'checks failing on a branch GitHub calls unstable',
      () => vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'UNSTABLE' }),
      "Some of its checks aren't passing, so an owner has to confirm.",
    ],
    [
      'a merge state GitHub has not worked out',
      () => vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'UNKNOWN' }),
      "I couldn't check branch protection. Without that, an owner has to confirm.",
    ],
    [
      'an unreadable merge state',
      () => vi.mocked(fetchMergeState).mockResolvedValue(undefined),
      "I couldn't check branch protection. Without that, an owner has to confirm.",
    ],
  ])('asks the owner, saying why, for a PR with %s', async (_case, arrange, reason) => {
    arrange();

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toContain(reason);
  });

  it.each([
    ['failing', 'FAILURE', 'Its checks are failing, so an owner has to confirm.'],
    ['erroring', 'ERROR', 'Its checks are failing, so an owner has to confirm.'],
    ['still running', 'PENDING', 'Its checks are still running, so an owner has to confirm.'],
    ['unreadable', undefined, "I couldn't read its checks, so an owner has to confirm."],
  ])('asks the owner, saying why, for a content-only PR whose checks are %s', async (_case, checks, reason) => {
    vi.mocked(fetchChecksState).mockResolvedValue(checks);

    const { posted } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toContain(reason);
  });

  it('does not skip the owner when the ask is more than the merge', async () => {
    const { logs } = await run('<@UBOT1> merge it once the copy is approved');

    expect(logs.map(entry => entry.stage)).not.toContain('implementation.quick_action.no_planner');
    expect(ghExec).not.toHaveBeenCalled();
    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm merge');
  });

  it('merges nothing once the run is cancelled, and hands the check the signal', async () => {
    const controller = new AbortController();
    vi.mocked(checkContentOnlyPr).mockImplementation(async () => {
      controller.abort();
      return { contentOnly: true, files: ['src/features/x/content.ts'], headSha: 'abc123', baseRef: 'main' };
    });

    const { result } = await run('<@UBOT1> merge it', { signal: controller.signal });

    expect(vi.mocked(checkContentOnlyPr).mock.calls[0][0].signal).toBe(controller.signal);
    expect(ghExec).not.toHaveBeenCalled();
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.status).toBe('CANCELLED');
  });

  describe('when gh fails', () => {
    const failMerge = (error: Error, view: () => Promise<string>) =>
      ghExec.mockReset().mockImplementation(async (args: string[]) => {
        if (args[1] === 'merge') throw error;
        return view();
      });

    it('says nothing was merged when gh refused and the PR is still open', async () => {
      failMerge(
        Object.assign(new Error('Command failed'), { stderr: 'GraphQL: Pull Request is not mergeable\n' }),
        async () => 'OPEN\n',
      );

      const { posted, result } = await run('<@UBOT1> merge it');

      expect(posted).toEqual([
        `I couldn't merge ${MARKETING_PR}: GraphQL: Pull Request is not mergeable. Nothing was merged.`,
      ]);
      expect(result.status).toBe('FAILED');
    });

    it('says someone pushed after the check when GitHub refuses the pinned commit', async () => {
      failMerge(
        Object.assign(new Error('Command failed'), {
          stderr: 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)\n',
        }),
        async () => 'OPEN\n',
      );

      const { posted, result } = await run('<@UBOT1> merge it');

      expect(posted).toEqual([
        "Someone pushed to it after I checked, so nothing was merged. Ask again and I'll re-check.",
      ]);
      expect(ghExec).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('SKIPPED');
    });

    it('says nothing was merged when gh is not installed, without asking it anything else', async () => {
      failMerge(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), async () => 'OPEN\n');

      const { posted } = await run('<@UBOT1> merge it');

      expect(ghExec).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([
        `I couldn't merge ${MARKETING_PR}: the GitHub command-line tool isn't available here. Nothing was merged.`,
      ]);
    });

    it("doesn't say nothing was merged when gh was killed for taking too long, even if the PR reads open", async () => {
      failMerge(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), async () => 'OPEN\n');

      const { posted, result } = await run('<@UBOT1> merge it');

      expect(posted).toEqual([
        `I couldn't tell whether ${MARKETING_PR} merged: the merge command timed out. Check the PR before asking again.`,
      ]);
      expect(result.status).toBe('FAILED');
    });

    it('reports the merge when gh fails after GitHub merged it', async () => {
      failMerge(Object.assign(new Error('Command failed'), { killed: true }), async () => 'MERGED\n');

      const { posted, result } = await run('<@UBOT1> merge it');

      expect(posted).toEqual([MERGED_PAST_REVIEW]);
      expect(result.status).toBe('SUCCESS');
    });

    it("doesn't claim nothing happened when it can't read the PR back", async () => {
      ghExec.mockReset().mockRejectedValue(new Error('Command failed: gh pr merge'));

      const { posted, result } = await run('<@UBOT1> merge it');

      expect(posted).toEqual([
        `I couldn't tell whether ${MARKETING_PR} merged: Command failed: gh pr merge. Check the PR before asking again.`,
      ]);
      expect(result.status).toBe('FAILED');
    });
  });
});

describe('contentOwnerReason', () => {
  it.each([
    [
      { kind: 'not_content', offending: ['src/lib/forms/x.ts'], fileCount: 1 },
      'It changes more than text (`src/lib/forms/x.ts`), so an owner has to confirm.',
    ],
    [
      { kind: 'not_content', offending: ['a.ts', 'b.ts'], fileCount: 2 },
      'It changes more than text (`a.ts`, `b.ts`), so an owner has to confirm.',
    ],
    [{ kind: 'too_many_files', fileCount: 34 }, 'It changes more than text (34 files), so an owner has to confirm.'],
    [{ kind: 'not_default_base' }, "It doesn't merge into the main branch, so an owner has to confirm."],
    [{ kind: 'unreadable' }, "I couldn't check that it only changes text, so an owner has to confirm."],
  ])('says %j in one sentence', (verdict, sentence) => {
    expect(contentOwnerReason({ contentOnly: false, reason: 'r', ...verdict } as never)).toBe(sentence);
  });
});
