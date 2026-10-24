import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';
import { getActiveJobIds, registerActiveJob, unregisterActiveJob } from '../src/state/activeJobs.js';
import { currentWork, finishWork, resetWorkLedgerForTests } from '../src/state/workLedger.js';

const runImplementationWorkflow = vi.fn();
const runAgenticEntry = vi.fn();
const decideTool = vi.fn();

vi.mock('../src/workflows/implementationWorkflow.js', () => ({ runImplementationWorkflow }));
vi.mock('../src/agentic/agenticEntry.js', () => ({ runAgenticEntry }));
vi.mock('../src/agentic/agenticPrReview.js', () => ({ runAgenticPrReview: vi.fn() }));
vi.mock('../src/workflows/investigationWorkflow.js', () => ({ runInvestigationWorkflow: vi.fn() }));
vi.mock('../src/workflows/devAssistWorkflow.js', () => ({ runDevAssistWorkflow: vi.fn() }));
vi.mock('../src/workflows/deployWorkflow.js', () => ({ runDeployWorkflow: vi.fn() }));
vi.mock('../src/workflows/unknownTaskWorkflow.js', () => ({ runUnknownTaskWorkflow: vi.fn() }));
vi.mock('../src/router/toolRouter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/router/toolRouter.js')>()),
  decideTool,
}));
vi.mock('../src/workflows/shared/workflowUtils.js', async () => ({
  ...(await vi.importActual('../src/workflows/shared/workflowUtils.js')),
  isPresencePing: vi.fn().mockReturnValue(false),
}));

const { routeTask } = await import('../src/router/taskRouter.js');

const config = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C-BUILD',
  allowedChannelsForBugFix: ['C-BUILD'],
  repoPaths: { newtonWeb: '/code/newton-web', newtonApi: '/code/newton-api' },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
  agentBackend: 'codex',
  prReviewTimeoutMs: 120_000,
  bugFixTimeoutMs: 120_000,
  pmTaskTimeoutMs: 120_000,
  accessControl: toResolvedAccessControlConfig(
    {
      mode: 'enforce',
      groups: {
        viewer: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
        reviewer: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
        builder: { manualUserIds: 'UPM,UPM2', allowedChannelIds: 'C-ONE,C-TWO', allowIm: true, allowMpim: false },
        admin: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
        owner: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
      },
    },
    ['UOWNER1'],
  ),
} as unknown as AppConfig;

const ASK =
  '<@UBOT1> on <https://www.example.com/placement|example.com/placement> change "Average Earned" to "Average Stipend" in the pune campus section';

function makeTask(userId: string, channelId: string, threadTs: string, text = ASK): NormalizedTask {
  return {
    event: {
      eventId: `Ev-${threadTs}`,
      channelId,
      channelType: channelId.startsWith('D') ? 'im' : 'channel',
      threadTs,
      eventTs: threadTs,
      userId,
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: userId === 'UOWNER1',
    isCoreDevAuthor: userId === 'UOWNER1',
    intent: 'IMPLEMENTATION',
  };
}

function makeSlack() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '9.9' }) } };
}

async function route(task: NormalizedTask, jobId: string, prOpen?: (prUrl: string) => Promise<boolean>) {
  const slack = makeSlack();
  registerActiveJob(jobId, new AbortController(), {
    channelId: task.event.channelId,
    threadTs: task.event.threadTs,
    requestedBy: task.event.userId,
  });
  const logStep = vi.fn();
  const result = await routeTask({
    task,
    config,
    slack: slack as never,
    store: {} as never,
    jobId,
    logStep,
    deps: { prOpen },
  });
  return { result, slack, logStep };
}

/** What intake does when the first run ends. */
function endRun(jobId: string, outcome: { status: string; prUrl?: string }) {
  finishWork(jobId, outcome);
  unregisterActiveJob(jobId);
}

