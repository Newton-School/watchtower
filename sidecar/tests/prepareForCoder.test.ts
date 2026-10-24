import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareForCoder } from '../src/workflows/implementationWorkflow.js';
import { getActiveJobIds, registerActiveJob, unregisterActiveJob } from '../src/state/activeJobs.js';
import { noteAsk, resetWorkLedgerForTests } from '../src/state/workLedger.js';
import type { WorktreeRefresh } from '../src/workspaces/workspaceManager.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

// The last step before the coder (issue #602): a heads-up about another PR on
// the same files, then the worktree moved to the latest base.

const config = {
  repoPaths: { newtonWeb: '/code/newton-web', newtonApi: '/code/newton-api' },
} as unknown as AppConfig;

const task = {
  event: {
    eventId: 'Ev1',
    channelId: 'C2',
    channelType: 'channel',
    threadTs: '222.2',
    eventTs: '222.2',
    userId: 'UPM',
    text: '<@UBOT> change the hero copy on the courses page',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
} as NormalizedTask;

const CWD = '/ws/newton-web/222.2';
const FILE = 'src/app/courses/hero.tsx';
const LISTED_PLAN = `Change the hero copy.\n\n## Files to change\n- \`${FILE}\` — the heading`;
const otherPr = {
  number: 1404,
  url: 'https://github.com/o/web/pull/1404',
  headRefName: 'pm/hero-111-1',
  files: [FILE],
};
const refreshed: WorktreeRefresh = { ok: true, base: 'origin/main', head: 'abc123' };

function makeSlack() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
}

function run(overrides: Partial<Parameters<typeof prepareForCoder>[0]> = {}) {
  return prepareForCoder({
    jobId: 'job-2',
    task,
    config,
    pipelineCwd: CWD,
    planMarkdown: LISTED_PLAN,
    planAffectedFiles: [FILE],
    threadTexts: [],
    slack: makeSlack() as never,
    ...overrides,
  });
}

describe('prepareForCoder', () => {
  beforeEach(() => {
    resetWorkLedgerForTests();
    registerActiveJob('job-2', new AbortController());
    noteAsk({
      jobId: 'job-2',
      requesterId: 'UPM',
      channelId: 'C2',
      threadTs: '222.2',
      kind: 'change',
      text: 'x',
      startedAtMs: 1,
    });
  });
  afterEach(() => {
    for (const id of getActiveJobIds()) unregisterActiveJob(id);
  });

  it('posts the heads-up, then moves the worktree to the latest base', async () => {
    const slack = makeSlack();
    const order: string[] = [];
    slack.chat.postMessage.mockImplementation(async () => {
      order.push('heads-up');
      return { ok: true };
    });
    const refresh = vi.fn(async () => {
      order.push('refresh');
      return refreshed;
    });
    const logStep = vi.fn();

    await run({ slack: slack as never, logStep, deps: { listOpenPrs: vi.fn().mockResolvedValue([otherPr]), refresh } });

    expect(refresh).toHaveBeenCalledWith(CWD);
    expect(order).toEqual(['heads-up', 'refresh']);
    expect((slack.chat.postMessage.mock.calls[0][0] as { text: string }).text).toMatch(/^Heads-up: <[^|]+\|PR #1404>/);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'implementation.workspace.refreshed',
        data: expect.objectContaining({ head: 'abc123' }),
      }),
    );
  });

  it('carries on with the worktree as it was when the refresh fails, and says so in the log', async () => {
    const logStep = vi.fn();
    const refresh = vi.fn(
      async (): Promise<WorktreeRefresh> => ({ ok: false, reason: 'fatal: unable to access origin' }),
    );
    await expect(
      run({ logStep, deps: { listOpenPrs: vi.fn().mockResolvedValue([]), refresh } }),
    ).resolves.toBeUndefined();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implementation.refresh.failed', level: 'WARN' }),
    );
  });

  it("logs nothing for a directory that is not one of miniOG's worktrees", async () => {
    const logStep = vi.fn();
    const refresh = vi.fn(
      async (): Promise<WorktreeRefresh> => ({ ok: false, reason: 'not a miniOG worktree', skipped: true }),
    );
    await run({ logStep, deps: { listOpenPrs: vi.fn().mockResolvedValue([]), refresh } });
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'implementation.refresh.failed' }));
  });

  it('does not warn on files guessed from the plan text, but still refreshes', async () => {
    const slack = makeSlack();
    const refresh = vi.fn(async () => refreshed);
    const listOpenPrs = vi.fn().mockResolvedValue([otherPr]);
    await run({
      slack: slack as never,
      planMarkdown: `Change the heading in \`${FILE}\`.`,
      deps: { listOpenPrs, refresh },
    });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(listOpenPrs).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not warn about a PR the thread names', async () => {
    const slack = makeSlack();
    await run({
      slack: slack as never,
      threadTexts: ['<@UBOT> can you address the comments on https://github.com/o/web/pull/1404'],
      deps: { listOpenPrs: vi.fn().mockResolvedValue([otherPr]), refresh: vi.fn(async () => refreshed) },
    });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});
