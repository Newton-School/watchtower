import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { PeoplePicker } from '../components/PeoplePicker';
import type { SlackDirectory } from '../types';

const directory: SlackDirectory = {
  people: [
    { id: 'U1', name: 'Aditya Sisodia', realName: 'Aditya Sisodia', username: 'aditya', avatarUrl: null },
    { id: 'U2', name: 'theOG', realName: 'Dipesh Rajoria', username: 'dipesh.rajoria', avatarUrl: null },
    { id: 'U3', name: 'Adi K', realName: 'Aditi Kumar', username: 'aditi.kumar', avatarUrl: null },
    { id: 'U4', name: 'Dipesh Z', realName: 'Dipesh Zaveri', username: 'dipesh', avatarUrl: null },
  ],
  groups: [],
};

function Picker({
  initial,
  dir,
  loading,
  onSubmit,
}: {
  initial: string[];
  dir: SlackDirectory | null;
  loading?: boolean;
  onSubmit?: () => void;
}) {
  const [ids, setIds] = useState(initial);
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <PeoplePicker
        label="People"
        accessibleName="People on builder"
        ids={ids}
        onChange={setIds}
        directory={dir}
        loading={loading}
      />
    </form>
  );
}

const chips = () => screen.queryAllByRole('listitem').filter(item => item.className.includes('people-chip'));
const box = () => screen.getByRole('combobox', { name: 'Add a person to People on builder' });

describe('PeoplePicker', () => {
  it('shows the people on the bundle by name, and an unknown ID as itself', () => {
    render(<Picker initial={['U2', 'UGONE123']} dir={directory} />);
    expect(chips().map(chip => chip.textContent)).toEqual(['DDipesh Rajoria×', 'UUGONE123×']);
    expect(chips()[1].title).toBe('UGONE123 is not in the Slack workspace');
  });

  it('finds people by name, leaves out those already on it, and adds one on Enter without saving the page', () => {
    const onSubmit = vi.fn();
    render(<Picker initial={['U1']} dir={directory} onSubmit={onSubmit} />);

    fireEvent.change(box(), { target: { value: 'adi' } });
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'AAditi KumarAdi K · @aditi.kumar',
    ]);

    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(chips().map(chip => chip.textContent)).toEqual(['AAditya Sisodia×', 'AAditi Kumar×']);
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('finds people by @username or @display name, an exact @username first', () => {
    render(<Picker initial={[]} dir={directory} />);
    const names = () => screen.getAllByRole('option').map(option => option.textContent);

    fireEvent.change(box(), { target: { value: '@dipesh.rajoria' } });
    expect(names()).toEqual(['DDipesh RajoriatheOG · @dipesh.rajoria']);

    fireEvent.change(box(), { target: { value: '@theog' } });
    expect(names()).toEqual(['DDipesh RajoriatheOG · @dipesh.rajoria']);

    // Alphabetically Rajoria comes first, but @dipesh is Zaveri's username.
    fireEvent.change(box(), { target: { value: '@dipesh' } });
    expect(names()).toEqual(['DDipesh ZaveriDipesh Z · @dipesh', 'DDipesh RajoriatheOG · @dipesh.rajoria']);

    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(chips().map(chip => chip.textContent)).toEqual(['DDipesh Zaveri×']);
    expect(chips()[0].title).toBe('@dipesh · U4');
  });

  it('says it is still loading people, and suggests them once they arrive', () => {
    const { rerender } = render(<Picker initial={[]} dir={null} loading />);
    expect(box().getAttribute('placeholder')).toBe('Loading people from Slack…');

    fireEvent.change(box(), { target: { value: '@adi' } });
    expect(screen.getByRole('status').textContent).toBe('Still loading people from Slack…');

    rerender(<Picker initial={[]} dir={directory} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'AAditi KumarAdi K · @aditi.kumar',
      'AAditya Sisodia@aditya',
    ]);
  });

  it('removes a person', () => {
    render(<Picker initial={['U1', 'U2']} dir={directory} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Aditya Sisodia' }));
    expect(chips().map(chip => chip.textContent)).toEqual(['DDipesh Rajoria×']);
  });

  it('takes a Slack user ID when the workspace could not be read', () => {
    render(<Picker initial={[]} dir={null} />);
    expect(screen.getByText('Nobody yet.')).toBeTruthy();

    // A name is not taken for an ID.
    fireEvent.change(box(), { target: { value: 'williams' } });
    expect(screen.queryAllByRole('option')).toEqual([]);

    fireEvent.change(box(), { target: { value: 'u0abc1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user ID U0ABC1234' }));
    expect(chips().map(chip => chip.textContent)).toEqual(['UU0ABC1234×']);
  });

  it('does not pick a suggestion on the Enter that ends an IME composition', () => {
    render(<Picker initial={[]} dir={directory} />);
    fireEvent.change(box(), { target: { value: 'adi' } });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    expect(chips()).toEqual([]);
    expect(box().getAttribute('aria-activedescendant')).toBeTruthy();
  });
});
