import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImplementationWorkflow } from '../src/workflows/implementationWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn().mockResolvedValue([]),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
}));

vi.mock('../src/slack/imageDownloader.js', () => ({
  downloadSlackImages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/backends/registry.js', () => ({
  getBackend: vi.fn().mockReturnValue({ supportsImages: () => false }),
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
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
  unknownTaskPolicy: 'desktop_only' as const,
  uncertainRepoPolicy: 'desktop_only' as const,
  unmappedPrRepoPolicy: 'desktop_only' as const,
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

describe('implementationWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
  });

  it('runs codex for implementation requests', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Done. Applied a chaotic but safe tweak as requested.',
        actions: ['Applied tweak'],
        prUrl: '',
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }),
      },
    };

    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'EvOwner0',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> do something cursed with my laptop',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        isCoreDevAuthor: true,
        intent: 'IMPLEMENTATION',
      },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.workflow).toBe('IMPLEMENTATION');
    expect(result.message).toContain('Applied a chaotic but safe tweak');
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('strips legacy success prefix and posts clean human summary', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'success',
        summary: 'Owner request success. Merged PR #7638 into master using squash merge.',
        actions: ['Merged PR #7638'],
        prUrl: 'https://github.com/Newton-School/newton-web/pull/7638',
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }),
      },
    };

    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'EvOwner2',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> merge this',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        isCoreDevAuthor: true,
        intent: 'IMPLEMENTATION',
      },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Merged PR #7638 into master using squash merge.');
    expect(result.message).not.toContain('Owner request success');
  });

  it('returns paused with human retry prompt when codex fails', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'fatal',
      lastMessage: '',
      parsedJson: undefined,
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }),
      },
    };

    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'EvOwner3',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> merge PR #123 in newton-web',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        isCoreDevAuthor: true,
        intent: 'IMPLEMENTATION',
      },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    expect(result.status).toBe('PAUSED');
    expect(result.message).toContain('I hit an execution issue right now');
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it('uses primary plain-text output without a relaxed retry', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Tagged the people who were already mentioned in that PR review thread.',
      parsedJson: undefined,
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }),
      },
    };

    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'EvOwnerPlainText',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> follow up in the existing PR review thread',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        isCoreDevAuthor: true,
        intent: 'IMPLEMENTATION',
      },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Tagged the people');
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('falls back to relaxed plain-text mode when strict JSON output fails', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'schema mismatch',
        lastMessage: '',
        parsedJson: undefined,
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: 'Created local repository `testing-mini-og` in /Users/dipesh/code.',
        parsedJson: undefined,
      });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      users: {
        info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }),
      },
    };

    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'EvOwner4',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UOWNER1',
          text: '<@UBOT1> create a testing-mini-og repo inside code folder on my machine',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot',
        isOwnerAuthor: true,
        isCoreDevAuthor: true,
        intent: 'IMPLEMENTATION',
      },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Created local repository');
    expect(runCodex).toHaveBeenCalledTimes(2);
  });
});
