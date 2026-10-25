import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __quickActionConfirm,
  QUICK_ACTION_APPROVE_REFUSAL,
  QUICK_ACTION_DEPLOY_REDIRECT,
  QUICK_ACTION_DEPLOY_RE,
  plannerFailureReply,
  runImplementationWorkflow,
} from '../src/workflows/implementationWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { __infraRetry, connectionLostReply } from '../src/codex/infraRetry.js';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { refreshSharedRepoToDefaultBranch } from '../src/workspaces/workspaceManager.js';
import { __connectors, currentConnectors } from '../src/backends/connectors.js';
import { collectThreadAttachments } from '../src/slack/threadAttachments.js';
import { resolveGithubTokenForCodex } from '../src/github/githubAuth.js';
import { fetchMergeState, fetchUnresolvedReviewThreadCount } from '../src/github/prReviewComments.js';

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

// What GitHub says about a merge: nothing in the way, unless a test says otherwise.
vi.mock('../src/github/prReviewComments.js', () => ({
  fetchUnresolvedReviewThreadCount: vi.fn(async () => ({ unresolvedCount: 0, totalThreads: 0 })),
  fetchMergeState: vi.fn(async () => ({ mergeStateStatus: 'CLEAN', isDraft: false })),
}));

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn((repoPath: string) => repoPath),
  refreshSharedRepoToDefaultBranch: vi.fn(async () => null),
}));

vi.mock('../src/slack/imageDownloader.js', () => ({
  downloadSlackImages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/backends/registry.js', () => ({
  getBackend: vi.fn().mockReturnValue({ supportsImages: () => false }),
}));

// The thread's attachments: none, unless a test says otherwise (issue #595).
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

// Issue #443: every agent used to get every connector the host user has. A
// code change now names what it keeps, by who asked.
describe('implementationWorkflow — connectors by requester', () => {
  let home: string;
  const realHome = __connectors.home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-impl-connectors-'));
    __connectors.home = () => home;
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          figma: { type: 'http', url: 'https://figma.example/mcp' },
          openpanel: { type: 'http', url: 'https://openpanel.example/mcp' },
        },
      }),
    );
    const installPath = path.join(home, 'plugins', 'newton-admin-mcp');
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'newton-admin': { command: 'uvx', args: ['serve'] } } }),
    );
    fs.writeFileSync(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'newton-admin-mcp@newton-plugins': [{ installPath }] } }),
    );
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
    __connectors.home = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const plannerConnectors = async (byOwner: boolean): Promise<string[]> => {
    let seen: string[] = [];
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockImplementation(async () => {
      seen = Object.keys(currentConnectors().mcpServers);
      return plannerNoCodeResult();
    });
    await runImplementationWorkflow({
      task: makeTask('<@UBOT1> match the banner to the new design', { byOwner }),
      config,
      slack: makeSlack() as unknown as import('@slack/web-api').WebClient,
    });
    return seen;
  };

  it('gives a builder Figma and nothing else', async () => {
    expect(await plannerConnectors(false)).toEqual(['figma']);
  });

  it('adds the admin upload server for an admin', async () => {
    expect(await plannerConnectors(true)).toEqual(['figma', 'plugin_newton-admin-mcp_newton-admin']);
  });
});

