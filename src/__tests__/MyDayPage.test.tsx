import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MyDay, MyDayItem, MyDayRun } from '../types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const toast = vi.fn();
vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toast(...args) }));

import { MyDayPage } from '../pages/MyDayPage';

const NOW = new Date().toISOString();
const DAYS_AGO = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

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
    nextStep: 'Plan it for next sprint? I would say yes.',
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
    firstSeenAt: NOW,
    sessionCwd: null,
    requestId: null,
    jobWorkflow: null,
    jobUpdatedAt: null,
    snoozedUntil: null,
    choices: [],
    lastSeenAt: NOW,
    ...overrides,
  };
}

function run(overrides: Partial<MyDayRun> = {}): MyDayRun {
  return {
    status: 'OK',
    trigger: 'schedule',
    windowStart: DAYS_AGO(1),
    windowEnd: NOW,
    startedAt: DAYS_AGO(0.5),
    finishedAt: DAYS_AGO(0.49),
    gaps: [],
    error: null,
    costUsd: 4.5,
    sweepCostUsd: 3.5,
    workCostUsd: 1,
    prepareOnly: false,
    ...overrides,
  };
}

function day(overrides: Partial<MyDay> = {}): MyDay {
  const runs = overrides.lastRun ? [overrides.lastRun] : [];
  return {
    enabled: false,
    runTime: '22:00',
    runQueued: false,
    lastRun: null,
    runs,
    items: [],
    policies: { review: 'auto', fix_own_pr: 'auto', open_pr: 'auto', tag: 'auto' },
    ...overrides,
  };
}

function serve(value: MyDay) {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'get_my_day') return value;
    if (command === 'close_my_day_items') return 2;
    return undefined;
  });
}

/** The card an ask is on, to press its own buttons. */
async function cardOf(ask: string): Promise<HTMLElement> {
  const title = await screen.findByText(ask);
  const card = title.closest('article');
  if (!card) throw new Error(`no card for ${ask}`);
  return card as HTMLElement;
}

function tab(name: RegExp) {
  return screen.getByRole('tab', { name });
}

