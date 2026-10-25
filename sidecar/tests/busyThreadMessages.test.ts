import { beforeEach, describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  __resetBusyThreadMessagesForTests,
  holdBusyThreadMessage,
  replayAfterThreadFrees,
  takeThreadReplays,
} from '../src/runtime/busyThreadMessages.js';
import type { SlackEventEnvelope } from '../src/types/contracts.js';

// Issue #703: a message that came in while the deploy offer held its thread
// ran nothing. The offer asks for it to run once the thread is free.

const client = {} as WebClient;
const TEXT = '<@UBOT1> also change the heading';
const message = (eventTs: string, threadTs = '400.1', channelId = 'C1', text = TEXT): SlackEventEnvelope => ({
  eventId: `Ev-${eventTs}`,
  channelId,
  threadTs,
  eventTs,
  userId: 'UBUILDER',
  text,
  rawEvent: {},
});

beforeEach(() => __resetBusyThreadMessagesForTests());

describe('messages held while their thread was busy', () => {
  it('run once the thread is free, when the run asks for them', () => {
    holdBusyThreadMessage(message('501.0'), client);
    holdBusyThreadMessage(message('502.0'), client);

    expect(replayAfterThreadFrees('C1', '400.1', '502.0', { text: TEXT })).toBe('replayed');
    const replays = takeThreadReplays('C1', '400.1');

    expect(replays.map(replay => replay.event.eventTs)).toEqual(['502.0']);
    // Taken once.
    expect(takeThreadReplays('C1', '400.1')).toEqual([]);
  });

  it('are not run unless asked for', () => {
    holdBusyThreadMessage(message('501.0'), client);

    expect(takeThreadReplays('C1', '400.1')).toEqual([]);
  });

  it('say so when the message was never held, or belongs to another thread', () => {
    holdBusyThreadMessage(message('501.0', '999.9'), client);

    expect(replayAfterThreadFrees('C1', '400.1', '503.0', { text: TEXT })).toBe('not_held');
    expect(replayAfterThreadFrees('C1', '400.1', '501.0', { text: TEXT })).toBe('not_held');
  });

  it.each([
    ['marked edited', { text: TEXT, edited: true }],
    ['showing other words now', { text: '<@UBOT1> nevermind, all good' }],
  ])('are not run when %s: their old words would run', (_case, seen) => {
    holdBusyThreadMessage(message('501.0', '400.1', 'C1', '<@UBOT1> revert PR 1490, the page is broken'), client);

    expect(replayAfterThreadFrees('C1', '400.1', '501.0', seen)).toBe('changed');
    expect(takeThreadReplays('C1', '400.1')).toEqual([]);
  });

  it('are forgotten after a few hours', () => {
    holdBusyThreadMessage(message('501.0'), client, 0);
    holdBusyThreadMessage(message('600.0'), client, 4 * 60 * 60 * 1000);

    expect(replayAfterThreadFrees('C1', '400.1', '501.0', { text: TEXT })).toBe('not_held');
    expect(replayAfterThreadFrees('C1', '400.1', '600.0', { text: TEXT })).toBe('replayed');
  });
});