// Issue #446: an owner's request plans from the shared clones. A planner told
// nothing about a clone 700 commits behind described code that had changed.
describe('implementationWorkflow — a planner on the shared clones', () => {
  beforeEach(() => {
    vi.mocked(runAgenticEntry).mockReset();
    vi.mocked(runAgenticEntry).mockResolvedValue({
      workflow: 'INFORMATIONAL',
      status: 'SUCCESS',
      message: 'answered',
      notifyDesktop: false,
      slackPosted: true,
    });
  });

  it('is told which clone is behind origin and to read origin instead', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockImplementation(async (repoPath: string) =>
      repoPath.endsWith('newton-web')
        ? { branch: 'master', head: 'eae5d68bb', upstream: 'origin/master', behind: 731, staleReason: 'dirty_tree' }
        : { branch: 'master', head: 'ac56c6935', upstream: 'origin/master', behind: 0 },
    );
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValue(plannerNoCodeResult());

    await runImplementationWorkflow({
      task: makeTask('<@UBOT1> add a retry to the playlist fetch', { byOwner: true }),
      config,
      slack: makeSlack() as unknown as import('@slack/web-api').WebClient,
    });

    const plannerPrompt = vi.mocked(runCodex).mock.calls[0][0].prompt;
    expect(plannerPrompt).toContain('newton-web');
    expect(plannerPrompt).toContain('origin/master');
    expect(plannerPrompt).toMatch(/STALE/);
  });
});

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

  it("hands the thread's screenshots and PDFs to the planner (issue #595)", async () => {
    // A plan written without the attached PDF assumed an old one, and it shipped to production.
    vi.mocked(collectThreadAttachments).mockResolvedValueOnce({
      imagePaths: ['/tmp/slack-files/F1-report.pdf', '/tmp/slack-files/F2-screen.png'],
      documentContext: '',
      unreadableNote: '',
    } as never);
    vi.mocked(runCodex).mockResolvedValue(plannerNoCodeResult());

    await runImplementationWorkflow({
      task: makeTask('<@UBOT1> add the banner using the attached report'),
      config,
      slack: makeSlack() as unknown as import('@slack/web-api').WebClient,
    });

    expect(vi.mocked(runCodex).mock.calls[0][0].imagePaths).toEqual([
      '/tmp/slack-files/F1-report.pdf',
      '/tmp/slack-files/F2-screen.png',
    ]);
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
      // Not one of the gate's sentences, so the planner reads it first (#719).
      task: makeTask('<@UBOT1> merge this PR, it is ready', { withPr: true }),
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
      task: makeTask(text, { withPr: true }),
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
    expect(vi.mocked(runCodex).mock.calls.at(-1)?.[0].prompt).toContain('never run a deploy command, script or skill');
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
    // Confirmed: the quick action runs, with no planner before it (issue #605), and the run is auditable.
    expect(runCodex).toHaveBeenCalledTimes(1);
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

    expect(runCodex).not.toHaveBeenCalled(); // not even a planner (issue #605)
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
    expect(runCodex).toHaveBeenCalledTimes(1);
    const audit = logs.find(entry => entry.stage === 'implementation.quick_action.pr_action');
    expect(audit?.data).toMatchObject({ requestedBy: 'UOWNER1', confirmedBy: 'UOWNER1' });
  });

  it('refuses when no owner is configured to confirm', async () => {
    const { result } = await run(`<@UBOT1> merge ${PR_URL}`, { withPr: true }, { ownerSlackUserIds: [] });

    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
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
    expect(quickPrompt).toContain('Do not merge, close, revert or sync any other pull request.');
  });

  it('leaves other quick operations, such as re-running tests, unconfirmed', async () => {
    await run('<@UBOT1> rerun the tests');
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(2);
  });
});

describe('implementationWorkflow — cancelled runs post no failure copy (#438)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runAgenticEntry).mockReset();
  });

  it('returns CANCELLED when stopped during the quick action, without "Quick action completed."', async () => {
    const controller = new AbortController();
    vi.mocked(runCodex)
      .mockResolvedValueOnce(plannerNoCodeResult())
      .mockImplementationOnce(async () => {
        controller.abort();
        return { ok: false, exitCode: 143, timedOut: false, stdout: '', stderr: '', lastMessage: '' };
      });
    const slack = makeSlack();

    const result = await runImplementationWorkflow({
      task: makeTask('<@UBOT1> rerun the tests'),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      signal: controller.signal,
    });

    expect(result.status).toBe('CANCELLED');
    const posted = slack.chat.postMessage.mock.calls.map(call => call[0].text);
    expect(posted).not.toContain('Quick action completed.');
  });

  it('returns CANCELLED when stopped during planning, and never asks for a merge confirmation', async () => {
    const controller = new AbortController();
    vi.mocked(runCodex).mockImplementationOnce(async () => {
      controller.abort();
      return plannerNoCodeResult();
    });
    const slack = makeSlack();

    const result = await runImplementationWorkflow({
      // A condition on the merge is the planner's to read (issue #605).
      task: makeTask(`<@UBOT1> merge ${PR_URL} once CI is green`, { withPr: true }),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      signal: controller.signal,
    });

    expect(result.status).toBe('CANCELLED');
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
  });
});

