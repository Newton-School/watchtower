import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { emojiChar, searchEmoji } from '../lib/emoji';

const QUICK = ['eyes', 'white_check_mark', 'x', '+1', 'pray', 'tada', '100', 'fire'];
const WIDTH = 300;
const GAP = 6;

type EmojiPickerProps = {
  /** The button that opened it; the picker sits next to it and ignores clicks on it. */
  anchor: HTMLElement;
  onPick: (name: string) => void;
  onClose: () => void;
};

/**
 * A small Slack-style picker: the usual reactions, plus search by name. It
 * floats over the page so a scrolling thread can't cut it off.
 */
export function EmojiPicker({ anchor, onPick, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 300;
    const below = rect.bottom + GAP;
    const top = below + height > window.innerHeight - GAP ? Math.max(GAP, rect.top - height - GAP) : below;
    const left = Math.min(Math.max(GAP, rect.right - WIDTH), window.innerWidth - WIDTH - GAP);
    setPosition({ top, left });
  }, [anchor]);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) || anchor.contains(target));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) onClose();
    };
    // It is placed once, so close it when what's under it moves.
    const onScroll = (e: Event) => {
      if (!inside(e.target)) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const results = searchEmoji(query);
  const options = query.trim() ? results.map(emoji => ({ name: emoji.names[0], char: emoji.char })) : null;

  return createPortal(
    <div
      className="emoji-picker"
      ref={ref}
      role="dialog"
      aria-label="Pick a reaction"
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
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
    </div>,
    document.body,
  );
}
