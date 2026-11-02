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
    action: null,
    jobStatus: null,
    prInfo: {},
    tapResult: null,
    deployJobId: null,
    deployStatus: null,
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function day(overrides: Partial<MyDay> = {}): MyDay {
  return {
    enabled: false,
    runTime: '22:00',
    runQueued: false,
    lastRun: null,
    items: [],
    policies: { review: 'auto', fix_own_pr: 'auto', open_pr: 'auto', tag: 'auto' },
    ...overrides,
  };
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
    expect(screen.getByText(/Saved as a draft in that conversation/)).toBeTruthy();
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

  it('shows a closed session in Done, where it can be reopened', async () => {
    serve(
      day({
        items: [item({ key: 'session:x', source: 'session', state: 'done', ownerClosed: 'done', ask: 'old work' })],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Done/ }));
    expect(screen.getByText('old work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it("warns about a draft left in Slack once the item is closed, and doesn't say to send it", async () => {
    serve(day({ items: [item({ key: 'a', state: 'done', replyText: 'One', draftStatus: 'saved' })] }));
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Done/ }));
    expect(screen.getByText(/its draft is still in Slack/)).toBeTruthy();
    expect(screen.queryByText(/Send it from Slack/)).toBeNull();
  });

  it('clears a load error once a later load works', async () => {
    invoke.mockRejectedValueOnce('no such column: owner_closed');
    invoke.mockImplementation(async () => day());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<MyDayPage />);
    expect(await screen.findByText(/no such column/)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(screen.queryByText(/no such column/)).toBeNull());
    vi.useRealTimers();
  });

  it('runs the work on his button, named for what it does', async () => {
    serve(day({ items: [item({ key: 'k', action: 'review_pr' })] }));
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review it' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('start_my_day_item', { key: 'k', text: null }));
  });

  it('offers no second start while a run waits for his answer, and hides a reply naming no PR yet', async () => {
    serve(
      day({
        items: [
          item({
            key: 'k',
            action: 'review_pr',
            jobId: 'j',
            jobStatus: 'PAUSED',
            replyText: 'Raised {PR_URL} for this.',
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    expect(await screen.findByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review it' })).toBeNull();
    expect(screen.queryByText(/\{PR_URL\}/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy reply' })).toBeNull();
  });

  it('sends his answer, and only with something typed', async () => {
    serve(day({ items: [item({ key: 'k' })] }));
    render(<MyDayPage />);
    const send = await screen.findByRole<HTMLButtonElement>('button', { name: 'Answer' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Your answer'), { target: { value: ' keep it P1 ' } });
    fireEvent.click(send);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('start_my_day_item', { key: 'k', text: 'keep it P1' }));
  });

  it('shows work under way in Waiting, with its run', async () => {
    const onOpenRun = vi.fn();
    serve(day({ items: [item({ key: 'k', state: 'working', jobId: 'job-1', ask: 'in progress' })] }));
    render(<MyDayPage onOpenRun={onOpenRun} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Waiting/ }));
    expect(screen.getByText('miniOG is on this now.')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Your answer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'See the run' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-1');
  });

  it('changes what runs on its own', async () => {
    serve(day());
    render(<MyDayPage />);
    await screen.findByText("It hasn't run yet.");
    fireEvent.change(screen.getByLabelText('New PRs for clear asks'), { target: { value: 'ask' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_my_day_policy', { name: 'open_pr', value: 'ask' }));
  });

  const prUrl = 'https://github.com/o/newton-web/pull/9468';
  const head = '0123456789abcdef0123456789abcdef01234567';

  it('merges only after asking, naming the PR and commit, and sends that commit', async () => {
    serve(day({ items: [item({ key: 'k', prInfo: { [prUrl]: { state: 'open', head, mine: false } } })] }));
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    expect(invoke).not.toHaveBeenCalledWith('my_day_pr_action', expect.anything());
    expect(screen.getByText('Merge newton-web#9468 at 0123456?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, merge' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('my_day_pr_action', { key: 'k', kind: 'merge', url: prUrl, head }),
    );
  });

  it('does nothing on Cancel', async () => {
    serve(day({ items: [item({ key: 'k', prInfo: { [prUrl]: { state: 'open', head, mine: false } } })] }));
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Yes, approve' })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('my_day_pr_action', expect.anything());
  });

  it('offers no Approve on his own PR, and nothing on a draft, an unread PR or a closed one', async () => {
    serve(
      day({
        items: [
          item({ key: 'mine', ask: 'mine', prInfo: { [prUrl]: { state: 'open', head, mine: true } } }),
          item({ key: 'draft', ask: 'draft', prInfo: { [prUrl]: { state: 'open', head, draft: true } } }),
          item({ key: 'closed', ask: 'closed', prInfo: { [prUrl]: { state: 'closed', head } } }),
          item({ key: 'unread', ask: 'unread' }),
        ],
      }),
    );
    render(<MyDayPage />);
    await screen.findByText('mine');
    expect(screen.getAllByRole('button', { name: 'Merge' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('offers Deploy only for a merged PR not yet live, and says a gate still follows', async () => {
    serve(
      day({
        items: [
          item({ key: 'k', state: 'done', prInfo: { [prUrl]: { state: 'merged', deployable: true } } }),
          item({
            key: 'live',
            state: 'done',
            ask: 'live',
            prInfo: { [prUrl]: { state: 'merged', deployable: false } },
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Done/ }));
    expect(screen.getAllByRole('button', { name: 'Deploy' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(screen.getByText(/confirm deploy/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, deploy' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('deploy_my_day_item', { key: 'k', url: prUrl }));
  });

  it('shows what came of a button, and the deploy it started', async () => {
    const onOpenRun = vi.fn();
    serve(day({ items: [item({ key: 'k', tapResult: 'Merged newton-web#9468 at 0123456.', deployJobId: 'job-9' })] }));
    render(<MyDayPage onOpenRun={onOpenRun} />);
    expect(await screen.findByText('Merged newton-web#9468 at 0123456.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'See the deploy' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-9');
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
