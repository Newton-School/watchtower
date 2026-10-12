import path from 'node:path';
import type { AttachmentLimits, UndeliveredAttachment, UndeliveredReason } from './fileAttachments.js';

/**
 * What to tell a thread when files the reply listed never arrived.
 *
 * The reply text is written by the agent and posted before the upload is
 * attempted, so it can already say "full list attached". When the upload then
 * fails nothing corrected it: over 30 days twelve replies promised a file and
 * none arrived, and one requester asked three times for the same list (issue
 * #433). The correction is a follow-up in the thread, and where the file is
 * text short enough to read in a message, the content itself.
 */

/** File types whose content a person can read pasted into a message. */
const TEXT_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.json',
  '.ndjson',
  '.yaml',
  '.yml',
  '.xml',
  '.sql',
  '.txt',
  '.md',
  '.log',
  '.html',
  '.diff',
  '.patch',
]);

/**
 * Most text pasted per reply, across all of its files. Eleven of the twelve
 * files that failed to attach in the audit were under this; at the chunk size
 * below it is at most nine messages.
 */
export const INLINE_MAX_CHARS = 30_000;

/** Slack asks for messages under 4,000 characters; this leaves room for the header and the fence. */
export const INLINE_CHUNK_CHARS = 3_500;

export interface UndeliveredFollowUp {
  /** Messages to post to the thread, in order. Empty when nothing went missing. */
  messages: string[];
  /** Files whose content was pasted instead. */
  inlined: string[];
  /** Files the thread did not get in any form. */
  lost: string[];
}

/** Slack reads `<…>` as a link or a mention even inside a code block, so file content is escaped. */
function escapeForSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A literal ``` inside the content would close the fence early; a zero-width space keeps it open. */
function keepFenceOpen(text: string): string {
  return text.replace(/```/g, '`\u200b`\u200b`');
}

function decodeText(content: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    return text.includes('\u0000') ? undefined : text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  } catch {
    return undefined;
  }
}

/** Split one over-long line so that each piece still fits a chunk once escaped. */
function splitLongLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const char of line) {
    const escaped = escapeForSlack(char);
    if (current.length + escaped.length > limit) {
      pieces.push(current);
      current = '';
    }
    current += escaped;
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

/** Break text into chunks at line boundaries, each within `limit` after escaping. */
export function chunkForSlack(text: string, limit = INLINE_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = (line: string): void => {
    if (current && current.length + 1 + line.length > limit) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  };
  for (const rawLine of keepFenceOpen(text).split('\n')) {
    const line = escapeForSlack(rawLine);
    if (line.length <= limit) {
      push(line);
      continue;
    }
    for (const piece of splitLongLine(rawLine, limit)) {
      push(piece);
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function whyNotDelivered(reason: UndeliveredReason, limits: AttachmentLimits): string {
  switch (reason) {
    case 'missing_scope':
      return "Slack won't let me upload files yet (the app is missing the `files:write` permission)";
    case 'upload_failed':
      return 'Slack rejected the upload';
    case 'over_file_limit':
      return `I can attach at most ${limits.maxFiles} files to one reply`;
    case 'refused':
      return "it isn't a kind of file I'm allowed to post";
    case 'not_found':
      return "the file wasn't there when I went to send it";
    case 'empty':
      return 'the file turned out to be empty';
    case 'too_large':
      return `it is over the ${formatSize(limits.maxFileBytes)} limit`;
  }
}

interface LostFile {
  file: UndeliveredAttachment;
  /** Text that would have been pasted had it fit the budget. */
  tooLong: boolean;
}

/** Why a file that failed at the upload could not be pasted either. Empty for a file that never got that far. */
function whyNotPasted({ file, tooLong }: LostFile, many: boolean): string {
  if (!file.content) {
    return '';
  }
  if (tooLong) {
    const size = many ? 'they are' : `at ${formatSize(file.bytes ?? 0)} it is`;
    return `, and ${size} too long to paste here. Ask for the part you need and I'll put it in the message`;
  }
  return many ? ", and they aren't something I can paste as text" : ", and it isn't something I can paste as text";
}

/** One message for everything the thread did not get in any form. */
function lostNotice(lost: LostFile[], limits: AttachmentLimits): string | undefined {
  if (lost.length === 0) {
    return undefined;
  }
  const why = (entry: LostFile, many: boolean): string =>
    `${whyNotDelivered(entry.file.reason, limits)}${whyNotPasted(entry, many)}`;
  if (lost.length === 1) {
    return `:warning: \`${lost[0].file.filename}\` didn't attach: ${why(lost[0], false)}.`;
  }
  // The usual case is one cause for all of them (eight screenshots, one missing
  // permission): say it once instead of once per file.
  const causes = new Set(lost.map(entry => why(entry, true)));
  if (causes.size === 1) {
    const names = lost.map(entry => `\`${entry.file.filename}\``).join(', ');
    return `:warning: ${lost.length} files didn't attach (${names}): ${why(lost[0], true)}.`;
  }
  const lines = lost.map(entry => `• \`${entry.file.filename}\`: ${why(entry, false)}`);
  return `:warning: These files didn't attach:\n${lines.join('\n')}`;
}

/**
 * Build the follow-up for a reply whose files did not all arrive.
 *
 * Only a file that carries `content` is ever pasted: that is set solely when
 * the file passed the allowlist and the size checks and the Slack upload was
 * the step that failed, so pasting publishes nothing an upload would not have.
 */
export function buildUndeliveredFollowUp(
  undelivered: UndeliveredAttachment[],
  limits: AttachmentLimits,
): UndeliveredFollowUp {
  const inlined: Array<{ file: UndeliveredAttachment; chunks: string[] }> = [];
  const lost: LostFile[] = [];
  let budget = INLINE_MAX_CHARS;

  for (const file of undelivered) {
    const isText = TEXT_EXTENSIONS.has(path.extname(file.filename).toLowerCase());
    const text = file.content && isText ? decodeText(file.content) : undefined;
    if (!text) {
      lost.push({ file, tooLong: false });
      continue;
    }
    const chunks = chunkForSlack(text);
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (length > budget) {
      lost.push({ file, tooLong: true });
      continue;
    }
    budget -= length;
    inlined.push({ file, chunks });
  }

  const messages: string[] = [];
  const notice = lostNotice(lost, limits);
  if (notice) {
    messages.push(notice);
  }

  for (const { file, chunks } of inlined) {
    chunks.forEach((chunk, index) => {
      const part = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
      const header =
        index === 0
          ? `:warning: \`${file.filename}\` didn't attach: ${whyNotDelivered(file.reason, limits)}. Here it is as text instead${part}:`
          : `\`${file.filename}\`${part}:`;
      messages.push(`${header}\n\`\`\`\n${chunk}\n\`\`\``);
    });
  }

  return {
    messages,
    inlined: inlined.map(entry => entry.file.filename),
    lost: lost.map(entry => entry.file.filename),
  };
}
