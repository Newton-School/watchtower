import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImplementationWorkflow } from '../src/workflows/implementationWorkflow.js';
import { getActiveBackendId, runCodex } from '../src/codex/runCodex.js';
import { waitForClarificationWithIdle } from '../src/workflows/shared/clarificationGuards.js';
import { claudeCodeBackend, claudePermissionMode } from '../src/backends/claudeCodeBackend.js';
import type { CodexRunRequest } from '../src/types/contracts.js';

// Issue #695: the planner's follow-up after a clarifying answer ran with every
// permission bypassed, before anyone had approved a change.

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
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
    users: { info: vi.fn().mockResolvedValue({ user: { profile: { display_name: 'Test' } } }) },
  };
}

function plannerAsks(question: string, backend: 'codex' | 'claude-code') {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '',
    sessionId: 'sess-1',
    parsedJson:
      backend === 'claude-code'
        ? { planMarkdown: '## Plan\n- find the target', clarificationNeeded: question }
        : {
            plan: ['Figure out the target'],
            affectedFiles: [],
            scope: 'small',
            requiresCodeChanges: true,
            clarificationNeeded: question,
          },
  };
}

async function runWithOneAnswer() {
  // Round 1 asks, the follow-up asks again, and the second wait is cancelled
  // so the run ends without reaching the coder.
  vi.mocked(waitForClarificationWithIdle)
    .mockResolvedValueOnce({ outcome: 'answered', answer: 'newton-web', answererId: 'UBUILDER' })
    .mockResolvedValueOnce({ outcome: 'cancelled' });
  const result = await runImplementationWorkflow({
    task: {
      event: {
        eventId: 'Ev695',
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
    slack: makeSlack() as unknown as import('@slack/web-api').WebClient,
  });
  const calls = vi.mocked(runCodex).mock.calls.map(([request]) => request as CodexRunRequest);
  return { result, calls };
}

describe('planner calls never run with permissions bypassed (#695)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(waitForClarificationWithIdle).mockReset();
  });

  it('runs the follow-up after a clarifying answer read-only (codex planner)', async () => {
    vi.mocked(getActiveBackendId).mockReturnValue('codex');
    vi.mocked(runCodex)
      .mockResolvedValueOnce(plannerAsks('Which repo?', 'codex'))
      .mockResolvedValueOnce(plannerAsks('Which page?', 'codex'));

    const { result, calls } = await runWithOneAnswer();

    expect(result.status).toBe('CANCELLED');
    expect(calls).toHaveLength(2);
    const [first, followUp] = calls;
    expect(first.readOnly).toBe(true);
    expect(followUp.prompt).toContain('newton-web');
    expect(followUp.readOnly).toBe(true);
    expect(claudePermissionMode(followUp)).toBe('read-only');
  });

  it('keeps plan mode for the first call and runs the resumed follow-up read-only (claude-code planner)', async () => {
    vi.mocked(getActiveBackendId).mockReturnValue('claude-code');
    vi.mocked(runCodex)
      .mockResolvedValueOnce(plannerAsks('Which repo?', 'claude-code'))
      .mockResolvedValueOnce(plannerAsks('Which page?', 'claude-code'));

    const { calls } = await runWithOneAnswer();

    expect(calls).toHaveLength(2);
    const [first, followUp] = calls;
    expect(claudePermissionMode(first)).toBe('plan');
    expect(followUp.resumeSessionId).toBe('sess-1');
    expect(claudePermissionMode(followUp)).toBe('read-only');

    const args = claudeCodeBackend.buildArgs(followUp, '/tmp/out/final.txt');
    expect(args).toContain('--resume');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });
});

describe('a follow-up plan without a code-changes verdict goes to approval, not to a quick action (#695)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(waitForClarificationWithIdle).mockReset();
  });

  async function runUntilApproval(followUp: Record<string, unknown>) {
    vi.mocked(waitForClarificationWithIdle).mockResolvedValueOnce({
      outcome: 'answered',
      answer: 'the pricing page',
      answererId: 'UBUILDER',
    });
    vi.mocked(runCodex)
      .mockResolvedValueOnce(plannerAsks('Which page?', 'claude-code'))
      .mockResolvedValueOnce(followUp as never);
    const controller = new AbortController();
    const stages: string[] = [];
    const result = await runImplementationWorkflow({
      task: {
        event: {
          eventId: 'Ev695b',
          channelId: 'C1',
          threadTs: '111.33',
          eventTs: '111.33',
          userId: 'UBUILDER',
          text: '<@UBOT1> change the price text',
          rawEvent: {},
        },
        mentionDetected: true,
        mentionType: 'bot' as const,
        isOwnerAuthor: false,
        isCoreDevAuthor: false,
        intent: 'IMPLEMENTATION' as const,
      },
      config,
      slack: makeSlack() as unknown as import('@slack/web-api').WebClient,
      signal: controller.signal,
      logStep: entry => {
        stages.push(entry.stage);
        // The plan is up for approval: that is all this test needs to see.
        if (entry.stage === 'implementation.approval.waiting') controller.abort();
      },
    });
    const calls = vi.mocked(runCodex).mock.calls.map(([request]) => request as CodexRunRequest);
    return { result, stages, calls };
  }

  it('asks Claude Code for a markdown plan and sends the markdown it returns to approval', async () => {
    vi.mocked(getActiveBackendId).mockReturnValue('claude-code');
    const { stages, calls } = await runUntilApproval({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      sessionId: 'sess-1',
      // What the Claude Code backend returns for a markdown final message.
      parsedJson: {
        status: 'success',
        summary: '## Files to change\n- `src/pricing.tsx`\n\n1. Change the price text.\n\nScope: small',
        actions: [],
        prUrl: '',
      },
    });

    expect(calls[1].prompt).toContain('Reply with the complete plan as markdown');
    expect(calls[1].outputSchemaPath).toBeUndefined();
    expect(stages).not.toContain('implementation.quick_action');
    expect(stages).toContain('implementation.approval.waiting');
  });

  it('treats JSON without requiresCodeChanges as a change', async () => {
    vi.mocked(getActiveBackendId).mockReturnValue('claude-code');
    const { stages } = await runUntilApproval({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      sessionId: 'sess-1',
      parsedJson: { planMarkdown: '## Plan\n- change the price text in `src/pricing.tsx`', clarificationNeeded: null },
    });

    expect(stages).not.toContain('implementation.quick_action');
    expect(stages).toContain('implementation.approval.waiting');
  });

  it('keeps the earlier plan for approval when the follow-up returns nothing readable', async () => {
    vi.mocked(getActiveBackendId).mockReturnValue('claude-code');
    const { stages } = await runUntilApproval({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'boom',
      lastMessage: '',
    });

    expect(stages).toContain('implementation.planner.clarification.unreadable');
    expect(stages).not.toContain('implementation.quick_action');
    expect(stages).toContain('implementation.approval.waiting');
  });
});

describe('claudePermissionMode', () => {
  it('follows the order buildArgs applies', () => {
    expect(claudePermissionMode({ noTools: true, planMode: true, readOnly: true })).toBe('no-tools');
    expect(claudePermissionMode({ planMode: true, readOnly: true })).toBe('plan');
    expect(claudePermissionMode({ readOnly: true })).toBe('read-only');
    expect(claudePermissionMode({})).toBe('bypass');
  });
});
