/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetButtonRepliesForTests,
  approvalBlocks,
  buttonRepliesSince,
  buttonsEnabled,
  configureButtons,
  confirmationBlocks,
  handleButtonClick,
  postGatePrompt,
  readButtonClick,
  recordButtonReply,
  rememberPrompt,
  retirePrompt,
  withButtonReplies,
  yesNoBlocks,
} from '../src/slack/buttonReplies.js';

afterEach(() => __resetButtonRepliesForTests());

const now = Date.parse('2026-10-19T10:00:00Z');

describe('the click registry', () => {
  it('keeps a click as the reply the person would have typed, at Slack’s time, for the prompt it sat on', () => {
    const reply = recordButtonReply({
      channelId: 'C1',
      messageTs: '150.0',
      userId: 'U1',
      value: 'yes',
      actionTs: '151.000200',
      now,
    });
    expect(reply).toEqual({ text: 'yes', user: 'U1', ts: '151.000200' });
    expect(buttonRepliesSince('C1', '150.0')).toEqual([reply]);
    // A click on an older prompt is not a reply to a newer one.
    expect(buttonRepliesSince('C1', '160.0')).toEqual([]);
    expect(buttonRepliesSince('C2', '150.0')).toEqual([]);
  });

  it('falls back to the host clock when Slack sent no time', () => {
    const reply = recordButtonReply({
      channelId: 'C1',
      messageTs: '150.0',
      userId: 'U1',
      value: 'yes',
      now,
    });
    expect(reply.ts).toBe((now / 1000).toFixed(6));
  });

  it('forgets clicks older than a day', () => {
    recordButtonReply({
      channelId: 'C1',
      messageTs: '150.0',
      userId: 'U1',
      value: 'yes',
      now: now - 25 * 3_600_000,
    });
    recordButtonReply({ channelId: 'C1', messageTs: '150.0', userId: 'U2', value: 'stop', now });
    expect(buttonRepliesSince('C1', '150.0').map(reply => reply.text)).toEqual(['stop']);
  });

  it('is off until the operator turns it on, and a broken switch reads as off', () => {
    expect(buttonsEnabled()).toBe(false);
    configureButtons({ isEnabled: () => true });
    expect(buttonsEnabled()).toBe(true);
    configureButtons({
      isEnabled: () => {
        throw new Error('db closed');
      },
    });
    expect(buttonsEnabled()).toBe(false);
  });
});

