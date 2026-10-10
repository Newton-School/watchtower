import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLARIFY_GIVE_UP_REPLY,
  DEFAULT_CLARIFY_QUESTION,
  DEPLOY_NEEDS_ONE_MESSAGE_REPLY,
  LOW_CONFIDENCE_CHANGE_QUESTION,
  OWNER_MENTION_CHANGE_QUESTION,
  ROUTE_CLARIFY_STAGE,
  ROUTE_CLARIFY_TTL_MS,
  askRequester,
  decideClarify,
  giveUpOnClarify,
  isRouteAnswer,
  isRouteQuestionExpired,
  parsePendingRouteQuestion,
  type PendingRouteQuestion,
} from '../src/router/routeClarify.js';
import { JobStore } from '../src/state/jobStore.js';
import type { NormalizedTask } from '../src/types/contracts.js';

const FLOOR = 0.75;
const decide = (overrides: Partial<Parameters<typeof decideClarify>[0]>) =>
  decideClarify({
    tool: 'answer',
    confidence: 0.9,
    addressing: 'direct',
    answering: false,
    heldByFloor: false,
    confidenceFloor: FLOOR,
    ...overrides,
  });

describe('decideClarify', () => {
  it('acts on a confident decision as given', () => {
    for (const tool of ['answer', 'chat', 'investigate', 'review_pr', 'change_code', 'unsupported'] as const) {
      expect(decide({ tool })).toEqual({ kind: 'run' });
    }
  });

  it("asks the router's question when the router says it cannot tell", () => {
    expect(decide({ tool: 'ask_user', question: 'Which page?' })).toEqual({
      kind: 'ask',
      question: 'Which page?',
      reason: 'router_asked',
    });
    expect(decide({ tool: 'ask_user' })).toMatchObject({ kind: 'ask', question: DEFAULT_CLARIFY_QUESTION });
  });

  it('does not let the model silence someone who addressed miniOG: it asks', () => {
    expect(decide({ tool: 'stay_silent' })).toEqual({
      kind: 'ask',
      question: DEFAULT_CLARIFY_QUESTION,
      reason: 'silenced_direct_mention',
    });
  });

  it('asks before starting the change pipeline on a low-confidence guess', () => {
    expect(decide({ tool: 'change_code', confidence: 0.62 })).toEqual({
      kind: 'ask',
      question: LOW_CONFIDENCE_CHANGE_QUESTION,
      reason: 'low_confidence_change',
    });
    // At the floor it runs: the floor is "below", as it always was.
    expect(decide({ tool: 'change_code', confidence: 0.75 })).toEqual({ kind: 'run' });
  });

  it('asks where the confidence floor would have kept the keyword seed', () => {
    expect(decide({ tool: 'chat', confidence: 0.6, heldByFloor: true })).toMatchObject({
      kind: 'ask',
      reason: 'floor_hold',
    });
  });

  it('asks once: an unclear reply to the question ends the chain instead of asking again', () => {
    expect(decide({ tool: 'ask_user', answering: true })).toEqual({ kind: 'give_up', reason: 'router_asked' });
    expect(decide({ tool: 'chat', confidence: 0.5, heldByFloor: true, answering: true })).toEqual({
      kind: 'give_up',
      reason: 'floor_hold',
    });
  });

  it('lets a reply to the question drop it', () => {
    expect(decide({ tool: 'stay_silent', answering: true })).toEqual({ kind: 'silent' });
  });

  it('acts normally on a clear reply to the question', () => {
    expect(decide({ tool: 'change_code', confidence: 0.9, answering: true })).toEqual({ kind: 'run' });
  });

  it('says how to ask for a deploy, and waits for no reply, when code found no target (issue #428)', () => {
    expect(decide({ tool: 'deploy', deployAllowed: false })).toEqual({
      kind: 'ask',
      question: DEPLOY_NEEDS_ONE_MESSAGE_REPLY,
      reason: 'deploy_without_target',
      park: false,
    });
    expect(decide({ tool: 'deploy', deployAllowed: true })).toEqual({ kind: 'run' });
    // A deploy is never started from a reply to a question.
    expect(decide({ tool: 'deploy', deployAllowed: false, answering: true })).toEqual({
      kind: 'give_up',
      reason: 'deploy_without_target',
    });
  });

  it('does not answer an owner mention with a question when the router cannot tell or wants silence', () => {
    for (const tool of ['ask_user', 'stay_silent', 'chat'] as const) {
      expect(decide({ tool, confidence: 0.3, heldByFloor: true, addressing: 'owner_mention' })).toEqual({
        kind: 'run',
      });
    }
  });

  it('asks before starting a change for someone who tagged the owner, however sure the router is (issue #430)', () => {
    for (const confidence of [0.6, 0.95]) {
      expect(decide({ tool: 'change_code', confidence, addressing: 'owner_mention' })).toEqual({
        kind: 'ask',
        question: OWNER_MENTION_CHANGE_QUESTION,
        reason: 'owner_mention_change',
      });
    }
  });

  it('runs what else an owner mention asks for without a question', () => {
    for (const tool of ['review_pr', 'investigate', 'answer'] as const) {
      expect(decide({ tool, addressing: 'owner_mention' })).toEqual({ kind: 'run' });
    }
  });
});

