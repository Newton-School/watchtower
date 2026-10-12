import { describe, expect, it } from 'vitest';
import {
  buildUndeliveredFollowUp,
  chunkForSlack,
  INLINE_CHUNK_CHARS,
  INLINE_MAX_CHARS,
} from '../src/slack/attachmentFollowUp.js';
import { DEFAULT_ATTACHMENT_LIMITS, type UndeliveredAttachment } from '../src/slack/fileAttachments.js';

const LIMITS = DEFAULT_ATTACHMENT_LIMITS;

function failedUpload(filename: string, text: string, reason: UndeliveredAttachment['reason'] = 'missing_scope') {
  const content = Buffer.from(text, 'utf8');
  return { filename, reason, bytes: content.length, content } satisfies UndeliveredAttachment;
}

// Issue #433: twelve replies in 30 days said a file was attached, none arrived,
// and nothing told the thread.
describe('buildUndeliveredFollowUp', () => {
  it('says nothing when every file arrived', () => {
    expect(buildUndeliveredFollowUp([], LIMITS)).toEqual({ messages: [], inlined: [], lost: [] });
  });

  it('pastes a small text file and says why it did not attach', () => {
    const followUp = buildUndeliveredFollowUp([failedUpload('lectures.csv', 'id,title\n1,Intro\n2,Arrays\n')], LIMITS);

    expect(followUp.inlined).toEqual(['lectures.csv']);
    expect(followUp.lost).toEqual([]);
    expect(followUp.messages).toEqual([
      ":warning: `lectures.csv` didn't attach: Slack won't let me upload files yet (the app is missing the " +
        '`files:write` permission). Here it is as text instead:\n```\nid,title\n1,Intro\n2,Arrays\n```',
    ]);
  });

  it('splits a longer file into numbered messages, each within the Slack limit', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `${i},lecture number ${i},2026-09-${(i % 28) + 1}`);
    const followUp = buildUndeliveredFollowUp([failedUpload('timestamps.csv', rows.join('\n'))], LIMITS);

    expect(followUp.inlined).toEqual(['timestamps.csv']);
    expect(followUp.messages.length).toBeGreaterThan(1);
    const total = followUp.messages.length;
    expect(followUp.messages[0]).toContain(`Here it is as text instead (1/${total}):`);
    expect(followUp.messages[1].startsWith(`\`timestamps.csv\` (2/${total}):\n\`\`\`\n`)).toBe(true);
    for (const message of followUp.messages) {
      expect(message.length).toBeLessThan(4000);
    }
    // Nothing lost or reordered between the chunks.
    const pasted = followUp.messages
      .map(message => message.slice(message.indexOf('```\n') + 4, message.lastIndexOf('\n```')))
      .join('\n');
    expect(pasted).toBe(rows.join('\n'));
  });

  it('does not paste a text file that is too long, and says so', () => {
    const big = failedUpload('everything.csv', 'x'.repeat(80) + '\n'.repeat(1) + 'row,row,row\n'.repeat(4000));
    const followUp = buildUndeliveredFollowUp([big], LIMITS);

    expect(followUp.inlined).toEqual([]);
    expect(followUp.lost).toEqual(['everything.csv']);
    expect(followUp.messages).toHaveLength(1);
    expect(followUp.messages[0]).toContain("`everything.csv` didn't attach");
    expect(followUp.messages[0]).toContain('KB it is too long to paste here');
    expect(followUp.messages[0]).toContain("Ask for the part you need and I'll put it in the message.");
  });

  it('does not paste a PDF or an image', () => {
    const pdf = { filename: 'how-xp-works.pdf', reason: 'missing_scope', bytes: 754_864, content: Buffer.alloc(64) };
    const followUp = buildUndeliveredFollowUp([pdf as UndeliveredAttachment], LIMITS);

    expect(followUp.lost).toEqual(['how-xp-works.pdf']);
    expect(followUp.messages).toEqual([
      ":warning: `how-xp-works.pdf` didn't attach: Slack won't let me upload files yet (the app is missing the " +
        "`files:write` permission), and it isn't something I can paste as text.",
    ]);
  });

  it('does not paste a file with a text extension that is not text', () => {
    const binary = {
      filename: 'export.csv',
      reason: 'upload_failed',
      bytes: 4,
      content: Buffer.from([0xff, 0xfe, 0x00, 0x41]),
    } satisfies UndeliveredAttachment;

    expect(buildUndeliveredFollowUp([binary], LIMITS).lost).toEqual(['export.csv']);
  });

  it('never pastes a file that was refused before the upload', () => {
    const refused: UndeliveredAttachment[] = [
      { filename: 'credentials.json', reason: 'refused' },
      { filename: 'gone.csv', reason: 'not_found' },
      { filename: 'part-6.csv', reason: 'over_file_limit' },
      { filename: 'huge.csv', reason: 'too_large', bytes: 30 * 1024 * 1024 },
      { filename: 'blank.txt', reason: 'empty', bytes: 0 },
    ];
    const followUp = buildUndeliveredFollowUp(refused, LIMITS);

    expect(followUp.inlined).toEqual([]);
    expect(followUp.lost).toHaveLength(5);
    expect(followUp.messages).toEqual([
      [
        ":warning: These files didn't attach:",
        "• `credentials.json`: it isn't a kind of file I'm allowed to post",
        "• `gone.csv`: the file wasn't there when I went to send it",
        '• `part-6.csv`: I can attach at most 5 files to one reply',
        '• `huge.csv`: it is over the 20.0 MB limit',
        '• `blank.txt`: the file turned out to be empty',
      ].join('\n'),
    ]);
  });

  it('gives one cause once when several files share it', () => {
    const shots = ['home.png', 'cart.png', 'checkout.png'].map(
      filename =>
        ({ filename, reason: 'missing_scope', bytes: 512, content: Buffer.alloc(512, 7) }) as UndeliveredAttachment,
    );

    expect(buildUndeliveredFollowUp(shots, LIMITS).messages).toEqual([
      ":warning: 3 files didn't attach (`home.png`, `cart.png`, `checkout.png`): Slack won't let me upload files yet " +
        "(the app is missing the `files:write` permission), and they aren't something I can paste as text.",
    ]);
  });

  it('puts the files it could not deliver first, then the pasted ones', () => {
    const followUp = buildUndeliveredFollowUp(
      [
        failedUpload('spec.md', '# Spec\n- one\n- two', 'upload_failed'),
        { filename: 'chart.png', reason: 'not_found' },
      ],
      LIMITS,
    );

    expect(followUp.lost).toEqual(['chart.png']);
    expect(followUp.inlined).toEqual(['spec.md']);
    expect(followUp.messages[0]).toBe(
      ":warning: `chart.png` didn't attach: the file wasn't there when I went to send it.",
    );
    expect(followUp.messages[1]).toContain(
      "`spec.md` didn't attach: Slack rejected the upload. Here it is as text instead:",
    );
  });

  it('shares one paste budget across the files of a reply', () => {
    const half = 'y'.repeat(99) + '\n';
    const first = failedUpload('a.csv', half.repeat(Math.floor(INLINE_MAX_CHARS / 100 / 2) + 20));
    const second = failedUpload('b.csv', half.repeat(Math.floor(INLINE_MAX_CHARS / 100 / 2) + 20));
    const third = failedUpload('c.csv', 'small,file\n');
    const followUp = buildUndeliveredFollowUp([first, second, third], LIMITS);

    expect(followUp.inlined).toEqual(['a.csv', 'c.csv']);
    expect(followUp.lost).toEqual(['b.csv']);
  });
});

describe('chunkForSlack', () => {
  it('escapes what Slack would read as a mention or a link', () => {
    expect(chunkForSlack('name,note\nasha,<!channel> & <@U123> said a > b')).toEqual([
      'name,note\nasha,&lt;!channel&gt; &amp; &lt;@U123&gt; said a &gt; b',
    ]);
  });

  it('keeps a code fence inside the content from closing the block', () => {
    const [chunk] = chunkForSlack('before\n```js\nconst a = 1;\n```\nafter');
    expect(chunk).not.toContain('```');
    expect(chunk.replace(/\u200b/g, '')).toBe('before\n```js\nconst a = 1;\n```\nafter');
  });

  it('splits a single line longer than a chunk without cutting an escaped character in half', () => {
    const chunks = chunkForSlack('&'.repeat(2000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(INLINE_CHUNK_CHARS);
      expect(chunk.replace(/&amp;/g, '')).toBe('');
    }
    expect(chunks.join('').length).toBe(2000 * 5);
  });
});
