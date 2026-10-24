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

/** The most messages one reply becomes. What is left after them goes in a file. */
export const MAX_REPLY_PARTS = 6;

/** Said with the file that holds the rest of a reply too long for `MAX_REPLY_PARTS` messages. */
export const REST_IN_FILE = 'The rest of this reply was too long for Slack, so it is in this file.';

/** Said when that file could not be attached. */
export const REST_NOT_SHOWN = 'The rest of this reply was too long for Slack and could not be attached.';

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
  /** Where the opening ``` starts. */
  openStart: number;
  /** Where the code starts: the next line when the opening ``` names only a language. */
  bodyStart: number;
  /** Where the closing ``` starts and ends. */
  closeStart: number;
  closeEnd: number;
  /** What reopens the block in the next part: ``` and its language, if it named one. */
  reopen: string;
}

interface Layout {
  fences: Fence[];
  /** Ranges no cut may fall strictly inside: inline code, mentions and links, entities, fences. */
  spans: Array<[number, number]>;
}

function layoutOf(text: string): Layout {
  const fences: Fence[] = [];
  const spans: Array<[number, number]> = [];
  // Slack reads every ``` as the start or the end of a code block, wherever
  // it is on its line. A last one with nothing to close it is plain text.
  const marks: number[] = [];
  for (let at = text.indexOf('```'); at !== -1; at = text.indexOf('```', at + 3)) marks.push(at);
  for (let i = 0; i + 1 < marks.length; i += 2) {
    const openStart = marks[i];
    const closeStart = marks[i + 1];
    const lineEnd = text.indexOf('\n', openStart + 3);
    const language =
      lineEnd !== -1 && lineEnd < closeStart ? /^([\w+#.-]*)[ \t]*$/.exec(text.slice(openStart + 3, lineEnd)) : null;
    const bodyStart = language ? lineEnd + 1 : openStart + 3;
    fences.push({ openStart, bodyStart, closeStart, closeEnd: closeStart + 3, reopen: `\`\`\`${language?.[1] ?? ''}` });
    spans.push([openStart, bodyStart], [closeStart, closeStart + 3]);
  }
  if (marks.length % 2 === 1) spans.push([marks[marks.length - 1], marks[marks.length - 1] + 3]);

  const inFence = (start: number, end: number) => fences.some(f => start < f.closeEnd && end > f.openStart);
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

/**
 * Where a cut before `index` lands: outside any code block, inside one's code,
 * or where the part before it would end with an empty block or half a fence.
 */
function placeOf(index: number, fences: Fence[]): Place {
  for (const fence of fences) {
    if (index <= fence.openStart || index >= fence.closeEnd) continue;
    if (index > fence.bodyStart && index <= fence.closeStart) return { kind: 'body', fence };
    return { kind: 'bad', fence };
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
    if (place.kind !== 'body' || insideSpan(i, spans)) return undefined;
    // Code on both sides, so neither part gets an empty block.
    const { fence } = place;
    const before = text.slice(fence.bodyStart, i).trim();
    const after = text.slice(i + 1, fence.closeStart).trim();
    return before && after ? fence : undefined;
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
    if (fenceAt > place.fence.bodyStart && fenceAt < place.fence.closeStart) {
      return { at: fenceAt, how: 'fence-hard', fence: place.fence };
    }
  }
  // Inside a fence, or too close to one to close the block: the whole block
  // goes to the next part.
  if (place.kind !== 'out' && place.fence.openStart > 0) return { at: place.fence.openStart, how: 'hard' };
  return { at, how: 'hard' };
}

/**
 * A mention or link too long to fit anywhere whole, as plain text: its label,
 * else what it points at, or nothing when `keepTarget` is false.
 */
function unwrapLongTokens(text: string, max: number, keepTarget: boolean): string {
  return text.replace(/<([^<>\n|]+)(?:\|([^<>\n]*))?>/g, (token, target: string, label: string | undefined) =>
    slackLength(token) > max ? label || (keepTarget ? target : '') : token,
  );
}

/** The first `max` parts of `text`, and what is left after them. */
function takeParts(text: string, limit: number, max: number): { parts: string[]; rest: string } {
  const parts: string[] = [];
  let rest = unwrapLongTokens(text, limit, true);
  while (parts.length < max && slackLength(rest) > limit) {
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
  if (parts.length < max) {
    if (rest.trim()) parts.push(rest);
    rest = '';
  }
  return { parts, rest: rest.trim() ? rest : '' };
}

/**
 * `text` as parts of at most `limit` (by `slackLength`), cut at a paragraph
 * break, a line break, a sentence end or a space, in that order of preference,
 * and only in the second half of a part when such a place exists there.
 */
export function splitSlackText(text: string, limit = SLACK_PART_CHARS): string[] {
  return takeParts(text, limit, Infinity).parts;
}

/**
 * `text` cut to at most `max` characters at a space, with "…" when anything
 * was cut. A mention, a link or inline code is left whole or left out (a link
 * too long to keep becomes its label), and a code block cut short is closed
 * (its closing fence goes past `max`).
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(max - 1, 1);
  // A leading mention or link longer than the room would leave only "<https://…".
  const lead = /^<[^<>\n]+>/.exec(text);
  const source =
    lead && lead[0].length > room ? unwrapLongTokens(lead[0], room, false) + text.slice(lead[0].length) : text;
  if (source !== text) return clipText(source.trimStart(), max);
  const { fences, spans } = layoutOf(source);
  let at = -1;
  for (let i = room; i > room / 2; i--) {
    if (/\s/.test(source[i]) && !insideSpan(i, spans)) {
      at = i;
      break;
    }
  }
  if (at === -1) {
    at = room;
    const span = insideSpan(at, spans);
    if (span && span[0] > 0) at = span[0];
    // Not between the halves of a surrogate pair.
    const code = source.charCodeAt(at);
    if (code >= 0xdc00 && code <= 0xdfff) at -= 1;
  }
  const head = source
    .slice(0, at)
    .trimEnd()
    .replace(/[,;:\s]+$/, '');
  const inBlock = fences.some(fence => at > fence.openStart && at < fence.closeEnd);
  return inBlock ? `${head}…${FENCE_CLOSE}` : `${head}…`;
}

/** What `postInParts` needs of a `chat.postMessage` call and its answer. */
interface PostArgs {
  text?: string;
  blocks?: unknown;
  attachments?: unknown;
  reply_broadcast?: boolean;
}

export interface PartOptions<A, R> {
  /** The most one part carries. */
  limit?: number;
  /** The most messages the reply becomes; the rest goes to `fileRest`. */
  maxParts?: number;
  /**
   * True when the first part went out some other way that allows only a few
   * posts (a response_url): the other parts then go as one message.
   */
  joinRest?: (first: R) => boolean;
  /** Puts what did not fit in `maxParts` messages in the thread as a file. True when it arrived. */
  fileRest?: (rest: string, args: A) => Promise<boolean>;
}

/**
 * Posts `args` through `post`, as several messages when its text is longer
 * than one part, and at most `maxParts` of them; what is left after that goes
 * in a file (`fileRest`), or a line says it could not be shown.
 *
 * Answers with the first part's response, so a caller that keeps the
 * message's ts points at where the reply starts. A first part that is refused
 * stops the rest. A later part that fails is logged, not thrown: the reply has
 * already begun in the thread, and a caller that saw an error would report the
 * whole reply as not posted. With blocks or attachments the text is only the
 * notification fallback and is posted as it is.
 */
export async function postInParts<A extends PostArgs, R extends { ok?: boolean }>(
  post: (args: A) => Promise<R>,
  args: A,
  options: PartOptions<A, R> = {},
): Promise<R> {
  if (typeof args.text !== 'string' || args.blocks || args.attachments) return post(args);
  const { parts, rest } = takeParts(args.text, options.limit ?? SLACK_PART_CHARS, options.maxParts ?? MAX_REPLY_PARTS);
  if (parts.length <= 1 && !rest) return post(args);

  const first = await post({ ...args, text: parts[0] });
  if (first.ok === false) return first;
  // Only the first part goes to the channel too.
  const later = (text: string) =>
    args.reply_broadcast ? { ...args, text, reply_broadcast: false } : { ...args, text };
  const others = parts.slice(1);
  const messages = others.length > 1 && options.joinRest?.(first) ? [others.join('\n\n')] : others;

  for (const [index, text] of messages.entries()) {
    try {
      const response = await post(later(text));
      if (response.ok === false) return first;
    } catch (error) {
      logger.warn(
        { component: 'slack', part: index + 2, parts: messages.length + 1, error: String(error) },
        'slack.post.part_failed: a later part of a long reply was not posted',
      );
      return first;
    }
  }

  if (rest) {
    const filed = options.fileRest ? await options.fileRest(rest, args).catch(() => false) : false;
    if (!filed) {
      logger.warn(
        { component: 'slack', parts: parts.length, restChars: rest.length },
        'slack.post.rest_dropped: a long reply was cut short and its rest could not be attached',
      );
      await post(later(REST_NOT_SHOWN)).catch(() => undefined);
    }
  }
  return first;
}