describe('MyDayPage', () => {
  beforeEach(() => {
    invoke.mockReset();
    toast.mockReset();
  });
  afterEach(cleanup);

  it("shows a reply's links as text with their real address, never as a link its label could disguise", async () => {
    serve(
      day({
        items: [
          item({
            key: 'r',
            ask: 'a reply',
            state: 'ready',
            prUrls: [],
            replyText: 'Fixed in <https://phish.example/x|newton-web#9468>.',
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    const card = await cardOf('a reply');
    expect(within(card).getByText('Fixed in newton-web#9468 (https://phish.example/x).')).toBeTruthy();
    expect(within(card).queryAllByRole('link')).toHaveLength(0);
  });

  it('offers Undo after closing, but not once closing stopped work, which Undo could not bring back', async () => {
    const value = day({
      items: [
        item({ key: 'plain', ask: 'a plain one' }),
        item({ key: 'live', ask: 'a waiting run', jobId: 'j', jobStatus: 'PAUSED', nextStep: 'Which?' }),
        item({ key: 'late', ask: 'one that just started' }),
      ],
    });
    invoke.mockImplementation(async (command: string, args?: { key?: string }) => {
      if (command === 'get_my_day') return value;
      // The app says what closing stopped, including work begun since the page last looked.
      if (command === 'close_my_day_item') return args?.key !== 'plain';
      return undefined;
    });
    render(<MyDayPage />);
    fireEvent.click(within(await cardOf('a plain one')).getByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Skipped', expect.objectContaining({ action: expect.anything() })),
    );
    toast.mockReset();
    const live = await cardOf('a waiting run');
    expect(within(live).queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(within(live).queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.click(within(live).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Skipped, and its run was stopped', undefined));
    toast.mockReset();
    fireEvent.click(within(await cardOf('one that just started')).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Skipped, and its run was stopped', undefined));
  });

  it('opens a collapsed row on y rather than acting on what it does not show', async () => {
    serve(
      day({
        items: [
          item({
            key: 'old',
            ask: 'an old decision',
            firstSeenAt: DAYS_AGO(9),
            choices: [{ do: 'close', label: 'Close it' }],
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }));
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'y' });
    expect(invoke).not.toHaveBeenCalledWith('close_my_day_item', expect.anything());
    expect(await screen.findByRole('button', { name: /Close it/ })).toBeTruthy();
  });

  it('skips a big old pile in batches the app accepts', async () => {
    const old = Array.from({ length: 205 }, (_, index) =>
      item({ key: `old-${index}`, ask: `old ${index}`, firstSeenAt: DAYS_AGO(9) }),
    );
    serve(day({ items: old }));
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip all 205' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Skip all 205' }).at(-1)!);
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(call => call[0] === 'close_my_day_items').map(call => call[1].keys.length),
      ).toEqual([200, 5]),
    );
  });

  it('shows an ask with its question and suggestion, and its Slack and PR links', async () => {
    serve(day({ items: [item({})] }));
    render(<MyDayPage />);
    const card = await cardOf('Review #9468');
    expect(within(card).getByText('Plan it for next sprint?')).toBeTruthy();
    expect(within(card).getByText('miniOG suggests: Yes.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /Slack/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_my_day_in_slack', { key: 'slack:C1:1.2' }));
    expect(within(card).getByRole('link', { name: /newton-web#9468/ })).toBeTruthy();
  });

  it('sorts items into the four views, and keeps sessions and waiting out of Your move', async () => {
    serve(
      day({
        items: [
          item({ key: 'a', ask: 'needs it' }),
          item({ key: 'b', ask: 'reply only', state: 'ready', replyText: 'Sure' }),
          item({ key: 'c', ask: 'unfinished work', source: 'session', sessionId: 'id', permalink: null, prUrls: [] }),
          item({ key: 'd', ask: 'on Sam', state: 'waiting', evidence: 'Waiting on Sam to test it.' }),
          item({
            key: 'e',
            ask: 'reviewed it',
            state: 'done',
            requestId: 'q',
            action: 'review_pr',
            doneSummary: 'r#1: 2 comments',
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    expect(await screen.findByText('needs it')).toBeTruthy();
    expect(screen.getByText('reply only')).toBeTruthy();
    expect(screen.queryByText('unfinished work')).toBeNull();
    expect(screen.queryByText('on Sam')).toBeNull();
    expect(tab(/Your move/).textContent).toContain('2');
    fireEvent.click(tab(/Waiting/));
    expect(screen.getByText('Waiting on Sam to test it.')).toBeTruthy();
    fireEvent.click(tab(/Sessions/));
    expect(screen.getByText('unfinished work')).toBeTruthy();
    fireEvent.click(tab(/miniOG did/));
    expect(screen.getByText('reviewed it')).toBeTruthy();
    expect(screen.getByText('Reviewed')).toBeTruthy();
  });

  it('resumes a session by its key, and says why a resume failed', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'get_my_day') {
        return day({
          items: [
            item({ key: 'session:x', source: 'session', sessionId: 'id', permalink: null, prUrls: [], ask: 's' }),
          ],
        });
      }
      // Tauri commands reject with the Rust side's error string.
      return Promise.reject('that folder is gone');
    });
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /Sessions/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Resume in Terminal/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('resume_my_day_session', { key: 'session:x' }));
    expect(await screen.findByText(/that folder is gone/)).toBeTruthy();
  });

  it('sweeps now from the header, and with a window and look-only from settings', async () => {
    serve(day());
    render(<MyDayPage />);
    await screen.findByText(/Hasn't swept yet/);
    fireEvent.click(screen.getByRole('button', { name: /Sweep now/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('run_my_day_now', { span: null, prepareOnly: false }));
    fireEvent.click(screen.getByRole('button', { name: 'My day settings' }));
    const drawer = screen.getByRole('dialog', { name: 'My day settings' });
    fireEvent.change(within(drawer).getByLabelText('Sweep window'), { target: { value: '3d' } });
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /Only look/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sweep now' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('run_my_day_now', { span: '3d', prepareOnly: true }));
  });

  it('turns the schedule on, and saves a new time on leaving the field, not while typing', async () => {
    serve(day({ enabled: true }));
    render(<MyDayPage />);
    await screen.findAllByText(/Next sweep/);
    fireEvent.click(screen.getByRole('button', { name: 'My day settings' }));
    const time = screen.getByLabelText('Sweep time');
    fireEvent.change(time, { target: { value: '23:30' } });
    expect(invoke).not.toHaveBeenCalledWith('save_my_day_schedule', expect.anything());
    fireEvent.blur(time);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_my_day_schedule', { enabled: true, runTime: '23:30' }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Sweep every night/ }));
    // Ticking the box keeps the time just set, and the two saves land in order.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_my_day_schedule', { enabled: false, runTime: '23:30' }),
    );
    const saves = invoke.mock.calls.filter(([command]) => command === 'save_my_day_schedule').map(([, args]) => args);
    expect(saves).toEqual([
      { enabled: true, runTime: '23:30' },
      { enabled: false, runTime: '23:30' },
    ]);
  });

  it("says the week's cost covers only the sweeps it lists, when there were more", async () => {
    const runs = Array.from({ length: 14 }, (_, n) => run({ startedAt: DAYS_AGO(n * 0.4), costUsd: 1 }));
    serve(day({ lastRun: runs[0], runs }));
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'My day settings' }));
    expect(await screen.findByText(/^The last 14 sweeps cost \$14\.00/)).toBeTruthy();
  });

  it('changes what runs on its own', async () => {
    serve(day());
    render(<MyDayPage />);
    await screen.findByText(/Hasn't swept yet/);
    fireEvent.click(screen.getByRole('button', { name: 'My day settings' }));
    const group = screen.getByRole('group', { name: 'New PRs for clear asks' });
    fireEvent.click(within(group).getByRole('button', { name: 'Ask me' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('save_my_day_policy', { name: 'open_pr', value: 'ask' }));
  });

  it('offers to turn on the nightly sweep before it has ever run', async () => {
    serve(day());
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sweep every night at 22:00' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_my_day_schedule', { enabled: true, runTime: '22:00' }),
    );
  });

  it('shows whether each PR is open or merged, and when it could not tell if one is live', async () => {
    const url = 'https://github.com/o/newton-web/pull/9468';
    serve(
      day({
        items: [
          item({
            prStates: { [url]: 'merged' },
            prInfo: { [url]: { state: 'merged', deployable: false, deployUnknown: true } },
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    expect((await screen.findByRole('link', { name: /newton-web#9468/ })).textContent).toContain(
      'merged · not sure if live',
    );
  });

  it('says where a reply went, or why it could not be saved', async () => {
    serve(
      day({
        items: [
          item({ key: 'a', ask: 'one', state: 'ready', replyText: 'One', draftStatus: 'saved' }),
          item({
            key: 'b',
            ask: 'two',
            state: 'ready',
            replyText: 'Two',
            draftStatus: 'failed',
            draftError: 'attached_draft_exists',
          }),
          item({ key: 'c', ask: 'three', state: 'ready', replyText: 'Three', draftStatus: 'blocked' }),
        ],
      }),
    );
    render(<MyDayPage />);
    const saved = await cardOf('one');
    expect(within(saved).getByText('Draft waiting in Slack')).toBeTruthy();
    fireEvent.click(within(saved).getByRole('button', { name: /Open draft in Slack/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_my_day_in_slack', { key: 'a' }));
    expect(screen.getByText(/attached_draft_exists/)).toBeTruthy();
    expect(screen.getByText(/Slack keeps one per conversation/)).toBeTruthy();
  });

  it('marks a reply sent, and skips and marks done', async () => {
    serve(
      day({
        items: [
          item({ key: 'reply', ask: 'a reply', state: 'ready', replyText: 'Sure' }),
          item({ key: 'open', ask: 'still open' }),
        ],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(within(await cardOf('a reply')).getByRole('button', { name: /Sent/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'reply', how: 'done' }));
    const open = await cardOf('still open');
    fireEvent.click(within(open).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'open', how: 'skipped' }));
    fireEvent.click(within(open).getByRole('button', { name: /Done/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'open', how: 'done' }));
  });

  it('only offers Reopen for what he closed, and warns about a draft left in Slack', async () => {
    serve(
      day({
        items: [
          item({
            key: 'his',
            ask: 'he closed',
            state: 'done',
            ownerClosed: 'skipped',
            replyText: 'One',
            draftStatus: 'saved',
          }),
          item({ key: 'run', ask: 'the run closed', state: 'done', doneSummary: 'You merged it.' }),
        ],
      }),
    );
    render(<MyDayPage />);
    fireEvent.click(await screen.findByRole('tab', { name: /miniOG did/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(screen.getByText('You skipped')).toBeTruthy();
    expect(screen.getByText(/its draft is still in Slack/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Reopen' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'his', how: 'reopen' }));
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

  it('runs the work on his button, named for what it does and saying what will happen', async () => {
    serve(day({ items: [item({ key: 'k', action: 'review_pr', nextStep: null })] }));
    render(<MyDayPage />);
    expect(await screen.findByText(/posts its comments on GitHub. It never approves./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review it/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('start_my_day_item', { key: 'k', text: null }));
  });

  it('runs a run that stopped again, and shows why it stopped', async () => {
    serve(
      day({
        items: [
          item({
            key: 'k',
            action: 'review_pr',
            jobId: 'j',
            jobStatus: 'FAILED',
            nextStep: "The run didn't finish: usage limit See the run, then answer or run it again.",
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    expect(await screen.findByText("The run didn't finish: usage limit")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Run again/ }));
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
            nextStep: 'Which repo is this for?',
            replyText: 'Raised {PR_URL} for this.',
          }),
        ],
      }),
    );
    render(<MyDayPage />);
    expect(await screen.findByText('Which repo is this for?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review it|Run again/ })).toBeNull();
    expect(screen.queryByText(/\{PR_URL\}/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy reply/ })).toBeNull();
  });

  it('sends his answer, and only with something typed', async () => {
    serve(day({ items: [item({ key: 'k', jobId: 'j', jobStatus: 'PAUSED', nextStep: 'P1 or P2?' })] }));
    render(<MyDayPage />);
    const send = await screen.findByRole<HTMLButtonElement>('button', { name: 'Send answer' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Your answer to miniOG'), { target: { value: ' keep it P1 ' } });
    fireEvent.click(send);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('start_my_day_item', { key: 'k', text: 'keep it P1' }));
  });

  it('hands an ask to miniOG in his own words, saying what miniOG can and cannot do', async () => {
    serve(day({ items: [item({ key: 'k' })] }));
    render(<MyDayPage />);
    const card = await cardOf('Review #9468');
    fireEvent.click(within(card).getByRole('button', { name: /Hand to miniOG/ }));
    expect(within(card).getByText(/never merges, approves or deploys/)).toBeTruthy();
    fireEvent.change(within(card).getByPlaceholderText('What should miniOG do?'), {
      target: { value: 'look into it' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('start_my_day_item', { key: 'k', text: 'look into it' }));
  });

  it('shows work under way in Waiting, with its run', async () => {
    const onOpenRun = vi.fn();
    serve(day({ items: [item({ key: 'k', state: 'working', jobId: 'job-1', ask: 'in progress' })] }));
    render(<MyDayPage onOpenRun={onOpenRun} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Waiting/ }));
    expect(screen.getByText('miniOG is on this now.')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/miniOG/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'See the run' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-1');
  });

  describe('one-tap answers', () => {
    it('closes, snoozes or hands to miniOG, the suggested one first', async () => {
      serve(
        day({
          items: [
            item({
              key: 'k',
              nextStep: 'Plan it for next sprint?',
              choices: [
                { do: 'snooze', label: 'Plan for next week', days: 4 },
                { do: 'close', label: 'Close it' },
                { do: 'miniog', label: 'Have miniOG look', instruction: 'Look into the 403s on the proctor report.' },
              ],
            }),
          ],
        }),
      );
      render(<MyDayPage />);
      const card = await cardOf('Review #9468');
      const suggested = within(card).getByRole('button', { name: /Plan for next week/ });
      expect(suggested.className).toContain('primary-button');
      fireEvent.click(suggested);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('snooze_my_day_item', { key: 'k', until: expect.any(String) }),
      );
      const until = invoke.mock.calls.find(call => call[0] === 'snooze_my_day_item')?.[1].until as string;
      const days = (Date.parse(until) - Date.now()) / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(3);
      expect(days).toBeLessThan(5);

      fireEvent.click(within(card).getByRole('button', { name: /Close it/ }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'k', how: 'done' }));

      fireEvent.click(within(card).getByRole('button', { name: /Have miniOG look/ }));
      expect(invoke).not.toHaveBeenCalledWith('start_my_day_item', expect.anything());
      expect(within(card).getByText('miniOG will: Look into the 403s on the proctor report.')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: 'Start it' }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('start_my_day_item', {
          key: 'k',
          text: 'Look into the 403s on the proctor report.',
        }),
      );
    });
  });

  describe('snoozing and clearing', () => {
    it('snoozes from the menu, and keeps what he put off out of Your move until he brings it back', async () => {
      serve(
        day({
          items: [
            item({ key: 'now', ask: 'now one' }),
            item({ key: 'later', ask: 'later one', snoozedUntil: new Date(Date.now() + 3 * 864e5).toISOString() }),
          ],
        }),
      );
      render(<MyDayPage />);
      const card = await cardOf('now one');
      fireEvent.click(within(card).getByRole('button', { name: /Snooze/ }));
      fireEvent.click(within(card).getByRole('menuitem', { name: /Tomorrow morning/ }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('snooze_my_day_item', { key: 'now', until: expect.any(String) }),
      );
      expect(screen.queryByText('later one')).toBeNull();
      expect(tab(/Your move/).textContent).toContain('1');
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      fireEvent.click(within(await cardOf('later one')).getByRole('button', { name: 'Bring back now' }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('wake_my_day_item', { key: 'later' }));
    });

    it('puts what is over a week old together, and skips it all only after asking', async () => {
      serve(
        day({
          items: [
            item({ key: 'fresh', ask: 'fresh one' }),
            item({ key: 'old-1', ask: 'old one', firstSeenAt: DAYS_AGO(9) }),
            item({ key: 'old-2', ask: 'older one', firstSeenAt: DAYS_AGO(12), state: 'ready', replyText: 'Hi' }),
          ],
        }),
      );
      render(<MyDayPage />);
      expect(await screen.findByText('fresh one')).toBeTruthy();
      expect(screen.queryByText('old one')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Skip all 2' }));
      expect(invoke).not.toHaveBeenCalledWith('close_my_day_items', expect.anything());
      expect(screen.getByText(/won't raise them again unless someone asks again/)).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: 'Skip all 2' }).at(-1)!);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('close_my_day_items', { keys: ['old-2', 'old-1'], how: 'skipped' }),
      );
    });
  });

  describe('the keyboard', () => {
    it('moves with j and k, and acts on the focused item', async () => {
      serve(
        day({
          items: [
            item({ key: 'b', ask: 'second', firstSeenAt: DAYS_AGO(1) }),
            item({ key: 'a', ask: 'first', firstSeenAt: DAYS_AGO(0.1) }),
          ],
        }),
      );
      render(<MyDayPage />);
      await screen.findByText('first');
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'e' });
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'b', how: 'done' }));
      fireEvent.keyDown(window, { key: 'k' });
      fireEvent.keyDown(window, { key: 'x' });
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'a', how: 'skipped' }));
    });

    it('leaves work that is going to its Stop button, and never repeats an action on a held key', async () => {
      serve(
        day({
          items: [
            item({ key: 'live', ask: 'a waiting run', jobId: 'j', jobStatus: 'PAUSED', nextStep: 'Which?' }),
            item({ key: 'plain', ask: 'a plain one', firstSeenAt: DAYS_AGO(1) }),
          ],
        }),
      );
      render(<MyDayPage />);
      await screen.findByText('a waiting run');
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'x' });
      fireEvent.keyDown(window, { key: 'e' });
      fireEvent.keyDown(window, { key: 's' });
      expect(invoke).not.toHaveBeenCalledWith('close_my_day_item', expect.anything());
      expect(screen.queryByRole('menuitem', { name: /Tomorrow morning/ })).toBeNull();
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(window, { key: 'x', repeat: true });
      expect(invoke).not.toHaveBeenCalledWith('close_my_day_item', expect.anything());
      fireEvent.keyDown(window, { key: 'x' });
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_my_day_item', { key: 'plain', how: 'skipped' }));
    });

    it('ignores keys typed into a field, and switches views with numbers', async () => {
      serve(day({ items: [item({ key: 'k', jobId: 'j', jobStatus: 'PAUSED', nextStep: 'Which?' })] }));
      render(<MyDayPage />);
      const field = await screen.findByPlaceholderText('Your answer to miniOG');
      fireEvent.keyDown(window, { key: 'j' });
      fireEvent.keyDown(field, { key: 'e' });
      expect(invoke).not.toHaveBeenCalledWith('close_my_day_item', expect.anything());
      fireEvent.keyDown(window, { key: '4' });
      expect(tab(/Sessions/).getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('PR buttons', () => {
    const prUrl = 'https://github.com/o/newton-web/pull/9468';
    const head = '0123456789abcdef0123456789abcdef01234567';

    async function openDetails(ask = 'Review #9468') {
      const card = await cardOf(ask);
      fireEvent.click(within(card).getByRole('button', { name: /Details/ }));
      return card;
    }

    it('merges only after asking, naming the PR and commit, and sends that commit', async () => {
      serve(day({ items: [item({ key: 'k', prInfo: { [prUrl]: { state: 'open', head, mine: false } } })] }));
      render(<MyDayPage />);
      const card = await openDetails();
      fireEvent.click(within(card).getByRole('button', { name: 'Merge' }));
      expect(invoke).not.toHaveBeenCalledWith('my_day_pr_action', expect.anything());
      expect(within(card).getByText('Merge newton-web#9468 at 0123456?')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: 'Yes, merge' }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('my_day_pr_action', { key: 'k', kind: 'merge', url: prUrl, head }),
      );
    });

    it('asks with what GitHub says about the PR, not the words from Slack', async () => {
      const info = { state: 'open', head, mine: false, title: 'Real title', author: 'shiv', base: 'master' };
      serve(day({ items: [item({ key: 'k', ask: 'merge the harmless thing', prInfo: { [prUrl]: info } })] }));
      render(<MyDayPage />);
      const card = await openDetails('merge the harmless thing');
      fireEvent.click(within(card).getByRole('button', { name: 'Merge' }));
      expect(
        within(card).getByText('Merge newton-web#9468 at 0123456, "Real title" by shiv into master?'),
      ).toBeTruthy();
    });

    it('does nothing on Cancel', async () => {
      serve(day({ items: [item({ key: 'k', prInfo: { [prUrl]: { state: 'open', head, mine: false } } })] }));
      render(<MyDayPage />);
      const card = await openDetails();
      fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
      fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
      expect(within(card).queryByRole('button', { name: 'Yes, approve' })).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith('my_day_pr_action', expect.anything());
    });

    it('offers no Approve on his own PR, and nothing on a draft, an unread PR or a closed one', async () => {
      serve(
        day({
          items: [
            item({ key: 'mine', ask: 'my own PR', prInfo: { [prUrl]: { state: 'open', head, mine: true } } }),
            item({ key: 'draft', ask: 'a draft PR', prInfo: { [prUrl]: { state: 'open', head, draft: true } } }),
            item({ key: 'closed', ask: 'a closed PR', prInfo: { [prUrl]: { state: 'closed', head } } }),
            item({ key: 'unread', ask: 'an unread PR' }),
          ],
        }),
      );
      render(<MyDayPage />);
      for (const ask of ['my own PR', 'a draft PR', 'a closed PR', 'an unread PR']) await openDetails(ask);
      expect(screen.getAllByRole('button', { name: 'Merge' })).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    });

    it('offers Deploy only for a merged PR not yet live, and says a gate still follows', async () => {
      serve(
        day({
          items: [
            item({ key: 'k', ask: 'waiting to ship', prInfo: { [prUrl]: { state: 'merged', deployable: true } } }),
            item({ key: 'live', ask: 'live', prInfo: { [prUrl]: { state: 'merged', deployable: false } } }),
          ],
        }),
      );
      render(<MyDayPage />);
      const card = await cardOf('waiting to ship');
      expect(screen.getAllByRole('button', { name: 'Deploy' })).toHaveLength(1);
      fireEvent.click(within(card).getByRole('button', { name: 'Deploy' }));
      expect(within(card).getByText(/confirm deploy/)).toBeTruthy();
      expect(within(card).getByText(/other merged work may go too/)).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: 'Yes, deploy' }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('deploy_my_day_item', { key: 'k', url: prUrl }));
    });

    it('still offers the deploy of a closed item, from what miniOG did', async () => {
      serve(
        day({
          items: [
            item({
              key: 'b',
              state: 'done',
              ownerClosed: 'done',
              ask: 'shipped soon',
              prInfo: {
                [prUrl]: { state: 'merged', deployable: true, title: 'Ship the thing', author: 'shiv', base: 'main' },
              },
            }),
          ],
        }),
      );
      render(<MyDayPage />);
      fireEvent.click(await screen.findByRole('tab', { name: /miniOG did/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
      fireEvent.click(screen.getByRole('button', { name: /^Deploy/ }));
      expect(screen.getByText(/confirm deploy/)).toBeTruthy();
      expect(screen.getByText(/"Ship the thing" by shiv into main\?/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Yes, deploy' }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('deploy_my_day_item', { key: 'b', url: prUrl }));
    });

    it('shows what came of a button, and the deploy it started', async () => {
      const onOpenRun = vi.fn();
      serve(
        day({ items: [item({ key: 'k', tapResult: 'Merged newton-web#9468 at 0123456.', deployJobId: 'job-9' })] }),
      );
      render(<MyDayPage onOpenRun={onOpenRun} />);
      expect(await screen.findByText('Merged newton-web#9468 at 0123456.')).toBeTruthy();
      await openDetails();
      fireEvent.click(screen.getByRole('button', { name: 'See the deploy' }));
      expect(onOpenRun).toHaveBeenCalledWith('job-9');
    });
  });

  it('stops a second sweep while one is going, and says a failed sweep failed and what it missed', async () => {
    const failed = run({ status: 'FAILED', error: 'the triage agent failed', gaps: ['Group DMs were not read.'] });
    serve(day({ lastRun: failed }));
    const { unmount } = render(<MyDayPage />);
    expect(await screen.findByText(/the triage agent failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /1 blind spot/ }));
    expect(screen.getByText('Group DMs were not read.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Sweep now/ }).disabled).toBe(false);
    unmount();
    serve(day({ lastRun: run({ status: 'RUNNING', finishedAt: null }) }));
    render(<MyDayPage />);
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Sweeping/ }).disabled).toBe(true),
    );
  });

  it('shows what the last sweep cost, split between reading and work', async () => {
    serve(day({ lastRun: run({ costUsd: 4.5, sweepCostUsd: 1.25, workCostUsd: 3.25 }) }));
    render(<MyDayPage />);
    const cost = await screen.findByText('$4.50');
    expect(cost.getAttribute('title')).toBe('Reading Slack $1.25 · reviews and changes $3.25');
  });
});
