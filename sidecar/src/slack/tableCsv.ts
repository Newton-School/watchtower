import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { botScopes } from './botScopes.js';

/**
 * Tables in an answer, attached as CSV files (issue #731).
 *
 * Analysts keep asking for sheets. A lookup writes a table as a pipe table in
 * a code block (the prompt asks it to), which Slack shows as text; the table
 * also goes under the answer as a `.csv` the person can open in a sheet. Only
 * a table with enough rows to be worth it, unless the person asked for a
 * sheet or a CSV. When the agent already delivered a sheet of its own (the
 * full dataset, through its file manifest), the tables in the text are a
 * preview of it and nothing more is attached.
 *
 * Aligned tables without pipes (columns lined up with spaces) are not read:
 * where one column ends is a guess, and a wrong guess makes a wrong sheet.
 */

export interface TextTable {
  /** The line just above the table, when it reads as its title. */
  heading?: string;
  columns: string[];
  rows: string[][];
}

/** Tables shorter than this are attached only when a sheet was asked for. */
export const CSV_MIN_ROWS = 5;
/** The most tables one answer attaches. */
const MAX_TABLES = 5;
/** The longest file name, before `.csv`. */
const MAX_NAME_CHARS = 50;
export const CSV_NOTE_ONE = 'The table as a CSV, for a sheet.';
export const CSV_NOTE_MANY = 'The tables as CSVs, for a sheet.';
/** Extensions of a file the agent attached that already is the sheet. */
export const SHEET_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.xls'];

const SEPARATOR_CELL_RE = /^:?-+:?$/;
/** Byte-order mark: Excel reads a CSV without one as Latin-1 and garbles ₹. */
const BOM = String.fromCharCode(0xfeff);
/** A fenced block of quoted Markdown is documentation, not data. */
const DOC_FENCE_LANGS = new Set(['md', 'markdown', 'mdx']);
/** A Slack token that may hold a `|` of its own: a link, a mention, a channel, a special mention. */
const SLACK_TOKEN_START_RE = /^<(?:https?:|mailto:|@|#|!)/;

const SHEET_ASK_RES = [
  // "as a sheet", "into a google sheet", "to csv", "in a spreadsheet", "as excel"
  /\b(?:as|into|in|to)\s+(?:an?\s+|the\s+)?(?:google\s+)?(?:sheets?|spreadsheets?|csv|excel|xlsx)\b/i,
  // "give me a csv", "send the spreadsheet", "need an excel file", "can I get a sheet"
  /\b(?:give|send|share|make|create|need|want|get|attach)\b[^.?!\n]{0,30}?\b(?:an?|the|this|that|it)\s+(?:google\s+)?(?:sheet|spreadsheet|csv|excel(?:\s+file)?|xlsx)\b/i,
  /\b(?:export|download)\b/i,
];

/** Whether the person asked for the answer as a sheet or a CSV (not a sheet merely named in the message). */
export function asksForSheet(text: string): boolean {
  const plain = text.replace(/<[^>]*>/g, ' ');
  return SHEET_ASK_RES.some(re => re.test(plain));
}

/**
 * The cells of one table line: split on `|`, except inside inline code (a
 * backtick that has a closing one later on the line) or a Slack token like
 * `<url|label>` and `<@U1|name>`, with `\|` read as a literal pipe. The outer
 * pipes go only when their cell is empty.
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  let inToken = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (!inToken && char === '`') {
      if (inCode) inCode = false;
      else if (line.indexOf('`', i + 1) !== -1) inCode = true;
    } else if (!inCode && !inToken && char === '<' && SLACK_TOKEN_START_RE.test(line.slice(i))) {
      inToken = line.indexOf('>', i + 1) !== -1;
    } else if (inToken && char === '>') {
      inToken = false;
    }
    if (char === '|' && !inCode && !inToken) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  const trimmed = line.trim();
  if (trimmed.startsWith('|') && cells[0].trim() === '') cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(cell => cell.trim());
}

function separatorWidth(line: string): number {
  if (!line.includes('-')) return 0;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => SEPARATOR_CELL_RE.test(cell)) ? cells.length : 0;
}

function isTableLine(line: string): boolean {
  return line.includes('|') && splitTableRow(line).length >= 2;
}

/** A cell as plain text: Slack and Markdown formatting removed, links kept readable. */
export function plainCell(cell: string): string {
  return cell
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
      label.trim() === url.trim() ? url : `${label} (${url})`,
    )
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, name?: string) => `@${name ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(^|[\s(])\*\*([^*]+)\*\*(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/(^|[\s(])\*([^*]+)\*(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/(^|[\s(])~([^~]+)~(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/** The line above a table, when it is short enough to be its title. */
function headingAbove(lines: string[], index: number): string | undefined {
  for (let i = index - 1; i >= 0 && i >= index - 2; i -= 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('```')) continue;
    if (line.includes('|')) return undefined;
    const text = plainCell(line.replace(/^#+\s*/, '').replace(/[:：]\s*$/, ''));
    return text && text.length <= 80 ? text : undefined;
  }
  return undefined;
}

