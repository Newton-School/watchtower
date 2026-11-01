import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MyDay, MyDayItem } from '../types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { MyDayPage } from '../pages/MyDayPage';

function item(overrides: Partial<MyDayItem>): MyDayItem {
  return {
    key: 'slack:C1:1.2',
    source: 'slack',
    state: 'needs_you',
    channelName: '#development',
    permalink: 'https://example.slack.com/archives/C1/p12',
    asker: 'Shiv',
    askedAt: 'Thu 19:38',
    ask: 'Review #9468',
    doneSummary: null,
    replyText: null,
    nextStep: 'Review the PR',
    evidence: null,
    prUrls: ['https://github.com/o/newton-web/pull/9468'],
    jobId: null,
    sessionId: null,
    ownerClosed: null,
    draftStatus: null,
    draftError: null,
    prStates: {},
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function day(overrides: Partial<MyDay> = {}): MyDay {
  return { enabled: false, runTime: '22:00', runQueued: false, lastRun: null, items: [], ...overrides };
}

function serve(value: MyDay) {
  invoke.mockImplementation(async (command: string) => (command === 'get_my_day' ? value : undefined));
}

describe('MyDayPage', () => {
  beforeEach(() => {
    invoke.mockReset();
  });
  afterEach(cleanup);

  it('shows an ask with what was asked, what is next, and its Slack and PR links', async () => {
    serve(day({ items: [item({})] }));
    render(<MyDayPage />);
    expect(await screen.findByText('Review #9468')).toBeTruthy();
    expect(screen.getByText('Review the PR')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Slack' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_my_day_in_slack', { key: 'slack:C1:1.2' }));
    expect(screen.getByRole('link', { name: 'newton-web#9468' })).toBeTruthy();
  });

  it('sorts items into tabs, and keeps sessions in their own', async () => {
    serve(
      day({
        items: [
          item({ key: 'a', ask: 'needs it' }),
          item({ key: 'b', ask: 'reply only', state: 'ready', replyText: 'Sure' }),
          item({ key: 'c', ask: 'unfinished work', source: 'session', sessionId: 'id', permalink: null, prUrls: [] }),
        ],
      }),
    );
    render(<MyDayPage />);
    expect(await screen.findByText('needs it')).toBeTruthy();
    expect(screen.queryByText('reply only')).toBeNull();
    expect(screen.queryByText('unfinished work')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ready to send/ }));
    expect(screen.getByText('reply only')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sessions/ }));
    expect(screen.getByText('unfinished work')).toBeTruthy();
  });

  it('resumes a session by its key', async () => {
    serve(
      day({ items: [item({ key: 'session:x', source: 'session', sessionId: 'id', permalink: null, prUrls: [] })] }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Sessions/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('resume_my_day_session', { key: 'session:x' }));
  });

  it('shows why a resume failed', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'get_my_day') {
        return day({
          items: [item({ key: 'session:x', source: 'session', sessionId: 'id', permalink: null, prUrls: [] })],
        });
      }
      // Tauri commands reject with the Rust side's error string.
      return Promise.reject('that folder is gone');
    });
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Sessions/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(await screen.findByText(/that folder is gone/)).toBeTruthy();
  });

  it('runs now with the window typed, and turns the schedule on', async () => {
    serve(day());
    render(<MyDayPage />);
    await screen.findByText("It hasn't run yet.");
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '3d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('run_my_day_now', { span: '3d', prepareOnly: false }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Run every night/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_my_day_schedule', { enabled: true, runTime: '22:00' }),
    );
  });

  it('shows whether each PR is open or merged', async () => {
    const url = 'https://github.com/o/newton-web/pull/9468';
    serve(day({ items: [item({ prStates: { [url]: 'merged' } })] }));
    render(<MyDayPage />);
    expect(await screen.findByRole('link', { name: 'newton-web#9468 · merged' })).toBeTruthy();
  });

  it('says where a reply went, or why it could not be saved', async () => {
    serve(
      day({
        items: [
          item({ key: 'a', state: 'ready', replyText: 'One', draftStatus: 'saved' }),
          item({
            key: 'b',
            state: 'ready',
            replyText: 'Two',
            draftStatus: 'failed',
            draftError: 'attached_draft_exists',
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Ready to send/ }));
    expect(screen.getByText(/Saved as a draft in that thread/)).toBeTruthy();
    expect(screen.getByText(/attached_draft_exists/)).toBeTruthy();
  });

  it('skips and marks done, reloads, and only offers Reopen for what he closed', async () => {
    serve(
      day({
        items: [
          item({ key: 'open', ask: 'still open' }),
          item({ key: 'his', ask: 'he closed', state: 'done', ownerClosed: 'skipped' }),
          item({ key: 'run', ask: 'the run closed', state: 'done' }),
        ],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'open', how: 'skipped' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'open', how: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: /^Done/ }));
    expect(await screen.findByText('You skipped this.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Reopen' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'his', how: 'reopen' }));
  });

  it('sends Prepare only with Run now', async () => {
    serve(day());
    render(<MyDayPage />);
    await screen.findByText("It hasn't run yet.");
    fireEvent.click(screen.getByRole('checkbox', { name: /Prepare/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('run_my_day_now', { span: null, prepareOnly: true }));
  });

  it('saves a new run time on leaving the field, not while typing', async () => {
    serve(day({ enabled: true }));
    render(<MyDayPage />);
    await screen.findByText("It hasn't run yet.");
    const time = screen.getByLabelText('Run time');
    fireEvent.change(time, { target: { value: '23:30' } });
    expect(invoke).not.toHaveBeenCalledWith('save_my_day_schedule', expect.anything());
    fireEvent.blur(time);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_my_day_schedule', { enabled: true, runTime: '23:30' }),
    );
  });

  it('stops a second run while one is going, and says a failed run failed', async () => {
    const run = {
      status: 'FAILED',
      trigger: 'schedule',
      windowStart: '2026-11-01T00:00:00.000Z',
      windowEnd: '2026-11-02T00:00:00.000Z',
      startedAt: '2026-11-02T00:00:00.000Z',
      finishedAt: null,
      gaps: ['Group DMs were not read.'],
      error: 'the triage agent failed',
      costUsd: 1.25,
    };
    serve(day({ lastRun: run }));
    const { unmount } = render(<MyDayPage />);
    expect(await screen.findByText(/the triage agent failed/)).toBeTruthy();
    expect(screen.getByText('Group DMs were not read.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run now' }).disabled).toBe(false);
    unmount();
    serve(day({ lastRun: { ...run, status: 'RUNNING', error: null } }));
    render(<MyDayPage />);
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run now' }).disabled).toBe(true));
  });
});