describe('implementationWorkflow — the abort signal reaches the planner (#264)', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset().mockResolvedValue(plannerNoCodeResult());
    vi.mocked(runAgenticEntry).mockReset();
  });

  it("passes the job's signal to the planner run, so a cancel stops it", async () => {
    const controller = new AbortController();
    const slack = makeSlack();

    await runImplementationWorkflow({
      task: makeTask('<@UBOT1> rerun the tests'),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      signal: controller.signal,
    });

    // Planner, then the quick action: both must be stoppable.
    expect(vi.mocked(runCodex).mock.calls[0][0].signal).toBe(controller.signal);
    expect(vi.mocked(runCodex).mock.calls[1][0].signal).toBe(controller.signal);
  });
});

describe('implementationWorkflow — a planner run that failed is not a plan (#439)', () => {
  const savedRetry = { ...__infraRetry };
  const API_ERROR_LINE = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
  // What the run that was posted as a plan looked like: exit 1, and the CLI's
  // own error line harvested as the "plan".
  const droppedPlanner = {
    ok: false,
    exitCode: 1,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: API_ERROR_LINE,
    durationMs: 0,
    parsedJson: { summary: API_ERROR_LINE },
    errorKind: 'API_ERROR' as const,
    apiErrorDetail: API_ERROR_LINE,
  };
  const run = (slack: ReturnType<typeof makeSlack>) =>
    runImplementationWorkflow({
      task: makeTask('<@UBOT1> change the CTA copy on the DS page to "Apply Now"'),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });
  const posted = (slack: ReturnType<typeof makeSlack>) =>
    slack.chat.postMessage.mock.calls.map(call => String(call[0].text));

  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runAgenticEntry).mockReset();
    __infraRetry.sleep = vi.fn().mockResolvedValue(true);
  });
  afterEach(() => Object.assign(__infraRetry, savedRetry));

  it('retries, then says the connection was lost: no plan, no approval prompt, no error line', async () => {
    vi.mocked(runCodex).mockResolvedValue(droppedPlanner);
    const slack = makeSlack();

    const result = await run(slack);

    expect(runCodex).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ status: 'FAILED', slackPosted: true, message: connectionLostReply('planning') });
    const messages = posted(slack);
    expect(messages[messages.length - 1]).toBe(connectionLostReply('planning'));
    for (const text of messages) {
      expect(text).not.toContain('API Error');
      expect(text).not.toContain('*Plan*');
      expect(text).not.toContain('admin needs to approve');
    }
  });

  it('carries on as normal when the connection comes back on a retry', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce(droppedPlanner).mockResolvedValue(plannerNoCodeResult());
    vi.mocked(runAgenticEntry).mockResolvedValue({
      workflow: 'INFORMATIONAL',
      status: 'SUCCESS',
      message: 'answered',
      notifyDesktop: false,
      slackPosted: true,
    });
    const slack = makeSlack();

    const result = await run(slack);

    expect(result.status).toBe('SUCCESS');
    expect(posted(slack).some(text => text.includes('lost my connection'))).toBe(false);
  });

  it('does not read a plan out of a planner that failed for any other reason either', async () => {
    vi.mocked(runCodex).mockResolvedValue({
      ...droppedPlanner,
      errorKind: undefined,
      apiErrorDetail: undefined,
      parsedJson: { summary: 'Traceback (most recent call last): …' },
    } as never);
    const slack = makeSlack();

    const result = await run(slack);

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('stopped with an error before it produced a plan');
    expect(posted(slack).some(text => text.includes('Traceback'))).toBe(false);
  });

  it('words each kind of failure for the thread', () => {
    expect(plannerFailureReply({ errorKind: 'API_ERROR', timedOut: false })).toBe(connectionLostReply('planning'));
    expect(
      plannerFailureReply({ errorKind: 'USAGE_LIMIT', limitResetsAtText: '9:40pm (Asia/Calcutta)', timedOut: false }),
    ).toContain('It resets 9:40pm (Asia/Calcutta).');
    expect(plannerFailureReply({ timedOut: true })).toContain('timed out before it produced a plan');
    expect(plannerFailureReply({ errorKind: 'EXTERNAL_KILL', timedOut: false })).toContain(
      'My planning run was killed from outside',
    );
  });
});

