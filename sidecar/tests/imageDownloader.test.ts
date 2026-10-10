import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSlackFiles, formatUnreadableAttachmentsNote } from '../src/slack/imageDownloader.js';
import type { WorkflowStepLogger } from '../src/types/contracts.js';

const screenshot = {
  id: 'F0C5Y4URXS5',
  name: 'image.png',
  mimetype: 'image/png',
  url_private_download: 'https://files.slack.com/files-pri/T1-F0C5Y4URXS5/download/image.png',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadSlackFiles', () => {
  it('records a 403 as skipped and points the log at the files:read scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    const logs: Parameters<WorkflowStepLogger>[0][] = [];
    const result = await downloadSlackFiles({
      files: [screenshot],
      botToken: 'xoxb-test',
      logStep: entry => logs.push(entry),
    });

    expect(result.imagePaths).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'image.png', mimetype: 'image/png', reason: 'http_403' }]);
    const httpError = logs.find(l => l.stage === 'files.download.http_error');
    expect(httpError?.message).toContain('HTTP 403');
    expect(httpError?.message).toContain("'files:read'");
  });

  it('does not blame the scope for other HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const logs: Parameters<WorkflowStepLogger>[0][] = [];
    await downloadSlackFiles({ files: [screenshot], botToken: 'xoxb-test', logStep: entry => logs.push(entry) });

    const httpError = logs.find(l => l.stage === 'files.download.http_error');
    expect(httpError?.message).toBe('Failed to download image.png: HTTP 500');
  });
});

describe('formatUnreadableAttachmentsNote', () => {
  it('is empty when every attachment was read', () => {
    expect(formatUnreadableAttachmentsNote([])).toBe('');
  });

  it('tells the agent the file exists so it never claims nothing was attached', () => {
    const note = formatUnreadableAttachmentsNote([{ name: 'image.png', mimetype: 'image/png', reason: 'http_403' }]);
    expect(note).toContain('image.png (download failed, HTTP 403)');
    expect(note).toContain('never tell the user nothing was attached');
  });

  it('describes each skip reason in plain words', () => {
    const note = formatUnreadableAttachmentsNote([
      { name: 'demo.mp4', mimetype: 'video/mp4', reason: 'unsupported_mimetype' },
      { name: 'huge.png', mimetype: 'image/png', reason: 'too_large' },
      { name: 'ninth.png', mimetype: 'image/png', reason: 'max_files_exceeded' },
      { name: 'flaky.png', mimetype: 'image/png', reason: 'download_error' },
    ]);
    expect(note).toContain('demo.mp4 (unsupported file type)');
    expect(note).toContain('huge.png (over the 10MB limit)');
    expect(note).toContain('ninth.png (over the 8-file limit)');
    expect(note).toContain('flaky.png (download failed)');
  });
});
