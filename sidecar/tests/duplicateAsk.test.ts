import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askFeatures,
  askTextOf,
  duplicateAskReply,
  findDuplicateAsk,
  isSameAsk,
  mayCheckForDuplicate,
  resolveDuplicateAsk,
} from '../src/router/duplicateAsk.js';
import { registerActiveJob, unregisterActiveJob, getActiveJobIds } from '../src/state/activeJobs.js';
import {
  currentWork,
  finishWork,
  noteAsk,
  notePlannedFiles,
  resetWorkLedgerForTests,
  type WorkEntry,
} from '../src/state/workLedger.js';
import type { NormalizedTask } from '../src/types/contracts.js';

const PAGE = '<https://www.example.com/placement|example.com/placement>';
const ASK = `<@UBOT> on ${PAGE} change "Average Earned" to "Average Stipend" in the 1st batch pune campus section`;
const ASK_WITH_MORE = `<@UOWNER> hey, urgent: on ${PAGE} change "Average Earned" to "Average Stipend" in the 1st batch pune campus section, and keep the heading bold`;

const HEADER_ASK = (page: string, node: string) =>
  `<@UBOT> update the header section of <https://www.example.com/campus/${page}|example.com/campus/${page}> refer to attached ss to understand which section im referring to design: Desktop - <https://www.figma.com/design/abc/Site?node-id=${node}&amp;t=xyz|figma.com/design/abc>`;

describe('isSameAsk', () => {
  it('matches a copy re-posted elsewhere, with or without more added', () => {
    expect(isSameAsk('change', ASK, ASK.replace('<@UBOT>', '<@UOWNER>'))).toBe(true);
    expect(isSameAsk('change', ASK, ASK_WITH_MORE)).toBe(true);
  });

  it('matches a request re-posted with the links the first one was missing', () => {
    const cut =
      '<@UBOT> update the header section of <https://www.example.com/campus/north|example.com/campus/north> refer to attached ss to understand which section im referring to design: Desktop -';
    expect(isSameAsk('change', cut, HEADER_ASK('north', '1-2'))).toBe(true);
  });

  it('does not catch a rephrased request: text, not meaning', () => {
    expect(
      isSameAsk(
        'change',
        `<@UBOT> on ${PAGE} please change the graduation year options: 2013 - 2025 becomes 2013 - 2026, 2026 becomes 2027`,
        `<@UOWNER> urgent requirement to update the graduation year options on ${PAGE}: 2013 - 2025 → 2013 - 2026, 2026 → 2027`,
      ),
    ).toBe(false);
  });

  it('tells the same request template for another page apart', () => {
    expect(isSameAsk('change', HEADER_ASK('north', '1-2'), HEADER_ASK('south', '3-4'))).toBe(false);
  });

  it('tells two edits to the same page apart', () => {
    expect(
      isSameAsk(
        'change',
        `<@UBOT> change "Average Earned" to "Average Stipend" and "23,364" to "23,149" in 1st batch pune campus section ${PAGE}`,
        `<@UBOT> update Students placed in AI firms section, change 30% to 31% ${PAGE}`,
      ),
    ).toBe(false);
  });

  it('tells asks one word apart: pune and delhi, add and remove, red and blue, show and not show', () => {
    const pairs: Array<[string, string]> = [
      [
        `<@UBOT> change Average Earned to Average Stipend in the first batch pune campus section ${PAGE}`,
        `<@UBOT> change Average Earned to Average Stipend in the first batch delhi campus section ${PAGE}`,
      ],
      [
        `<@UBOT> add the scholarship banner above the hero section on ${PAGE}`,
        `<@UBOT> remove the scholarship banner above the hero section on ${PAGE}`,
      ],
      [
        `<@UBOT> make the apply now button in the hero section red on ${PAGE}`,
        `<@UBOT> make the apply now button in the hero section blue on ${PAGE}`,
      ],
      [
        `<@UBOT> show the scholarship banner in the hero section on ${PAGE}`,
        `<@UBOT> do not show the scholarship banner in the hero section on ${PAGE}`,
      ],
    ];
    for (const [a, b] of pairs) expect(isSameAsk('change', a, b), `${a} / ${b}`).toBe(false);
  });

  it('tells a swap apart: the same quotes in the other order', () => {
    expect(
      isSameAsk(
        'change',
        `<@UBOT> on ${PAGE} change the hero button label "Apply now" to "Enroll today" please`,
        `<@UBOT> on ${PAGE} change the hero button label "Enroll today" to "Apply now" please`,
      ),
    ).toBe(false);
  });

  it('tells asks apart by their numbers', () => {
    expect(
      isSameAsk(
        'change',
        '<@UBOT> on the placement page change the AI firms stat from 30% to 31% please',
        '<@UBOT> on the placement page change the AI firms stat from 30% to 32% please',
      ),
    ).toBe(false);
  });

  it('never matches on a message with almost nothing in it', () => {
    expect(isSameAsk('change', 'yes', 'yes')).toBe(false);
    expect(isSameAsk('lookup', '<@UBOT> check now', '<@UBOT> check now')).toBe(false);
  });

  it('matches a lookup only when it is nearly word for word', () => {
    const asked = '<@UBOT> how is the monthly leaderboard rank computed for learners in a cohort';
    expect(isSameAsk('lookup', asked, `${asked}?`)).toBe(true);
    expect(isSameAsk('lookup', asked, `${asked}, and who decides the tie breaks when two learners score equal`)).toBe(
      false,
    );
    expect(
      isSameAsk(
        'lookup',
        '<@UBOT> what is the condition or flag which determines that a learner has been placed',
        '<@UBOT> what is the condition or flag which determines that a learner has dropped out',
      ),
    ).toBe(false);
  });
});