describe('a parked question', () => {
  const pending: PendingRouteQuestion = {
    question: 'What should I check?',
    requesterId: 'UREQ',
    askedAtMs: 1_000_000,
    askedText: 'check now',
  };

  it("is answered by the requester's next reply, within 30 minutes", () => {
    expect(isRouteAnswer({ pending, senderId: 'UREQ', nowMs: pending.askedAtMs + 60_000 })).toBe(true);
    expect(isRouteAnswer({ pending, senderId: 'UREQ', nowMs: pending.askedAtMs + ROUTE_CLARIFY_TTL_MS })).toBe(true);
  });

  it('is not answered by anyone else, or late', () => {
    expect(isRouteAnswer({ pending, senderId: 'UOTHER', nowMs: pending.askedAtMs + 60_000 })).toBe(false);
    expect(isRouteAnswer({ pending, senderId: 'UREQ', nowMs: pending.askedAtMs + ROUTE_CLARIFY_TTL_MS + 1 })).toBe(
      false,
    );
    expect(isRouteQuestionExpired(pending, pending.askedAtMs + ROUTE_CLARIFY_TTL_MS + 1)).toBe(true);
  });

  it('is read back from its log payload, and a malformed payload is no question', () => {
    expect(parsePendingRouteQuestion({ ...pending, reason: 'router_asked' })).toEqual(pending);
    expect(parsePendingRouteQuestion({ question: 'q', requesterId: 'U1', askedAtMs: 5 })).toMatchObject({
      askedText: '',
    });
    for (const bad of [undefined, null, 'x', {}, { question: 'q' }, { ...pending, askedAtMs: 'soon' }]) {
      expect(parsePendingRouteQuestion(bad)).toBeUndefined();
    }
  });
});

function makeTask(): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      threadTs: '100.1',
      eventTs: '100.2',
      userId: 'UREQ',
      text: '<@UBOT> check now',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION',
  };
}

