import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectThreadAttachments, filesForTrigger } from '../src/slack/threadAttachments.js';
import type { SlackFileAttachment } from '../src/slack/imageDownloader.js';

function file(id: string, name: string, mimetype: string): SlackFileAttachment {
  return { id, name, mimetype, url_private_download: `https://files.slack.example/${id}/${name}` };
}

const screenshot = file('F1', 'image.png', 'image/png');
const notes = file('F2', 'notes.txt', 'text/plain');

function serve(bodies: Record<string, { status?: number; body?: string | Buffer }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const entry = Object.entries(bodies).find(([id]) => url.includes(`/${id}/`))?.[1] ?? { status: 404 };
      return new Response(entry.body ?? '', { status: entry.status ?? 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('collectThreadAttachments', () => {
  it('does nothing for a thread without files', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await collectThreadAttachments({ files: [], botToken: 'xoxb-test' })).toEqual({
      imagePaths: [],
      documentContext: '',
      unreadableNote: '',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns images by path and the text of documents', async () => {
    serve({ F1: { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, F2: { body: 'lecture ids: 11, 12, 13' } });

    const result = await collectThreadAttachments({ files: [screenshot, notes], botToken: 'xoxb-test' });

    expect(result.imagePaths).toHaveLength(1);
    expect(fs.existsSync(result.imagePaths[0])).toBe(true);
    expect(result.documentContext).toContain('Attached documents from thread:');
    expect(result.documentContext).toContain('lecture ids: 11, 12, 13');
    expect(result.unreadableNote).toBe('');
  });

  it('hands a PDF over by path instead of pasting its bytes into the prompt', async () => {
    serve({ F3: { body: Buffer.from('%PDF-1.7\n\u0000\u0001binary') } });

    const result = await collectThreadAttachments({
      files: [file('F3', 'how-xp-works.pdf', 'application/pdf')],
      botToken: 'xoxb-test',
    });

    expect(result.imagePaths).toHaveLength(1);
    expect(result.imagePaths[0].endsWith('.pdf')).toBe(true);
    expect(result.documentContext).toBe('');
  });

  it('clips a long document instead of flooding the prompt', async () => {
    serve({ F2: { body: 'x'.repeat(20_000) } });

    const result = await collectThreadAttachments({ files: [notes], botToken: 'xoxb-test' });

    expect(result.documentContext.length).toBeGreaterThan(8000);
    expect(result.documentContext.length).toBeLessThan(8200);
  });

  // The state of the installed token for the whole audit window: every download a 403.
  it('names a file it could not open, so the agent never says nothing was attached', async () => {
    serve({ F1: { status: 403 } });

    const result = await collectThreadAttachments({ files: [screenshot], botToken: 'xoxb-test' });

    expect(result.imagePaths).toEqual([]);
    expect(result.unreadableNote).toContain('image.png (download failed, HTTP 403)');
    expect(result.unreadableNote).toContain('never tell the user nothing was attached');
  });

  it('still names the files when the download blows up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    const result = await collectThreadAttachments({ files: [screenshot, notes], botToken: 'xoxb-test' });

    expect(result.imagePaths).toEqual([]);
    expect(result.unreadableNote).toContain('image.png');
    expect(result.unreadableNote).toContain('notes.txt');
  });
});

describe('filesForTrigger', () => {
  const thread = [
    { ts: '100.1', files: [file('OLD', 'old.png', 'image/png')] },
    { ts: '200.1' },
    { ts: '300.1', files: [file('MID', 'mid.png', 'image/png')] },
    { ts: '400.1', files: [file('NOW', 'now.png', 'image/png'), file('NOW2', 'now2.png', 'image/png')] },
    { ts: '500.1', files: [file('LATER', 'later.png', 'image/png')] },
  ];

  it("puts the triggering message's files first, then the rest newest first", () => {
    expect(filesForTrigger(thread, '400.1').map(f => f.id)).toEqual(['NOW', 'NOW2', 'LATER', 'MID', 'OLD']);
  });

  it('falls back to newest first when the trigger carries no file', () => {
    expect(filesForTrigger(thread, '200.1').map(f => f.id)).toEqual(['LATER', 'NOW', 'NOW2', 'MID', 'OLD']);
  });

  it('lists a file once even when two messages carry it', () => {
    const shared = file('SAME', 'same.png', 'image/png');
    expect(
      filesForTrigger(
        [
          { ts: '1.1', files: [shared] },
          { ts: '2.1', files: [shared] },
        ],
        '2.1',
      ),
    ).toHaveLength(1);
  });
});
