import { describe, expect, it } from 'vitest';
import type { MyDay, MyDayItem } from '../types';
import {
  cleanReason,
  closingStopsWork,
  didBreakdown,
  didFeed,
  didRecently,
  displayAsk,
  displayWho,
  moveKind,
  nextMonday,
  nextRunText,
  prLabel,
  readableReply,
  sessionReasons,
  sessionRepo,
  snoozeOptions,
  splitNextStep,
  untilLabel,
  waitKind,
  yourMove,
  yourMoveCount,
} from '../lib/myDay';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function item(overrides: Partial<MyDayItem> = {}): MyDayItem {
  return {
    key: 'k',
    source: 'slack',
    state: 'needs_you',
    channelName: null,
    permalink: null,
    asker: 'Shiv',
    askedAt: null,
    ask: 'an ask',
    doneSummary: null,
    replyText: null,
    nextStep: null,
    evidence: null,
    prUrls: [],
    jobId: null,
    sessionId: null,
    ownerClosed: null,
    draftStatus: null,
    draftError: null,
    prStates: {},
    action: null,
    jobStatus: null,
    prInfo: {},
    tapResult: null,
    deployJobId: null,
    deployStatus: null,
    firstSeenAt: ago(1),
    sessionCwd: null,
    requestId: null,
    jobWorkflow: null,
    jobUpdatedAt: null,
    snoozedUntil: null,
    choices: [],
    lastSeenAt: ago(1),
    ...overrides,
  };
}

describe('what an item asks of him', () => {
  it('puts a waiting run first, then a stopped one, then the rest by kind', () => {
    expect(moveKind(item({ jobId: 'j', jobStatus: 'PAUSED' }))).toBe('asking');
    expect(moveKind(item({ jobId: 'j', jobStatus: 'RUNNING' }))).toBe('asking');
    expect(moveKind(item({ action: 'review_pr', jobId: 'j', jobStatus: 'FAILED' }))).toBe('stuck');
    expect(moveKind(item({ nextStep: "The run couldn't start: no slot." }))).toBe('stuck');
    expect(moveKind(item({ state: 'ready' }))).toBe('send');
    expect(moveKind(item({ action: 'review_pr' }))).toBe('start');
    expect(moveKind(item({ asker: 'Dipesh (own promise)' }))).toBe('promise');
    expect(moveKind(item({ asker: 'You (promise)' }))).toBe('promise');
    expect(moveKind(item({}))).toBe('decide');
  });

  it("keeps a finished live run's id from making a plain question look stuck", () => {
    expect(moveKind(item({ jobId: 'old-live-job', jobStatus: 'FAILED' }))).toBe('decide');
  });

  it('is never his move when done, waiting, working, or a session', () => {
    expect(moveKind(item({ state: 'done' }))).toBeNull();
    expect(moveKind(item({ state: 'waiting' }))).toBeNull();
    expect(moveKind(item({ state: 'working' }))).toBeNull();
    expect(moveKind(item({ source: 'session' }))).toBeNull();
    expect(waitKind(item({ state: 'working' }))).toBe('miniog');
    expect(waitKind(item({ state: 'waiting', jobStatus: 'RUNNING' }))).toBe('miniog');
    expect(waitKind(item({ state: 'waiting' }))).toBe('others');
  });
});

describe('his move', () => {
  it('sets aside what is over a week old and what he put off, and counts only what is left', () => {
    const items = [
      item({ key: 'fresh' }),
      item({ key: 'old', firstSeenAt: ago(8) }),
      item({ key: 'old-but-asking', firstSeenAt: ago(8), jobId: 'j', jobStatus: 'PAUSED' }),
      item({ key: 'put-off', snoozedUntil: new Date(NOW + 60_000).toISOString() }),
      item({ key: 'back', snoozedUntil: ago(0.1) }),
      item({ key: 'session', source: 'session' }),
    ];
    const move = yourMove(items, NOW);
    expect(move.sections.flatMap(section => section.items.map(entry => entry.key)).sort()).toEqual([
      'back',
      'fresh',
      'old-but-asking',
    ]);
    expect(move.old.map(entry => entry.key)).toEqual(['old']);
    expect(move.snoozed.map(entry => entry.key)).toEqual(['put-off']);
    expect(move.count).toBe(4);
    expect(yourMoveCount({ items } as MyDay, NOW)).toBe(4);
    expect(yourMoveCount(null)).toBe(0);
  });
});

