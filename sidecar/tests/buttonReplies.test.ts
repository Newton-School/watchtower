import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetButtonRepliesForTests,
  approvalBlocks,
  buttonRepliesSince,
  buttonsEnabled,
  clickedText,
  configureButtons,
  confirmationBlocks,
  readButtonClick,
  recordButtonReply,
} from '../src/slack/buttonReplies.js';

afterEach(() => __resetButtonRepliesForTests());

describe('the click registry', () => {
  it('keeps a click as the reply the person would have typed, after the prompt', () => {
    const now = Date.parse('2026-10-19T10:00:00Z');
    const reply = recordButtonReply({ channelId: 'C1', threadTs: '100.1', userId: 'U1', value: 'yes', now });
    expect(reply).toEqual({ text: 'yes', user: 'U1', ts: (now / 1000).toFixed(6) });
    expect(buttonRepliesSince('C1', '100.1', '100.1')).toEqual([reply]);
    expect(buttonRepliesSince('C1', '100.1', reply.ts)).toEqual([]);
    expect(buttonRepliesSince('C1', '200.2', '0')).toEqual([]);
  });

  it('forgets clicks older than a day', () => {
    const now = Date.parse('2026-10-19T10:00:00Z');
    recordButtonReply({ channelId: 'C1', threadTs: '100.1', userId: 'U1', value: 'yes', now: now - 25 * 3_600_000 });
    recordButtonReply({ channelId: 'C1', threadTs: '100.1', userId: 'U2', value: 'stop', now });
    expect(buttonRepliesSince('C1', '100.1', '0').map(reply => reply.text)).toEqual(['stop']);
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

describe('readButtonClick', () => {
  const body = {
    type: 'block_actions',
    user: { id: 'UADMIN' },
    channel: { id: 'C1' },
    message: { ts: '150.00', thread_ts: '100.1', text: "Here's my plan. An admin needs to approve before I proceed:" },
    actions: [{ action_id: 'miniog_approve', value: 'yes', type: 'button' }],
  };

  it('reads miniOG’s own buttons and nothing else', () => {
    expect(readButtonClick(body)).toEqual({
      channelId: 'C1',
      threadTs: '100.1',
      messageTs: '150.00',
      userId: 'UADMIN',
      actionId: 'miniog_approve',
      value: 'yes',
      messageText: "Here's my plan. An admin needs to approve before I proceed:",
    });
    expect(readButtonClick({ ...body, actions: [{ action_id: 'other_app_button', value: 'x' }] })).toBeUndefined();
    expect(readButtonClick({ ...body, user: {} })).toBeUndefined();
  });

  it('uses the message itself as the thread when the prompt is a top-level message', () => {
    expect(readButtonClick({ ...body, message: { ts: '150.00', text: 't' } })?.threadTs).toBe('150.00');
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

  it('put the exact phrase and Cancel under a confirmation', () => {
    const blocks = confirmationBlocks('Deploy?', 'confirm deploy', 'Confirm deploy');
    const actions = blocks[1] as { elements: Array<{ action_id: string; value: string; text: { text: string } }> };
    expect(actions.elements.map(element => [element.action_id, element.value, element.text.text])).toEqual([
      ['miniog_confirm', 'confirm deploy', 'Confirm deploy'],
      ['miniog_decline', 'cancel', 'Cancel'],
    ]);
  });

  it('rewrites a clicked prompt with the choice and no buttons', () => {
    expect(clickedText('Deploy?', 'U1', 'miniog_confirm')).toBe('Deploy?\n_<@U1> confirmed with a button._');
    expect(clickedText('Plan', 'U1', 'miniog_stop')).toBe('Plan\n_<@U1> stopped it with a button._');
  });
});
