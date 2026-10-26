import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { botScopes } from '../src/slack/botScopes.js';
import {
  asksForSheet,
  attachReplyTablesAsCsv,
  csvFileNames,
  CSV_NOTE_MANY,
  CSV_NOTE_ONE,
  extractTables,
  plainCell,
  splitTableRow,
  tablesWorthCsv,
  tableToCsv,
} from '../src/slack/tableCsv.js';
import type { WorkflowStepLog } from '../src/types/contracts.js';

const BOM = String.fromCharCode(0xfeff);

function pipeTable(rows: number, header = '| Batch | Open | Closed |'): string {
  const body = Array.from({ length: rows }, (_, i) => `| B${i + 1} | ${i} | ${i * 2} |`);
  return [header, '|---|---|---|', ...body].join('\n');
}

afterEach(() => botScopes.setForTest(undefined));

describe('splitTableRow', () => {
  it('drops the outer pipes and trims cells', () => {
    expect(splitTableRow('| a | b |  c |')).toEqual(['a', 'b', 'c']);
    expect(splitTableRow('a | b')).toEqual(['a', 'b']);
  });

  it('reads an escaped pipe as a literal pipe', () => {
    expect(splitTableRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('keeps a pipe inside inline code', () => {
    expect(splitTableRow('| `a | b` | c |')).toEqual(['`a | b`', 'c']);
  });

  it('keeps the pipe inside a Slack link, mention or channel', () => {
    expect(
      splitTableRow('| <https://x.co/pr/1|PR #1> | <@U123|dipesh> | <#C42|general> | <!here> |').map(plainCell),
    ).toEqual(['PR #1 (https://x.co/pr/1)', '@dipesh', '#general', '@here']);
  });

  it('reads a stray backtick as text when no closing one follows', () => {
    expect(splitTableRow("| it's ` odd | b |")).toEqual(["it's ` odd", 'b']);
  });

  it('drops a last cell only when it is empty', () => {
    expect(splitTableRow('| a | b | `x|`')).toEqual(['a', 'b', '`x|`']);
    expect(splitTableRow('| a | |')).toEqual(['a', '']);
  });
});

describe('plainCell', () => {
  it('removes Slack and Markdown formatting', () => {
    expect(plainCell('*bold*')).toBe('bold');
    expect(plainCell('**bold** text')).toBe('bold text');
    expect(plainCell('_it_')).toBe('it');
    expect(plainCell('~gone~')).toBe('gone');
    expect(plainCell('`code`')).toBe('code');
  });

  it('keeps links readable', () => {
    expect(plainCell('<https://x.co/a|the page>')).toBe('the page (https://x.co/a)');
    expect(plainCell('<https://x.co/a>')).toBe('https://x.co/a');
    expect(plainCell('<https://x.co/a|https://x.co/a>')).toBe('https://x.co/a');
    expect(plainCell('<@U123|dipesh>')).toBe('@dipesh');
    expect(plainCell('<#C123|general>')).toBe('#general');
  });

  it('decodes Slack entities', () => {
    expect(plainCell('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d');
  });

  it('leaves snake_case and multiplication alone', () => {
    expect(plainCell('request_type_id')).toBe('request_type_id');
    expect(plainCell('2*3*4')).toBe('2*3*4');
  });
});

describe('extractTables', () => {
  it('reads a table with alignment colons and the line above as its heading', () => {
    const text = [
      '*228 live requests across the 4 RU batches*:',
      '',
      '| Batch | Sem |',
      '|:---|---:|',
      "| NST'23 | 7 |",
      "| NST'24 | 5 |",
      '',
      'More text.',
    ].join('\n');
    const [table] = extractTables(text);
    expect(table.columns).toEqual(['Batch', 'Sem']);
    expect(table.rows).toEqual([
      ["NST'23", '7'],
      ["NST'24", '5'],
    ]);
    expect(table.heading).toBe('228 live requests across the 4 RU batches');
  });

  it('reads two tables', () => {
    const text = `Open:\n${pipeTable(5)}\n\nClosed:\n${pipeTable(6)}`;
    const tables = extractTables(text);
    expect(tables.map(t => t.rows.length)).toEqual([5, 6]);
    expect(tables.map(t => t.heading)).toEqual(['Open', 'Closed']);
  });

  it('reads a pipe table inside a plain code block, the way the lookup prompt asks for it', () => {
    const text = 'Per batch:\n```\n' + pipeTable(5) + '\n```';
    const [table] = extractTables(text);
    expect(table.rows).toHaveLength(5);
    expect(table.heading).toBe('Per batch');
  });

  it('accepts a one-dash separator, but only with as many columns as the header', () => {
    expect(extractTables('| a | b |\n|-|-|\n| 1 | 2 |')[0].rows).toEqual([['1', '2']]);
    expect(extractTables('| a | b | c |\n|---|---|\n| 1 | 2 | 3 |')).toEqual([]);
  });

  it('stops a piped table at the first line without an outer pipe', () => {
    const text = `${pipeTable(5)}\nThis line mentions a | pipe but is prose.`;
    expect(extractTables(text)[0].rows).toHaveLength(5);
  });

  it('pads short rows and keeps long ones whole', () => {
    const text = '| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |';
    expect(extractTables(text)[0].rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3', '4'],
    ]);
  });

  it('finds nothing in prose, bullets or a lone pipe line', () => {
    expect(extractTables('• one\n• two\nA | B without a separator\nmore')).toEqual([]);
    expect(extractTables('no tables here')).toEqual([]);
  });

  it('does not read a table lined up with spaces (no pipes): its columns would be a guess', () => {
    const aligned = [
      '```',
      'Batch          Sem  Total  Open',
      "NST'23 CS+AI   7    26     14",
      "NST'24 CS+AI   5    82     16",
      "NST'24 CS+DS   5    4      2",
      "NST'25 CS+AI   3    90     29",
      "NST'26 CS+AI   1    26     8",
      '```',
    ].join('\n');
    expect(extractTables(aligned)).toEqual([]);
  });

  it('skips a table quoted from Markdown docs and a reference table of --flags', () => {
    const docs = '```markdown\n' + pipeTable(6) + '\n```';
    expect(extractTables(docs)).toEqual([]);
    const flags = [
      '| Flag | Meaning |',
      '|---|---|',
      '| --ref | branch to run on |',
      '| --repo | which repo |',
      '| -f | a workflow input |',
      '| --json | output fields |',
      '| --limit | how many |',
    ].join('\n');
    expect(extractTables(flags)).toEqual([]);
  });
});

describe('tableToCsv', () => {
  it('quotes commas, quotes and newlines, and keeps ₹ and other unicode', () => {
    const csv = tableToCsv({
      columns: ['Name', 'Fee'],
      rows: [
        ['Data Science, v4', '₹1.5L'],
        ['He said "hi"', 'line\nbreak'],
        [' padded', 'ok'],
      ],
    });
    expect(csv).toBe(
      `${BOM}Name,Fee\r\n"Data Science, v4",₹1.5L\r\n"He said ""hi""","line\nbreak"\r\n" padded",ok\r\n`,
    );
  });

  it('neutralises anything a spreadsheet would run, and leaves whole numbers alone', () => {
    const cells = [
      '=SUM(A1)',
      '+1',
      '@cmd',
      "-1+cmd|' /C calc'!A0",
      '-1+IMPORTXML("https://x.co","//a")',
      '-1-1',
      '-x',
      '-5',
      '-3.2',
      '+12%',
      '1,234',
      '-1,234.50',
    ];
    const lines = tableToCsv({ columns: ['v'], rows: cells.map(cell => [cell]) })
      .split('\r\n')
      .slice(1, -1);
    expect(lines).toEqual([
      "'=SUM(A1)",
      '+1',
      "'@cmd",
      `"'-1+cmd|' /C calc'!A0"`.replace(/^"|"$/g, ''),
      `"'-1+IMPORTXML(""https://x.co"",""//a"")"`,
      "'-1-1",
      "'-x",
      '-5',
      '-3.2',
      '+12%',
      '"1,234"',
      '"-1,234.50"',
    ]);
  });
});

describe('which tables get a CSV', () => {
  it('a table of 5 rows does, 4 rows does not unless a sheet was asked for', () => {
    expect(tablesWorthCsv(pipeTable(5), 'how many open requests per batch?')).toHaveLength(1);
    expect(tablesWorthCsv(pipeTable(4), 'how many open requests per batch?')).toHaveLength(0);
    expect(tablesWorthCsv(pipeTable(3), 'give me this as a sheet')).toHaveLength(1);
    expect(tablesWorthCsv(pipeTable(3), 'can you share a CSV of this?')).toHaveLength(1);
  });

  it('reads an ask for a sheet, not a sheet named in the message', () => {
    expect(asksForSheet('put it in a google sheet')).toBe(true);
    expect(asksForSheet('export to excel please')).toBe(true);
    expect(asksForSheet('can I download this?')).toBe(true);
    expect(asksForSheet('send me the spreadsheet')).toBe(true);
    expect(asksForSheet('I need an excel file of these')).toBe(true);
    expect(asksForSheet('as csv please')).toBe(true);
    expect(asksForSheet('which batches are in DS Spreadsheets - September?')).toBe(false);
    expect(asksForSheet('what sheets of paper')).toBe(false);
    expect(asksForSheet('how does the cheatsheet work')).toBe(false);
    expect(asksForSheet('<https://x.co/sheet|link> what changed?')).toBe(false);
  });

  it('names files from the heading, else the question, numbered when they clash', () => {
    const tables = extractTables(`Open:\n${pipeTable(5)}\n\n${pipeTable(5)}\n\nOpen:\n${pipeTable(5)}`);
    expect(csvFileNames(tables, '<@UBOT> requests per batch?')).toEqual([
      'open-1.csv',
      'requests-per-batch.csv',
      'open-2.csv',
    ]);
    expect(csvFileNames(extractTables(pipeTable(5)), '')).toEqual(['table.csv']);
  });

  it('cuts a long name at a word boundary', () => {
    const [name] = csvFileNames(
      extractTables(pipeTable(5)),
      'how many students joined each data science batch since january and from which cities',
    );
    expect(name).toBe('how-many-students-joined-each-data-science-batch.csv');
  });
});

describe('attachReplyTablesAsCsv', () => {
  const slackWith = (upload: ReturnType<typeof vi.fn>) => ({ filesUploadV2: upload }) as unknown as WebClient;
  const base = { channelId: 'C1', threadTs: '1.1' };

  it('uploads one CSV per table with one note', async () => {
    const upload = vi.fn(async () => ({ ok: true }));
    const result = await attachReplyTablesAsCsv({
      ...base,
      slack: slackWith(upload),
      replyText: `Open:\n${pipeTable(5)}\n\nClosed:\n${pipeTable(5)}`,
      askText: 'requests per batch',
    });
    expect(result.uploaded).toBe(2);
    const args = upload.mock.calls[0][0] as {
      initial_comment: string;
      file_uploads: Array<{ filename: string; file: Buffer }>;
      thread_ts: string;
    };
    expect(args.initial_comment).toBe(CSV_NOTE_MANY);
    expect(args.thread_ts).toBe('1.1');
    expect(args.file_uploads.map(f => f.filename)).toEqual(['open.csv', 'closed.csv']);
    expect(args.file_uploads[0].file.toString('utf8')).toContain('Batch,Open,Closed\r\nB1,0,0\r\n');
  });

  it('says "the table" for one', async () => {
    const upload = vi.fn(async () => ({ ok: true }));
    await attachReplyTablesAsCsv({ ...base, slack: slackWith(upload), replyText: pipeTable(6), askText: 'q' });
    expect((upload.mock.calls[0][0] as { initial_comment: string }).initial_comment).toBe(CSV_NOTE_ONE);
  });

  it('does nothing for a reply with no table or a short one', async () => {
    const upload = vi.fn();
    await attachReplyTablesAsCsv({ ...base, slack: slackWith(upload), replyText: 'Just text.', askText: 'q' });
    await attachReplyTablesAsCsv({ ...base, slack: slackWith(upload), replyText: pipeTable(2), askText: 'q' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('skips when the agent already delivered a sheet', async () => {
    const upload = vi.fn();
    const logs: WorkflowStepLog[] = [];
    await attachReplyTablesAsCsv({
      ...base,
      slack: slackWith(upload),
      replyText: pipeTable(8),
      askText: 'q',
      sheetAlreadyDelivered: true,
      logStep: entry => logs.push(entry),
    });
    expect(upload).not.toHaveBeenCalled();
    expect(logs).toEqual([expect.objectContaining({ stage: 'reply.tables_csv.skipped' })]);
    expect(logs[0].data).toMatchObject({ reason: 'agent_sheet' });
  });

  it('skips when the app is known to lack files:write', async () => {
    botScopes.setForTest(['chat:write', 'files:read']);
    const upload = vi.fn();
    const logs: WorkflowStepLog[] = [];
    await attachReplyTablesAsCsv({
      ...base,
      slack: slackWith(upload),
      replyText: pipeTable(8),
      askText: 'q',
      logStep: entry => logs.push(entry),
    });
    expect(upload).not.toHaveBeenCalled();
    expect(logs[0].data).toMatchObject({ reason: 'missing_scope' });
  });

  it('logs a failed upload and does not throw', async () => {
    const upload = vi.fn(async () => {
      throw new Error('missing_scope');
    });
    const logs: WorkflowStepLog[] = [];
    const result = await attachReplyTablesAsCsv({
      ...base,
      slack: slackWith(upload),
      replyText: pipeTable(5),
      askText: 'q',
      logStep: entry => logs.push(entry),
    });
    expect(result.uploaded).toBe(0);
    expect(logs[0]).toMatchObject({ stage: 'reply.tables_csv.failed', level: 'WARN' });
  });

  it('never throws, even when the logger does', async () => {
    const upload = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      attachReplyTablesAsCsv({
        ...base,
        slack: slackWith(upload),
        replyText: pipeTable(5),
        askText: 'q',
        logStep: () => {
          throw new Error('logger down');
        },
      }),
    ).resolves.toEqual({ uploaded: 0 });
  });
});
