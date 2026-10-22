import { useEffect, useRef, useState } from 'react';
import { emojiChar, searchEmoji } from '../lib/emoji';

const QUICK = ['eyes', 'white_check_mark', 'x', '+1', 'pray', 'tada', '100', 'fire'];

type EmojiPickerProps = {
  onPick: (name: string) => void;
  onClose: () => void;
};

/** A small Slack-style picker: the usual reactions, plus search by name. */
export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const results = searchEmoji(query);
  const options = query.trim() ? results.map(emoji => ({ name: emoji.names[0], char: emoji.char })) : null;

  return (
    <div className="emoji-picker" ref={ref} role="dialog" aria-label="Pick a reaction">
      <input
        className="emoji-picker-search"
        autoFocus
        placeholder="Search emoji"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && options && options.length > 0) onPick(options[0].name);
        }}
      />
      <div className="emoji-picker-grid">
        {(options ?? QUICK.map(name => ({ name, char: emojiChar(name) ?? name }))).map(option => (
          <button
            key={option.name}
            type="button"
            className="emoji-picker-option"
            title={`:${option.name}:`}
            aria-label={`:${option.name}:`}
            onClick={() => onPick(option.name)}
          >
            {option.char}
          </button>
        ))}
        {options && options.length === 0 ? (
          <span className="muted emoji-picker-empty">No emoji named that.</span>
        ) : null}
      </div>
    </div>
  );
}