const posted = (slack: ReturnType<typeof makeSlack>) =>
  slack.chat.postMessage.mock.calls.map(call => (call[0] as { text: string }).text);

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkLedgerForTests();
  decideTool.mockResolvedValue({
    ok: true,
    decision: { tool: 'change_code', confidence: 0.92, reason: 'stub' },
    durationMs: 1,
  });
  runImplementationWorkflow.mockResolvedValue({
    workflow: 'IMPLEMENTATION',
    status: 'SUCCESS',
    message: 'impl ok',
    notifyDesktop: false,
    slackPosted: true,
  });
});
afterEach(() => {
  for (const id of getActiveJobIds()) unregisterActiveJob(id);
});

describe('routeTask: the same ask twice (issue #602)', () => {
  it('points the second ask at the first thread and runs nothing', async () => {
    await route(makeTask('UPM', 'C-ONE', '100.1'), 'job-1');
    expect(runImplementationWorkflow).toHaveBeenCalledTimes(1);

    const { result, slack, logStep } = await route(makeTask('UPM', 'C-TWO', '200.1'), 'job-2');

    expect(result.status).toBe('SKIPPED');
    expect(runImplementationWorkflow).toHaveBeenCalledTimes(1);
    expect(posted(slack)).toEqual([
      expect.stringMatching(
        /^I'm already working on this in <https:\/\/[^|]+\/archives\/C-ONE\/p1001\|this thread>\. /,
      ),
    ]);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.duplicate_ask',
        data: expect.objectContaining({ firstJobId: 'job-1' }),
      }),
    );
  });

  it('runs the same words from someone else', async () => {
    await route(makeTask('UPM', 'C-ONE', '100.1'), 'job-1');
    const { result } = await route(makeTask('UPM2', 'C-TWO', '200.1'), 'job-2');
    expect(result.status).toBe('SUCCESS');
    expect(runImplementationWorkflow).toHaveBeenCalledTimes(2);
  });

  it('runs it again once the first run is over without a PR, or failed leaving one', async () => {
    await route(makeTask('UPM', 'C-ONE', '100.1'), 'job-1');
    endRun('job-1', { status: 'SUCCESS' });
    expect((await route(makeTask('UPM', 'C-TWO', '200.1'), 'job-2')).result.status).toBe('SUCCESS');
    endRun('job-2', { status: 'FAILED', prUrl: 'https://github.com/o/r/pull/8' });
    expect((await route(makeTask('UPM', 'C-ONE', '300.1'), 'job-3')).result.status).toBe('SUCCESS');
  });

  it("points at the first run's PR while it is open, and runs once it is merged", async () => {
    await route(makeTask('UPM', 'C-ONE', '100.1'), 'job-1');
    endRun('job-1', { status: 'SUCCESS', prUrl: 'https://github.com/o/r/pull/9' });

    const open = await route(makeTask('UPM', 'C-TWO', '200.1'), 'job-2', async () => true);
    expect(open.result.status).toBe('SKIPPED');
    expect(posted(open.slack)[0]).toMatch(/^I opened <https:\/\/github.com\/o\/r\/pull\/9\|a PR> for this/);

    const merged = await route(makeTask('UPM', 'C-TWO', '300.1'), 'job-3', async () => false);
    expect(merged.result.status).toBe('SUCCESS');
  });

  it('never points a channel at a DM, or a DM at a channel', async () => {
    await route(makeTask('UPM', 'D-PM', '100.1'), 'job-1');
    expect((await route(makeTask('UPM', 'C-TWO', '200.1'), 'job-2')).result.status).toBe('SUCCESS');
    expect((await route(makeTask('UPM', 'D-PM', '300.1'), 'job-3')).result.status).toBe('SKIPPED');
  });

  it('runs an owner repeating a request', async () => {
    await route(makeTask('UOWNER1', 'C-ONE', '100.1'), 'job-1');
    expect((await route(makeTask('UOWNER1', 'C-TWO', '200.1'), 'job-2')).result.status).toBe('SUCCESS');
  });

  it('notes each run it starts, so later asks are checked against it', async () => {
    await route(makeTask('UPM', 'C-ONE', '100.1'), 'job-1');
    expect(currentWork().map(entry => [entry.jobId, entry.kind, entry.requesterId])).toEqual([
      ['job-1', 'change', 'UPM'],
    ]);
  });
});
