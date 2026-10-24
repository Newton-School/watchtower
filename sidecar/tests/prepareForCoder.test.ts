import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareForCoder } from '../src/workflows/implementationWorkflow.js';
import { getActiveJobIds, registerActiveJob, unregisterActiveJob } from '../src/state/activeJobs.js';
import { noteAsk, resetWorkLedgerForTests } from '../src/state/workLedger.js';
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

const FILE = 'src/app/courses/hero.tsx';
const LISTED_PLAN = `Change the hero copy.\n\n## Files to change\n- \`${FILE}\` — the heading`;
const otherPr = {
  number: 1404,
  url: 'https://github.com/o/web/pull/1404',
  headRefName: 'pm/hero-111-1',
  files: [FILE],
};

function makeSlack() {
  return { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
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
      return '/ws/newton-web/222.2';
    });

    const cwd = await prepareForCoder({
      jobId: 'job-2',
      task,
      config,
      pipelineCwd: '/ws/newton-web/222.2',
      planMarkdown: LISTED_PLAN,
      planAffectedFiles: [FILE],
      threadTexts: [],
      slack: slack as never,
      deps: { listOpenPrs: vi.fn().mockResolvedValue([otherPr]), refresh },
    });

    expect(cwd).toBe('/ws/newton-web/222.2');
    expect(refresh).toHaveBeenCalledWith('/code/newton-web', '222.2');
    expect(order).toEqual(['heads-up', 'refresh']);
    expect((slack.chat.postMessage.mock.calls[0][0] as { text: string }).text).toMatch(/^Heads-up: <[^|]+\|PR #1404>/);
  });

  it('does not warn on files guessed from the plan text, but still refreshes', async () => {
    const slack = makeSlack();
    const refresh = vi.fn(async () => '/ws/newton-web/222.2');
    const listOpenPrs = vi.fn().mockResolvedValue([otherPr]);
    await prepareForCoder({
      jobId: 'job-2',
      task,
      config,
      pipelineCwd: '/ws/newton-web/222.2',
      planMarkdown: `Change the heading in \`${FILE}\`.`,
      planAffectedFiles: [FILE],
      threadTexts: [],
      slack: slack as never,
      deps: { listOpenPrs, refresh },
    });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(listOpenPrs).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not warn about a PR the thread names', async () => {
    const slack = makeSlack();
    await prepareForCoder({
      jobId: 'job-2',
      task,
      config,
      pipelineCwd: '/ws/newton-web/222.2',
      planMarkdown: LISTED_PLAN,
      planAffectedFiles: [FILE],
      threadTexts: ['<@UBOT> can you address the comments on https://github.com/o/web/pull/1404'],
      slack: slack as never,
      deps: { listOpenPrs: vi.fn().mockResolvedValue([otherPr]), refresh: vi.fn(async () => '/ws/newton-web/222.2') },
    });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('leaves a worktree it cannot place in a known repo as it is', async () => {
    const refresh = vi.fn();
    const cwd = await prepareForCoder({
      jobId: 'job-2',
      task,
      config,
      pipelineCwd: '/somewhere/else/222.2',
      planMarkdown: LISTED_PLAN,
      planAffectedFiles: [FILE],
      threadTexts: [],
      slack: makeSlack() as never,
      deps: { listOpenPrs: vi.fn().mockResolvedValue([]), refresh },
    });
    expect(cwd).toBe('/somewhere/else/222.2');
    expect(refresh).not.toHaveBeenCalled();
  });
});