/** A table of command-line options quoted from docs: most of its first column are `--flags`. */
function isFlagReference(rows: string[][]): boolean {
  if (rows.length === 0) return false;
  const flags = rows.filter(row => /^-{1,2}[a-z]/i.test(row[0] ?? '')).length;
  return flags * 2 > rows.length;
}

/**
 * Every pipe table in a reply: a header line, then a `|---|---|` separator
 * with as many columns, then the lines that follow while they are still rows.
 * A table inside a plain code block is read; one inside a block fenced as
 * Markdown (```md) is quoted documentation and is not, nor is a reference
 * table of `--flags`.
 */
export function extractTables(text: string): TextTable[] {
  const lines = text.split(/\r?\n/);
  const tables: TextTable[] = [];
  let fenceLang: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = /^\s*```\s*([\w-]*)/.exec(lines[i]);
    if (fence) {
      fenceLang = fenceLang === undefined ? fence[1].toLowerCase() : undefined;
      continue;
    }
    if (i + 1 >= lines.length || !isTableLine(lines[i])) continue;
    const columns = splitTableRow(lines[i]).map(plainCell);
    if (separatorWidth(lines[i + 1]) !== columns.length) continue;
    // A table written with outer pipes ends at the first line without one, so
    // a sentence after it that happens to hold a "|" is not read as a row.
    const piped = lines[i].trim().startsWith('|');
    const isRow = (line: string) =>
      separatorWidth(line) === 0 && (piped ? line.trim().startsWith('|') && line.trim().length > 1 : isTableLine(line));
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && isRow(lines[j]); j += 1) {
      const cells = splitTableRow(lines[j]).map(plainCell);
      // Short rows are padded and long ones keep every cell: nothing is dropped.
      while (cells.length < columns.length) cells.push('');
      rows.push(cells);
    }
    const quotedDocs = fenceLang !== undefined && DOC_FENCE_LANGS.has(fenceLang);
    if (!quotedDocs && !isFlagReference(rows)) tables.push({ heading: headingAbove(lines, i), columns, rows });
    i = j - 1;
  }
  return tables;
}

/** A whole cell that is a number (with sign, thousands commas, decimals or a percent) is left alone. */
const PLAIN_NUMBER_RE = /^[+-]?(\d[\d,]*)?(\.\d+)?%?$/;

/**
 * One CSV field (RFC 4180). A value a spreadsheet would run as a formula
 * (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a
 * leading `'`, unless the whole cell is a plain number.
 */
function csvField(value: string): string {
  let field = value;
  const plainNumber = /\d/.test(field) && PLAIN_NUMBER_RE.test(field);
  if (/^[=+\-@\t\r]/.test(field) && !plainNumber) field = `'${field}`;
  return /[",\r\n]|^\s|\s$/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/** A table as CSV text with CRLF line ends and a byte-order mark, so Excel reads ₹ and other non-ASCII right. */
export function tableToCsv(table: Pick<TextTable, 'columns' | 'rows'>): string {
  const lines = [table.columns, ...table.rows].map(row => row.map(csvField).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

function slugFor(text: string | undefined): string {
  const slug = (text ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= MAX_NAME_CHARS) return slug;
  // Cut at the last word boundary that fits, not in the middle of a word.
  const cut = slug.slice(0, MAX_NAME_CHARS + 1);
  const hyphen = cut.lastIndexOf('-');
  return (hyphen > 0 ? cut.slice(0, hyphen) : slug.slice(0, MAX_NAME_CHARS)).replace(/-+$/, '');
}

/** File names for the tables: each table's heading, else the question, numbered when there are several. */
export function csvFileNames(tables: TextTable[], askText: string): string[] {
  const fallback = slugFor(askText.replace(/<@[^>]+>/g, ' ')) || 'table';
  const names = tables.map(table => slugFor(table.heading) || fallback);
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return names.map(name => {
    if ((counts.get(name) ?? 0) < 2) return `${name}.csv`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return `${name}-${n}.csv`;
  });
}

/** The tables in a reply that are worth a CSV. */
export function tablesWorthCsv(replyText: string, askText: string): TextTable[] {
  const wanted = asksForSheet(askText);
  return extractTables(replyText)
    .filter(table => table.rows.length > 0 && (wanted || table.rows.length >= CSV_MIN_ROWS))
    .slice(0, MAX_TABLES);
}

/** Whether the bot can upload files, as far as anyone knows (the missing scope is learnt, not assumed). */
export function canUploadFiles(): boolean {
  return !botScopes.knownMissing('files:write');
}

/**
 * Attach the reply's tables as CSV files under it in the thread. Best effort:
 * nothing here throws, and a failed upload is logged; the run has already
 * answered.
 */
export async function attachReplyTablesAsCsv(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  replyText: string;
  /** The message the reply answers: it names the files, and can ask for a sheet. */
  askText: string;
  /** The agent delivered a sheet of its own: the tables in the text are its preview. */
  sheetAlreadyDelivered?: boolean;
  logStep?: WorkflowStepLogger;
}): Promise<{ uploaded: number }> {
  const { slack, channelId, threadTs, replyText, askText, sheetAlreadyDelivered, logStep } = params;
  let names: string[] = [];
  try {
    const tables = tablesWorthCsv(replyText, askText);
    if (tables.length === 0) return { uploaded: 0 };
    if (sheetAlreadyDelivered) {
      logStep?.({
        stage: 'reply.tables_csv.skipped',
        message: 'The reply has a table, but the agent already attached a sheet of its own.',
        data: { tables: tables.length, reason: 'agent_sheet' },
      });
      return { uploaded: 0 };
    }
    if (!canUploadFiles()) {
      logStep?.({
        stage: 'reply.tables_csv.skipped',
        message: "The reply has a table, but the Slack app can't upload files (files:write is missing).",
        data: { tables: tables.length, reason: 'missing_scope' },
      });
      return { uploaded: 0 };
    }
    names = csvFileNames(tables, askText);
    const fileUploads = tables.map((table, index) => ({
      file: Buffer.from(tableToCsv(table), 'utf8'),
      filename: names[index],
      title: names[index],
    }));
    await slack.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      initial_comment: tables.length === 1 ? CSV_NOTE_ONE : CSV_NOTE_MANY,
      file_uploads: fileUploads,
    });
    logStep?.({
      stage: 'reply.tables_csv.uploaded',
      message: `Attached ${tables.length} table(s) from the reply as CSV.`,
      data: { files: names, rows: tables.map(table => table.rows.length) },
    });
    return { uploaded: tables.length };
  } catch (error) {
    try {
      logStep?.({
        stage: 'reply.tables_csv.failed',
        level: 'WARN',
        message: `Couldn't attach the reply's table(s) as CSV: ${String(error)}`,
        data: { files: names },
      });
    } catch {
      // A logger that throws must not undo an answer that already posted.
    }
    return { uploaded: 0 };
  }
}