describe('askFeatures', () => {
  it('reads a link the same with or without www, a trailing slash or a Slack label', () => {
    expect(askFeatures('<https://www.example.com/a/b/|label>').specifics).toEqual(['link:example.com/a/b']);
    expect(askFeatures('see https://example.com/a/b').specifics).toEqual(['link:example.com/a/b']);
  });

  it('reads 23,364 and 23364 as one number, skips list markers, and keeps the order written', () => {
    expect(askFeatures('1. change 23,364 to "x"').specifics).toEqual(['num:23364', 'quote:x']);
    expect(askFeatures('change "x" to 23364').specifics).toEqual(['quote:x', 'num:23364']);
  });

  it('leaves out mentions and the "Sent using" footer, and keeps negations', () => {
    const { words } = askFeatures('<@UBOT> do not update hero banner copy *Sent using* <@UCLAUDE>');
    expect([...words].sort()).toEqual(['banner', 'copy', 'hero', 'not', 'update']);
  });
});

function makeTask(overrides: {
  userId?: string;
  channelId?: string;
  channelType?: string;
  threadTs?: string;
  text?: string;
  isOwnerAuthor?: boolean;
  eventId?: string;
  ingestSource?: 'socket' | 'catchup' | 'launchpad';
  rawEvent?: Record<string, unknown>;
  clarification?: NormalizedTask['clarification'];
  threadMessages?: NormalizedTask['threadMessages'];
  requestedForUserId?: string;
}): NormalizedTask {
  const threadTs = overrides.threadTs ?? '200.1';
  return {
    event: {
      eventId: overrides.eventId ?? 'Ev2',
      channelId: overrides.channelId ?? 'C-OTHER',
      channelType: overrides.channelType ?? 'channel',
      threadTs,
      eventTs: threadTs,
      userId: overrides.userId ?? 'UPM',
      text: overrides.text ?? ASK_WITH_MORE,
      ingestSource: overrides.ingestSource,
      requestedForUserId: overrides.requestedForUserId,
      rawEvent: overrides.rawEvent ?? {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: overrides.isOwnerAuthor ?? false,
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION',
    clarification: overrides.clarification,
    threadMessages: overrides.threadMessages,
  };
}

const NOW = Date.parse('2026-10-14T12:00:00Z');

function entry(overrides: Partial<WorkEntry> = {}): WorkEntry {
  return {
    jobId: 'job-first',
    requesterId: 'UPM',
    channelId: 'C-FIRST',
    channelType: 'channel',
    threadTs: '100.1',
    kind: 'change',
    text: ASK,
    startedAtMs: NOW - 13 * 60_000,
    ...overrides,
  };
}

describe('findDuplicateAsk', () => {
  it("finds the requester's run still in flight in another thread", () => {
    const first = entry();
    expect(findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-new', work: [first], nowMs: NOW })).toBe(
      first,
    );
  });

  it('never matches across requesters', () => {
    const work = [entry({ requesterId: 'USOMEONE' })];
    expect(
      findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-new', work, nowMs: NOW }),
    ).toBeUndefined();
  });

  it('matches who the run is for, not who typed it', () => {
    const task = makeTask({ userId: 'UOWNER', requestedForUserId: 'UPM' });
    expect(findDuplicateAsk({ task, kind: 'change', jobId: 'job-new', work: [entry()], nowMs: NOW })).toBeDefined();
  });

  it('leaves the same thread alone, and never matches the job against itself (a retry)', () => {
    const sameThread = entry({ channelId: 'C-OTHER', threadTs: '200.1' });
    expect(
      findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-new', work: [sameThread], nowMs: NOW }),
    ).toBeUndefined();
    expect(
      findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-first', work: [entry()], nowMs: NOW }),
    ).toBeUndefined();
  });

  it('only looks back 15 minutes', () => {
    const old = entry({ startedAtMs: NOW - 16 * 60_000 });
    expect(
      findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-new', work: [old], nowMs: NOW }),
    ).toBeUndefined();
  });

  it('never matches a DM with a channel, either way, so no DM link lands in a channel', () => {
    const inDm = entry({ channelId: 'D-PM', channelType: 'im' });
    expect(
      findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-new', work: [inDm], nowMs: NOW }),
    ).toBeUndefined();
    const fromDm = makeTask({ channelId: 'D-PM', channelType: 'im' });
    expect(
      findDuplicateAsk({ task: fromDm, kind: 'change', jobId: 'job-new', work: [entry()], nowMs: NOW }),
    ).toBeUndefined();
    // Two threads of the same DM are fine.
    expect(findDuplicateAsk({ task: fromDm, kind: 'change', jobId: 'job-new', work: [inDm], nowMs: NOW })).toBe(inDm);
  });

  it('points at the PR of a run that ended in the last 15 minutes', () => {
    const done = entry({
      startedAtMs: NOW - 60 * 60_000,
      endedAtMs: NOW - 5 * 60_000,
      prUrl: 'https://github.com/o/r/pull/9',
    });
    const found = findDuplicateAsk({ task: makeTask({}), kind: 'change', jobId: 'job-new', work: [done], nowMs: NOW });
    expect(found).toBe(done);
    expect(duplicateAskReply(done, 'https://slack.test/archives/C-FIRST/p1001')).toBe(
      'I opened <https://github.com/o/r/pull/9|a PR> for this a few minutes ago, in <https://slack.test/archives/C-FIRST/p1001|this thread>. Add anything new there, or mention me here if this is a different request.',
    );
  });

  it('keeps lookups and changes apart', () => {
    expect(
      findDuplicateAsk({ task: makeTask({}), kind: 'lookup', jobId: 'job-new', work: [entry()], nowMs: NOW }),
    ).toBeUndefined();
  });

  it('reads a "yes" to miniOG\'s question with the message it asked about', () => {
    const task = makeTask({
      text: 'yes',
      clarification: { question: 'Want me to pick this up?', askedText: ASK_WITH_MORE },
    });
    expect(askTextOf(task)).toContain('Average Stipend');
    expect(findDuplicateAsk({ task, kind: 'change', jobId: 'job-new', work: [entry()], nowMs: NOW })).toBeDefined();
  });
});

describe('resolveDuplicateAsk', () => {
  beforeEach(() => resetWorkLedgerForTests());

  it('lets a request run when the earlier PR was merged or closed since, and forgets that run', async () => {
    const done = entry({ endedAtMs: Date.now() - 60_000, prUrl: 'https://github.com/o/r/pull/9' });
    const prOpen = vi.fn().mockResolvedValue(false);
    expect(await resolveDuplicateAsk({ task: makeTask({}), kind: 'change', work: [done], prOpen })).toBeUndefined();
    expect(prOpen).toHaveBeenCalledWith('https://github.com/o/r/pull/9');
  });

  it('points at a PR that is still open, and asks GitHub nothing about a run still in flight', async () => {
    const done = entry({ endedAtMs: Date.now() - 60_000, prUrl: 'https://github.com/o/r/pull/9' });
    expect(
      await resolveDuplicateAsk({ task: makeTask({}), kind: 'change', work: [done], prOpen: async () => true }),
    ).toBe(done);
    const prOpen = vi.fn();
    const running = entry({ startedAtMs: Date.now() - 60_000 });
    expect(await resolveDuplicateAsk({ task: makeTask({}), kind: 'change', work: [running], prOpen })).toBe(running);
    expect(prOpen).not.toHaveBeenCalled();
  });
});

describe('mayCheckForDuplicate', () => {
  it('checks an ordinary request', () => {
    expect(mayCheckForDuplicate(makeTask({}))).toBe(true);
  });

  it('skips owners, retriggers from the app and restart replays', () => {
    expect(mayCheckForDuplicate(makeTask({ isOwnerAuthor: true }))).toBe(false);
    expect(mayCheckForDuplicate(makeTask({ ingestSource: 'launchpad' }))).toBe(false);
    expect(mayCheckForDuplicate(makeTask({ eventId: 'restart:job-1' }))).toBe(false);
  });

  it('skips a message with files, which text cannot compare', () => {
    expect(mayCheckForDuplicate(makeTask({ rawEvent: { files: [{ id: 'F1' }] } }))).toBe(false);
  });

  it('checks a thread once: a second mention there says it is a different request', () => {
    const told = duplicateAskReply(entry(), 'https://slack.test/x');
    const task = makeTask({ threadMessages: [{ text: told, user: 'UBOT', ts: '200.2' }] });
    expect(mayCheckForDuplicate(task)).toBe(false);
  });
});

describe('workLedger', () => {
  beforeEach(() => {
    resetWorkLedgerForTests();
    for (const id of getActiveJobIds()) unregisterActiveJob(id);
  });
  afterEach(() => {
    for (const id of getActiveJobIds()) unregisterActiveJob(id);
  });

  const note = (jobId: string) =>
    noteAsk({
      jobId,
      requesterId: 'UPM',
      channelId: 'C1',
      threadTs: `${jobId}.1`,
      kind: 'change',
      text: 'x',
      startedAtMs: NOW,
    });

  it('holds runs while they are active and forgets them after', () => {
    registerActiveJob('job-a', new AbortController());
    note('job-a');
    note('job-gone');
    expect(currentWork(NOW).map(e => e.jobId)).toEqual(['job-a']);
    unregisterActiveJob('job-a');
    expect(currentWork(NOW)).toEqual([]);
  });

  it('keeps a run that succeeded with an open PR for 15 minutes after it ends', () => {
    registerActiveJob('job-a', new AbortController());
    note('job-a');
    notePlannedFiles('job-a', 'repo', ['a.ts'], NOW);
    finishWork('job-a', { status: 'SUCCESS', prUrl: 'https://github.com/o/r/pull/1' }, NOW);
    unregisterActiveJob('job-a');
    const [kept] = currentWork(NOW + 10 * 60_000);
    expect(kept.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(kept.plan).toBeUndefined();
    expect(currentWork(NOW + 16 * 60_000)).toEqual([]);
  });

  it("forgets a run that ended without a PR, a failed run's leftover PR, and a PR that is no longer open", () => {
    for (const outcome of [
      { status: 'SUCCESS' },
      { status: 'FAILED', prUrl: 'https://github.com/o/r/pull/2', prState: 'OPEN' },
      { status: 'SUCCESS', prUrl: 'https://github.com/o/r/pull/3', prState: 'MERGED' },
    ]) {
      registerActiveJob('job-a', new AbortController());
      note('job-a');
      finishWork('job-a', outcome, NOW);
      unregisterActiveJob('job-a');
      expect(currentWork(NOW), JSON.stringify(outcome)).toEqual([]);
    }
  });

  it("keeps a run's first place in line across a retry", () => {
    registerActiveJob('job-a', new AbortController());
    note('job-a');
    expect(notePlannedFiles('job-a', 'repo', ['a.ts'], NOW)).toBe(NOW);
    note('job-a');
    expect(notePlannedFiles('job-a', 'repo', ['a.ts'], NOW + 5_000)).toBe(NOW);
    expect(notePlannedFiles('job-unknown', 'repo', ['a.ts'], NOW)).toBeUndefined();
  });
});
