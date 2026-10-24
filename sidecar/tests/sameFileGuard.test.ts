import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findSameFileBlockers,
  normalizeRepoPath,
  OPEN_PR_GRACE_MS,
  SAME_FILE_WAIT_MAX_MS,
  sharedFiles,
  waitForSameFileTurn,
  type OpenPr,
} from '../src/workflows/shared/sameFileGuard.js';
import { getActiveJobIds, registerActiveJob, unregisterActiveJob } from '../src/state/activeJobs.js';
import {
  currentWork,
  finishWork,
  noteAsk,
  notePlannedFiles,
  resetWorkLedgerForTests,
} from '../src/state/workLedger.js';

const NOW = Date.parse('2026-10-16T07:10:00Z');
const FILE = 'src/features/nst/placement/batch-momentum.tsx';

describe('sharedFiles', () => {
  it('reads paths the way planners and GitHub write them', () => {
    expect(normalizeRepoPath('./src/a.tsx:12')).toBe('src/a.tsx');
    expect(normalizeRepoPath('`/src/a.tsx`')).toBe('src/a.tsx');
    expect(sharedFiles(['./src/a.tsx:12', 'src/b.tsx'], ['src/a.tsx'])).toEqual(['src/a.tsx']);
  });

  it('matches a path a planner wrote without its leading directories', () => {
    expect(sharedFiles(['placement/batch-momentum.tsx'], [FILE])).toEqual(['placement/batch-momentum.tsx']);
    expect(sharedFiles(['src/other.tsx'], [FILE])).toEqual([]);
  });
});

function openPr(overrides: Partial<OpenPr> = {}): OpenPr {
  return {
    number: 1404,
    url: 'https://github.com/o/marketing/pull/1404',
    headRefName: 'someone/stipend-copy-1792134079-030449',
    createdAt: new Date(NOW - 10 * 60_000).toISOString(),
    files: [FILE],
    ...overrides,
  };
}

describe('findSameFileBlockers', () => {
  const base = { jobId: 'job-2', threadTs: '1792134193.898239', repo: 'marketing', files: [FILE], nowMs: NOW };
  const run = (overrides: { notedAtMs?: number; repo?: string; files?: string[] } = {}) => ({
    jobId: 'job-1',
    requesterId: 'UPM',
    channelId: 'C1',
    threadTs: '1792134079.030449',
    kind: 'change' as const,
    text: 'x',
    startedAtMs: NOW - 9 * 60_000,
    plan: {
      repo: overrides.repo ?? 'marketing',
      files: overrides.files ?? [FILE],
      notedAtMs: overrides.notedAtMs ?? NOW - 60_000,
    },
  });

  it('is held back by a run on the same file whose plan was approved first', () => {
    expect(findSameFileBlockers({ ...base, notedAtMs: NOW, work: [run()], openPrs: [] })).toEqual([
      { kind: 'run', jobId: 'job-1', channelId: 'C1', threadTs: '1792134079.030449', files: [FILE] },
    ]);
  });

  it('is not held back by a run approved after it, so two runs never wait on each other', () => {
    expect(findSameFileBlockers({ ...base, notedAtMs: NOW, work: [run({ notedAtMs: NOW + 1 })], openPrs: [] })).toEqual(
      [],
    );
  });

  it('ignores runs on other repos or other files', () => {
    expect(findSameFileBlockers({ ...base, notedAtMs: NOW, work: [run({ repo: 'web' })], openPrs: [] })).toEqual([]);
    expect(
      findSameFileBlockers({ ...base, notedAtMs: NOW, work: [run({ files: ['src/x.tsx'] })], openPrs: [] }),
    ).toEqual([]);
  });

  it('is held back by a fresh open PR on the same file from another thread', () => {
    expect(findSameFileBlockers({ ...base, notedAtMs: NOW, work: [], openPrs: [openPr()] })).toEqual([
      { kind: 'pr', number: 1404, url: 'https://github.com/o/marketing/pull/1404', files: [FILE] },
    ]);
  });

  it("ignores this thread's own PRs, by either branch spelling", () => {
    const dashed = openPr({ headRefName: 'someone/ai-firms-1792134193-898239' });
    const dotted = openPr({ headRefName: 'fix-1792134193.898239' });
    expect(findSameFileBlockers({ ...base, notedAtMs: NOW, work: [], openPrs: [dashed, dotted] })).toEqual([]);
  });

  it('stops waiting on an open PR an hour after it was opened', () => {
    const old = openPr({ createdAt: new Date(NOW - OPEN_PR_GRACE_MS).toISOString() });
    expect(findSameFileBlockers({ ...base, notedAtMs: NOW, work: [], openPrs: [old] })).toEqual([]);
  });
});

