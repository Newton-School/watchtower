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

function slackError(code: string): Error & { data: { error: string } } {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
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

  it('posts once with the header as its first line, and edits that message for every stage and the finish', async () => {
    const slack = makeSlack();
    const progress = createProgressMessage({
      slack: slack as any,
      channelId: 'C1',
      threadTs: '1.0',
      header: 'Plan approved — I will code it up.',
    });

    await progress.set({ text: 'writing the code', step: 1, total: 3 });
    vi.setSystemTime(new Date('2026-10-19T10:04:00Z'));
    await progress.set({ text: 'reviewing the changes', step: 2, total: 3 });
    await progress.finish('Done in 4 min. Summary below.');

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0]).toMatchObject({
      channel: 'C1',
      thread_ts: '1.0',
      text: 'Plan approved — I will code it up.\nwriting the code · step 1/3 · 0s',
    });
    const edits = slack.chat.update.mock.calls.map((call: any[]) => call[0]);
    expect(edits.map(edit => edit.ts)).toEqual(['100.5', '100.5']);
    expect(edits.map(edit => edit.text)).toEqual([
      'Plan approved — I will code it up.\nreviewing the changes · step 2/3 · 4 min',
      'Plan approved — I will code it up.\nDone in 4 min. Summary below.',
    ]);
    expect(progress.ts).toBe('100.5');
    expect(progress.finished).toBe(true);
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

  it('never lets a slow tick land after the finish', async () => {
    const slack = makeSlack();
    let releaseTick: (() => void) | undefined;
    slack.chat.update
      .mockImplementationOnce(() => new Promise<void>(resolve => (releaseTick = resolve)))
      .mockResolvedValue({ ok: true });
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0' });

    await progress.set({ text: 'running final checks', step: 3, total: 3 });
    await vi.advanceTimersByTimeAsync(60_000); // the tick's edit is now in flight
    const finishing = progress.finish('Done in 1 min. Summary below.');
    await vi.advanceTimersByTimeAsync(10);
    expect(slack.chat.update).toHaveBeenCalledTimes(1); // the finish waits its turn
    releaseTick?.();
    await finishing;

    const texts = slack.chat.update.mock.calls.map((call: any[]) => call[0].text as string);
    expect(texts[texts.length - 1]).toBe('Done in 1 min. Summary below.');
    progress.dispose();
  });

  it('hold shows a line and stops the clock until the next stage', async () => {
    const slack = makeSlack();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0' });

    await progress.set({ text: 'thinking through the approach', step: 1, total: 2 });
    await progress.hold('waiting for an admin to approve the plan');
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    expect(slack.chat.update.mock.calls[0][0].text).toBe('waiting for an admin to approve the plan');

    await progress.set({ text: 'writing the code', step: 2, total: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slack.chat.update).toHaveBeenCalledTimes(3);
    progress.dispose();
  });

  it('gives up after a Slack error that cannot succeed on retry, with one WARN row', async () => {
    const slack = makeSlack();
    slack.chat.update.mockRejectedValue(slackError('message_not_found'));
    const logStep = vi.fn();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0', logStep });

    await progress.set({ text: 'writing the code', step: 1, total: 3 });
    await progress.set({ text: 'reviewing the changes', step: 2, total: 3 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await progress.finish('Done in 5 min. Summary below.');

    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    expect(logStep).toHaveBeenCalledTimes(1);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'slack.progress.disabled', level: 'WARN', data: expect.anything() }),
    );
    progress.dispose();
  });

  it('gives up after three failures in a row', async () => {
    const slack = makeSlack();
    slack.chat.update.mockRejectedValue(new Error('socket hang up'));
    const logStep = vi.fn();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0', logStep });

    await progress.set({ text: 'writing the code', step: 1, total: 3 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(slack.chat.update).toHaveBeenCalledTimes(3);
    expect(logStep).toHaveBeenCalledTimes(1);
    progress.dispose();
  });

  it('posts at most once: a failed post never becomes a second message', async () => {
    const slack = makeSlack();
    slack.chat.postMessage.mockRejectedValue(new Error('channel_not_found'));
    const logStep = vi.fn();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0', logStep });

    await expect(progress.set({ text: 'writing the code', step: 1, total: 3 })).resolves.toBeUndefined();
    await progress.set({ text: 'reviewing the changes', step: 2, total: 3 });
    await progress.finish('Done');

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'slack.progress.disabled', level: 'WARN' }));
    progress.dispose();
  });

  it('does nothing after dispose, and finish is a no-op the second time', async () => {
    const slack = makeSlack();
    const progress = createProgressMessage({ slack: slack as any, channelId: 'C1', threadTs: '1.0' });
    await progress.set({ text: 'writing the code' });
    await progress.finish('Done');
    await progress.finish('Stopped before it finished.');
    progress.dispose();
    await progress.set({ text: 'writing the code' });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
  });
});
