/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressMessage, formatElapsed, formatProgressLine } from '../src/slack/progressMessage.js';

function makeSlack() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.5' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

describe('formatElapsed', () => {
  it('reads as seconds, minutes, then hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(6 * 60_000 + 20_000)).toBe('6 min');
    expect(formatElapsed(2 * 3_600_000)).toBe('2 h');
    expect(formatElapsed(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
  });
});

describe('formatProgressLine', () => {
  it('joins the stage, its position and the elapsed time', () => {
    expect(formatProgressLine({ text: 'writing the code', step: 1, total: 3 }, 125_000)).toBe(
      'writing the code · step 1/3 · 2 min',
    );
    expect(
      formatProgressLine(
        { text: 'review flagged some things, the coder is revising', step: 1, total: 3, round: 1, rounds: 2 },
        30_000,
      ),
    ).toBe('review flagged some things, the coder is revising · step 1/3 · round 1/2 · 30s');
    expect(formatProgressLine({ text: 'wrapping up' }, 1_000)).toBe('wrapping up · 1s');
  });
});

describe('createProgressMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts the intro once and edits that message for every stage and the finish', async () => {
    const slack = makeSlack();
    const progress = createProgressMessage({
      slack: slack as any,
      channelId: 'C1',
      threadTs: '1.0',
      intro: 'Plan approved — I will code it up.',
    });

    await progress.set({ text: 'writing the code', step: 1, total: 3 });
    vi.setSystemTime(new Date('2026-10-19T10:04:00Z'));
    await progress.set({ text: 'reviewing the changes', step: 2, total: 3 });
    await progress.finish('Done in 4 min. Summary below.');

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: 'C1',
      thread_ts: '1.0',
      text: 'Plan approved — I will code it up.',
    });
    const edits = slack.chat.update.mock.calls.map((call: any[]) => call[0]);
    expect(edits.map(edit => edit.ts)).toEqual(['100.5', '100.5', '100.5']);
    expect(edits.map(edit => edit.text)).toEqual([
      'writing the code · step 1/3 · 0s',
      'reviewing the changes · step 2/3 · 4 min',
      'Done in 4 min. Summary below.',
    ]);
    expect(progress.ts).toBe('100.5');
    progress.dispose();
  });

  it('refreshes the elapsed time once a minute while a stage runs, and stops after finish', async () => {
    const slack = makeSlack();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0' });

    await progress.set({ text: 'writing the code', step: 1, total: 3 });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0].text).toBe('writing the code · step 1/3 · 0s');

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const ticks = slack.chat.update.mock.calls.map((call: any[]) => call[0].text as string);
    expect(ticks).toEqual(['writing the code · step 1/3 · 1 min', 'writing the code · step 1/3 · 2 min']);

    await progress.finish('Stopped after 2 min: a check found a critical issue.');
    const before = slack.chat.update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(slack.chat.update.mock.calls.length).toBe(before);
    progress.dispose();
  });

  it('never throws when Slack refuses, and says so once in the log', async () => {
    const slack = makeSlack();
    slack.chat.postMessage.mockRejectedValue(new Error('channel_not_found'));
    const logStep = vi.fn();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0', logStep });

    await expect(progress.set({ text: 'writing the code', step: 1, total: 3 })).resolves.toBeUndefined();
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'slack.progress.failed', level: 'WARN' }));
    progress.dispose();
  });

  it('does nothing after dispose', async () => {
    const slack = makeSlack();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0' });
    progress.dispose();
    await progress.set({ text: 'writing the code' });
    await progress.finish('Done');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(slack.chat.update).not.toHaveBeenCalled();
  });
});