describe('reading triage text', () => {
  it("splits a question from triage's suggestion", () => {
    expect(splitNextStep("Plan it for next sprint? I'd say yes.")).toEqual({
      question: 'Plan it for next sprint?',
      suggestion: 'Yes.',
    });
    expect(splitNextStep("Do it yourself or hand it to Mrinal? I'd hand it to Mrinal.")).toEqual({
      question: 'Do it yourself or hand it to Mrinal?',
      suggestion: 'Hand it to Mrinal.',
    });
    expect(splitNextStep('Review the PR.')).toEqual({ question: 'Review the PR.', suggestion: null });
    expect(splitNextStep("I'd ask Sam.")).toEqual({ question: "I'd ask Sam.", suggestion: null });
    expect(splitNextStep(null)).toEqual({ question: '', suggestion: null });
  });

  it('drops the old "see the run" tail, which the buttons now say', () => {
    expect(cleanReason("The run didn't finish: boom See the run, then answer or run it again.")).toBe(
      "The run didn't finish: boom",
    );
    expect(cleanReason('The run finished without opening a PR. See the run for what it said.')).toBe(
      'The run finished without opening a PR.',
    );
    expect(cleanReason('Nothing to trim.')).toBe('Nothing to trim.');
  });

  it('reads an old promise as his, and leaves other asks as written', () => {
    const promise = item({ asker: 'Dipesh (own promise)', ask: 'His own promise: test the signup flow.' });
    expect(displayAsk(promise)).toBe('Test the signup flow.');
    expect(displayWho(promise)).toBe('Your promise');
    expect(displayAsk(item({ ask: 'review #9468' }))).toBe('review #9468');
    expect(displayWho(item({ asker: null, source: 'github' }))).toBe('GitHub');
  });
});

describe('sessions', () => {
  it('names the repo a session ran in, worktrees included', () => {
    expect(sessionRepo(item({ sessionCwd: '/Users/d/code/watchtower' }))).toBe('watchtower');
    expect(sessionRepo(item({ sessionCwd: '/Users/d/code/watchtower/.claude/worktrees/my-day' }))).toBe('watchtower');
    expect(sessionRepo(item({ sessionCwd: null }))).toBeNull();
  });

  it('turns its reasons into short chips', () => {
    const reasons = 'Ended on a question you never answered. 4 uncommitted files in /x. 2 commits on main not pushed.';
    expect(sessionReasons(item({ doneSummary: reasons }))).toEqual([
      'Unanswered question',
      '4 uncommitted',
      '2 unpushed',
    ]);
  });
});

