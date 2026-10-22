import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EmojiPicker } from '../components/EmojiPicker';

function open() {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onPick = vi.fn();
  render(<EmojiPicker anchor={anchor} onPick={onPick} onClose={vi.fn()} />);
  return onPick;
}

describe('EmojiPicker', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists every category and remembers what was picked', () => {
    const onPick = open();
    for (const category of ['Frequent', 'Smileys & Emotion', 'Food & Drink', 'Flags']) {
      expect(screen.getByRole('tab', { name: category })).toBeTruthy();
    }
    expect(screen.queryByRole('tab', { name: 'Component' })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: ':pizza:' })[0]);
    expect(onPick).toHaveBeenCalledWith('pizza');
    expect(JSON.parse(localStorage.getItem('watchtower.recentEmoji') ?? '[]')).toEqual(['pizza']);
  });

  it('searches by name and shows the hovered emoji name', () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('Search all emoji'), { target: { value: 'rocket' } });
    const rocket = screen.getByRole('button', { name: ':rocket:' });
    fireEvent.mouseEnter(rocket);

    expect(screen.getByText(':rocket:', { exact: false })).toBeTruthy();
  });
});
