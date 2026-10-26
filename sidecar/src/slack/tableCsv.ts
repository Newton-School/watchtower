import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * Tables in an answer, attached as CSV files (issue #731).
 *
 * Analysts keep asking for sheets. Slack shows a pipe table as plain text, so
 * an answer with a table of any length also gets the table as a `.csv` the
 * person can open in a sheet. Only a table with enough rows to be worth it,
 * unless the person asked for a sheet or a CSV. When the agent already
 * attached a CSV itself (the full dataset, through its file manifest), the
 * tables in the text are a preview of it and nothing more is attached.
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
export const CSV_NOTE_ONE = 'The table as a CSV, for a sheet.';
export const CSV_NOTE_MANY = 'The tables as CSVs, for a sheet.';

const SEPARATOR_CELL_RE = /^:?-{3,}:?$/;
/** Byte-order mark: Excel reads a CSV without one as Latin-1 and garbles ₹. */
const BOM = String.fromCharCode(0xfeff);
const SHEET_ASK_RE = /\b(csv|sheets?|spreadsheets?|excel|xlsx?|gsheets?)\b/i;

/** Whether the person asked for the answer as a sheet or a CSV. */
export function asksForSheet(text: string): boolean {
  return SHEET_ASK_RE.test(text.replace(/<[^>]*>/g, ' '));
}

/**
 * The cells of one table line: split on `|` outside inline code, with `\|`
 * read as a literal pipe and the outer pipes dropped.
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (char === '`') inCode = !inCode;
    if (char === '|' && !inCode) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
  return cells.map(cell => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => SEPARATOR_CELL_RE.test(cell));
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

/**
 * Every pipe table in a reply: a header line, a `|---|---|` separator line,
 * then the lines that follow while they still have cells. Fence lines around
 * a table don't stop it being read.
 */
export function extractTables(text: string): TextTable[] {
  const lines = text.split(/\r?\n/);
  const tables: TextTable[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!isTableLine(lines[i]) || !isSeparatorRow(lines[i + 1])) continue;
    const columns = splitTableRow(lines[i]).map(plainCell);
    // A table written with outer pipes ends at the first line without one, so
    // a sentence after it that happens to hold a "|" is not read as a row.
    const piped = lines[i].trim().startsWith('|');
    const isRow = (line: string) =>
      !isSeparatorRow(line) && (piped ? line.trim().startsWith('|') && line.trim().length > 1 : isTableLine(line));
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && isRow(lines[j]); j += 1) {
      const cells = splitTableRow(lines[j]).map(plainCell);
      // Short rows are padded and long ones keep every cell: nothing is dropped.
      while (cells.length < columns.length) cells.push('');
      rows.push(cells);
    }
    tables.push({ heading: headingAbove(lines, i), columns, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * One CSV field (RFC 4180). A value a spreadsheet would run as a formula
 * (`=`, `+`, `@`, or `-` not starting a number) gets a leading `'`.
 */
function csvField(value: string): string {
  let field = value;
  if (/^[=+@\t\r]/.test(field) || /^-(?![\d.\s]|$)/.test(field)) field = `'${field}`;
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
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug;
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

/**
 * Attach the reply's tables as CSV files under it in the thread. Best effort:
 * a failed upload is logged and never fails the run, which already answered.
 */
export async function attachReplyTablesAsCsv(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  replyText: string;
  /** The message the reply answers: it names the files, and can ask for a sheet. */
  askText: string;
  /** The agent attached a CSV of its own: the tables in the text are its preview. */
  csvAlreadyAttached?: boolean;
  logStep?: WorkflowStepLogger;
}): Promise<{ uploaded: number }> {
  const { slack, channelId, threadTs, replyText, askText, csvAlreadyAttached, logStep } = params;
  const tables = tablesWorthCsv(replyText, askText);
  if (tables.length === 0) return { uploaded: 0 };
  if (csvAlreadyAttached) {
    logStep?.({
      stage: 'reply.tables_csv.skipped',
      message: 'The reply has a table, but the agent already attached a CSV of its own.',
      data: { tables: tables.length },
    });
    return { uploaded: 0 };
  }
  const names = csvFileNames(tables, askText);
  const fileUploads = tables.map((table, index) => ({
    file: Buffer.from(tableToCsv(table), 'utf8'),
    filename: names[index],
    title: names[index],
  }));
  try {
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
    logStep?.({
      stage: 'reply.tables_csv.failed',
      level: 'WARN',
      message: `Couldn't attach the reply's table(s) as CSV: ${String(error)}`,
      data: { files: names },
    });
    return { uploaded: 0 };
  }
}
