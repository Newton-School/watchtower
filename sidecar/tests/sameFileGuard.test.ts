import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findSameFileOverlaps,
  headsUpOnSameFiles,
  namedPrNumbers,
  normalizeRepoPath,
  sharedFiles,
  type OpenPr,
} from '../src/workflows/shared/sameFileGuard.js';
import { getActiveJobIds, registerActiveJob, unregisterActiveJob } from '../src/state/activeJobs.js';
import { currentWork, noteAsk, notePlannedFiles, resetWorkLedgerForTests } from '../src/state/workLedger.js';

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

  it('never matches a bare file name by its tail: page.tsx alone names nothing', () => {
    expect(sharedFiles(['page.tsx'], ['app/courses/page.tsx'])).toEqual([]);
    expect(sharedFiles(['app/courses/page.tsx'], ['index.ts'])).toEqual([]);
    expect(sharedFiles(['package.json'], ['package.json'])).toEqual(['package.json']);
  });
});

describe('namedPrNumbers', () => {
  it('reads PRs named by link, #number or "PR number", and not HTML entities', () => {
    expect([
      ...namedPrNumbers([
        'address the review on PR #1475',
        'see <https://github.com/o/r/pull/1404|#1404>',
        'and #1406 too, PR 1407',
        'it&#39;s fine',
      ]),
    ]).toEqual([1475, 1404, 1406, 1407]);
  });
});

function openPr(overrides: Partial<OpenPr> = {}): OpenPr {
  return {
    number: 1404,
    url: 'https://github.com/o/marketing/pull/1404',
    headRefName: 'someone/stipend-copy-1792134079-030449',
    files: [FILE],
    ...overrides,
  };
}

describe('findSameFileOverlaps', () => {
  const base = {
    jobId: 'job-2',
    threadTs: '1792134193.898239',
    repo: 'marketing',
    files: [FILE],
    namedPrs: new Set<number>(),
  };
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

  it('names a run on the same file whose plan was approved first, and not one approved after', () => {
    expect(findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [run()], openPrs: [] })).toEqual([
      { kind: 'run', jobId: 'job-1', channelId: 'C1', threadTs: '1792134079.030449', files: [FILE] },
    ]);
    expect(findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [run({ notedAtMs: NOW + 1 })], openPrs: [] })).toEqual(
      [],
    );
  });

  it('ignores runs on other repos or other files', () => {
    expect(findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [run({ repo: 'web' })], openPrs: [] })).toEqual([]);
    expect(
      findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [run({ files: ['src/x.tsx'] })], openPrs: [] }),
    ).toEqual([]);
  });

  it('names an open PR on the same file from another thread, however old', () => {
    expect(findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [], openPrs: [openPr()] })).toEqual([
      { kind: 'pr', number: 1404, url: 'https://github.com/o/marketing/pull/1404', files: [FILE] },
    ]);
  });

  it("ignores this thread's own PRs, by either branch spelling, and PRs the run is about", () => {
    const dashed = openPr({ headRefName: 'someone/ai-firms-1792134193-898239' });
    const dotted = openPr({ headRefName: 'fix-1792134193.898239' });
    expect(findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [], openPrs: [dashed, dotted] })).toEqual([]);
    expect(
      findSameFileOverlaps({ ...base, notedAtMs: NOW, work: [], openPrs: [openPr()], namedPrs: new Set([1404]) }),
    ).toEqual([]);
  });
});

describe('headsUpOnSameFiles', () => {
  const makeSlack = () => ({ chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } });
  const texts = (slack: ReturnType<typeof makeSlack>) =>
    slack.chat.postMessage.mock.calls.map(call => (call[0] as { text: string }).text);

  const startRun = (jobId: string, threadTs: string) => {
    registerActiveJob(jobId, new AbortController());
    noteAsk({ jobId, requesterId: 'UPM', channelId: 'C1', threadTs, kind: 'change', text: 'x', startedAtMs: NOW });
  };

  beforeEach(() => {
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
    context: ['<@UBOT> change 30% to 31% on the placement page'],
    slack: slack as never,
    listOpenPrs: vi.fn().mockResolvedValue([]),
    ...extra,
  });

  it('says nothing when nothing else touches the files', async () => {
    startRun('job-2', '222.2');
    const slack = makeSlack();
    expect(await headsUpOnSameFiles(params(slack))).toBeUndefined();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('posts one line naming the open PR, and carries on', async () => {
    startRun('job-2', '222.2');
    const slack = makeSlack();
    const logStep = vi.fn();
    const overlap = await headsUpOnSameFiles(
      params(slack, { logStep, listOpenPrs: vi.fn().mockResolvedValue([openPr(), openPr({ number: 1406 })]) }),
    );
    expect(overlap).toMatchObject({ kind: 'pr', number: 1404 });
    expect(texts(slack)).toEqual([
      "Heads-up: <https://github.com/o/marketing/pull/1404|PR #1404> is also changing `batch-momentum.tsx`. If it merges first, I'll need `@miniOG sync it` here.",
    ]);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'implementation.same_file.heads_up' }));
  });

  it('names the thread of a run that has no PR yet', async () => {
    startRun('job-1', '111.1');
    notePlannedFiles('job-1', 'marketing', [FILE], NOW - 60_000);
    startRun('job-2', '222.2');
    const slack = makeSlack();
    await headsUpOnSameFiles(params(slack));
    expect(texts(slack)).toEqual([
      expect.stringMatching(
        /^Heads-up: <https:\/\/[^|]+\/archives\/C1\/p1111\|another request> is also changing `batch-momentum.tsx`\. If its PR merges first, I'll need `@miniOG sync it` here\.$/,
      ),
    ]);
  });

  it('does not warn about a PR the ask names', async () => {
    startRun('job-2', '222.2');
    const slack = makeSlack();
    await headsUpOnSameFiles(
      params(slack, {
        context: ['<@UBOT> address the review on PR #1404'],
        listOpenPrs: vi.fn().mockResolvedValue([openPr()]),
      }),
    );
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('notes its own plan, relative to the worktree, so a later run can name it', async () => {
    startRun('job-2', '222.2');
    await headsUpOnSameFiles(params(makeSlack(), { files: [`/ws/marketing/222.2/${FILE}`] }));
    const [noted] = currentWork();
    expect(noted.plan).toMatchObject({ repo: 'marketing', files: [FILE] });
  });

  it('posts nothing when GitHub cannot be read', async () => {
    startRun('job-1', '111.1');
    notePlannedFiles('job-1', 'marketing', [FILE], NOW - 60_000);
    startRun('job-2', '222.2');
    const slack = makeSlack();
    const logStep = vi.fn();
    const listOpenPrs = vi.fn().mockRejectedValue(new Error('gh: not logged in'));
    expect(await headsUpOnSameFiles(params(slack, { logStep, listOpenPrs }))).toBeUndefined();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implementation.same_file.pr_lookup_failed' }),
    );
  });

  it('leaves a run the router never noted alone', async () => {
    const listOpenPrs = vi.fn();
    expect(await headsUpOnSameFiles(params(makeSlack(), { listOpenPrs }))).toBeUndefined();
    expect(listOpenPrs).not.toHaveBeenCalled();
  });
});
