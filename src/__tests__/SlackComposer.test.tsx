import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { SlackComposer, applyMentions } from '../components/SlackComposer';

const directory = {
  people: [
    { id: 'U1', name: 'Aditya Sisodia', realName: 'Aditya Sisodia', username: 'aditya', avatarUrl: null },
    { id: 'U2', name: 'theOG', realName: 'Dipesh Rajoria', username: 'dipesh.rajoria', avatarUrl: null },
    { id: 'U3', name: 'Adi K', realName: 'Aditi Kumar', username: 'aditi', avatarUrl: null },
  ],
  groups: [{ id: 'S1', handle: 'core-dev', name: 'Core dev' }],
};

function setup(participants: string[] = []) {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<SlackComposer busy={false} participants={participants} onSend={onSend} />);
  return { onSend, box: screen.getByRole('textbox', { name: 'Reply as miniOG' }) as HTMLTextAreaElement };
}

function type(box: HTMLTextAreaElement, value: string) {
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

describe('SlackComposer', () => {
  beforeEach(() => {
    // jsdom has no object URLs; image attachments use them for previews.
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    invoke.mockReset();
    invoke.mockImplementation((command: string) =>
      command === 'get_slack_directory' ? Promise.resolve(directory) : Promise.resolve(undefined),
    );
  });

  it('suggests people as you type @, thread people first, and posts a real mention', async () => {
    const { onSend, box } = setup(['U3']);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_slack_directory'));

    type(box, 'thanks @adi');
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['@Adi KAditi Kumar', '@Aditya Sisodia']);

    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('thanks @Aditya Sisodia ');
    expect(screen.queryByRole('listbox')).toBeNull();

    type(box, 'thanks @Aditya Sisodia for this');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ text: 'thanks <@U1> for this', broadcast: false, files: [] });
    });
  });

  it('finds a person by their Slack username', async () => {
    const { onSend, box } = setup();

    type(box, 'cc @dipesh.r');
    fireEvent.click(await screen.findByRole('button', { name: /theOG/ }));
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ text: 'cc <@U2>', broadcast: false, files: [] });
    });
  });

  it('mentions user groups by handle', async () => {
    // The directory read in the first test is shared, as in the app.
    const { onSend, box } = setup();

    type(box, 'cc @core');
    fireEvent.click(await screen.findByRole('button', { name: /core-dev/ }));
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith({ text: 'cc <!subteam^S1|@core-dev>', broadcast: false, files: [] });
    });
  });

  it('sends to the channel too when asked, and attaches files without that option', async () => {
    const { onSend, box } = setup();
    type(box, 'heads up');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also send to channel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ text: 'heads up', broadcast: true, files: [] }));

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Files to attach'), { target: { files: [file] } });
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Also send to channel' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith({ text: '', broadcast: false, files: [file] }));
  });

  it('sends once when Enter is pressed again while files are being read', async () => {
    let finish: (sent: boolean) => void = () => {};
    const onSend = vi.fn(() => new Promise<boolean>(resolve => (finish = resolve)));
    render(<SlackComposer busy={false} participants={[]} onSend={onSend} />);
    const box = screen.getByRole('textbox', { name: 'Reply as miniOG' });
    fireEvent.change(screen.getByLabelText('Files to attach'), {
      target: { files: [new File(['a'], 'a.txt', { type: 'text/plain' })] },
    });

    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    finish(true);

    await waitFor(() => expect(screen.queryByText('a.txt')).toBeNull());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('takes files dropped on it', () => {
    setup();
    const file = new File(['img'], 'drop.png', { type: 'image/png' });
    const form = screen.getByRole('textbox', { name: 'Reply as miniOG' }).closest('form') as HTMLFormElement;
    fireEvent.drop(form, { dataTransfer: { files: [file], types: ['Files'] } });

    expect(screen.getByText('drop.png')).toBeTruthy();
  });

  it('says why a file is refused even when others in the same pick attach', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Files to attach'), {
      target: { files: [new File([], 'blank.txt'), new File(['a'], 'a.txt')] },
    });

    expect(screen.getByText("blank.txt is empty, so it can't be attached.")).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
  });

  it('attaches at most 10 files and says so', () => {
    setup();
    const files = Array.from({ length: 12 }, (_, i) => new File(['x'], `f${i}.txt`));
    fireEvent.change(screen.getByLabelText('Files to attach'), { target: { files } });

    expect(screen.getByText('Up to 10 files and 50 MB go in one reply.')).toBeTruthy();
    expect(screen.queryByText('f10.txt')).toBeNull();
    expect(screen.getByText('f9.txt')).toBeTruthy();
  });

  it('refuses files over 20 MB', () => {
    setup();
    const big = new File(['x'], 'huge.mov');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Files to attach'), { target: { files: [big] } });

    expect(screen.getByText("huge.mov is over 20 MB, so it can't be attached.")).toBeTruthy();
  });

  it('inserts an emoji from the picker', async () => {
    const { box } = setup();
    type(box, 'done ');
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    fireEvent.click(screen.getAllByRole('button', { name: ':tada:' })[0]);

    expect(box.value).toBe('done :tada: ');
  });
});

describe('applyMentions', () => {
  it('swaps labels for mention markup, longest label first', () => {
    const text = applyMentions('ask @Sam K and @Sam &amp; co', [
      { label: '@Sam', token: '<@U1>' },
      { label: '@Sam K', token: '<@U2>' },
    ]);
    expect(text).toBe('ask <@U2> and <@U1> &amp; co');
  });

  it("doesn't match inside a longer name or inside another mention's markup", () => {
    expect(applyMentions('@Samantha and @Sam', [{ label: '@Sam', token: '<@U1>' }])).toBe('@Samantha and <@U1>');
    expect(
      applyMentions('@core-dev and @core', [
        { label: '@core-dev', token: '<!subteam^S1|@core-dev>' },
        { label: '@core', token: '<@U9>' },
      ]),
    ).toBe('<!subteam^S1|@core-dev> and <@U9>');
  });
});

describe('applyMentions word boundary', () => {
  it('leaves longer hand-typed names and email addresses alone', () => {
    const mentions = [
      { label: '@core', token: '<@U9>' },
      { label: '@dipesh', token: '<@U1>' },
    ];
    expect(applyMentions('@core-dev @dipesh.rajoria x@dipesh.com', mentions)).toBe(
      '@core-dev @dipesh.rajoria x@dipesh.com',
    );
    expect(applyMentions('ping @core. and @dipesh, thanks', mentions)).toBe('ping <@U9>. and <@U1>, thanks');
  });
});