// Issue #605: "merge the pr" ran a 3.5-minute planner to learn no code was
// needed, then asked for the confirmation. A message that is only an
// operation on one known PR now goes straight to the quick action.
describe('implementationWorkflow — a PR operation needs no planner (#605)', () => {
  const OTHER_PR = 'https://github.com/Newton-School/newton-web/pull/9301';
  const target = (url: string, source: 'trigger' | 'thread') => ({
    url,
    owner: 'Newton-School',
    repo: 'newton-web',
    number: Number(url.split('/').pop()),
    source,
  });

  beforeEach(() => {
    vi.mocked(runCodex).mockReset().mockResolvedValue(plannerNoCodeResult());
    vi.mocked(runAgenticEntry).mockReset();
    vi.mocked(fetchUnresolvedReviewThreadCount).mockClear();
  });
  afterEach(() => {
    vi.mocked(resolveGithubTokenForCodex).mockResolvedValue(undefined);
    vi.mocked(fetchUnresolvedReviewThreadCount).mockResolvedValue({ unresolvedCount: 0, totalThreads: 0 });
    vi.mocked(fetchMergeState).mockResolvedValue({ mergeStateStatus: 'CLEAN', isDraft: false });
  });

  /** GitHub's answers for the PR; the token makes the run read them. */
  function github(threads: { unresolvedCount: number }, state: Awaited<ReturnType<typeof fetchMergeState>>) {
    vi.mocked(resolveGithubTokenForCodex).mockResolvedValue('ghs_test');
    vi.mocked(fetchUnresolvedReviewThreadCount).mockResolvedValue({ ...threads, totalThreads: 2 });
    vi.mocked(fetchMergeState).mockResolvedValue(state);
  }
  const confirmPrompt = (posted: string[]) => posted.find(text => text.includes('confirm merge'));

  async function run(text: string, prContexts: ReturnType<typeof target>[], options: { byOwner?: boolean } = {}) {
    const slack = makeSlack();
    const logs: { stage: string; data?: Record<string, unknown> }[] = [];
    const task = { ...makeTask(text, options), prContexts, prContext: prContexts[0] };
    const result = await runImplementationWorkflow({
      task,
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      logStep: entry => logs.push(entry),
    });
    const posted = slack.chat.postMessage.mock.calls.map(call => call[0].text as string);
    return { result, posted, logs };
  }

  it("merges the thread's only PR after the owner's confirmation, with one agent call and no plan", async () => {
    const { result, posted, logs } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')]);

    expect(runCodex).toHaveBeenCalledTimes(1);
    const quickPrompt = vi.mocked(runCodex).mock.calls[0][0].prompt;
    expect(quickPrompt).toContain('quick operational action');
    expect(quickPrompt).toContain(`Pull requests you may act on: ${PR_URL}.`);
    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm merge');
    expect(posted.find(text => text.includes('confirm merge'))).toContain(`<@UBUILDER> asked me to merge ${PR_URL}.`);
    expect(logs.map(entry => entry.stage)).toContain('implementation.quick_action.no_planner');
    expect(logs.map(entry => entry.stage)).not.toContain('pipeline.agent.planner.start');
    expect(result).toMatchObject({ workflow: 'IMPLEMENTATION', status: 'SUCCESS' });
  });

  it('limits the agent to the PR the message names, not every PR in the thread', async () => {
    await run('<@UBOT1> merge #9301', [target(PR_URL, 'thread'), target(OTHER_PR, 'thread')]);

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCodex).mock.calls[0][0].prompt).toContain(`Pull requests you may act on: ${OTHER_PR}.`);
  });

  it('syncs on "sync it", the daily follow-up\'s offer, with its own phrase', async () => {
    await run('<@UBOT1> sync it', [target(PR_URL, 'thread')]);

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm sync');
  });

  it('takes the action from the ask, not from a word inside a link', async () => {
    const syncTool = {
      url: 'https://github.com/Newton-School/sync-tool/pull/3',
      owner: 'Newton-School',
      repo: 'sync-tool',
      number: 3,
      source: 'trigger' as const,
    };
    await run(`<@UBOT1> merge <${syncTool.url}|sync-tool#3>`, [syncTool]);

    expect(vi.mocked(__quickActionConfirm.wait).mock.calls[0][0].phrase).toBe('confirm merge');
  });

  it('still plans first for a merge with a change', async () => {
    const { logs } = await run('<@UBOT1> merge it and fix the typo in the title first', [target(PR_URL, 'thread')]);

    expect(logs.map(entry => entry.stage)).toContain('pipeline.agent.planner.start');
    expect(logs.map(entry => entry.stage)).not.toContain('implementation.quick_action.no_planner');
    // The planner says no code is needed here, so the quick action follows it.
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  // #719: after a planner, a condition, two PRs or no PR is asked about, and nothing runs.
  it.each([
    ['a merge with a condition', '<@UBOT1> merge it once CI is green', [target(PR_URL, 'thread')], PR_URL],
    [
      'two PRs and no way to tell',
      '<@UBOT1> merge it',
      [target(PR_URL, 'thread'), target(OTHER_PR, 'thread')],
      `which pull request you mean (${PR_URL}, ${OTHER_PR})`,
    ],
    ['no PR at all', '<@UBOT1> merge it', [], 'what you want me to do'],
  ])('plans first, then asks instead of acting, for %s', async (_case, text, prs, said) => {
    const { logs, posted } = await run(text, prs);

    expect(logs.map(entry => entry.stage)).toContain('pipeline.agent.planner.start');
    expect(logs.map(entry => entry.stage)).toContain('implementation.quick_action.unclear');
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(posted.some(text => text.includes(said))).toBe(true);
  });

  it('says in the confirmation when the merge would go past a required review', async () => {
    github({ unresolvedCount: 1 }, { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', isDraft: false });

    const { posted } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')]);

    const asked = expect.objectContaining({ owner: 'Newton-School', repo: 'newton-web', pullNumber: 9300 });
    expect(fetchUnresolvedReviewThreadCount).toHaveBeenCalledWith(asked);
    expect(fetchMergeState).toHaveBeenCalledWith(asked);
    // Read once per run: the owner's own check and the confirmation share it.
    expect(fetchMergeState).toHaveBeenCalledTimes(1);
    expect(confirmPrompt(posted)).toContain(
      'It has 1 unresolved review comment. It still needs an approving review, so merging now uses admin rights. <@UOWNER1>, reply `confirm merge`',
    );
  });

  it.each([
    [
      'behind the base branch',
      { mergeStateStatus: 'BEHIND' },
      "It's behind the base branch, so merging now skips the up-to-date rule.",
    ],
    ['a draft', { mergeStateStatus: 'DRAFT', isDraft: true }, "It's still a draft."],
    ['still being worked out by GitHub', { mergeStateStatus: 'UNKNOWN' }, "I couldn't check branch protection."],
    ['unreadable', undefined, "I couldn't check branch protection."],
  ])('says so in the confirmation when the PR is %s', async (_case, state, note) => {
    github({ unresolvedCount: 0 }, state);

    const { posted } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')]);

    expect(confirmPrompt(posted)).toBe(
      `<@UBUILDER> asked me to merge ${PR_URL}. ${note} <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
    );
  });

  it('still counts unresolved comments when the merge state cannot be read', async () => {
    github({ unresolvedCount: 2 }, undefined);
    vi.mocked(fetchMergeState).mockRejectedValue(new Error('Resource not accessible'));

    const { posted } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')]);

    expect(confirmPrompt(posted)).toContain(
      "It has 2 unresolved review comments. I couldn't check branch protection. <@UOWNER1>, reply `confirm merge`",
    );
  });

  it.each([
    ['for someone else', {}],
    ['for the owner', { byOwner: true }],
  ])('does not offer to merge a PR with conflicts %s, and runs no agent', async (_case, options) => {
    github({ unresolvedCount: 1 }, { mergeStateStatus: 'DIRTY', isDraft: false });

    const { result, posted } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')], options);

    expect(posted).toEqual([
      `${PR_URL} has conflicts with its base branch, so it can't be merged yet. Nothing was changed.`,
    ]);
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED');
  });

  it('says a PR has conflicts in the confirmation when a planner read the ask, since it may be more than the merge', async () => {
    github({ unresolvedCount: 0 }, { mergeStateStatus: 'DIRTY', isDraft: false });

    const { posted, logs } = await run('<@UBOT1> merge it, CI is green', [target(PR_URL, 'thread')]);

    expect(logs.map(entry => entry.stage)).toContain('pipeline.agent.planner.start');
    expect(confirmPrompt(posted)).toContain(
      "It has conflicts, so it can't be merged yet. <@UOWNER1>, reply `confirm merge`",
    );
  });

  it("says it in the owner's own unresolved-comments prompt too", async () => {
    github(
      { unresolvedCount: 2 },
      { reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', isDraft: false },
    );

    // Stop the job once the prompt is up: the wait for a yes is not what this checks.
    const controller = new AbortController();
    const slack = makeSlack();
    slack.chat.postMessage.mockImplementation(async (message: { text: string }) => {
      if (message.text.startsWith('This PR has')) controller.abort();
      return { ok: true, ts: '123.45' };
    });
    const result = await runImplementationWorkflow({
      task: { ...makeTask('<@UBOT1> merge it', { byOwner: true }), prContexts: [target(PR_URL, 'thread')] },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
      signal: controller.signal,
    });

    expect(slack.chat.postMessage.mock.calls[0][0].text).toBe(
      'This PR has 2 unresolved review comments. A reviewer asked for changes, so merging now uses admin rights. Should I still merge? Reply *yes* to proceed or *no* to cancel.',
    );
    expect(result.status).toBe('CANCELLED');
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('adds nothing to the confirmation when the branch lets the merge through', async () => {
    github({ unresolvedCount: 0 }, { mergeStateStatus: 'CLEAN', isDraft: false });

    const { posted } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')]);

    expect(confirmPrompt(posted)).toBe(
      `<@UBUILDER> asked me to merge ${PR_URL}. <@UOWNER1>, reply \`confirm merge\` within 10 minutes and I'll do it. Without that, nothing changes.`,
    );
  });

  it('stops before the confirmation when the job is cancelled while waiting', async () => {
    __quickActionConfirm.wait = vi.fn().mockResolvedValue({ outcome: 'cancelled' });

    const { result } = await run('<@UBOT1> merge it', [target(PR_URL, 'thread')]);

    expect(runCodex).not.toHaveBeenCalled();
    expect(result.status).toBe('CANCELLED');
  });
});

// Issue #710: the quick action read its operation from the raw text, so a
// word inside a link, its label or a mention counted as the instruction.
describe('implementationWorkflow — words inside links are not the operation (#710)', () => {
  const ISSUE_LINK = '<https://github.com/Newton-School/newton-web/issues/12|revert notes>';

  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValue(plannerNoCodeResult());
    vi.mocked(runAgenticEntry).mockReset();
    vi.mocked(runAgenticEntry).mockResolvedValue({
      workflow: 'INFORMATIONAL',
      status: 'SUCCESS',
      message: 'answered',
      notifyDesktop: false,
      slackPosted: true,
    });
  });

  const run = async (text: string, options: { withPr?: boolean; byOwner?: boolean } = {}) => {
    const slack = makeSlack();
    const result = await runImplementationWorkflow({
      task: makeTask(text, options),
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });
    const posted = slack.chat.postMessage.mock.calls.map(call => String(call[0]?.text ?? ''));
    return { result, posted };
  };

  it('answers an ask about a branch whose link says "merge"', async () => {
    const { result, posted } = await run(
      '<@UBOT1> what does <https://github.com/Newton-School/newton-web/tree/fix/merge-banner|fix/merge-banner> change?',
    );
    expect(runAgenticEntry).toHaveBeenCalledWith(expect.objectContaining({ mode: 'informational' }));
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.workflow).toBe('INFORMATIONAL');
    expect(posted.some(text => /asked me to/.test(text))).toBe(false);
  });

  it('does not close anything for a file link named close-modal', async () => {
    const { result } = await run(
      '<@UBOT1> explain <https://github.com/Newton-School/newton-web/blob/master/src/close-modal.tsx|close-modal.tsx>',
      { withPr: true },
    );
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  it('still merges when the words say merge and the message also has a link', async () => {
    const { posted } = await run(`<@UBOT1> merge <${PR_URL}>, see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm merge' }));
    expect(posted.some(text => text.includes('asked me to merge'))).toBe(true);
    // The agent is told the one operation it may perform.
    expect(vi.mocked(runCodex).mock.calls[1][0].prompt).toContain(
      'The confirmed operation is `merge`; perform no other pull-request operation.',
    );
  });

  it('answers a question whose only "merge" is a link label', async () => {
    const { result } = await run(
      '<@UBOT1> what do <https://github.com/Newton-School/newton-web/issues/12|merge notes> say?',
      { withPr: true },
    );
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  it('answers an ask about a typed branch name containing "merge"', async () => {
    const { result } = await run(`<@UBOT1> what does fix/merge-banner change? see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  it('answers an ask about a typed file name containing "close"', async () => {
    const { result } = await run(`<@UBOT1> explain close-modal.tsx, see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  it('still syncs when asked, beside a link', async () => {
    const { posted } = await run(`<@UBOT1> sync it, see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm sync' }));
    expect(posted.some(text => text.includes('asked me to sync'))).toBe(true);
  });

  it('still re-runs the tests when asked, beside a link', async () => {
    const { result } = await run(`<@UBOT1> re-run the tests, see ${ISSUE_LINK}`, { withPr: true });
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runCodex).mock.calls[1][0].prompt).not.toContain('The confirmed operation is');
    expect(result.workflow).toBe('IMPLEMENTATION');
  });

  it('closes when asked to close, even after a link labelled "revert"', async () => {
    const { posted } = await run(`<@UBOT1> see ${ISSUE_LINK} then close it`, { withPr: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm close' }));
    expect(posted.some(text => text.includes('asked me to close'))).toBe(true);
  });

  it('does not redirect to the deploy command when "deploy" is only inside a link', async () => {
    const { result, posted } = await run(
      '<@UBOT1> what changed in <https://github.com/Newton-School/newton-web/tree/release/deploy-fix|release/deploy-fix>?',
    );
    expect(posted).not.toContain(QUICK_ACTION_DEPLOY_REDIRECT);
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  it('does not refuse an approval that is only a link label', async () => {
    const { result, posted } = await run(
      '<@UBOT1> summarize <https://github.com/Newton-School/newton-web/tree/approve-flow|approve-flow>',
    );
    expect(posted).not.toContain(QUICK_ACTION_APPROVE_REFUSAL);
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  // Issue #719: "bring that PR's branch up to date with master" was answered
  // with "I can't update the branch", because only the word "sync" counted.
  it("syncs when asked to bring the PR's branch up to date with master", async () => {
    const { result, posted } = await run(`<@UBOT1> bring that PR's branch up to date with master, see ${ISSUE_LINK}`, {
      withPr: true,
    });
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm sync' }));
    expect(posted.some(text => text.includes('asked me to sync'))).toBe(true);
    expect(vi.mocked(runCodex).mock.calls[1][0].prompt).toContain('The confirmed operation is `sync`');
    expect(result.workflow).toBe('IMPLEMENTATION');
  });

  it('reads "merge master into it" as a sync, never as merging the PR', async () => {
    const { posted } = await run(`<@UBOT1> merge master into it, see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm sync' }));
    expect(posted.some(text => text.includes('asked me to merge'))).toBe(false);
  });

  it('syncs on a rebase ask and tells the agent to say it merged instead', async () => {
    await run(`<@UBOT1> rebase it on main, see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm sync' }));
    expect(vi.mocked(runCodex).mock.calls[1][0].prompt).toContain('They asked for a rebase.');
  });

  // #719 review: after a planner, "merge master into <PR link>" and the like
  // merged the PR itself, with no confirmation when the owner asked.
  it.each([
    `<@UBOT1> merge master into <${PR_URL}>, see ${ISSUE_LINK}`,
    `<@UBOT1> merge origin/master into <${PR_URL}|newton-web#9300>, see ${ISSUE_LINK}`,
    `<@UBOT1> merge master to <${PR_URL}>, see ${ISSUE_LINK}`,
    `<@UBOT1> update the branch of <${PR_URL}> with master, see ${ISSUE_LINK}`,
  ])('syncs, never merges, for the owner: %s', async text => {
    const { posted } = await run(text, { withPr: true, byOwner: true });
    const agentPrompts = vi
      .mocked(runCodex)
      .mock.calls.slice(1)
      .map(call => String(call[0].prompt));
    expect(agentPrompts.some(prompt => prompt.includes('The confirmed operation is `sync`'))).toBe(true);
    expect(agentPrompts.some(prompt => prompt.includes('The confirmed operation is `merge`'))).toBe(false);
    expect(posted.some(text => /unresolved review comment/.test(text))).toBe(false);
  });

  it.each([
    `<@UBOT1> merge main, see ${ISSUE_LINK}`,
    `<@UBOT1> merge it with master, see ${ISSUE_LINK}`,
    `<@UBOT1> don't merge it, just bring it up to date with master, see ${ISSUE_LINK}`,
    `<@UBOT1> no rush, merge master into it, see ${ISSUE_LINK}`,
    `<@UBOT1> master ko merge mat karo, see ${ISSUE_LINK}`,
    `<@UBOT1> sync it and merge it, see ${ISSUE_LINK}`,
  ])('asks which operation, and runs nothing, for the owner: %s', async text => {
    const { result, posted } = await run(text, { withPr: true, byOwner: true });
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SKIPPED');
    expect(posted.some(text => text.includes("I wasn't sure what to do with"))).toBe(true);
    expect(posted.some(text => /unresolved review comment/.test(text))).toBe(false);
  });

  // #719 round 2: after a planner, a merge, close or revert is always confirmed,
  // the owner's own included; only the strict gate's sentences skip that.
  it.each([
    [`<@UBOT1> merge it, it is ready, see ${ISSUE_LINK}`, 'merge'],
    [`<@UBOT1> close it, we went another way, see ${ISSUE_LINK}`, 'close'],
    [`<@UBOT1> revert it, see ${ISSUE_LINK}`, 'revert'],
  ])('asks even the owner to confirm what a planner read: %s', async (text, action) => {
    const { posted } = await run(text, { withPr: true, byOwner: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: `confirm ${action}` }));
    expect(posted.some(said => said.includes(`asked me to ${action} ${PR_URL}`))).toBe(true);
  });

  it("lets the owner's plain sync after a planner run without a confirmation", async () => {
    await run(`<@UBOT1> sync it, see ${ISSUE_LINK}`, { withPr: true, byOwner: true });
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(vi.mocked(runCodex).mock.calls[1][0].prompt).toContain('The confirmed operation is `sync`');
  });

  it('asks which PR when the words name one the thread does not know', async () => {
    const { posted, result } = await run(`<@UBOT1> merge it 9999, see ${ISSUE_LINK}`, { withPr: true, byOwner: true });
    expect(result.status).toBe('SKIPPED');
    expect(posted.some(said => said.includes('which pull request you mean'))).toBe(true);
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
  });

  it('never lets the agent run an operation nobody confirmed', async () => {
    const { posted, result } = await run(`<@UBOT1> sync up the PR branch, see ${ISSUE_LINK}`, {
      withPr: true,
      byOwner: true,
    });
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SKIPPED');
    expect(posted.some(said => said.includes("I wasn't sure what to do with"))).toBe(true);
  });

  it('says "Tell me again" in a DM', async () => {
    const slack = makeSlack();
    const task = makeTask(`<@UBOT1> merge main, see ${ISSUE_LINK}`, { withPr: true, byOwner: true });
    await runImplementationWorkflow({
      task: { ...task, event: { ...task.event, channelId: 'D1', channelType: 'im' } },
      config,
      slack: slack as unknown as import('@slack/web-api').WebClient,
    });
    const posted = slack.chat.postMessage.mock.calls.map(call => String(call[0]?.text ?? ''));
    expect(posted.some(said => said.includes('Tell me again with just the one you want'))).toBe(true);
  });

  it('answers a yes/no question about the PR instead of acting on it', async () => {
    const { result } = await run(`<@UBOT1> you merged it? see ${ISSUE_LINK}`, { withPr: true, byOwner: true });
    expect(runAgenticEntry).toHaveBeenCalledWith(expect.objectContaining({ mode: 'informational' }));
    expect(result.workflow).toBe('INFORMATIONAL');
  });

  it('asks even the owner to confirm a rebase ask, since it runs as a merge of the base branch', async () => {
    const { posted } = await run(`<@UBOT1> rebase it on main, see ${ISSUE_LINK}`, { withPr: true, byOwner: true });
    expect(__quickActionConfirm.wait).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'confirm sync' }));
    expect(posted.some(text => text.includes("I don't rebase or squash"))).toBe(true);
  });

  it('still answers an ask to update the copy', async () => {
    const { result } = await run(`<@UBOT1> what would updating the copy change? see ${ISSUE_LINK}`, { withPr: true });
    expect(__quickActionConfirm.wait).not.toHaveBeenCalled();
    expect(result.workflow).toBe('INFORMATIONAL');
  });
});
