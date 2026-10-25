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

async function run(text: string, options: { userId?: string; byOwner?: boolean; pr?: string } = {}) {
  const userId = options.byOwner ? 'UOWNER1' : (options.userId ?? 'UBUILDER');
  const pr = prOf(options.pr ?? MARKETING_PR);
  const slack = {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }) },
  };
  const logs: { stage: string; data?: Record<string, unknown> }[] = [];
  const task = {
    event: { eventId: 'EvMerge', channelId: 'C1', threadTs: '111.22', eventTs: '111.22', userId, text, rawEvent: {} },
    mentionDetected: true,
    mentionType: 'bot' as const,
    isOwnerAuthor: Boolean(options.byOwner),
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
  });
  const posted = slack.chat.postMessage.mock.calls.map(call => call[0].text as string);
  return { result, posted, logs };
}

const ghExec = vi.fn();

beforeEach(() => {
  vi.mocked(runCodex)
    .mockReset()
    .mockResolvedValue({ ok: true, exitCode: 0, parsedJson: { summary: 'Merged it.' } } as never);
  __quickActionConfirm.wait = vi.fn().mockResolvedValue({ outcome: 'confirmed', userId: 'UOWNER1' });
  ghExec.mockReset().mockResolvedValue('');
  __contentMergeGh.exec = ghExec;
  vi.mocked(fetchUnresolvedReviewThreadCount).mockReset().mockResolvedValue({ unresolvedCount: 0, totalThreads: 0 });
  vi.mocked(fetchMergeState)
    .mockReset()
    .mockResolvedValue({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', isDraft: false });
  vi.mocked(fetchChecksState).mockReset().mockResolvedValue(null);
  vi.mocked(checkContentOnlyPr)
    .mockReset()
    .mockResolvedValue({ contentOnly: true, files: ['src/features/agentic-ai-course/content.ts'], headSha: 'abc123' });
});
afterEach(() => vi.clearAllMocks());

const confirmPrompt = (posted: string[]) => posted.find(text => text.includes('confirm merge'));

describe('merging a content-only marketing PR (#701)', () => {
  it.each([
    ['a builder', 'UBUILDER'],
    ['an admin', 'UADMIN'],
  ])('merges on the word of %s, past the required review, with no owner and no agent', async (_who, userId) => {
    const { result, posted, logs } = await run('<@UBOT1> merge it', { userId });

    expect(ghExec).toHaveBeenCalledTimes(1);
    expect(ghExec).toHaveBeenCalledWith(
      [
        'pr',
        'merge',
        '1490',
        '--repo',
        'Newton-School/newton-marketing-web',
        '--squash',
        // Only the commit the check read: a later push makes GitHub refuse it.
        '--match-head-commit',
        'abc123',
        '--admin',
      ],
      'ghs_test',
    );
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
    expect(posted).toEqual([
      `Merged ${MARKETING_PR}: it only changes text, numbers and links. It isn't live yet; someone from core-dev has to deploy it.`,
    ]);
    const merge = logs.find(entry => entry.stage === 'implementation.quick_action.content_merge');
    expect(merge?.data).toMatchObject({
      requestedBy: userId,
      admin: true,
      files: ['src/features/agentic-ai-course/content.ts'],
    });
    expect(result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SUCCESS' });
  });

  it('merges without admin rights when nothing blocks the merge', async () => {
    vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'CLEAN', isDraft: false });

    await run('<@UBOT1> merge it');

    expect(ghExec.mock.calls[0][0]).not.toContain('--admin');
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

  it('asks the owner as before, with no reason, when the requester could not have asked for the change', async () => {
    const { posted } = await run('<@UBOT1> merge it', { userId: 'UVIEWER' });

    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(ghExec).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBe(
      `<@UVIEWER> asked me to merge ${MARKETING_PR}. It still needs an approving review, so merging now uses admin rights. <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
    );
  });

  it('leaves a repo without a content policy exactly as it was', async () => {
    const { posted } = await run('<@UBOT1> merge it', { pr: WEB_PR });

    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBe(
      `<@UBUILDER> asked me to merge ${WEB_PR}. It still needs an approving review, so merging now uses admin rights. <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
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
      'review comments that could not be read',
      () =>
        vi
          .mocked(fetchUnresolvedReviewThreadCount)
          .mockResolvedValue({ unresolvedCount: 0, totalThreads: 0, failed: true }),
    ],
    [
      'requested changes',
      () =>
        vi
          .mocked(fetchMergeState)
          .mockResolvedValue({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }),
    ],
    ['a draft', () => vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'DRAFT', isDraft: true })],
    [
      'a merge state GitHub has not worked out',
      () => vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'UNKNOWN' }),
    ],
    ['an unreadable merge state', () => vi.mocked(fetchMergeState).mockResolvedValue(undefined)],
    ['failing checks', () => vi.mocked(fetchChecksState).mockResolvedValue('FAILURE')],
    ['checks still running', () => vi.mocked(fetchChecksState).mockResolvedValue('PENDING')],
    ['checks that could not be read', () => vi.mocked(fetchChecksState).mockResolvedValue(undefined)],
  ])('asks the owner for a content-only PR with %s', async (_case, arrange) => {
    arrange();

    const { posted, logs } = await run('<@UBOT1> merge it');

    expect(ghExec).not.toHaveBeenCalled();
    expect(checkContentOnlyPr).not.toHaveBeenCalled();
    expect(confirmPrompt(posted)).toBeDefined();
    expect(confirmPrompt(posted)).not.toContain('so an owner has to confirm');
    expect(logs.map(entry => entry.stage)).toContain('implementation.quick_action.content_check');
  });

  it('does not skip the owner when the ask is more than the merge', async () => {
    const { logs } = await run('<@UBOT1> merge it once the copy is approved');

    expect(logs.map(entry => entry.stage)).not.toContain('implementation.quick_action.no_planner');
    expect(ghExec).not.toHaveBeenCalled();
    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm merge');
  });

  it('says nothing was merged when gh fails and the PR is still open', async () => {
    ghExec.mockReset().mockImplementation(async (args: string[]) => {
      if (args[1] === 'merge')
        throw Object.assign(new Error('Command failed'), { stderr: 'GraphQL: Base branch was modified\n' });
      return 'OPEN\n';
    });

    const { posted, result } = await run('<@UBOT1> merge it');

    expect(posted).toEqual([
      `I couldn't merge ${MARKETING_PR}: GraphQL: Base branch was modified. Nothing was merged.`,
    ]);
    expect(result.status).toBe('FAILED');
  });

  it('reports the merge when gh fails after GitHub merged it', async () => {
    ghExec.mockReset().mockImplementation(async (args: string[]) => {
      if (args[1] === 'merge') throw new Error('Command timed out');
      return 'MERGED\n';
    });

    const { posted, result } = await run('<@UBOT1> merge it');

    expect(posted[0]).toMatch(/^Merged /);
    expect(result.status).toBe('SUCCESS');
  });

  it("doesn't claim nothing happened when it can't tell", async () => {
    ghExec.mockReset().mockRejectedValue(new Error('Command timed out'));

    const { posted, result } = await run('<@UBOT1> merge it');

    expect(posted).toEqual([
      `I couldn't tell whether ${MARKETING_PR} merged: Command timed out. Check the PR before asking again.`,
    ]);
    expect(result.status).toBe('FAILED');
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
    [{ kind: 'unreadable' }, "I couldn't check that it only changes text, so an owner has to confirm."],
  ])('says %j in one sentence', (verdict, sentence) => {
    expect(contentOwnerReason({ contentOnly: false, reason: 'r', ...verdict } as never)).toBe(sentence);
  });
});
