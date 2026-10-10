import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __quickActionConfirm,
  QUICK_ACTION_APPROVE_REFUSAL,
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

const PR_URL = 'https://github.com/Newton-School/newton-web/pull/9300';

function makeTask(text: string, options: { byOwner?: boolean; withPr?: boolean } = {}) {
  const prContext = { url: PR_URL, owner: 'Newton-School', repo: 'newton-web', number: 9300 };
  return {
    event: {
      eventId: 'EvNoCode',
      channelId: 'C1',
      threadTs: '111.22',
      eventTs: '111.22',
      userId: options.byOwner ? 'UOWNER1' : 'UBUILDER',
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot' as const,
    isOwnerAuthor: Boolean(options.byOwner),
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION' as const,
    ...(options.withPr ? { prContext } : {}),
  };
}

// Merge / close / revert asked by someone other than the owner now wait for
// the owner's confirmation (issue #429). Default to "the owner confirmed" so
// suites about what happens afterwards keep exercising it.
beforeEach(() => {
  __quickActionConfirm.wait = vi.fn().mockResolvedValue({ outcome: 'confirmed', userId: 'UOWNER1' });
});

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

describe('implementationWorkflow — quick-action merge needs the owner (#429)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset().mockResolvedValue(plannerNoCodeResult());
    vi.mocked(runAgenticEntry).mockReset();
  });

  async function run(text: string, options: { byOwner?: boolean; withPr?: boolean } = {}, overrides = {}) {
    const slack = makeSlack();
    const logs: { stage: string; data?: Record<string, unknown> }[] = [];
    const result = await runImplementationWorkflow({
      task: makeTask(text, options),
      config: { ...config, ...overrides },
      slack: slack as unknown as import('@slack/web-api').WebClient,
      logStep: entry => logs.push(entry),
    });
    const posted = slack.chat.postMessage.mock.calls.map(call => call[0].text as string);
    return { result, posted, logs };
  }

  const outcome = (value: string) => {
    __quickActionConfirm.wait = vi.fn().mockResolvedValue({ outcome: value });
  };

  it('asks the owner, by exact phrase, before merging for someone else', async () => {
    const { posted, logs } = await run(`<@UBOT1> merge ${PR_URL}`, { withPr: true });

    const prompt = posted.find(text => text.includes('confirm merge'));
    expect(prompt).toContain('<@UBUILDER> asked me to merge');
    expect(prompt).toContain(PR_URL);
    expect(prompt).toContain('<@UOWNER1>, reply `confirm merge` within 10 minutes');
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTs: '123.45',
        phrase: 'confirm merge',
        allowedUserIds: ['UOWNER1'],
        stagePrefix: 'implementation.quick_action.confirm',
      }),
    );
    // Confirmed: the quick action runs, and the run is auditable.
    expect(runCodex).toHaveBeenCalledTimes(2);
    const audit = logs.find(entry => entry.stage === 'implementation.quick_action.pr_action');
    expect(audit?.data).toEqual({ action: 'merge', prUrls: [PR_URL], requestedBy: 'UBUILDER', confirmedBy: 'UOWNER1' });
  });

  it('does not let the requester, or any other admin, be the one who confirms', async () => {
    await run(
      `<@UBOT1> merge ${PR_URL}`,
      { withPr: true },
      { coreDevSlackUserIds: ['UOWNER1', 'UBUILDER', 'UADMIN2'] },
    );
    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].allowedUserIds).toEqual(['UOWNER1']);
  });

  it.each([
    ['expired', 'SKIPPED', 'so nothing was changed'],
    ['declined', 'SKIPPED', 'Okay, leaving it as it is.'],
    ['cancelled', 'CANCELLED', 'Stopped before the merge was confirmed.'],
  ])('runs no agent when the confirmation is %s', async (value, status, message) => {
    outcome(value);
    const { result } = await run(`<@UBOT1> merge ${PR_URL}`, { withPr: true });

    expect(runCodex).toHaveBeenCalledTimes(1); // the planner only
    expect(result.status).toBe(status);
    expect(result.message).toContain(message);
  });

  it('uses the action in the phrase for close and revert', async () => {
    await run('<@UBOT1> close this PR', { withPr: true });
    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm close');

    await run('<@UBOT1> revert this PR', { withPr: true });
    expect(vi.mocked(__quickActionConfirm.wait).mock.lastCall?.[0].phrase).toBe('confirm revert');
  });

  it("runs the owner's own merge without asking the owner to confirm", async () => {
    const { logs } = await run(`<@UBOT1> merge ${PR_URL}`, { byOwner: true, withPr: true });

    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(2);
    const audit = logs.find(entry => entry.stage === 'implementation.quick_action.pr_action');
    expect(audit?.data).toMatchObject({ requestedBy: 'UOWNER1', confirmedBy: 'UOWNER1' });
  });

  it('refuses when no owner is configured to confirm', async () => {
    const { result } = await run(`<@UBOT1> merge ${PR_URL}`, { withPr: true }, { ownerSlackUserIds: [] });

    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('no owner configured');
  });

  it('declines an approve-only ask without running an agent', async () => {
    const { result, posted } = await run('<@UBOT1> approve this PR', { withPr: true });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED');
    expect(posted).toContain(QUICK_ACTION_APPROVE_REFUSAL);
  });

  it('never lets the agent approve, and limits it to the named pull requests', async () => {
    await run(`<@UBOT1> approve and merge ${PR_URL}`, { withPr: true });

    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm merge');
    const quickPrompt = vi.mocked(runCodex).mock.calls[1][0].prompt;
    expect(quickPrompt).toContain('Never submit an approving review');
    expect(quickPrompt).toContain(`Pull requests you may act on: ${PR_URL}.`);
    expect(quickPrompt).toContain('Do not merge, close or revert any other pull request.');
  });

  it('leaves other quick operations, such as re-running tests, unconfirmed', async () => {
    await run('<@UBOT1> rerun the tests');
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(2);
  });
});
