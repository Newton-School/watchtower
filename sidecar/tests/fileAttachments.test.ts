import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  allowedAttachmentExtensions,
  attachmentRefusalReason,
  parseFileManifest,
  uploadAttachments,
  DEFAULT_ATTACHMENT_LIMITS,
} from '../src/slack/fileAttachments.js';
import { parseScreenshotManifest, uploadScreenshots } from '../src/slack/imageUploader.js';
import type { WorkflowStepLog } from '../src/types/contracts.js';

const FILES_MARKER = '===FILES===';

function makeTempFile(name: string, bytes = 32): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x61));
  return p;
}

/** Minimal WebClient stub exposing only filesUploadV2. */
function fakeSlack(filesUploadV2: (args?: unknown) => Promise<unknown>): WebClient {
  return { filesUploadV2 } as unknown as WebClient;
}

function missingScopeError(): Error {
  const err = new Error('An API error occurred: missing_scope') as Error & { data?: Record<string, unknown> };
  err.data = { ok: false, error: 'missing_scope', needed: 'files:write', provided: 'chat:write,channels:read' };
  return err;
}

describe('parseFileManifest', () => {
  it('strips the manifest from the visible reply and returns the entries', () => {
    const reply = [
      '2,676 companies have a playbook.',
      FILES_MARKER,
      '[{"path":"/tmp/a.csv","caption":"all rows"}]',
    ].join('\n');
    const { visibleText, attachments } = parseFileManifest(reply, FILES_MARKER);
    expect(visibleText).toBe('2,676 companies have a playbook.');
    expect(visibleText).not.toContain(FILES_MARKER);
    expect(attachments).toEqual([{ path: '/tmp/a.csv', caption: 'all rows' }]);
  });

  it('tolerates a fenced manifest', () => {
    const reply = `report\n${FILES_MARKER}\n\`\`\`json\n[{"path":"/tmp/a.csv"}]\n\`\`\``;
    const { visibleText, attachments } = parseFileManifest(reply, FILES_MARKER);
    expect(visibleText).toBe('report');
    expect(attachments).toEqual([{ path: '/tmp/a.csv', caption: undefined }]);
  });

  it('returns the whole reply when there is no manifest', () => {
    expect(parseFileManifest('just an answer', FILES_MARKER)).toEqual({
      visibleText: 'just an answer',
      attachments: [],
    });
  });

  it('keeps the report and drops attachments when the manifest is malformed', () => {
    const { visibleText, attachments } = parseFileManifest(`body\n${FILES_MARKER}\nnot json`, FILES_MARKER);
    expect(visibleText).toBe('body');
    expect(attachments).toEqual([]);
  });

  it('drops manifest entries with no path', () => {
    const reply = `r\n${FILES_MARKER}\n[{"caption":"no path"},{"path":"/tmp/ok.csv"}]`;
    expect(parseFileManifest(reply, FILES_MARKER).attachments).toEqual([{ path: '/tmp/ok.csv', caption: undefined }]);
  });

  it('does not treat the QA marker as a file manifest (markers are distinct)', () => {
    const reply = 'qa report\n===SCREENSHOTS===\n[{"path":"/tmp/a.png"}]';
    expect(parseFileManifest(reply, FILES_MARKER).attachments).toEqual([]);
  });
});

describe('attachmentRefusalReason', () => {
  it('allows the data and report formats an answer would attach', () => {
    for (const name of ['rows.csv', 'export.json', 'report.md', 'run.log', 'chart.png', 'summary.pdf']) {
      expect(attachmentRefusalReason(`/tmp/${name}`)).toBeUndefined();
    }
  });

  it('refuses dotfiles outright', () => {
    expect(attachmentRefusalReason('/repo/.env')).toBe('dotfile_refused');
    expect(attachmentRefusalReason('/repo/.env.production')).toBe('dotfile_refused');
    expect(attachmentRefusalReason('/home/u/.npmrc')).toBe('dotfile_refused');
  });

  it('refuses key material and extensionless files', () => {
    expect(attachmentRefusalReason('/home/u/.ssh/id_rsa')).toBeDefined();
    expect(attachmentRefusalReason('/tmp/server.pem')).toBeDefined();
    expect(attachmentRefusalReason('/tmp/private.key')).toBeDefined();
    expect(attachmentRefusalReason('/tmp/archive.zip')).toBeDefined();
  });

  it('refuses secret-looking names even with an allowed extension', () => {
    expect(attachmentRefusalReason('/tmp/credentials.json')).toBe('secret_like_filename_refused');
    expect(attachmentRefusalReason('/tmp/api-key.txt')).toBe('secret_like_filename_refused');
    expect(attachmentRefusalReason('/tmp/service.secret.json')).toBe('secret_like_filename_refused');
    // ...but a legitimately named file containing the substring is fine
    expect(attachmentRefusalReason('/tmp/tokenomics.csv')).toBeUndefined();
  });

  it('exposes the allowlist for prompt rendering', () => {
    const exts = allowedAttachmentExtensions();
    expect(exts).toContain('.csv');
    expect(exts).not.toContain('.pem');
  });
});

