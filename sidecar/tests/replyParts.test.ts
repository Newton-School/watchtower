import { describe, expect, it, vi } from 'vitest';
import { chunkForSlack } from '../src/slack/attachmentFollowUp.js';
import { clipText, postInParts, slackLength, SLACK_PART_CHARS, splitSlackText } from '../src/slack/replyParts.js';

function words(count: number, word = 'word'): string {
  return Array.from({ length: count }, () => word).join(' ');
}

/** Every part fits, and nothing but the whitespace at a cut went missing. */
function expectWhole(text: string, parts: string[], limit: number) {
  for (const part of parts) expect(slackLength(part)).toBeLessThanOrEqual(limit);
  const squash = (value: string) => value.replace(/\s+/g, '');
  expect(squash(parts.join(''))).toBe(squash(text));
}

describe('splitSlackText', () => {
  it('leaves a reply that fits alone', () => {
    expect(splitSlackText('short reply')).toEqual(['short reply']);
    const full = 'x'.repeat(SLACK_PART_CHARS);
    expect(splitSlackText(full)).toEqual([full]);
  });

  it('cuts at a paragraph break before a line break', () => {
    const text = `${words(10, 'alpha')}\n\n${words(5, 'beta')}\n${words(10, 'gamma')}`;
    const parts = splitSlackText(text, 100);
    expect(parts[0]).toBe(`${words(10, 'alpha')}`);
    expect(parts[1].startsWith('beta')).toBe(true);
    expectWhole(text, parts, 100);
  });

  it('falls back to a line break, then a sentence end, then a space', () => {
    const lines = `${words(8, 'one')}\n${words(8, 'two')}\n${words(8, 'six')}`;
    expect(splitSlackText(lines, 70)[0]).toBe(`${words(8, 'one')}\n${words(8, 'two')}`);

    const sentences = `${words(9, 'first')}. ${words(9, 'second')} and ${words(9, 'third')}`;
    expect(splitSlackText(sentences, 100)[0]).toBe(`${words(9, 'first')}.`);

    const plain = words(40, 'dedupe');
    const parts = splitSlackText(plain, 100);
    for (const part of parts) expect(part).toMatch(/^dedupe( dedupe)*$/);
    expectWhole(plain, parts, 100);
  });

  it('does not take a break in the first half of a part when a later one fits', () => {
    const text = `intro\n\n${words(30, 'body')}. ${words(30, 'more')}`;
    const parts = splitSlackText(text, 200);
    expect(parts[0].length).toBeGreaterThan(100);
    expectWhole(text, parts, 200);
  });

  it('keeps inline code, mentions and links whole', () => {
    const filler = words(12, 'pad');
    const text = `${filler} \`npm run build --prefix sidecar\` <@U05EUC842KD> <https://example.com/a b|the docs page> ${filler}`;
    for (const limit of [60, 70, 80, 90, 100, 110]) {
      const parts = splitSlackText(text, limit);
      const joined = parts.join('\n');
      expect(joined).toContain('`npm run build --prefix sidecar`');
      expect(joined).toContain('<@U05EUC842KD>');
      expect(joined).toContain('<https://example.com/a b|the docs page>');
      expectWhole(text, parts, limit);
    }
  });

  it('moves a code block that fits to the next part instead of cutting it', () => {
    const block = '```ts\nconst a = 1;\nconst b = 2;\n```';
    const text = `${words(12, 'lead')}\n${block}\nafter`;
    const parts = splitSlackText(text, 90);
    expect(parts).toContain(`${block}\nafter`);
  });

  it('closes a long code block at a line break and reopens it with its language', () => {
    const code = Array.from({ length: 30 }, (_, i) => `  const value${i} = compute(${i});`).join('\n');
    const text = `Here is the change:\n\`\`\`ts\n${code}\n\`\`\`\nThat is all.`;
    const parts = splitSlackText(text, 300);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(slackLength(part)).toBeLessThanOrEqual(300);
      // Every part's fences pair up.
      expect((part.split('```').length - 1) % 2).toBe(0);
    }
    for (const part of parts.slice(1, -1)) expect(part.startsWith('```ts\n')).toBe(true);
    // Code lines are never cut and keep their indentation.
    const codeLines = parts.flatMap(part => part.split('\n')).filter(line => line.includes('compute('));
    expect(codeLines).toEqual(code.split('\n'));
    expect(parts[parts.length - 1].endsWith('That is all.')).toBe(true);
  });

  it('cuts one over-long code line at the limit and still closes the block', () => {
    const text = `\`\`\`\n${'x'.repeat(250)}\n\`\`\``;
    const parts = splitSlackText(text, 100);
    for (const part of parts) {
      expect(slackLength(part)).toBeLessThanOrEqual(100);
      expect(part.startsWith('```')).toBe(true);
      expect(part.endsWith('```')).toBe(true);
    }
    expect(parts.join('').replace(/```|\n/g, '')).toBe('x'.repeat(250));
  });

  it('cuts a single token longer than the limit rather than looping', () => {
    const token = 'a'.repeat(250);
    const parts = splitSlackText(`see ${token} now`, 100);
    for (const part of parts) expect(slackLength(part)).toBeLessThanOrEqual(100);
    expect(parts.join('').replace(/\s/g, '')).toBe(`see${token}now`);
  });

  it('never cuts an emoji or other multi-byte character in half', () => {
    const text = '👍🏽é漢'.repeat(60);
    const parts = splitSlackText(text, 50);
    expect(parts.join('')).toBe(text);
    for (const part of parts) {
      expect(slackLength(part)).toBeLessThanOrEqual(50);
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it('counts characters Slack escapes at their escaped length', () => {
    expect(slackLength('a & b < c')).toBe(9 + 4 + 3);
    const parts = splitSlackText(words(80, 'R&D'), 200);
    for (const part of parts) expect(slackLength(part)).toBeLessThanOrEqual(200);
  });

  it('counts text already escaped once, and never cuts inside an entity', () => {
    expect(slackLength('a &amp; b &lt; c')).toBe(16);
    // Attachment content arrives in chunks escaped to fit; they are not split again.
    for (const chunk of chunkForSlack('&'.repeat(2000))) expect(splitSlackText(chunk)).toEqual([chunk]);
    const parts = splitSlackText('&amp;'.repeat(50), 23);
    for (const part of parts) expect(part).toMatch(/^(&amp;)+$/);
  });

  it('splits a 4,100-character reply where Slack would have cut mid-word', () => {
    const paragraph = `${words(60, 'finding')}.`;
    const text = Array.from({ length: 9 }, () => paragraph).join('\n\n');
    expect(text.length).toBeGreaterThan(4_000);
    const parts = splitSlackText(text);
    expect(parts.length).toBe(2);
    for (const part of parts) expect(part.endsWith('.')).toBe(true);
  });
});

describe('clipText', () => {
  it('leaves short text alone', () => {
    expect(clipText('fine as it is', 50)).toBe('fine as it is');
  });

  it('cuts at a space within the limit and adds an ellipsis', () => {
    const clipped = clipText('The sibling parameter passes through getValidCampaign before the request', 50);
    expect(clipped).toBe('The sibling parameter passes through…');
    expect(clipped.length).toBeLessThanOrEqual(50);
  });

  it('drops a trailing comma or colon before the ellipsis', () => {
    expect(clipText('first, second, third, fourth, fifth', 22)).toBe('first, second, third…');
  });

  it('leaves inline code and mentions whole or out', () => {
    expect(clipText('run `npm run build --prefix sidecar` then wait', 30)).toBe('run…');
    expect(clipText('ask <@U05EUC842KD> about it today', 15)).toBe('ask…');
  });

  it('cuts a word with no space in reach at the limit, never mid-emoji', () => {
    expect(clipText('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
    const clipped = clipText('😀'.repeat(10), 10);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  it('closes a code block it cut', () => {
    const clipped = clipText('Before:\n```\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```', 30);
    expect((clipped.split('```').length - 1) % 2).toBe(0);
  });
});

describe('postInParts', () => {
  it('posts a short reply once, as it is', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, ts: '1' });
    const args = { channel: 'C1', thread_ts: '9', text: 'hello' };
    await expect(postInParts(post, args)).resolves.toEqual({ ok: true, ts: '1' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(args);
  });

  it('posts a long reply in order, in the same thread, and answers with the first part', async () => {
    let n = 0;
    const post = vi.fn(async () => ({ ok: true, ts: String(++n) }));
    const text = `${words(15, 'alpha')}\n\n${words(15, 'beta')}\n\n${words(15, 'gamma')}`;
    const result = await postInParts(post, { channel: 'C1', thread_ts: '9', text, reply_broadcast: true }, 100);
    expect(result).toEqual({ ok: true, ts: '1' });
    const calls = post.mock.calls.map(call => (call as unknown[])[0] as Record<string, unknown>);
    expect(calls.length).toBe(3);
    expect(calls.map(call => call.thread_ts)).toEqual(['9', '9', '9']);
    expect(calls.map(call => String(call.text).split(' ')[0])).toEqual(['alpha', 'beta', 'gamma']);
    // Only the first part is sent to the channel too.
    expect(calls.map(call => call.reply_broadcast)).toEqual([true, false, false]);
  });

  it('stops when the first part is refused, and swallows a later failure', async () => {
    const text = `${words(15, 'alpha')}\n\n${words(15, 'beta')}\n\n${words(15, 'gamma')}`;
    const refused = vi.fn().mockResolvedValue({ ok: false });
    await expect(postInParts(refused, { text }, 100)).resolves.toEqual({ ok: false });
    expect(refused).toHaveBeenCalledTimes(1);

    const flaky = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: '1' })
      .mockRejectedValueOnce(new Error('ratelimited'))
      .mockResolvedValue({ ok: true, ts: '3' });
    await expect(postInParts(flaky, { text }, 100)).resolves.toEqual({ ok: true, ts: '1' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('posts text that only backs blocks as it is', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true });
    const args = { text: words(100), blocks: [{ type: 'section' }] };
    await postInParts(post, args, 100);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(args);
  });
});
