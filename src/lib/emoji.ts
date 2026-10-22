import emojiData from './emojiData.json';

type EmojiRow = [unified: string, names: string[], category: number, skins: number];

export type Emoji = {
  char: string;
  /** Slack short names; the first is the one Slack shows. */
  names: string[];
  category: string;
};

// Slack writes a skin tone as `name::skin-tone-N`.
const SKIN_TONES: Record<string, string> = {
  'skin-tone-2': '\u{1F3FB}',
  'skin-tone-3': '\u{1F3FC}',
  'skin-tone-4': '\u{1F3FD}',
  'skin-tone-5': '\u{1F3FE}',
  'skin-tone-6': '\u{1F3FF}',
};

function toChar(unified: string): string {
  return String.fromCodePoint(...unified.split('-').map(hex => parseInt(hex, 16)));
}

export const EMOJI_CATEGORIES: string[] = emojiData.categories;

export const EMOJI: Emoji[] = (emojiData.emoji as EmojiRow[]).map(([unified, names, category]) => ({
  char: toChar(unified),
  names,
  category: EMOJI_CATEGORIES[category],
}));

const byName = new Map<string, string>();
for (const emoji of EMOJI) {
  for (const name of emoji.names) byName.set(name, emoji.char);
}

/** The character for a Slack emoji name, or null for a workspace custom emoji. */
export function emojiChar(name: string): string | null {
  const [base, tone] = name.split('::');
  const char = byName.get(base);
  if (!char) return null;
  return tone && SKIN_TONES[tone] ? char + SKIN_TONES[tone] : char;
}

/** Emoji whose names contain `query`, best matches (name starts with it) first. */
export function searchEmoji(query: string, limit = 48): Emoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const starts: Emoji[] = [];
  const contains: Emoji[] = [];
  for (const emoji of EMOJI) {
    if (emoji.category === 'Component') continue;
    if (emoji.names.some(name => name.startsWith(q))) starts.push(emoji);
    else if (emoji.names.some(name => name.includes(q))) contains.push(emoji);
  }
  return [...starts, ...contains].slice(0, limit);
}