describe('uploadAttachments', () => {
  it('uploads a valid file and reports the count under the agentic stage prefix', async () => {
    const logs: WorkflowStepLog[] = [];
    let sent: { file: Buffer; filename: string; title: string }[] = [];
    const slack = fakeSlack((args: unknown) => {
      sent = (args as { file_uploads: typeof sent }).file_uploads;
      return Promise.resolve({ ok: true });
    });
    const n = await uploadAttachments({
      slack,
      channelId: 'C1',
      threadTs: '1.1',
      attachments: [{ path: makeTempFile('company_playbooks.csv'), caption: 'all rows' }],
      logStep: e => logs.push(e),
    });
    expect(n).toBe(1);
    expect(sent[0].filename).toBe('company_playbooks.csv');
    expect(sent[0].title).toBe('all rows');
    expect(logs.some(l => l.stage === 'agentic.files.uploaded')).toBe(true);
  });

  it('makes no API call when every attachment is refused by the allowlist', async () => {
    const logs: WorkflowStepLog[] = [];
    let called = false;
    const slack = fakeSlack(() => {
      called = true;
      return Promise.resolve({ ok: true });
    });
    const n = await uploadAttachments({
      slack,
      channelId: 'C1',
      attachments: [{ path: makeTempFile('.env') }, { path: makeTempFile('id_rsa') }],
      logStep: e => logs.push(e),
    });
    expect(called).toBe(false);
    expect(n).toBe(0);
    const none = logs.find(l => l.stage === 'agentic.files.none');
    expect(none).toBeDefined();
    const skipped = none?.data?.skipped as Array<{ reason: string }>;
    expect(skipped.map(s => s.reason)).toEqual(['dotfile_refused', 'extension_not_allowed_none']);
  });

  it('skips a file over the size cap but still uploads the rest', async () => {
    const logs: WorkflowStepLog[] = [];
    const slack = fakeSlack(() => Promise.resolve({ ok: true }));
    const n = await uploadAttachments({
      slack,
      channelId: 'C1',
      attachments: [
        { path: makeTempFile('huge.csv', DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + 1) },
        { path: makeTempFile('small.csv') },
      ],
      logStep: e => logs.push(e),
    });
    expect(n).toBe(1);
    const validated = logs.find(l => l.stage === 'agentic.files.validated');
    expect(validated?.level).toBe('WARN');
    expect(String((validated?.data?.skipped as Array<{ reason: string }>)[0].reason)).toContain('too_large');
  });

  it('caps the number of files at the configured limit', async () => {
    const logs: WorkflowStepLog[] = [];
    const attachments = Array.from({ length: DEFAULT_ATTACHMENT_LIMITS.maxFiles + 3 }, (_, i) => ({
      path: makeTempFile(`part-${i}.csv`),
    }));
    const n = await uploadAttachments({
      slack: fakeSlack(() => Promise.resolve({ ok: true })),
      channelId: 'C1',
      attachments,
      logStep: e => logs.push(e),
    });
    expect(n).toBe(DEFAULT_ATTACHMENT_LIMITS.maxFiles);
    expect(logs.find(l => l.stage === 'agentic.files.start')?.data?.capped).toBe(DEFAULT_ATTACHMENT_LIMITS.maxFiles);
  });

  it('classifies a missing files:write scope explicitly', async () => {
    const logs: WorkflowStepLog[] = [];
    const slack = fakeSlack(() => Promise.reject(missingScopeError()));
    const n = await uploadAttachments({
      slack,
      channelId: 'C1',
      attachments: [{ path: makeTempFile('rows.csv') }],
      logStep: e => logs.push(e),
    });
    expect(n).toBe(0);
    const scopeLog = logs.find(l => l.stage === 'agentic.files.missing_scope');
    expect(scopeLog?.level).toBe('ERROR');
    expect(scopeLog?.data?.needed).toBe('files:write');
    expect(logs.some(l => l.stage === 'agentic.files.upload_failed')).toBe(false);
  });
});

describe('webapp-QA adapter still behaves as before', () => {
  it('keeps the ===SCREENSHOTS=== marker and qa.evidence.* stages', async () => {
    const { visibleText, screenshots } = parseScreenshotManifest('report\n===SCREENSHOTS===\n[{"path":"/tmp/a.png"}]');
    expect(visibleText).toBe('report');
    expect(screenshots).toEqual([{ path: '/tmp/a.png', caption: undefined }]);

    const logs: WorkflowStepLog[] = [];
    const n = await uploadScreenshots({
      slack: fakeSlack(() => Promise.resolve({ ok: true })),
      channelId: 'C1',
      threadTs: '1.1',
      screenshots: [{ path: makeTempFile('shot.png') }],
      logStep: e => logs.push(e),
    });
    expect(n).toBe(1);
    expect(logs.some(l => l.stage === 'qa.evidence.uploaded')).toBe(true);
    expect(logs.some(l => l.stage.startsWith('agentic.files'))).toBe(false);
  });

  it('keeps the tighter QA size cap (5MB), independent of the agentic limit', async () => {
    const logs: WorkflowStepLog[] = [];
    const n = await uploadScreenshots({
      slack: fakeSlack(() => Promise.resolve({ ok: true })),
      channelId: 'C1',
      screenshots: [{ path: makeTempFile('big.png', 5 * 1024 * 1024 + 1) }],
      logStep: e => logs.push(e),
    });
    expect(n).toBe(0);
    expect(logs.some(l => l.stage === 'qa.evidence.none')).toBe(true);
  });
});