describe('what miniOG did', () => {
  it('says what each piece of work came to, dated by its job', () => {
    const feed = didFeed([
      item({ key: 'review', state: 'done', requestId: 'q1', action: 'review_pr', jobUpdatedAt: ago(0.2) }),
      item({
        key: 'nothing-new',
        state: 'done',
        requestId: 'q2',
        action: 're_review_pr',
        doneSummary: 'No new commits on r#1 since miniOG last reviewed it, so there was nothing new to review.',
        jobUpdatedAt: ago(0.3),
      }),
      item({ key: 'stopped', requestId: 'q3', action: 'review_pr', jobUpdatedAt: ago(5), lastSeenAt: ago(0) }),
      item({ key: 'pr', state: 'ready', requestId: 'q4', action: 'open_pr', jobUpdatedAt: ago(0.4) }),
      item({ key: 'live', state: 'done', jobId: 'j', jobWorkflow: 'PR_REVIEW', doneSummary: 'miniOG handled this.' }),
      item({ key: 'drafted', state: 'ready', draftStatus: 'saved', firstSeenAt: ago(3), lastSeenAt: ago(0) }),
      item({ key: 'his', state: 'done', ownerClosed: 'skipped' }),
      item({ key: 'others', state: 'done' }),
      item({ key: 'open', state: 'needs_you' }),
    ]);
    const byKey = Object.fromEntries(feed.map(entry => [entry.item.key, entry]));
    expect(byKey.review).toMatchObject({ who: 'night', verb: 'Reviewed', outcome: 'done' });
    expect(byKey['nothing-new'].verb).toBe('Checked: nothing new');
    expect(byKey.stopped).toMatchObject({ verb: "Couldn't finish a review", outcome: 'needs_you', at: ago(5) });
    expect(byKey.pr).toMatchObject({ verb: 'Opened a PR', outcome: 'ready' });
    expect(byKey.live).toMatchObject({ who: 'live', verb: 'Reviewed' });
    expect(byKey.drafted).toMatchObject({ who: 'drafted', at: ago(3) });
    expect(byKey.his).toMatchObject({ who: 'you', verb: 'You skipped' });
    expect(byKey.others).toMatchObject({ who: 'others', verb: 'Closed on Slack' });
    expect(byKey.open).toBeUndefined();
  });

  it("counts the last day's work for the tile, without what came back to him", () => {
    const items = [
      item({
        key: 'a',
        state: 'done',
        requestId: 'q',
        action: 'review_pr',
        jobUpdatedAt: new Date(NOW - 3600_000).toISOString(),
      }),
      item({
        key: 'b',
        state: 'done',
        requestId: 'q',
        action: 'open_pr',
        jobUpdatedAt: new Date(NOW - 7200_000).toISOString(),
      }),
      item({ key: 'c', requestId: 'q', action: 'review_pr', jobUpdatedAt: new Date(NOW - 3600_000).toISOString() }),
      item({ key: 'd', state: 'done', requestId: 'q', action: 'review_pr', jobUpdatedAt: ago(3) }),
    ];
    const recent = didRecently(items, NOW);
    expect(recent.map(entry => entry.item.key).sort()).toEqual(['a', 'b']);
    expect(didBreakdown(recent)).toBe('1 review · 1 change');
  });
});

describe('snoozing', () => {
  it('offers tomorrow, Monday and a week, without Monday twice on a Sunday', () => {
    const friday = Date.parse('2026-11-20T15:00:00');
    expect(snoozeOptions(friday).map(option => option.label)).toEqual([
      'Tomorrow morning',
      'Monday morning',
      'In a week',
    ]);
    expect(new Date(snoozeOptions(friday)[1].until).getDay()).toBe(1);
    const sunday = Date.parse('2026-11-22T15:00:00');
    expect(snoozeOptions(sunday).map(option => option.label)).toEqual(['Tomorrow morning', 'In a week']);
  });

  it('goes from one Monday to the next', () => {
    const monday = Date.parse('2026-11-23T08:00:00');
    const next = nextMonday(monday);
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(30);
    expect(next.getHours()).toBe(9);
  });
});

describe('the next sweep', () => {
  const at = (time: string) => Date.parse(`2026-11-20T${time}:00`);
  const base = { runTime: '22:00', runQueued: false, runs: [], items: [], policies: {} };
  const ranAt = (time: string) => ({ startedAt: new Date(at(time)).toISOString() }) as MyDay['lastRun'];

  it('says when it is, the way the scheduler decides, or that it is off', () => {
    const on = { ...base, enabled: true, enabledAt: new Date(at('08:00')).toISOString() };
    expect(nextRunText({ ...base, enabled: false, enabledAt: null, lastRun: null }, at('09:00'))).toBe(
      'Nightly sweep is off',
    );
    expect(nextRunText({ ...on, lastRun: null }, at('09:00'))).toBe('Next sweep tonight at 22:00');
    expect(nextRunText({ ...on, lastRun: ranAt('22:00') }, at('23:00'))).toBe('Next sweep tomorrow at 22:00');
  });

  it('waits 12 hours after any sweep, as the scheduler does', () => {
    const on = { ...base, enabled: true, enabledAt: new Date(at('08:00')).toISOString() };
    expect(nextRunText({ ...on, lastRun: ranAt('15:00') }, at('16:00'))).toBe('Next sweep tomorrow at 03:00');
  });

  it('says a sweep is due now when the time passed and nothing has covered it', () => {
    const on = { ...base, enabled: true, enabledAt: '2026-11-01T00:00:00.000Z' };
    expect(nextRunText({ ...on, lastRun: null }, at('09:00'))).toBe('Next sweep any minute');
  });
});

