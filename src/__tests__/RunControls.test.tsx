import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  messages: [
    { ts: '100.000001', user: 'UASKER', text: '<@UBOT> summarise this thread' },
    { ts: '100.000002', user: 'UBOT', bot_id: 'B1', text: 'Here you go.' },
  ],
  replyCount: 1,
  truncated: false,
  readError: null,
};

const idle: RunControls = {
  canStop: false,
  rerunAsk: 'summarise this thread',
  rerunFor: 'UASKER',
  busyJobId: null,
  busyWaiting: false,
  starting: false,
  answer: null,
};

/** miniOG waits at a gate mid-run in job-1, on its reply at 100.000002. */
const waitingOnPlan: RunControls = {
  ...idle,
  canStop: true,
  busyJobId: 'job-1',
  busyWaiting: true,
  answer: { jobId: 'job-1', kind: 'approval', promptTs: '100.000002', answerBy: [] },
};

// One directory for the whole file: the app shares its first read.
const directory = { people: [{ id: 'UASKER', name: 'rahul', realName: 'Rahul K', avatarUrl: null }], groups: [] };

type Overrides = {
  started?: StartedRunStatus[];
  askTs?: string | null;
  fail?: Record<string, string>;
  read?: RunThread;
};

function respondWith(
  controls: RunControls | (() => RunControls),
  { started = [], askTs = null, fail = {}, read = thread }: Overrides = {},
) {
  const current = () => (typeof controls === 'function' ? controls() : controls);
  invoke.mockImplementation((command: string) => {
    if (fail[command]) return Promise.reject(fail[command]);
    if (command === 'get_run_thread') return Promise.resolve(read);
    if (command === 'get_run_controls') return Promise.resolve(current());
    if (command === 'get_slack_directory') return Promise.resolve(directory);
    if (command === 'rerun_in_thread' || command === 'ask_miniog_in_thread')
      return Promise.resolve({ requestId: 'req-1', askTs, answersJobId: null });
    if (command === 'answer_miniog')
      return Promise.resolve({ requestId: 'req-1', askTs, answersJobId: current().answer?.jobId ?? null });
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
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('stop_run', { jobId: 'job-1' }));
    expect(await screen.findAllByText('Stopping…')).toHaveLength(2);
  });

  it('shows a failed stop next to the controls', async () => {
    respondWith(
      { ...idle, canStop: true, busyJobId: 'job-1', rerunAsk: null },
      { fail: { stop_run: 'This run has already finished.' } },
    );
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop' }));

    expect((await screen.findByRole('alert')).textContent).toBe('This run has already finished.');
    expect(screen.getByRole('group', { name: 'Stop this run' })).toBeTruthy();
  });

  it('re-runs the ask for its requester, posting it, and follows the new run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respondWith(idle, {
      started: [
        { status: 'PENDING', jobId: null, error: null },
        { status: 'RUNNING', jobId: 'job-2', error: null },
      ],
    });
    const onOpenRun = vi.fn();
    render(<SlackThread jobId="job-1" onOpenRun={onOpenRun} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }));
    const panel = screen.getByRole('group', { name: 'Re-run this ask' });
    expect(panel.textContent).toContain('Re-run for @rahul, on your authority:');
    expect(panel.textContent).toContain('summarise this thread');
    expect((within(panel).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run now' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('rerun_in_thread', { jobId: 'job-1', postAsk: true }));
    expect(await screen.findByText('Waiting for miniOG to pick up your re-run…')).toBeTruthy();

    vi.advanceTimersByTime(4100);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the new run →' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-2');
  });

  it('re-runs silently and remembers the choice', async () => {
    respondWith(idle);
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Post the ask in the thread' }));
    expect(screen.getByText('Nothing is posted, not even an emoji; miniOG just starts answering here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run now' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('rerun_in_thread', { jobId: 'job-1', postAsk: false }));
    expect(window.localStorage.getItem('watchtower.rerunPostsAsk')).toBe('0');
  });

  it('Escape closes the re-run panel without leaving the page', async () => {
    respondWith(idle);
    render(<SlackThread jobId="job-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }));

    const pageSawIt = vi.fn();
    window.addEventListener('keydown', pageSawIt);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', pageSawIt);

    expect(screen.queryByRole('group', { name: 'Re-run this ask' })).toBeNull();
    expect(pageSawIt).not.toHaveBeenCalled();
  });

  it('Escape closes the newest layer first: the @-suggestions, then the panel', async () => {
    respondWith(idle);
    render(<SlackThread jobId="job-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run' }));

    const box = screen.getByRole('textbox', { name: 'Reply as miniOG' });
    fireEvent.change(box, { target: { value: '@ra', selectionStart: 3 } });
    expect(await screen.findByRole('listbox', { name: 'People to mention' })).toBeTruthy();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'People to mention' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Re-run this ask' })).toBeTruthy();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Re-run this ask' })).toBeNull();
  });

  it('holds new runs while another run works in the thread', async () => {
    respondWith({ ...idle, busyJobId: 'job-9' });
    const onOpenRun = vi.fn();
    render(<SlackThread jobId="job-1" onOpenRun={onOpenRun} />);

    expect(await screen.findByText('miniOG is working on another run in this thread.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Re-run' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-9');

    fireEvent.click(screen.getByRole('button', { name: 'Ask miniOG' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask miniOG' }), { target: { value: 'check it' } });
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('miniOG is already working in this thread.')).toBeTruthy();
  });

  it('treats a run waiting for an answer as holding the thread', async () => {
    respondWith({ ...idle, canStop: true, busyJobId: 'job-1', busyWaiting: true });
    render(<SlackThread jobId="job-1" />);

    expect(await screen.findByText('miniOG is waiting for an answer on this run.')).toBeTruthy();
    const rerun = screen.getByRole('button', { name: 'Re-run' }) as HTMLButtonElement;
    expect(rerun.disabled).toBe(true);
    expect(rerun.title).toBe(
      'miniOG is waiting for an answer in this thread. Answer it below, or stop that run to start another.',
    );
  });

  it('answers miniOG while it waits mid-run, and the run carries on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respondWith(waitingOnPlan, { started: [{ status: 'SUCCESS', jobId: 'job-1', error: null }] });
    const onOpenRun = vi.fn();
    render(<SlackThread jobId="job-1" onOpenRun={onOpenRun} />);

    const question = (await screen.findByText('Here you go.')).closest('[data-ts]') as HTMLElement;
    expect(await within(question).findByText('waiting for an answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask miniOG' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answer miniOG' }));
    const box = screen.getByRole('textbox', { name: 'Answer miniOG' }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe('Answer miniOG: yes to go ahead, no, or what to change…');
    expect((screen.getByRole('checkbox', { name: 'Post the answer in the thread' }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.change(box, { target: { value: 'yes' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('answer_miniog', { jobId: 'job-1', text: 'yes', postAnswer: true }),
    );
    expect(await screen.findByRole('textbox', { name: 'Reply as miniOG' })).toBeTruthy();
    expect(await screen.findByText('Waiting for miniOG to pick up your answer…')).toBeTruthy();
    vi.advanceTimersByTime(2000);
    expect(await screen.findByText('miniOG took your answer.')).toBeTruthy();
    // The answer went into this run: nothing new to open.
    expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
  });

  it('picks a paused run up again silently, remembers that, and follows the new run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respondWith(
      {
        ...idle,
        busyJobId: 'job-7',
        busyWaiting: true,
        answer: { jobId: 'job-7', kind: 'paused', promptTs: null, answerBy: [] },
      },
      { started: [{ status: 'RUNNING', jobId: 'job-8', error: null }] },
    );
    const onOpenRun = vi.fn();
    render(<SlackThread jobId="job-1" onOpenRun={onOpenRun} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Answer miniOG' }));
    const box = screen.getByRole('textbox', { name: 'Answer miniOG' }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe('Answer miniOG to pick this up again…');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Post the answer in the thread' }));
    expect(screen.getByText('Nothing is posted; miniOG just carries on with your answer.')).toBeTruthy();
    expect(window.localStorage.getItem('watchtower.answerPostsInThread')).toBe('0');
    fireEvent.change(box, { target: { value: 'use the staging data' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('answer_miniog', {
        jobId: 'job-1',
        text: 'use the staging data',
        postAnswer: false,
      }),
    );
    vi.advanceTimersByTime(2000);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the new run →' }));
    expect(onOpenRun).toHaveBeenCalledWith('job-8');
  });

  it("can't answer a question meant for someone else", async () => {
    respondWith({
      ...waitingOnPlan,
      answer: { jobId: 'job-1', kind: 'confirm', promptTs: '100.000002', answerBy: ['UASKER'] },
    });
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Answer miniOG' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer miniOG' }), { target: { value: 'confirm deploy' } });
    expect((screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Only @rahul can answer this, in Slack.')).toBeTruthy();
  });

  it('never sends an ask as an answer when miniOG starts waiting under it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let controls: RunControls = { ...idle, rerunAsk: null };
    respondWith(() => controls);
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ask miniOG' }));
    const box = screen.getByRole('textbox', { name: 'Ask miniOG' });
    fireEvent.change(box, { target: { value: 'deploy it' } });

    controls = waitingOnPlan;
    vi.advanceTimersByTime(5000);
    expect(
      await screen.findByText('miniOG is waiting for an answer now. Pick Answer miniOG to send this as the answer.'),
    ).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('ask_miniog_in_thread', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('answer_miniog', expect.anything());

    // Picking Answer sends the same words as the answer.
    fireEvent.click(screen.getByRole('button', { name: 'Answer miniOG' }));
    expect((screen.getByRole('textbox', { name: 'Answer miniOG' }) as HTMLTextAreaElement).value).toBe('deploy it');
  });

  it('asks miniOG from the composer, then goes back to replying', async () => {
    respondWith({ ...idle, rerunAsk: null });
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ask miniOG' }));
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
    const reply = await screen.findByRole('textbox', { name: 'Reply as miniOG' });
    expect((reply as HTMLTextAreaElement).value).toBe('');
  });

  it("says why miniOG didn't start a run", async () => {
    respondWith(
      { ...idle, rerunAsk: null },
      {
        askTs: '100.000009',
        started: [
          {
            status: 'SKIPPED',
            jobId: null,
            error: 'miniOG is already working in this thread. The posted ask was taken back.',
          },
        ],
      },
    );
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ask miniOG' }));
    const box = screen.getByRole('textbox', { name: 'Ask miniOG' });
    fireEvent.change(box, { target: { value: 'check it' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(
      await screen.findByText(
        "miniOG didn't start your ask: miniOG is already working in this thread. The posted ask was taken back.",
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
  });

  it('cancels a run miniOG has not picked up', async () => {
    respondWith({ ...idle, rerunAsk: null }, { started: [{ status: 'PENDING', jobId: null, error: null }] });
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ask miniOG' }));
    const box = screen.getByRole('textbox', { name: 'Ask miniOG' });
    fireEvent.change(box, { target: { value: 'check it' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cancel_started_run', { jobId: 'job-1', requestId: 'req-1' }),
    );
    expect(await screen.findByText('Cancelled your ask before miniOG took it.')).toBeTruthy();
  });

  it('warns that deleting the message that started a running run stops it', async () => {
    // A posted ask: miniOG's own message started the run.
    respondWith({ ...idle, canStop: true, busyJobId: 'job-1' }, { read: { ...thread, triggerTs: '100.000002' } });
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('miniOG is working on this run.');

    const trigger = document.querySelector('[data-ts="100.000002"]') as HTMLElement;
    fireEvent.click(within(trigger).getByRole('button', { name: 'Delete message' }));
    expect(
      within(trigger).getByText('Delete this message for everyone? It started this run, so the run stops too.'),
    ).toBeTruthy();
  });

  it('lets a paste into an ask through, even when it carries an image', async () => {
    respondWith(idle);
    render(<SlackThread jobId="job-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask miniOG' }));

    const file = new File(['x'], 'cells.png', { type: 'image/png' });
    const allowed = fireEvent.paste(screen.getByRole('textbox', { name: 'Ask miniOG' }), {
      clipboardData: { files: [file], types: ['Files', 'text/plain'] },
    });
    expect(allowed).toBe(true);
    expect(screen.queryByText(/Files go with a reply/)).toBeNull();
  });
});
