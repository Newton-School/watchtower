/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __confirmationTiming,
  normalizeConfirmationReply,
  waitForExactConfirmation,
} from '../src/workflows/shared/confirmationGate.js';

const REQUESTER = 'UREQ';
const BOT = 'UBOT1';
const PROMPT_TS = '1791000100.000100';

type Reply = { user: string; text: string; ts: string };

const prompt: Reply = { user: BOT, text: 'Deploy *newton-web* to production?', ts: PROMPT_TS };
const after = (seconds: number, user: string, text: string): Reply => ({
  user,
  text,
  ts: `${1791000100 + seconds}.000100`,
});

/** Each poll sees the next scripted thread snapshot; the last one repeats. */
function slackWith(...snapshots: Reply[][]) {
  const replies = vi.fn();
  snapshots.forEach((messages, index) => {
    if (index === snapshots.length - 1) replies.mockResolvedValue({ messages });
    else replies.mockResolvedValueOnce({ messages });
  });
  const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '9.9' });
  return { slack: { conversations: { replies }, chat: { postMessage } } as any, replies, postMessage };
}

function wait(slack: any, overrides: Partial<Parameters<typeof waitForExactConfirmation>[0]> = {}) {
  return waitForExactConfirmation({
    slack,
    channelId: 'C1',
    threadTs: '1791000000.000100',
    promptTs: PROMPT_TS,
    phrase: 'confirm deploy',
    allowedUserIds: [REQUESTER],
    botUserId: BOT,
    stagePrefix: 'deploy.confirm',
    ...overrides,
  });
}

const realTiming = { ...__confirmationTiming };

beforeEach(() => {
  __confirmationTiming.pollMs = 1;
  __confirmationTiming.deadlineMs = 150;
});

afterEach(() => {
  Object.assign(__confirmationTiming, realTiming);
});

describe('normalizeConfirmationReply', () => {
  it('ignores mentions, formatting marks, case and trailing punctuation', () => {
    expect(normalizeConfirmationReply('<@UBOT1> `Confirm Deploy`.')).toBe('confirm deploy');
    expect(normalizeConfirmationReply('  *confirm   deploy*!  ')).toBe('confirm deploy');
  });

  it('keeps extra words, so a longer sentence is not the phrase', () => {
    expect(normalizeConfirmationReply('yes confirm deploy')).toBe('yes confirm deploy');
  });
});

describe('waitForExactConfirmation', () => {
  it('confirms on the exact phrase from the requester', async () => {
    const { slack } = slackWith([prompt, after(5, REQUESTER, '<@UBOT1> `confirm deploy`')]);
    const result = await wait(slack);
    expect(result).toEqual({ outcome: 'confirmed', userId: REQUESTER, replyTs: '1791000105.000100' });
  });

  it('does not treat "yes", "ok" or "ship it" as confirmation', async () => {
    const { slack } = slackWith([
      prompt,
      after(5, REQUESTER, 'yes'),
      after(6, REQUESTER, 'ok'),
      after(7, REQUESTER, 'ship it'),
      after(8, REQUESTER, 'yes, confirm deploy please'),
    ]);
    expect((await wait(slack)).outcome).toBe('expired');
  });

  it('ignores the phrase from someone else, and tells them once', async () => {
    const { slack, postMessage } = slackWith([prompt, after(5, 'UOTHER', 'confirm deploy')]);
    const result = await wait(slack);
    expect(result.outcome).toBe('expired');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toBe(`<@UOTHER> only <@${REQUESTER}> can confirm this.`);
  });

  it('ignores the phrase when it was sent before the prompt', async () => {
    const early: Reply = { user: REQUESTER, text: 'confirm deploy', ts: '1791000050.000100' };
    const { slack } = slackWith([early, prompt]);
    expect((await wait(slack)).outcome).toBe('expired');
  });

  it("ignores the bot's own messages, even one quoting the phrase", async () => {
    const { slack } = slackWith([prompt, after(1, BOT, 'confirm deploy')]);
    expect((await wait(slack)).outcome).toBe('expired');
  });

  it('declines on a plain no from the requester', async () => {
    const { slack } = slackWith([prompt, after(5, REQUESTER, 'No.')]);
    const result = await wait(slack);
    expect(result).toEqual({ outcome: 'declined', userId: REQUESTER, replyTs: '1791000105.000100' });
  });

  it("does not let someone else's no decline it", async () => {
    const { slack } = slackWith(
      [prompt, after(5, 'UOTHER', 'no')],
      [prompt, after(5, 'UOTHER', 'no'), after(9, REQUESTER, 'confirm deploy')],
    );
    expect((await wait(slack)).outcome).toBe('confirmed');
  });

  it('expires when nobody answers, having done nothing', async () => {
    const { slack, postMessage } = slackWith([prompt]);
    expect(await wait(slack)).toEqual({ outcome: 'expired' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('keeps waiting through a transient Slack error', async () => {
    const { slack, replies } = slackWith([prompt, after(5, REQUESTER, 'confirm deploy')]);
    replies.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect((await wait(slack)).outcome).toBe('confirmed');
    expect(replies.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns cancelled when the job is aborted while waiting', async () => {
    __confirmationTiming.pollMs = 20;
    __confirmationTiming.deadlineMs = 60_000;
    const { slack } = slackWith([prompt]);
    const controller = new AbortController();
    const pending = wait(slack, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ outcome: 'cancelled' });
  });

  it('accepts any of several allowed users and names them all when refusing', async () => {
    const { slack, postMessage } = slackWith(
      [prompt, after(3, 'UOTHER', 'confirm merge')],
      [prompt, after(3, 'UOTHER', 'confirm merge'), after(6, 'UOWNER2', 'confirm merge')],
    );
    const result = await wait(slack, { phrase: 'confirm merge', allowedUserIds: ['UOWNER1', 'UOWNER2'] });
    expect(result.outcome).toBe('confirmed');
    expect(result.userId).toBe('UOWNER2');
    expect(postMessage.mock.calls[0][0].text).toBe('<@UOTHER> only <@UOWNER1> or <@UOWNER2> can confirm this.');
  });

  it('logs the stages a run audit looks for', async () => {
    const stages: string[] = [];
    const { slack } = slackWith([prompt, after(5, REQUESTER, 'confirm deploy')]);
    await wait(slack, { logStep: entry => stages.push(entry.stage) });
    expect(stages).toEqual(['deploy.confirm.waiting', 'deploy.confirm.confirmed']);
  });
});