describe('review fixes', () => {
  it('shows where every link in a reply goes, whatever its label says', () => {
    const text =
      '<@U1> reviewed <https://phish.example/x|newton-web#9468> and <https://github.com/o/r/pull/1>. 1 &lt; 2';
    expect(readableReply(text, { U1: 'Sam' })).toBe(
      '@Sam reviewed newton-web#9468 (https://phish.example/x) and https://github.com/o/r/pull/1. 1 < 2',
    );
    expect(readableReply('<@U2> hi', {})).toBe('@U2 hi');
  });

  it('credits miniOG for work he closed only if it had finished', () => {
    const feed = didFeed([
      item({ key: 'sent', state: 'done', ownerClosed: 'done', closedFrom: 'ready', requestId: 'q', action: 'open_pr' }),
      item({
        key: 'stopped',
        state: 'done',
        ownerClosed: 'skipped',
        closedFrom: 'working',
        requestId: 'q',
        action: 'review_pr',
      }),
      item({
        key: 'old-close',
        state: 'done',
        ownerClosed: 'done',
        closedFrom: null,
        requestId: 'q',
        action: 'review_pr',
      }),
    ]);
    const byKey = Object.fromEntries(feed.map(entry => [entry.item.key, entry]));
    expect(byKey.sent).toMatchObject({ who: 'night', verb: 'Opened a PR', outcome: 'done' });
    expect(byKey.stopped).toMatchObject({ who: 'you', verb: 'You skipped' });
    expect(byKey['old-close']).toMatchObject({ who: 'you', verb: 'You marked done' });
  });

  it('keeps what came back from a snooze, or has a fresh result, out of the old pile', () => {
    const woke = item({ key: 'woke', firstSeenAt: ago(10), snoozedUntil: ago(1) });
    const result = item({
      key: 'result',
      firstSeenAt: ago(10),
      requestId: 'q',
      state: 'ready',
      jobUpdatedAt: ago(0.2),
    });
    const stale = item({ key: 'stale', firstSeenAt: ago(10), snoozedUntil: ago(8) });
    const move = yourMove([woke, result, stale], NOW);
    expect(move.old.map(entry => entry.key)).toEqual(['stale']);
  });

  it('names snooze days by the calendar, not by hours', () => {
    const saturdayNight = Date.parse('2026-11-21T22:00:00');
    expect(untilLabel(new Date(Date.parse('2026-11-23T09:00:00')).toISOString(), saturdayNight)).not.toBe('tomorrow');
    expect(untilLabel(new Date(Date.parse('2026-11-22T09:00:00')).toISOString(), saturdayNight)).toBe('tomorrow');
    expect(untilLabel(new Date(Date.parse('2026-11-21T23:30:00')).toISOString(), saturdayNight)).toBe('later today');
  });
});

describe('prLabel', () => {
  it("names the owner unless the PR was checked as one of the org's", () => {
    expect(prLabel('https://github.com/o/r/pull/12', true)).toBe('r#12');
    expect(prLabel('https://github.com/someone/r/pull/12')).toBe('someone/r#12');
    expect(prLabel('not a pr')).toBe('not a pr');
  });
});

describe('closingStopsWork', () => {
  it('holds for work going or a run waiting on him, and nothing else', () => {
    expect(closingStopsWork(item({ state: 'working' }))).toBe(true);
    expect(closingStopsWork(item({ jobId: 'j', jobStatus: 'PAUSED' }))).toBe(true);
    expect(closingStopsWork(item({ state: 'waiting', jobId: 'j', jobStatus: 'RUNNING' }))).toBe(true);
    expect(closingStopsWork(item({ jobId: 'j', jobStatus: 'SUCCESS' }))).toBe(false);
    expect(closingStopsWork(item())).toBe(false);
    expect(closingStopsWork(item({ state: 'done', jobId: 'j', jobStatus: 'RUNNING' }))).toBe(false);
  });
});
