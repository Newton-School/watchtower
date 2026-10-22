import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EMOJI, EMOJI_CATEGORIES, emojiChar, searchEmoji } from '../lib/emoji';
import { useEscapeLayer } from '../lib/escapeLayers';
import type { Emoji } from '../lib/emoji';

const WIDTH = 340;
const GAP = 6;
const RECENT_KEY = 'watchtower.recentEmoji';
const MAX_RECENT = 16;
// Shown before anything has been picked on this Mac.
const STARTERS = ['eyes', 'white_check_mark', 'x', '+1', 'pray', 'tada', '100', 'fire'];

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

function rememberPick(name: string) {
  try {
    const next = [name, ...readRecent().filter(recent => recent !== name)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A convenience only; picking still works.
  }
}

type EmojiPickerProps = {
  /** The button that opened it; the picker sits next to it and ignores clicks on it. */
  anchor: HTMLElement;
  onPick: (name: string) => void;
  onClose: () => void;
};

/**
 * A Slack-style emoji picker: search, recently used, and every standard emoji
 * by category. It floats over the page so a scrolling thread can't cut it off.
 */
export function EmojiPicker({ anchor, onPick, onClose }: EmojiPickerProps) {
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const recent = readRecent();
    const recentEmoji = (recent.length > 0 ? recent : STARTERS)
      .map(name => ({ char: emojiChar(name), names: [name] }))
      .filter((emoji): emoji is Emoji => emoji.char !== null);
    const byCategory = EMOJI_CATEGORIES.filter(category => category !== 'Component').map(category => ({
      category,
      emoji: EMOJI.filter(emoji => emoji.category === category),
    }));
    return [{ category: recent.length > 0 ? 'Recent' : 'Frequent', emoji: recentEmoji }, ...byCategory];
  }, []);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 380;
    const below = rect.bottom + GAP;
    const top = below + height > window.innerHeight - GAP ? Math.max(GAP, rect.top - height - GAP) : below;
    const left = Math.min(Math.max(GAP, rect.right - WIDTH), window.innerWidth - WIDTH - GAP);
    setPosition({ top, left });
  }, [anchor]);

  // Focus once placed: a hidden input can't take focus, so autoFocus would miss.
  useEffect(() => {
    if (position) searchRef.current?.focus();
  }, [position]);

  useEscapeLayer(true, onClose);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) || anchor.contains(target));
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) onClose();
    };
    // It is placed once, so close it when the reader scrolls what's under it.
    // (A wheel, not a scroll event: the thread scrolling itself to a new
    // message shouldn't close it.)
    const onWheel = (e: WheelEvent) => {
      if (!inside(e.target)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const pick = (name: string) => {
    rememberPick(name);
    onPick(name);
  };

  const results = useMemo(() => (query.trim() ? searchEmoji(query, 120) : null), [query]);

  // The grid holds ~1,900 buttons; build it once per search, not on every hover.
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const grid = useMemo(() => {
    const renderOption = (emoji: Emoji) => (
      <button
        key={emoji.names[0]}
        type="button"
        className="emoji-picker-option"
        title={`:${emoji.names[0]}:`}
        aria-label={`:${emoji.names[0]}:`}
        onClick={() => pickRef.current(emoji.names[0])}
        onMouseEnter={() => setHovered(emoji.names[0])}
      >
        {emoji.char}
      </button>
    );
    return results ? (
      <div className="emoji-picker-grid">
        {results.map(renderOption)}
        {results.length === 0 ? <span className="muted emoji-picker-empty">No emoji named that.</span> : null}
      </div>
    ) : (
      sections.map(section => (
        <section key={section.category} data-category={section.category}>
          <h4 className="emoji-picker-heading">{section.category}</h4>
          <div className="emoji-picker-grid">{section.emoji.map(renderOption)}</div>
        </section>
      ))
    );
  }, [results, sections]);

  return createPortal(
    <div
      className="emoji-picker"
      ref={ref}
      role="dialog"
      aria-label="Pick an emoji"
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
      <input
        className="emoji-picker-search"
        ref={searchRef}
        placeholder="Search all emoji"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && results && results.length > 0) pick(results[0].names[0]);
        }}
      />
      {results ? null : (
        <div className="emoji-picker-tabs" role="tablist">
          {sections.map(section => (
            <button
              key={section.category}
              type="button"
              role="tab"
              className="emoji-picker-tab"
              title={section.category}
              aria-label={section.category}
              onClick={() => {
                const target = gridRef.current?.querySelector(`[data-category="${section.category}"]`);
                if (target instanceof HTMLElement && gridRef.current) gridRef.current.scrollTop = target.offsetTop;
              }}
            >
              {section.emoji[0]?.char ?? '•'}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-picker-scroll" ref={gridRef}>
        {grid}
      </div>
      <div className="emoji-picker-footer">
        {hovered ? (
          <>
            <span className="emoji-picker-footer-char">{emojiChar(hovered)}</span>:{hovered}:
          </>
        ) : (
          <span className="muted">Pick an emoji</span>
        )}
      </div>
    </div>,
    document.body,
  );
}
