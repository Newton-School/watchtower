import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RunControls, RunThread, StartedRunStatus } from '../types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { SlackThread } from '../components/SlackThread';

const thread: RunThread = {
  hasThread: true,
  channelId: 'C1',
  channelName: 'miniog-testing',
  channelKind: 'channel',
  threadTs: '100.000001',
  triggerTs: '100.000001',
  botUserId: 'UBOT',
  permalink: null,
  users: {
    UASKER: { name: 'rahul', avatarUrl: null, isBot: false },
    UBOT: { name: 'miniOG', avatarUrl: null, isBot: true },
  },
  messages: [{ ts: '100.000001', user: 'UASKER', text: '<@UBOT> summarise this thread' }],
  replyCount: 0,
  truncated: false,
  readError: null,
};

const idle: RunControls = {
  canStop: false,
  rerunAsk: 'summarise this thread',
  rerunFor: 'UASKER',
  busyJobId: null,
  starting: false,
};

function respondWith(controls: RunControls, started: StartedRunStatus[] = []) {
  invoke.mockImplementation((command: string) => {
    if (command === 'get_run_thread') return Promise.resolve(thread);
    if (command === 'get_run_controls') return Promise.resolve(controls);
    if (command === 'get_slack_directory') return Promise.resolve({ people: [], groups: [] });
    if (command === 'rerun_in_thread' || command === 'ask_miniog_in_thread')
      return Promise.resolve({ requestId: 'req-1', askTs: null });
    if (command === 'get_started_run') return Promise.resolve(started.length > 1 ? started.shift() : started[0]);
    return Promise.resolve(undefined);
  });
}

describe('run controls in the thread view', () => {
  beforeEach(() => {
    invoke.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops a run after a confirm', async () => {
    respondWith({ ...idle, canStop: true, busyJobId: 'job-1', rerunAsk: null });
    render(<SlackThread jobId="job-1" />);

    expect(await screen.findByText('miniOG is working on this run.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '■ Stop run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stop_run', { jobId: 'job-1' }));
  });

  it('re-runs the ask for its requester, posting it, and follows the new run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respondWith(idle, [
      { status: 'PENDING', jobId: null, error: null },
      { status: 'RUNNING', jobId: 'job-2', error: null },
    ]);
    const onOpenRun = vi.fn();
    render(<SlackThread jobId="job-1" onOpenRun={onOpenRun} />);

    fireEvent.click(await screen.findByRole('button', { name: '↻ Re-run' }));
    const panel = screen.getByRole('group', { name: 'Re-run this ask' });
    expect(panel.textContent).toContain('Re-run for @rahul, on your authority:');
    expect(panel.textContent).toContain('summarise this thread');
    expect((screen.getByRole('checkbox', { name: 'Post the ask in the thread' }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('rerun_in_thread', { jobId: 'job-1', postAsk: true }));
    expect(await screen.findByText('Waiting for miniOG to pick up your re-run…')).toBeTruthy();

    vi.advanceTimersByTime(4100);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the new run →' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-2');
  });

  it('re-runs silently and remembers the choice', async () => {
    respondWith(idle);
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: '↻ Re-run' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Post the ask in the thread' }));
    expect(screen.getByText('Nothing is posted; miniOG just starts answering here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('rerun_in_thread', { jobId: 'job-1', postAsk: false }));
    expect(window.localStorage.getItem('watchtower.rerunPostsAsk')).toBe('0');
  });

  it('holds new runs while another run works in the thread', async () => {
    respondWith({ ...idle, busyJobId: 'job-9' });
    const onOpenRun = vi.fn();
    render(<SlackThread jobId="job-1" onOpenRun={onOpenRun} />);

    expect(await screen.findByText('miniOG is working on another run in this thread.')).toBeTruthy();
    expect((screen.getByRole('button', { name: '↻ Re-run' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-9');

    fireEvent.click(screen.getByRole('tab', { name: 'Ask miniOG' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask miniOG' }), { target: { value: 'check it' } });
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('miniOG is already working in this thread.').length).toBeGreaterThan(0);
  });

  it('asks miniOG from the composer and says why a run did not start', async () => {
    respondWith({ ...idle, rerunAsk: null }, [
      { status: 'SKIPPED', jobId: null, error: 'miniOG is already working in this thread.' },
    ]);
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Ask miniOG' }));
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true);
    const box = screen.getByRole('textbox', { name: 'Ask miniOG' });
    fireEvent.change(box, { target: { value: 'what changed in <this> PR?' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('ask_miniog_in_thread', {
        jobId: 'job-1',
        text: 'what changed in &lt;this&gt; PR?',
        postAsk: true,
      }),
    );
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(
      await screen.findByText(
        "miniOG didn't start your ask: miniOG is already working in this thread.",
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
  });
});
