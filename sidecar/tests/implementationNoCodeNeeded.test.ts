import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUICK_ACTION_DEPLOY_REDIRECT,
  QUICK_ACTION_DEPLOY_RE,
  runImplementationWorkflow,
} from '../src/workflows/implementationWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';

// Regression coverage for #348 RC2: when the planner concludes no code changes
// are needed AND the request is not an operational action, the implementation
// workflow must answer the question via the read-only INFORMATIONAL path
// (runAgenticEntry) instead of running the coder / emitting a bug-fix prompt.

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/agentic/agenticEntry.js', () => ({
  runAgenticEntry: vi.fn(),
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
  // The no-code branch lives inside the multi-agent planner path.
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

function makeTask(text: string) {
  return {
    event: {
      eventId: 'EvNoCode',
      channelId: 'C1',
      threadTs: '111.22',
      eventTs: '111.22',
      userId: 'UBUILDER',
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot' as const,
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION' as const,
  };
}

// Planner verdict: no code changes needed (the codex backend reads
// requiresCodeChanges straight off parsedJson).
function plannerNoCodeResult() {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '',
    parsedJson: {
      plan: ['Summarize the tracking changes and rules'],
      affectedFiles: [],
      scope: 'small',
      requiresCodeChanges: false,
      clarificationNeeded: null,
    },
  };
}

describe('implementationWorkflow — no code needed (#348 RC2)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runAgenticEntry).mockReset();
    vi.mocked(runAgenticEntry).mockResolvedValue({
      workflow: 'INFORMATIONAL',
      status: 'SUCCESS',
      message: 'here is what changed',
      notifyDesktop: false,
      slackPosted: true,
    });
  });

  it('answers an informational ask via the INFORMATIONAL path instead of running the coder', async () => {
    vi.mocked(runCodex).mockResolvedValue(plannerNoCodeResult());
    const slack = makeSlack();

    const result = await runImplementationWorkflow({
      task: makeTask('<@UBOT1> check PR #8666 and tell me what changed and the rules'),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    // Handed off to the read-only answer path...
    expect(runAgenticEntry).toHaveBeenCalledTimes(1);
    expect(runAgenticEntry).toHaveBeenCalledWith(expect.objectContaining({ mode: 'informational' }));
    // ...and the coder/quick-action codex never ran (only the planner call).
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.workflow).toBe('INFORMATIONAL');
    expect(result.status).toBe('SUCCESS');
  });

  it('still routes a genuine operational action (merge) through the quick-action path, not informational', async () => {
    vi.mocked(runCodex).mockResolvedValue(plannerNoCodeResult());
    const slack = makeSlack();

    const result = await runImplementationWorkflow({
      task: makeTask('<@UBOT1> merge this PR'),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });

    expect(runAgenticEntry).not.toHaveBeenCalled();
    // planner + quick-action codex call.
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(result.workflow).toBe('IMPLEMENTATION');
  });
});

describe('implementationWorkflow — quick action never deploys (#407)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset().mockResolvedValue(plannerNoCodeResult());
    vi.mocked(runAgenticEntry).mockReset();
  });

  async function run(text: string) {
    const slack = makeSlack();
    const result = await runImplementationWorkflow({
      task: makeTask(text),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });
    return { result, slack };
  }

  it.each([
    '<@UBOT1> release the NSAT results page fix',
    '<@UBOT1> ship it',
    '<@UBOT1> deploy this',
    '<@UBOT1> roll back the last change',
    '<@UBOT1> rollback prod',
    '<@UBOT1> push this to production',
  ])('redirects %s to the deploy command instead of running an agent', async text => {
    const { result, slack } = await run(text);

    // Only the planner ran: no quick-action agent, no informational agent.
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED');
    expect(result.message).toBe(QUICK_ACTION_DEPLOY_REDIRECT);
    const posted = slack.chat.postMessage.mock.calls.map(call => call[0].text);
    expect(posted).toContain(QUICK_ACTION_DEPLOY_REDIRECT);
    expect(QUICK_ACTION_DEPLOY_REDIRECT).toContain('deploy newton-web to prod');
  });

  it('keeps the other operation in a mixed ask, and tells the agent never to deploy', async () => {
    const { result } = await run('<@UBOT1> merge this PR and deploy it');

    expect(runCodex).toHaveBeenCalledTimes(2);
    const quickPrompt = vi.mocked(runCodex).mock.calls[1][0].prompt;
    expect(quickPrompt).toContain('Never deploy, release, ship or roll back anything');
    expect(quickPrompt).not.toContain('(merge PR, deploy,');
    expect(result.workflow).toBe('IMPLEMENTATION');
  });

  it('carries the same guardrail on a plain merge', async () => {
    await run('<@UBOT1> merge this PR');
    expect(vi.mocked(runCodex).mock.calls[1][0].prompt).toContain('never run a deploy command, script or skill');
  });

  it('does not treat words that merely contain a deploy verb as a deploy ask', () => {
    expect(QUICK_ACTION_DEPLOY_RE.test('check the relationship table and the shipment page')).toBe(false);
    expect(QUICK_ACTION_DEPLOY_RE.test('redeployment notes')).toBe(false);
  });
});
