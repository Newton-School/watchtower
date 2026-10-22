import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RunThread } from '../types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { SlackThread } from '../components/SlackThread';

function makeThread(overrides: Partial<RunThread> = {}): RunThread {
  return {
    hasThread: true,
    channelId: 'C1',
    channelName: 'miniog-testing',
    channelKind: 'channel',
    threadTs: '100.000001',
    triggerTs: '100.000001',
    botUserId: 'UBOT',
    permalink: 'https://example.slack.com/archives/C1/p100000001',
    users: {
      UOG: { name: 'theOG', avatarUrl: null, isBot: false },
      UBOT: { name: 'miniOG', avatarUrl: null, isBot: true },
    },
    messages: [
      {
        ts: '100.000001',
        user: 'UOG',
        text: '<@UBOT> what repos can you work on?',
        reactions: [{ name: 'white_check_mark', count: 1, users: ['UBOT'] }],
      },
      { ts: '1000.000002', user: 'UBOT', bot_id: 'B1', text: 'I can work on *newton-web*.' },
    ],
    replyCount: 1,
    truncated: false,
    readError: null,
    ...overrides,
  };
}

function respondWith(thread: RunThread) {
  invoke.mockImplementation((command: string) => {
    if (command === 'get_run_thread') return Promise.resolve(thread);
    if (command === 'get_slack_directory') return Promise.resolve({ people: [], groups: [] });
    if (command === 'get_slack_image') return Promise.resolve('data:image/png;base64,AAAA');
    return Promise.resolve(undefined);
  });
}

function messageRow(ts: string): HTMLElement {
  const row = document.querySelector(`[data-ts="${ts}"]`);
  if (!row) throw new Error(`no message ${ts}`);
  return row as HTMLElement;
}

