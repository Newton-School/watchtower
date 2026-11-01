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
    expect(screen.getByRole('link', { name: 'Open in Slack' }).getAttribute('href')).toContain('/archives/C1/');
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('run_my_day_now', { span: '3d' }));
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_my_day_schedule', { enabled: true, runTime: '22:00' }),
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
