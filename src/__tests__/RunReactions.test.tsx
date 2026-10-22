import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { RunReactions } from '../components/RunReactions';

describe('RunReactions', () => {
  beforeEach(() => {
    invoke.mockReset();
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
        return Promise.resolve({ hasMessage: true, reactions: null, readError: 'missing_scope' });
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