describe('SlackThread', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the thread like Slack, marking the message that started the run', async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);

    expect(await screen.findByText('#miniog-testing')).toBeTruthy();
    expect(screen.getByText('Thread · 1 reply · you act as miniOG here')).toBeTruthy();
    const trigger = messageRow('100.000001');
    expect(within(trigger).getByText('theOG')).toBeTruthy();
    expect(within(trigger).getByText('started this run')).toBeTruthy();
    expect(within(trigger).getByText('@miniOG')).toBeTruthy();
    const reply = messageRow('1000.000002');
    expect(within(reply).getByText('APP')).toBeTruthy();
    expect(within(reply).getByText('newton-web').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'Open in Slack ↗' }).getAttribute('href')).toContain('slack.com');
  });

  it('posts a reply as miniOG on Enter and clears the box', async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);

    const box = await screen.findByRole('textbox', { name: 'Reply as miniOG' });
    fireEvent.change(box, { target: { value: 'On it.' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('post_as_miniog', { jobId: 'job-1', text: 'On it.', broadcast: false });
    });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });

  it("toggles miniOG's reaction from a pill and adds one from the picker", async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: "Remove miniOG's :white_check_mark:" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_miniog_reaction', {
        jobId: 'job-1',
        ts: '100.000001',
        name: 'white_check_mark',
        add: false,
      });
    });

    fireEvent.click(within(messageRow('1000.000002')).getByRole('button', { name: 'React as miniOG' }));
    fireEvent.click(screen.getAllByRole('button', { name: ':eyes:' })[0]);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_miniog_reaction', {
        jobId: 'job-1',
        ts: '1000.000002',
        name: 'eyes',
        add: true,
      });
    });
  });

  it("edits and deletes only miniOG's messages", async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);

    await screen.findByText('#miniog-testing');
    expect(within(messageRow('100.000001')).queryByRole('button', { name: 'Edit message' })).toBeNull();

    const reply = messageRow('1000.000002');
    fireEvent.click(within(reply).getByRole('button', { name: 'Edit message' }));
    const editor = within(reply).getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(editor, { target: { value: 'I can work on 3 repos.' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('edit_miniog_message', {
        jobId: 'job-1',
        ts: '1000.000002',
        text: 'I can work on 3 repos.',
      });
    });

    await waitFor(() => expect(within(reply).getByRole('button', { name: 'Delete message' })).toBeTruthy());
    fireEvent.click(within(reply).getByRole('button', { name: 'Delete message' }));
    fireEvent.click(within(reply).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('delete_miniog_message', { jobId: 'job-1', ts: '1000.000002' });
    });
  });

  it('shows a failed action without losing the draft', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'get_run_thread') return Promise.resolve(makeThread());
      return Promise.reject('Slack said not_in_channel');
    });
    render(<SlackThread jobId="job-1" />);

    const box = await screen.findByRole('textbox', { name: 'Reply as miniOG' });
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Slack said not_in_channel')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('hello');
  });

  it('reads the thread again every few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');
    const reads = () => invoke.mock.calls.filter(([command]) => command === 'get_run_thread').length;
    expect(reads()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(reads()).toBe(2);
  });

  it('offers the emoji sweep when Slack will not let the app read the thread', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'get_run_thread') {
        return Promise.resolve(makeThread({ messages: [], readError: { kind: 'noAccess', code: 'missing_scope' } }));
      }
      return Promise.resolve({ removed: ['eyes'], failed: [] });
    });
    render(<SlackThread jobId="job-1" />);

    fireEvent.click(await screen.findByRole('button', { name: "Remove miniOG's emojis from the run's message" }));

    expect(await screen.findByText('Removed 👀.')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('remove_job_reactions', { jobId: 'job-1', names: null });
  });

  it('Escape cancels an edit and is kept from the page', async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');

    const reply = messageRow('1000.000002');
    fireEvent.click(within(reply).getByRole('button', { name: 'Edit message' }));
    const editor = within(reply).getByRole('textbox', { name: 'Edit message' });
    const pageSawIt = vi.fn();
    window.addEventListener('keydown', pageSawIt);
    fireEvent.keyDown(editor, { key: 'Escape' });
    window.removeEventListener('keydown', pageSawIt);

    expect(within(reply).queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect(pageSawIt).not.toHaveBeenCalled();
  });

  it('keeps the last read on screen when a refresh hits a Slack hiccup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reads = [makeThread(), makeThread({ messages: [], readError: { kind: 'other', code: 'ratelimited' } })];
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === 'get_run_thread' ? (reads.length > 1 ? reads.shift() : reads[0]) : undefined),
    );
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(await screen.findByText("Couldn't refresh (Slack said ratelimited); showing the last read.")).toBeTruthy();
    expect(messageRow('1000.000002')).toBeTruthy();
  });

  it("doesn't offer Edit on a prompt with buttons, and escapes what you type", async () => {
    const thread = makeThread();
    thread.messages[1] = { ...thread.messages[1], blocks: [{ type: 'section' }, { type: 'actions' }] };
    respondWith(thread);
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');

    const reply = messageRow('1000.000002');
    expect(within(reply).queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(within(reply).getByRole('button', { name: 'Delete message' })).toBeTruthy();

    const box = screen.getByRole('textbox', { name: 'Reply as miniOG' });
    fireEvent.change(box, { target: { value: 'a < b & c, ask <@UOG>' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('post_as_miniog', {
        jobId: 'job-1',
        text: 'a &lt; b &amp; c, ask <@UOG>',
        broadcast: false,
      });
    });
  });

  it('focuses the picker search so typing finds an emoji', async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');

    fireEvent.click(within(messageRow('1000.000002')).getByRole('button', { name: 'React as miniOG' }));
    const search = screen.getByPlaceholderText('Search all emoji');
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: 'fire' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_miniog_reaction', {
        jobId: 'job-1',
        ts: '1000.000002',
        name: 'fire',
        add: true,
      });
    });
  });

  it('Escape closes a delete prompt even with focus back on the page', async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');

    const reply = messageRow('1000.000002');
    fireEvent.click(within(reply).getByRole('button', { name: 'Delete message' }));
    expect(within(reply).getByText('Delete this message for everyone?')).toBeTruthy();
    const pageSawIt = vi.fn();
    window.addEventListener('keydown', pageSawIt);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', pageSawIt);

    expect(within(reply).queryByText('Delete this message for everyone?')).toBeNull();
    expect(pageSawIt).not.toHaveBeenCalled();
  });

  it('closes the picker when its button is clicked again', async () => {
    respondWith(makeThread());
    render(<SlackThread jobId="job-1" />);
    await screen.findByText('#miniog-testing');

    const button = within(messageRow('1000.000002')).getByRole('button', { name: 'React as miniOG' });
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: 'Pick an emoji' })).toBeTruthy();
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'Pick an emoji' })).toBeNull();
  });

  it('shows Slack images inline and other files as chips', async () => {
    const thread = makeThread();
    thread.messages[1] = {
      ...thread.messages[1],
      files: [
        {
          id: 'F1',
          name: 'shot.png',
          mimetype: 'image/png',
          thumb_360: 'https://files.slack.com/files-tmb/T1-F1/shot_360.png',
          thumb_360_w: 360,
          thumb_360_h: 180,
          permalink: 'https://example.slack.com/files/F1',
        },
        { id: 'F2', name: 'notes.pdf', mimetype: 'application/pdf', permalink: 'https://example.slack.com/files/F2' },
      ],
    };
    respondWith(thread);
    render(<SlackThread jobId="job-1" />);

    const image = await screen.findByRole('img', { name: 'shot.png' });
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(invoke).toHaveBeenCalledWith('get_slack_image', {
      url: 'https://files.slack.com/files-tmb/T1-F1/shot_360.png',
      mimetype: 'image/png',
    });
    expect(screen.getByRole('link', { name: '📎 notes.pdf' })).toBeTruthy();

    // An image that won't decode falls back to a link to the file.
    fireEvent.error(image);
    expect(await screen.findByRole('link', { name: '🖼 shot.png' })).toBeTruthy();
  });

  it('renders nothing for a run without a Slack thread', async () => {
    invoke.mockResolvedValue(makeThread({ hasThread: false }));
    const { container } = render(<SlackThread jobId="job-1" />);

    await waitFor(() => expect(container.innerHTML).toBe(''));
  });
});
