import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runImplementationWorkflow } from '../src/workflows/implementationWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { __followUpDeps } from '../src/workflows/shared/followUpPr.js';

// Issue #730, at the workflow: a change asked in a thread whose earlier change
// run left an open PR is planned as a follow-up on it, and two open PRs get a
// question before any planner runs.

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
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));
vi.mock('../src/notify/desktopNotifier.js', () => ({ notifyDesktop: vi.fn() }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
  refreshSharedRepoToDefaultBranch: vi.fn(async () => null),
}));
vi.mock('../src/backends/registry.js', () => ({
  getBackend: vi.fn().mockReturnValue({ supportsImages: () => false }),
}));
vi.mock('../src/slack/threadAttachments.js', () => ({
  collectThreadAttachments: vi.fn(async () => ({ imagePaths: [], documentContext: '', unreadableNote: '' })),
}));
vi.mock('../src/router/repoClassifier.js', () => ({
  classifyRepo: vi.fn().mockReturnValue({ selectedRepo: 'newton-web', confidence: 0.9, uncertain: false }),
}));

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
  repoPaths: { newtonWeb: '/Users/dipesh/code/newton-web', newtonApi: '/Users/dipesh/code/newton-api' },
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: true,
  bugFixTimeoutMs: 2700000,
};

const PR1 = 'https://github.com/Newton-School/newton-web/pull/9300';
const PR2 = 'https://github.com/Newton-School/newton-web/pull/9301';

const task = {
  event: {
    eventId: 'EvFollow',
    channelId: 'C1',
    threadTs: '111.22',
    eventTs: '111.30',
    userId: 'UBUILDER',
    text: '<@UBOT1> also change the footer heading to "Talk to us"',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot' as const,
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION' as const,
};

function makeSlack() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }) },
  };
}

const plannerNoCode = {
  ok: true,
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  lastMessage: '',
  parsedJson: {
    plan: ['Answer'],
    affectedFiles: [],
    scope: 'small',
    requiresCodeChanges: false,
    clarificationNeeded: null,
  },
};

describe('a change asked in a thread with an earlier change run PR (issue #730)', () => {
  const realView = __followUpDeps.viewPr;
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValue(plannerNoCode);
    vi.mocked(runAgenticEntry).mockReset();
    vi.mocked(runAgenticEntry).mockResolvedValue({
      workflow: 'INFORMATIONAL',
      status: 'SUCCESS',
      message: 'answered',
      notifyDesktop: false,
      slackPosted: true,
    });
  });
  afterEach(() => {
    __followUpDeps.viewPr = realView;
  });

  const run = (urls: string[], logStep = vi.fn(), slack = makeSlack()) =>
    runImplementationWorkflow({
      task,
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      store: { changeRunPrUrlsInThread: vi.fn(() => urls) } as never,
      logStep,
    });

  it('tells the planner it is a follow-up on the open PR, on top of its branch', async () => {
    __followUpDeps.viewPr = vi.fn(async () => ({
      state: 'OPEN',
      headRefName: 'pm/hero-111-22',
      isCrossRepository: false,
      files: [{ path: 'src/hero.tsx' }],
    }));
    const logStep = vi.fn();
    await run([PR1], logStep);

    const plannerPrompt = vi.mocked(runCodex).mock.calls[0][0].prompt;
    expect(plannerPrompt).toContain('=== FOLLOW-UP ON AN OPEN PULL REQUEST ===');
    expect(plannerPrompt).toContain(`opened ${PR1} (Newton-School/newton-web, branch \`pm/hero-111-22\`)`);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'implementation.followup.detected',
        data: { prUrl: PR1, branch: 'pm/hero-111-22' },
      }),
    );
  });

  it('asks which PR when two are open, before any planner runs', async () => {
    __followUpDeps.viewPr = vi.fn(async () => ({ state: 'OPEN', headRefName: 'b', isCrossRepository: false }));
    const slack = makeSlack();
    const result = await run([PR2, PR1], vi.fn(), slack);

    expect(result.status).toBe('SKIPPED');
    expect(runCodex).not.toHaveBeenCalled();
    expect((slack.chat.postMessage.mock.calls[0][0] as { text: string }).text).toBe(
      `This thread has 2 open pull requests I made: <${PR2}>, <${PR1}>. Mention me again with the link of the one this change belongs to, so I add it there.`,
    );
  });

  it('plans normally, and notes why, when the earlier PR is already merged', async () => {
    __followUpDeps.viewPr = vi.fn(async () => ({ state: 'MERGED', headRefName: 'pm/hero-111-22' }));
    const logStep = vi.fn();
    await run([PR1], logStep);

    expect(vi.mocked(runCodex).mock.calls[0][0].prompt).not.toContain('FOLLOW-UP ON AN OPEN PULL REQUEST');
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'implementation.followup.fallback',
        data: { prUrl: PR1, reason: 'merged' },
      }),
    );
  });

  it('plans normally in a thread with no earlier change run PR', async () => {
    const view = vi.fn();
    __followUpDeps.viewPr = view;
    await run([]);
    expect(view).not.toHaveBeenCalled();
    expect(vi.mocked(runCodex).mock.calls[0][0].prompt).not.toContain('FOLLOW-UP');
  });
});