describe('retirePrompt', () => {
  it('rewrites a remembered prompt with the outcome and no buttons, once', async () => {
    const slack = { chat: { update: vi.fn().mockResolvedValue({ ok: true }) } };
    rememberPrompt({ channelId: 'C1', ts: '150.0', text: 'Deploy?', now });

    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'Confirmed by <@U1>.' });
    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'again' });

    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    expect(slack.chat.update.mock.calls[0][0]).toEqual({
      channel: 'C1',
      ts: '150.0',
      text: 'Deploy?\n_Confirmed by <@U1>._',
      blocks: [],
    });
  });

  it('leaves a prompt it does not know alone, and never throws', async () => {
    const slack = { chat: { update: vi.fn().mockRejectedValue(new Error('message_not_found')) } };
    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'x' });
    expect(slack.chat.update).not.toHaveBeenCalled();
    rememberPrompt({ channelId: 'C1', ts: '150.0', text: 'Deploy?', now });
    await expect(
      retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('readButtonClick', () => {
  const body = {
    type: 'block_actions',
    user: { id: 'UADMIN' },
    channel: { id: 'C1' },
    message: { ts: '150.00', thread_ts: '100.1', text: "Here's my plan." },
    actions: [{ action_id: 'miniog_approve', value: 'yes', type: 'button', action_ts: '151.000200' }],
  };

  it('reads miniOG’s own buttons and nothing else', () => {
    expect(readButtonClick(body)).toEqual({
      channelId: 'C1',
      threadTs: '100.1',
      messageTs: '150.00',
      userId: 'UADMIN',
      actionId: 'miniog_approve',
      value: 'yes',
      actionTs: '151.000200',
    });
    expect(readButtonClick({ ...body, actions: [{ action_id: 'other_app_button', value: 'x' }] })).toBeUndefined();
    expect(readButtonClick({ ...body, user: {} })).toBeUndefined();
  });

  it('uses the message itself as the thread when the prompt is a top-level message', () => {
    expect(readButtonClick({ ...body, message: { ts: '150.00', text: 't' } })?.threadTs).toBe('150.00');
  });
});

describe('handleButtonClick', () => {
  const click = {
    channelId: 'C1',
    messageTs: '150.0',
    userId: 'U1',
    actionId: 'miniog_stop',
    value: 'stop',
    actionTs: '151.0',
  };

  it('hands a Stop to the stop lane and records nothing when it stopped a job', async () => {
    const onStopClick = vi.fn().mockResolvedValue(true);
    configureButtons({ isEnabled: () => true, onStopClick });
    await handleButtonClick(click);
    expect(onStopClick).toHaveBeenCalledWith(click);
    expect(buttonRepliesSince('C1', '150.0')).toEqual([]);
  });

  it('keeps a Stop for a polling gate when no job was there to stop', async () => {
    configureButtons({ isEnabled: () => true, onStopClick: vi.fn().mockResolvedValue(false) });
    await handleButtonClick(click);
    expect(buttonRepliesSince('C1', '150.0')).toEqual([{ text: 'stop', user: 'U1', ts: '151.0' }]);
  });

  it('records every other click', async () => {
    await handleButtonClick({ ...click, actionId: 'miniog_approve', value: 'yes' });
    expect(buttonRepliesSince('C1', '150.0')).toEqual([{ text: 'yes', user: 'U1', ts: '151.0' }]);
  });

  it('answers a click no job is waiting on instead of keeping it', async () => {
    const onOrphanClick = vi.fn().mockResolvedValue(undefined);
    configureButtons({ isEnabled: () => true, hasListener: () => false, onOrphanClick });
    await handleButtonClick({ ...click, actionId: 'miniog_approve', value: 'yes' });
    expect(onOrphanClick).toHaveBeenCalledTimes(1);
    expect(buttonRepliesSince('C1', '150.0')).toEqual([]);
  });
});

describe('the blocks', () => {
  it('put Approve and Stop under the plan prompt, with the phrases the gate reads', () => {
    const blocks = approvalBlocks('Here is my plan.');
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Here is my plan.' } });
    const actions = blocks[1] as { elements: Array<{ action_id: string; value: string; style?: string }> };
    expect(actions.elements.map(element => [element.action_id, element.value, element.style])).toEqual([
      ['miniog_approve', 'yes', 'primary'],
      ['miniog_stop', 'stop', 'danger'],
    ]);
  });

  it('put Yes and No under a yes-or-no question, where No turns it down rather than stopping the job', () => {
    const actions = yesNoBlocks('Merge anyway?')[1] as { elements: Array<{ action_id: string; value: string }> };
    expect(actions.elements.map(element => [element.action_id, element.value])).toEqual([
      ['miniog_approve', 'yes'],
      ['miniog_decline', 'no'],
    ]);
  });

  it('put the exact phrase and Cancel under a confirmation', () => {
    const blocks = confirmationBlocks('Deploy?', 'confirm deploy', 'Confirm deploy');
    const actions = blocks[1] as { elements: Array<{ action_id: string; value: string; text: { text: string } }> };
    expect(actions.elements.map(element => [element.action_id, element.value, element.text.text])).toEqual([
      ['miniog_confirm', 'confirm deploy', 'Confirm deploy'],
      ['miniog_decline', 'cancel', 'Cancel'],
    ]);
  });
});

describe('retirePrompt after a failure', () => {
  it('keeps the prompt remembered after a transient failure, and forgets one whose message is gone', async () => {
    const slack = {
      chat: { update: vi.fn().mockRejectedValueOnce(new Error('ratelimited')).mockResolvedValue({ ok: true }) },
    };
    rememberPrompt({ channelId: 'C1', ts: '150.0', text: 'Deploy?', now });
    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'x' });
    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'x' });
    expect(slack.chat.update).toHaveBeenCalledTimes(2);

    const gone = {
      chat: {
        update: vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { data: { error: 'message_not_found' } })),
      },
    };
    rememberPrompt({ channelId: 'C1', ts: '160.0', text: 'Plan?', now });
    await retirePrompt({ slack: gone as any, channelId: 'C1', promptTs: '160.0', outcome: 'x' });
    await retirePrompt({ slack: gone as any, channelId: 'C1', promptTs: '160.0', outcome: 'x' });
    expect(gone.chat.update).toHaveBeenCalledTimes(1);
  });
});

describe('withButtonReplies', () => {
  it('merges clicks with thread messages in time order', () => {
    recordButtonReply({ channelId: 'C1', messageTs: '150.0', userId: 'U1', value: 'yes', actionTs: '151.0', now });
    const merged = withButtonReplies([{ text: 'stop', user: 'U2', ts: '152.0' }], 'C1', '150.0');
    expect(merged.map(reply => reply.text)).toEqual(['yes', 'stop']);
  });
});

describe('postGatePrompt', () => {
  it('posts with buttons and remembers the prompt only when the switch is on', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '150.0' }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const blocks = vi.fn(() => approvalBlocks('Plan?'));
    expect(await postGatePrompt(slack as any, { channel: 'C1', thread_ts: '100.1', text: 'Plan?', blocks })).toBe(
      '150.0',
    );
    expect(blocks).not.toHaveBeenCalled();
    expect(slack.chat.postMessage.mock.calls[0][0]).toEqual({ channel: 'C1', thread_ts: '100.1', text: 'Plan?' });
    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'x' });
    expect(slack.chat.update).not.toHaveBeenCalled();

    configureButtons({ isEnabled: () => true });
    expect(await postGatePrompt(slack as any, { channel: 'C1', thread_ts: '100.1', text: 'Plan?', blocks })).toBe(
      '150.0',
    );
    expect(slack.chat.postMessage.mock.calls[1][0].blocks).toHaveLength(2);
    await retirePrompt({ slack: slack as any, channelId: 'C1', promptTs: '150.0', outcome: 'done' });
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
  });
});
