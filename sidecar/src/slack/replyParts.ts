import { logger } from '../logging/logger.js';

/**
 * Long replies, posted in parts that each read whole (issue #623).
 *
 * Slack cuts a message's text at 4,000 characters wherever the limit falls,
 * and posts the rest as a second message: an investigation reply ended on
 * "de" and the next message opened with "dupe", and a change-run summary was
 * cut in the middle of a section. Replies are now split here first, at a
 * paragraph break, else a line break, else the end of a sentence, else a
 * space, and never inside inline code, a mention or a link. A code block too
 * long for one part is closed at a line break and reopened, with its language,
 * in the next part.
 *
 * Short text that is cut to fit (a finding in a list, a quoted summary) is cut
 * at a space too, by `clipText`.
 */

/** The most one part carries, by `slackLength`. Slack cuts at 4,000. */
export const SLACK_PART_CHARS = 3_900;

/** What a cut inside a code block adds to the part before it. */
const FENCE_CLOSE = '\n```';

/** Text already escaped for Slack (file content pasted into a reply is). */
const ENTITY = /&(?:amp|lt|gt);/y;

/** What one character adds to the length Slack counts. */
function weightAt(text: string, index: number, char: string): number {
  if (char === '&') {
    ENTITY.lastIndex = index;
    return ENTITY.test(text) ? 1 : 5;
  }
  return char === '<' || char === '>' ? 4 : char.length;
}

/**
 * The length Slack counts. `&`, `<` and `>` reach it escaped, so they count
 * as their entities; mentions and links are counted that way too, which only
 * errs short. UTF-16 units, so an emoji counts as two.
 */
export function slackLength(text: string): number {
  let length = 0;
  let index = 0;
  for (const char of text) {
    length += weightAt(text, index, char);
    index += char.length;
  }
  return length;
}

interface Fence {
  /** Where the line that opens the block starts, and where it ends (its newline). */
  openerStart: number;
  openerEnd: number;
  /** Where the closing line starts and ends; the text's end for a block left open. */
  closeStart: number;
  closeEnd: number;
  /** What reopens the block in the next part: ``` and its language, if it named one. */
  reopen: string;
}

interface Layout {
  fences: Fence[];
  /** Ranges no cut may fall strictly inside: inline code, mentions and links, entities, fence lines. */
  spans: Array<[number, number]>;
}

function reopenMarker(line: string): string {
  const language = /^\s*```([\w+#.-]*)\s*$/.exec(line);
  return language ? `\`\`\`${language[1]}` : '```';
}

function layoutOf(text: string): Layout {
  const fences: Fence[] = [];
  const spans: Array<[number, number]> = [];
  let open: { openerStart: number; openerEnd: number; reopen: string } | undefined;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const ticks = line.split('```').length - 1;
    if (open && ticks > 0) {
      fences.push({ ...open, closeStart: lineStart, closeEnd: lineEnd });
      spans.push([lineStart, lineEnd]);
      open = undefined;
    } else if (!open && /^\s*```/.test(line)) {
      // A line with a pair of fences ("```npm ci```") is a block of its own.
      if (ticks % 2 === 1) open = { openerStart: lineStart, openerEnd: lineEnd, reopen: reopenMarker(line) };
      spans.push([lineStart, lineEnd]);
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open) fences.push({ ...open, closeStart: text.length, closeEnd: text.length });

  const inFence = (start: number, end: number) => fences.some(f => start < f.closeEnd && end > f.openerStart);
  // Mentions, channels and links (<@U123>, <#C123|name>, <https://…|label>),
  // and characters already escaped (&amp;).
  for (const match of text.matchAll(/<[^<>\n]+>|&(?:amp|lt|gt);/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/`[^`\n]+`/g)) {
    const end = match.index + match[0].length;
    if (!inFence(match.index, end)) spans.push([match.index, end]);
  }
  return { fences, spans };
}

function insideSpan(index: number, spans: Array<[number, number]>): [number, number] | undefined {
  return spans.find(([start, end]) => start < index && index < end);
}

