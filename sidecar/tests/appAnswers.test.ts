/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { replyTsAfter, routeAppAnswer, runAppAnswerPoller } from '../src/launchpad/appAnswers.js';
import { whileWaitingForAnswer } from '../src/runtime/humanWaits.js';
import { __resetButtonRepliesForTests, buttonRepliesSince, recordButtonReply } from '../src/slack/buttonReplies.js';
import { JobStore } from '../src/state/jobStore.js';
import { agentCallContext } from '../src/state/runContext.js';
import { waitForClarificationWithIdle } from '../src/workflows/shared/clarificationGuards.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

const CHANNEL = 'C0B5ZVDM7GU';
const THREAD = '1761200000.000100';
const PROMPT = '1761200100.000200';
const config = { botUserId: 'UBOT1', ownerSlackUserIds: ['UOWNER1'] } as AppConfig;

function createStore(): JobStore {
  return new JobStore(path.join(os.tmpdir(), `watchtower-app-answers-${uuidv4()}.db`));
}

function createJob(store: JobStore, id: string): void {
  store.createJob({
    id,
    eventId: `evt-${id}`,
    dedupeKey: `dedupe-${id}`,
    workflow: 'IMPLEMENTATION',
    channelId: CHANNEL,
    threadTs: THREAD,
    payload: { text: '<@UBOT1> fix the banner', requestUserId: 'UREQ1' },
  });
}

/** Paused a while ago, so its :zzz: is up. */
function pauseLongAgo(store: JobStore, jobId: string): void {
  store.markJob(jobId, 'PAUSED');
  (store as any).db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run('2026-10-22T00:00:00.000Z', jobId);
}

function waitAt(store: JobStore, jobId: string, promptTs = PROMPT): void {
  store.beginHumanWait({
    jobId,
    kind: 'approval',
    channelId: CHANNEL,
    threadTs: THREAD,
    promptTs,
    allowedUserIds: ['UOWNER1'],
  });
}

function answer(
  store: JobStore,
  id: string,
  jobId: string,
  extra: { answerPromptTs?: string; originEventTs?: string },
) {
  store.createLaunchpadRequest({
    id,
    target: 'miniog',
    prompt: 'yes',
    ownerUserId: 'UOWNER1',
    requestedForUserId: 'UREQ1',
    originChannelId: CHANNEL,
    originThreadTs: THREAD,
    originEventTs: extra.originEventTs ?? '1761200200.000300',
    answerForJobId: jobId,
    answerPromptTs: extra.answerPromptTs,
  });
}

function intake(store: JobStore) {
  const enqueue = vi.fn(async (_event: SlackEventEnvelope) => {});
  const chatDelete = vi.fn(async () => ({ ok: true }));
  const params = { webClient: { chat: { delete: chatDelete } } as any, config, store, enqueue };
  return { params, enqueue, chatDelete };
}

describe('whileWaitingForAnswer', () => {
  it('keeps the wait on record for as long as the gate waits, inside a job', async () => {
    const store = createStore();
    createJob(store, 'job-1');
    const wait = {
      kind: 'question' as const,
      channelId: CHANNEL,
      threadTs: THREAD,
      promptTs: PROMPT,
      allowedUserIds: ['UREQ1'],
    };

    const seen = await agentCallContext.run({ jobId: 'job-1', store }, () =>
      whileWaitingForAnswer(wait, async () => store.humanWaitFor('job-1')),
    );

    expect(seen).toMatchObject({ jobId: 'job-1', kind: 'question', promptTs: PROMPT, allowedUserIds: ['UREQ1'] });
    expect(store.humanWaitFor('job-1')).toBeUndefined();
  });

  it('clears the wait when the gate throws, and records nothing outside a job', async () => {
    const store = createStore();
    const wait = {
      kind: 'confirm' as const,
      channelId: CHANNEL,
      threadTs: THREAD,
      promptTs: PROMPT,
      allowedUserIds: [],
    };
    await expect(
      agentCallContext.run({ jobId: 'job-2', store }, () =>
        whileWaitingForAnswer(wait, async () => {
          throw new Error('aborted');
        }),
      ),
    ).rejects.toThrow('aborted');
    expect(store.humanWaitFor('job-2')).toBeUndefined();

    await whileWaitingForAnswer(wait, async () => {
      expect(store.humanWaitFor('job-2')).toBeUndefined();
    });
  });

  it('keeps the phrase a confirm gate takes', () => {
    const store = createStore();
    store.beginHumanWait({
      jobId: 'job-4',
      kind: 'confirm',
      channelId: CHANNEL,
      threadTs: THREAD,
      promptTs: PROMPT,
      allowedUserIds: ['UOWNER1'],
      expects: 'confirm merge',
    });
    expect(store.humanWaitFor('job-4')?.expects).toBe('confirm merge');
  });

  it('leaves a newer wait alone when an older gate ends, and startup clears every wait', () => {
    const store = createStore();
    waitAt(store, 'job-3', '1761200100.000200');
    waitAt(store, 'job-3', '1761200300.000400');
    store.endHumanWait('job-3', '1761200100.000200');
    expect(store.humanWaitFor('job-3')?.promptTs).toBe('1761200300.000400');
    store.clearHumanWaits();
    expect(store.humanWaitFor('job-3')).toBeUndefined();
  });
});

