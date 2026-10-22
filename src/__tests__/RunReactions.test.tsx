import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { RunReactions } from '../components/RunReactions';

describe('RunReactions', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists miniOG's emojis and removes one", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'get_job_reactions') {
        return Promise.resolve({ hasMessage: true, reactions: ['eyes', 'x'], readError: null });
      }
      return Promise.resolve({ removed: ['eyes'], failed: [] });
    });

    render(<RunReactions jobId="job-1" running={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove :eyes:' }));

    expect(await screen.findByText('Removed 👀.')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('remove_job_reactions', { jobId: 'job-1', names: ['eyes'] });
    expect(screen.getByRole('button', { name: 'Remove all' })).toBeTruthy();
  });

  it('offers a sweep when Slack will not let the app read the message', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'get_job_reactions') {
        return Promise.resolve({
          hasMessage: true,
          reactions: null,
          readError: { kind: 'noAccess', code: 'missing_scope' },
        });
      }
      return Promise.resolve({ removed: [], failed: [] });
    });

    render(<RunReactions jobId="job-2" running={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove any miniOG emojis' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('remove_job_reactions', { jobId: 'job-2', names: null });
    });
    expect(await screen.findByText('miniOG had no emojis left there.')).toBeTruthy();
  });

  it('says a deleted message has nothing to clean, without a sweep', async () => {
    invoke.mockResolvedValue({
      hasMessage: true,
      reactions: null,
      readError: { kind: 'deleted', code: 'thread_not_found' },
    });

    render(<RunReactions jobId="job-6" running={false} />);

    expect(await screen.findByText("That message was deleted, so there's nothing to clean.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove any miniOG emojis' })).toBeNull();
  });

  it('points to Settings when Slack rejects the token', async () => {
    invoke.mockResolvedValue({ hasMessage: true, reactions: null, readError: { kind: 'auth', code: 'invalid_auth' } });

    render(<RunReactions jobId="job-7" running={false} />);

    expect(await screen.findByText('Slack rejected the bot token (invalid_auth). Check it in Settings.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove any miniOG emojis' })).toBeNull();
  });

  it('reads the message again when the run ends', async () => {
    invoke.mockResolvedValueOnce({ hasMessage: true, reactions: ['eyes'], readError: null });
    invoke.mockResolvedValueOnce({ hasMessage: true, reactions: ['white_check_mark'], readError: null });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(<RunReactions jobId="job-8" running />);
    expect(await screen.findByRole('button', { name: 'Remove :eyes:' })).toBeTruthy();

    rerender(<RunReactions jobId="job-8" running={false} />);
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(await screen.findByRole('button', { name: 'Remove :white_check_mark:' })).toBeTruthy();
  });

  it('renders nothing for a run that did not start from a Slack message', async () => {
    invoke.mockResolvedValue({ hasMessage: false, reactions: null, readError: null });

    const { container } = render(<RunReactions jobId="job-3" running={false} />);

    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
  });

  it('says when nothing is left and notes a run still going', async () => {
    invoke.mockResolvedValue({ hasMessage: true, reactions: [], readError: null });

    render(<RunReactions jobId="job-4" running />);

    expect(await screen.findByText('None left on the message.')).toBeTruthy();
    expect(screen.getByText(/still going/)).toBeTruthy();
  });

  it('shows the error with a retry', async () => {
    invoke.mockRejectedValueOnce('Slack request failed: timeout');
    invoke.mockResolvedValueOnce({ hasMessage: true, reactions: ['zzz'], readError: null });

    render(<RunReactions jobId="job-5" running={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'Remove :zzz:' })).toBeTruthy();
  });
});