type Place = { kind: 'out' } | { kind: 'body'; fence: Fence } | { kind: 'bad'; fence: Fence };

/** Where a cut before `index` lands: outside any code block, inside one's body, or in its opening line. */
function placeOf(index: number, fences: Fence[]): Place {
  for (const fence of fences) {
    if (index <= fence.openerStart || index >= fence.closeEnd) continue;
    if (index <= fence.openerEnd) return { kind: 'bad', fence };
    if (index <= fence.closeStart) return { kind: 'body', fence };
  }
  return { kind: 'out' };
}

/** The largest index whose prefix fits `budget`, never between the halves of a surrogate pair. */
function fitEnd(text: string, budget: number): number {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const weight = weightAt(text, index, char);
    if (used + weight > budget) break;
    used += weight;
    index += char.length;
  }
  return index;
}

function firstCharLength(text: string): number {
  return (text.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
}

type Cut =
  | { at: number; how: 'newline' | 'space' | 'hard' }
  | { at: number; how: 'fence-newline' | 'fence-hard'; fence: Fence };

function isBlankRest(text: string, from: number): boolean {
  const next = text.slice(from).search(/[^ \t]/);
  return next === -1 || text[from + next] === '\n';
}

function findCut(text: string, limit: number): Cut {
  const { fences, spans } = layoutOf(text);
  const end = fitEnd(text, limit);
  const fenceEnd = fitEnd(text, limit - FENCE_CLOSE.length);
  const out = (i: number) => placeOf(i, fences).kind === 'out' && !insideSpan(i, spans);

  const paragraph = (i: number) => text[i] === '\n' && isBlankRest(text, i + 1) && out(i);
  const line = (i: number) => text[i] === '\n' && out(i);
  const sentence = (i: number) =>
    text[i] === ' ' && /[.!?]["')\]”’]?$/.test(text.slice(Math.max(0, i - 2), i)) && out(i);
  const word = (i: number) => (text[i] === ' ' || text[i] === '\t') && out(i);
  const codeLine = (i: number): Fence | undefined => {
    if (text[i] !== '\n' || i > fenceEnd) return undefined;
    const place = placeOf(i, fences);
    if (place.kind !== 'body') return undefined;
    const { fence } = place;
    // Not the first line's own newline (an empty block before the cut), nor
    // the last body line's (an empty block after it).
    const bodyStart = fence.openerEnd + 1;
    if (i <= bodyStart || (fence.closeStart < text.length && i >= fence.closeStart - 1)) return undefined;
    return insideSpan(i, spans) ? undefined : fence;
  };

  // A cut in the first half of the part is taken only when nothing later fits.
  for (const floor of [Math.floor(end / 2), 1]) {
    for (const [test, how] of [
      [paragraph, 'newline'],
      [line, 'newline'],
    ] as const) {
      for (let i = end; i >= floor; i--) if (test(i)) return { at: i, how };
    }
    for (let i = fenceEnd; i >= floor; i--) {
      const fence = codeLine(i);
      if (fence) return { at: i, how: 'fence-newline', fence };
    }
    for (const test of [sentence, word]) {
      for (let i = end; i >= floor; i--) if (test(i)) return { at: i, how: 'space' };
    }
  }

  // One run with no place to break: cut at the limit, but not inside a
  // mention, a link or inline code that starts after the part's beginning.
  let at = end || firstCharLength(text);
  const span = insideSpan(at, spans);
  if (span && span[0] > 0) at = span[0];
  const place = placeOf(at, fences);
  if (place.kind === 'body') {
    const fenceAt = Math.min(at, fenceEnd);
    if (fenceAt > place.fence.openerEnd + 1) return { at: fenceAt, how: 'fence-hard', fence: place.fence };
  }
  // In a block's opening line, or too close to it to close the block: the
  // whole block goes to the next part.
  if (place.kind !== 'out' && place.fence.openerStart > 0) return { at: place.fence.openerStart, how: 'hard' };
  return { at, how: 'hard' };
}

/**
 * `text` as parts of at most `limit` (by `slackLength`), cut at a paragraph
 * break, a line break, a sentence end or a space, in that order of preference,
 * and only in the second half of a part when such a place exists there.
 */
export function splitSlackText(text: string, limit = SLACK_PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (slackLength(rest) > limit) {
    const cut = findCut(rest, limit);
    let head: string;
    let tail: string;
    switch (cut.how) {
      case 'newline':
        head = rest.slice(0, cut.at).trimEnd();
        tail = rest.slice(cut.at).replace(/^(?:[ \t]*\n)+/, '');
        break;
      case 'space':
        head = rest.slice(0, cut.at).trimEnd();
        tail = rest.slice(cut.at).replace(/^[ \t\n]+/, '');
        break;
      case 'fence-newline':
        head = rest.slice(0, cut.at) + FENCE_CLOSE;
        tail = `${cut.fence.reopen}\n${rest.slice(cut.at + 1)}`;
        break;
      case 'fence-hard':
        head = rest.slice(0, cut.at) + FENCE_CLOSE;
        tail = `${cut.fence.reopen}\n${rest.slice(cut.at)}`;
        break;
      default:
        head = rest.slice(0, cut.at);
        tail = rest.slice(cut.at);
    }
    // A reopened block that would not shrink what is left: cut plainly instead.
    if (tail.length >= rest.length) {
      const at = fitEnd(rest, limit) || firstCharLength(rest);
      head = rest.slice(0, at);
      tail = rest.slice(at);
    }
    if (head.trim()) parts.push(head);
    rest = tail;
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

/**
 * `text` cut to at most `max` characters at a space, with "…" when anything
 * was cut. A mention, a link or inline code is left whole or left out, and a
 * code block cut short is closed (its closing fence goes past `max`).
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const { spans } = layoutOf(text);
  const room = Math.max(max - 1, 1);
  let at = -1;
  for (let i = room; i > room / 2; i--) {
    if (/\s/.test(text[i]) && !insideSpan(i, spans)) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    at = room;
    const span = insideSpan(at, spans);
    if (span && span[0] > 0) at = span[0];
    // Not between the halves of a surrogate pair.
    const code = text.charCodeAt(at);
    if (code >= 0xdc00 && code <= 0xdfff) at -= 1;
  }
  let head = text
    .slice(0, at)
    .trimEnd()
    .replace(/[,;:\s]+$/, '');
  if ((head.split('```').length - 1) % 2 === 1) head = `${head}…${FENCE_CLOSE}`;
  else head = `${head}…`;
  return head;
}

/** What `postInParts` needs of a `chat.postMessage` call and its answer. */
interface PostArgs {
  text?: string;
  blocks?: unknown;
  attachments?: unknown;
  reply_broadcast?: boolean;
}

/**
 * Posts `args` through `post`, as several messages when its text is longer
 * than one part. Answers with the first part's response, so a caller that
 * keeps the message's ts points at where the reply starts. A later part that
 * fails is logged, not thrown: the reply has already begun in the thread, and
 * a caller that saw an error would report the whole reply as not posted.
 * With blocks or attachments the text is only the notification fallback and
 * is posted as it is.
 */
export async function postInParts<A extends PostArgs, R extends { ok?: boolean }>(
  post: (args: A) => Promise<R>,
  args: A,
  limit = SLACK_PART_CHARS,
): Promise<R> {
  if (typeof args.text !== 'string' || args.blocks || args.attachments) return post(args);
  const parts = splitSlackText(args.text, limit);
  if (parts.length <= 1) return post(args);

  const first = await post({ ...args, text: parts[0] });
  if (first.ok === false) return first;
  for (const [index, part] of parts.slice(1).entries()) {
    // Only the first part goes to the channel too.
    const next = args.reply_broadcast ? { ...args, text: part, reply_broadcast: false } : { ...args, text: part };
    try {
      const response = await post(next);
      if (response.ok === false) break;
    } catch (error) {
      logger.warn(
        { component: 'slack', part: index + 2, parts: parts.length, error: String(error) },
        'slack.post.part_failed: a later part of a long reply was not posted',
      );
      break;
    }
  }
  return first;
}