describe('routeAppAnswer', () => {
  it('sends an answer to the gate it was written for, or picks a paused run up again', () => {
    const store = createStore();
    createJob(store, 'job-run');
    waitAt(store, 'job-run');
    expect(routeAppAnswer(store, { answerForJobId: 'job-run', answerPromptTs: PROMPT })).toEqual({
      kind: 'gate',
      jobId: 'job-run',
      channelId: CHANNEL,
      promptTs: PROMPT,
    });

    createJob(store, 'job-paused');
    pauseLongAgo(store, 'job-paused');
    expect(routeAppAnswer(store, { answerForJobId: 'job-paused' })).toEqual({ kind: 'resume' });
  });

  it('waits for a run that has only just paused, and never resumes one paused under a mid-run answer', () => {
    const store = createStore();
    createJob(store, 'job-paused');
    store.markJob('job-paused', 'PAUSED');
    expect(routeAppAnswer(store, { answerForJobId: 'job-paused' })).toEqual({ kind: 'later' });
    expect(routeAppAnswer(store, { answerForJobId: 'job-paused' }, Date.now() + 6_000)).toEqual({ kind: 'resume' });
    expect(routeAppAnswer(store, { answerForJobId: 'job-paused', answerPromptTs: PROMPT })).toEqual({
      kind: 'drop',
      reason: 'miniOG paused before your answer reached it. Answer again to pick it back up.',
    });
  });

  it('dates the answer after its question even when the clock runs behind Slack', () => {
    expect(replyTsAfter('1761200100.000200', 1_761_200_000_000)).toBe('1761200100.000201');
    expect(replyTsAfter('1761200100.999999', 1_761_200_000_000)).toBe('1761200101.000000');
    expect(replyTsAfter('1761200100.000200', 1_761_200_200_500)).toBe('1761200200.500000');
  });

  it('drops an answer that would reach the wrong question or nothing', () => {
    const store = createStore();
    createJob(store, 'job-run');
    waitAt(store, 'job-run', '1761200300.000400');
    expect(routeAppAnswer(store, { answerForJobId: 'job-run', answerPromptTs: PROMPT })).toEqual({
      kind: 'drop',
      reason: 'miniOG asked something new before your answer reached it.',
    });

    store.endHumanWait('job-run', '1761200300.000400');
    expect(routeAppAnswer(store, { answerForJobId: 'job-run', answerPromptTs: PROMPT }).kind).toBe('drop');

    store.markJob('job-run', 'SUCCESS');
    expect(routeAppAnswer(store, { answerForJobId: 'job-run', answerPromptTs: PROMPT })).toEqual({
      kind: 'drop',
      reason: 'The run ended before your answer reached it.',
    });
    expect(routeAppAnswer(store, { answerForJobId: 'job-gone' })).toEqual({
      kind: 'drop',
      reason: 'That run is gone.',
    });
  });
});

describe('runAppAnswerPoller', () => {
  afterEach(() => {
    __resetButtonRepliesForTests();
    vi.useRealTimers();
  });

  it("hands the owner's answer to the waiting gate, once", async () => {
    const store = createStore();
    createJob(store, 'job-run');
    waitAt(store, 'job-run');
    answer(store, 'ans-1', 'job-run', { answerPromptTs: PROMPT });
    const { params, enqueue } = intake(store);

    // The launchpad poller leaves answers to this one.
    expect(store.claimPendingLaunchpadRequests()).toEqual([]);
    await runAppAnswerPoller(params);
    await runAppAnswerPoller(params);

    expect(store.getLaunchpadRequest('ans-1')).toMatchObject({ status: 'SUCCESS', jobId: 'job-run' });
    const replies = buttonRepliesSince(CHANNEL, PROMPT);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ user: 'UOWNER1', text: 'yes' });
    expect(store.listJobLogs('job-run').map(log => log.stage)).toContain('watchtower.answer.received');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('picks a paused run up again from the answer, in its thread', async () => {
    const store = createStore();
    createJob(store, 'job-paused');
    pauseLongAgo(store, 'job-paused');
    answer(store, 'ans-2', 'job-paused', { originEventTs: '1761200200.000300' });
    const { params, enqueue } = intake(store);

    await runAppAnswerPoller(params);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0][0];
    expect(event).toMatchObject({
      channelId: CHANNEL,
      threadTs: THREAD,
      eventTs: '1761200200.000300',
      userId: 'UOWNER1',
      requestedForUserId: 'UREQ1',
      answersJobId: 'job-paused',
      launchpadRequestId: 'ans-2',
      text: '<@UBOT1> yes',
    });
    expect(event.rawEvent).toMatchObject({ originThread: true });
    expect(store.getLaunchpadRequest('ans-2')?.status).toBe('QUEUED');
  });

  it('closes an answer that reaches nothing and takes back its posted copy', async () => {
    const store = createStore();
    createJob(store, 'job-done');
    store.markJob('job-done', 'SUCCESS');
    answer(store, 'ans-3', 'job-done', { answerPromptTs: PROMPT, originEventTs: '1761200200.000300' });
    const { params, chatDelete } = intake(store);

    await runAppAnswerPoller(params);

    expect(chatDelete).toHaveBeenCalledWith({ channel: CHANNEL, ts: '1761200200.000300' });
    expect(store.getLaunchpadRequest('ans-3')).toMatchObject({
      status: 'FAILED',
      errorMessage: 'The run ended before your answer reached it. The posted answer was taken back.',
    });
  });

  it('a question miniOG asked takes the answer from the app beside the thread replies', async () => {
    vi.useFakeTimers();
    const slack = { conversations: { replies: vi.fn(async () => ({ messages: [] })) } } as any;
    const outcome = waitForClarificationWithIdle({
      slack,
      channelId: CHANNEL,
      threadTs: THREAD,
      allowedUserIds: ['UREQ1', 'UOWNER1'],
      promptTs: PROMPT,
      logStep: () => {},
      botUserId: 'UBOT1',
    });
    recordButtonReply({ channelId: CHANNEL, messageTs: PROMPT, userId: 'UOWNER1', value: 'the web repo' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toEqual({ outcome: 'answered', answer: 'the web repo', answererId: 'UOWNER1' });
  });
});
