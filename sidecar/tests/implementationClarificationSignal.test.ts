import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImplementationWorkflow } from '../src/workflows/implementationWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { waitForClarificationWithIdle } from '../src/workflows/shared/clarificationGuards.js';

// Regression coverage for the zombie-resume bug (#348 RC3): the implementation
// workflow's clarification waits must receive the job's abort signal, so
// cancelJob() actually terminates a parked job instead of leaving it alive to
// resume on a later thread reply against an already-aborted signal.

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/workflows/shared/clarificationGuards.js', () => ({
  waitForClarificationWithIdle: vi.fn(),
  detectClarificationLoop: vi.fn().mockReturnValue({ looping: false }),
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
  coreDevSlackUserGroup: '',
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
  multiAgentEnabled: true,
  bugFixTimeoutMs: 2700000,
};

function makeSlack() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
    },
    users: {
      info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }),
    },
  };
}

describe('implementationWorkflow — clarification wait receives the abort signal (#348 RC3)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(waitForClarificationWithIdle).mockReset();
  });

  it('passes the job abort signal into waitForClarificationWithIdle', async () => {
    // Planner asks a clarifying question → workflow enters the clarification
    // loop and waits. The wait must be cancellable via the job's signal.
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        plan: ['Figure out the target'],
        affectedFiles: [],
        scope: 'small',
        requiresCodeChanges: true,
        clarificationNeeded: 'Which repo do you mean — newton-web or newton-api?',
      },
    });
    // The wait resolves as cancelled so the loop exits cleanly.
    vi.mocked(waitForClarificationWithIdle).mockResolvedValue({ outcome: 'cancelled' });

    const controller = new AbortController();
    const slack = makeSlack();

    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'EvSig',
          channelId: 'C1',
          threadTs: '111.22',
          eventTs: '111.22',
          userId: 'UBUILDER',
          text: '<@UBOT1> change the thing',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot' as const,
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'IMPLEMENTATION' as const,
      },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      signal: controller.signal,
    });

    expect(waitForClarificationWithIdle).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(result.status).toBe('CANCELLED');
  });
});