describe('waitForSameFileTurn', () => {
  let clock = NOW;
  const now = () => clock;
  // Each poll moves the clock a minute on.
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const makeSlack = () => ({ chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } });
  const texts = (slack: ReturnType<typeof makeSlack>) =>
    slack.chat.postMessage.mock.calls.map(call => (call[0] as { text: string }).text);

  const startRun = (jobId: string, threadTs: string) => {
    registerActiveJob(jobId, new AbortController());
    noteAsk({ jobId, requesterId: 'UPM', channelId: 'C1', threadTs, kind: 'change', text: 'x', startedAtMs: clock });
  };

  beforeEach(() => {
    clock = NOW;
    sleep.mockClear();
    resetWorkLedgerForTests();
    for (const id of getActiveJobIds()) unregisterActiveJob(id);
  });
  afterEach(() => {
    for (const id of getActiveJobIds()) unregisterActiveJob(id);
  });

  const params = (slack: ReturnType<typeof makeSlack>, extra: Record<string, unknown> = {}) => ({
    jobId: 'job-2',
    channelId: 'C2',
    threadTs: '222.2',
    repo: 'marketing',
    cwd: '/ws/marketing/222.2',
    files: [FILE],
    slack: slack as never,
    deps: { listOpenPrs: vi.fn().mockResolvedValue([]), sleep, now },
    ...extra,
  });

  it('starts at once when nothing else touches the files', async () => {
    startRun('job-2', '222.2');
    const slack = makeSlack();
    expect(await waitForSameFileTurn(params(slack))).toEqual({ outcome: 'clear', waited: false });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('waits for the run that got to the file first, then starts', async () => {
    startRun('job-1', '111.1');
    notePlannedFiles('job-1', 'marketing', [FILE], clock - 60_000);
    startRun('job-2', '222.2');
    const slack = makeSlack();
    const logStep = vi.fn();
    // The first run ends without a PR during the third poll.
    sleep.mockImplementation(async (ms: number) => {
      clock += ms;
      if (sleep.mock.calls.length === 3) {
        finishWork('job-1', {}, clock);
        unregisterActiveJob('job-1');
      }
    });

    const turn = await waitForSameFileTurn(params(slack, { logStep }));

    expect(turn).toEqual({ outcome: 'clear', waited: true });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(texts(slack)).toEqual([
      expect.stringMatching(
        /^Waiting my turn: <https:\/\/[^|]+\/archives\/C1\/p1111\|another request> is already changing `batch-momentum.tsx`\. I'll start once it's done and its PR is merged/,
      ),
    ]);
    expect(logStep.mock.calls.map(call => call[0].stage)).toEqual([
      'implementation.same_file.waiting',
      'implementation.same_file.clear',
    ]);
  });

  it('notes its own plan so a later run waits for it', async () => {
    startRun('job-2', '222.2');
    await waitForSameFileTurn(
      params(makeSlack(), { cwd: '/ws/marketing/222.2', files: [`/ws/marketing/222.2/${FILE}`] }),
    );
    const [noted] = currentWork(clock);
    expect(noted.plan).toEqual({ repo: 'marketing', files: [FILE], notedAtMs: NOW });
  });

  it('starts once the PR on the same file is merged', async () => {
    startRun('job-2', '222.2');
    const slack = makeSlack();
    // Open for the first two checks, merged by the third.
    const listOpenPrs = vi
      .fn()
      .mockResolvedValueOnce([openPr()])
      .mockResolvedValueOnce([openPr()])
      .mockResolvedValue([]);
    const turn = await waitForSameFileTurn(params(slack, { deps: { listOpenPrs, sleep, now } }));
    expect(turn).toEqual({ outcome: 'clear', waited: true });
    expect(texts(slack)).toEqual([
      "Waiting my turn: <https://github.com/o/marketing/pull/1404|PR #1404> is already changing `batch-momentum.tsx`. I'll start once it's merged (two hours at most), so the two PRs don't clash.",
    ]);
  });

  it('gives an open PR an hour, and a run two hours, then starts and says how to fix a clash', async () => {
    startRun('job-2', '222.2');
    const slack = makeSlack();
    // Opened ten minutes ago and never merged: it stops holding the run an hour after it was opened.
    const listOpenPrs = vi.fn(async () => [openPr({ createdAt: new Date(NOW - 10 * 60_000).toISOString() })]);
    const turn = await waitForSameFileTurn(params(slack, { deps: { listOpenPrs, sleep, now } }));
    expect(turn).toEqual({ outcome: 'gave_up', waited: true });
    expect(clock - NOW).toBe(OPEN_PR_GRACE_MS - 10 * 60_000);
    expect(texts(slack)[1]).toMatch(/^Starting now rather than waiting longer on <[^|]+\|PR #1404>\./);

    // An in-flight run that never ends hits the two-hour limit.
    resetWorkLedgerForTests();
    clock = NOW;
    startRun('job-1', '111.1');
    notePlannedFiles('job-1', 'marketing', [FILE], clock - 60_000);
    startRun('job-3', '333.3');
    const slack3 = makeSlack();
    const stuck = await waitForSameFileTurn(params(slack3, { jobId: 'job-3', threadTs: '333.3' }));
    expect(stuck).toEqual({ outcome: 'gave_up', waited: true });
    expect(clock - NOW).toBe(SAME_FILE_WAIT_MAX_MS);
    expect(texts(slack3)[1]).toMatch(
      /^Starting now rather than waiting longer on <[^|]+\|another request>\. .*`sync it`\.$/,
    );
  });

  it('stops waiting when the job is cancelled', async () => {
    startRun('job-1', '111.1');
    notePlannedFiles('job-1', 'marketing', [FILE], clock - 60_000);
    startRun('job-2', '222.2');
    const controller = new AbortController();
    sleep.mockImplementation(async () => controller.abort());
    const turn = await waitForSameFileTurn(params(makeSlack(), { signal: controller.signal }));
    expect(turn).toEqual({ outcome: 'cancelled', waited: true });
  });

  it('still checks other runs when GitHub cannot be read, and says so once', async () => {
    startRun('job-2', '222.2');
    const logStep = vi.fn();
    const listOpenPrs = vi.fn().mockRejectedValue(new Error('gh: not logged in'));
    const turn = await waitForSameFileTurn(params(makeSlack(), { logStep, deps: { listOpenPrs, sleep, now } }));
    expect(turn).toEqual({ outcome: 'clear', waited: false });
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implementation.same_file.pr_lookup_failed' }),
    );
  });

  it('leaves a run the router never noted alone', async () => {
    const listOpenPrs = vi.fn();
    const turn = await waitForSameFileTurn(params(makeSlack(), { deps: { listOpenPrs, sleep, now } }));
    expect(turn).toEqual({ outcome: 'clear', waited: false });
    expect(listOpenPrs).not.toHaveBeenCalled();
  });
});