const makeSlack = () => ({ chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.3' }) } });

describe('askRequester', () => {
  it('asks the requester in the thread, logs the pending question, and parks the job', async () => {
    const slack = makeSlack();
    const logStep = vi.fn();

    const result = await askRequester({
      slack: slack as never,
      store: { pausedJobForThread: () => undefined },
      task: makeTask(),
      userMessage: 'check now',
      question: 'What should I check?',
      reason: 'router_asked',
      logStep,
      nowMs: 42,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'C1',
      thread_ts: '100.1',
      text: '<@UREQ> What should I check?',
    });
    expect(result).toMatchObject({ status: 'PAUSED', workflow: 'UNKNOWN', slackPosted: true });
    expect(logStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stage: ROUTE_CLARIFY_STAGE,
        data: {
          question: 'What should I check?',
          requesterId: 'UREQ',
          askedAtMs: 42,
          askedText: 'check now',
          reason: 'router_asked',
        },
      }),
    );
  });

  it('asks without parking when another job is already parked in the thread', async () => {
    const slack = makeSlack();
    const logStep = vi.fn();

    const result = await askRequester({
      slack: slack as never,
      store: { pausedJobForThread: () => ({ id: 'job-plan', workflow: 'IMPLEMENTATION' }) },
      task: makeTask(),
      userMessage: 'no',
      question: DEFAULT_CLARIFY_QUESTION,
      reason: 'floor_hold',
      logStep,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledOnce();
    // Not PAUSED, and not the stage that marks a pending question: the next reply belongs to the other job.
    expect(result.status).toBe('SKIPPED');
    expect(logStep.mock.calls[0][0].stage).toBe('router.clarify.asked_unparked');
  });
});

describe('askRequester without parking', () => {
  it('posts the reply and leaves no pending question when asked not to park', async () => {
    const slack = makeSlack();
    const logStep = vi.fn();

    const result = await askRequester({
      slack: slack as never,
      store: { pausedJobForThread: () => undefined },
      task: makeTask(),
      userMessage: 'ship it',
      question: DEPLOY_NEEDS_ONE_MESSAGE_REPLY,
      reason: 'deploy_without_target',
      park: false,
      logStep,
    });

    expect(slack.chat.postMessage.mock.calls[0][0].text).toBe(`<@UREQ> ${DEPLOY_NEEDS_ONE_MESSAGE_REPLY}`);
    expect(result.status).toBe('SKIPPED');
    expect(logStep.mock.calls[0][0].stage).not.toBe(ROUTE_CLARIFY_STAGE);
  });
});

describe('giveUpOnClarify', () => {
  it('says once that it still cannot tell, and parks nothing', async () => {
    const slack = makeSlack();

    const result = await giveUpOnClarify({ slack: slack as never, task: makeTask(), reason: 'router_asked' });

    expect(slack.chat.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'C1',
      thread_ts: '100.1',
      text: CLARIFY_GIVE_UP_REPLY,
    });
    expect(result).toMatchObject({ status: 'SKIPPED', slackPosted: true });
  });
});

describe('JobStore and parked questions', () => {
  function storeWithParkedQuestion() {
    const store = new JobStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-clarify-')), 'wt.db'));
    const pending = { question: 'Which page?', requesterId: 'UREQ', askedAtMs: 1234, askedText: 'fix it' };
    for (const id of ['job-asked', 'job-other']) {
      store.createJob({
        id,
        eventId: `ev-${id}`,
        dedupeKey: `dk-${id}`,
        workflow: 'IMPLEMENTATION',
        channelId: 'C1',
        threadTs: id === 'job-asked' ? '100.1' : '200.1',
        payload: { eventTs: '100.2' },
      });
    }
    store.appendJobLog({
      jobId: 'job-asked',
      level: 'INFO',
      stage: ROUTE_CLARIFY_STAGE,
      message: 'asked',
      data: { ...pending, reason: 'router_asked' },
    });
    store.markJob('job-asked', 'PAUSED');
    store.markJob('job-other', 'PAUSED');
    return { store, pending };
  }

  it('finds the question a job is parked on, and none on a job parked for another reason', () => {
    const { store, pending } = storeWithParkedQuestion();
    expect(store.pausedRouteQuestion('job-asked')).toEqual(pending);
    expect(store.pausedRouteQuestion('job-other')).toBeUndefined();
    store.close();
  });

  it('lists only jobs still parked on a question', () => {
    const { store, pending } = storeWithParkedQuestion();
    expect(store.pausedRouteQuestions()).toEqual([{ id: 'job-asked', pending }]);

    store.markJob('job-asked', 'SKIPPED', { result: { reason: 'clarify_unanswered' } });
    expect(store.pausedRouteQuestions()).toEqual([]);
    store.close();
  });
});
