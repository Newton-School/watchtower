import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowStepLogger } from '../types/contracts.js';

export interface SlackFileAttachment {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
}

const IMAGE_MIMETYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const SUPPORTED_MIMETYPES = new Set([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Code snippets (Slack uploads)
  'text/javascript',
  'text/typescript',
  'text/html',
  'text/css',
  'text/xml',
  'application/xml',
]);

const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface DownloadSlackFilesResult {
  imagePaths: string[];
  documentPaths: string[];
  allPaths: string[];
  skipped: Array<{ name: string; mimetype: string; reason: string }>;
}

export async function downloadSlackFiles(params: {
  files: SlackFileAttachment[];
  botToken: string;
  destDir?: string;
  logStep?: WorkflowStepLogger;
}): Promise<DownloadSlackFilesResult> {
  const { files, botToken, logStep } = params;

  const result: DownloadSlackFilesResult = {
    imagePaths: [],
    documentPaths: [],
    allPaths: [],
    skipped: [],
  };

  if (files.length === 0) return result;

  const supported = files.filter(f => SUPPORTED_MIMETYPES.has(f.mimetype));
  const unsupported = files.filter(f => !SUPPORTED_MIMETYPES.has(f.mimetype));

  for (const f of unsupported) {
    result.skipped.push({ name: f.name, mimetype: f.mimetype, reason: 'unsupported_mimetype' });
  }

  if (supported.length === 0) {
    logStep?.({
      stage: 'files.download.skip',
      message: `No supported files found. ${unsupported.length} file(s) skipped (unsupported types).`,
      level: 'WARN',
      data: { skipped: result.skipped },
    });
    return result;
  }

  const toDownload = supported.slice(0, MAX_FILES);
  if (supported.length > MAX_FILES) {
    for (const f of supported.slice(MAX_FILES)) {
      result.skipped.push({ name: f.name, mimetype: f.mimetype, reason: 'max_files_exceeded' });
    }
  }

  logStep?.({
    stage: 'files.download.start',
    message: `Downloading ${toDownload.length} file(s) from Slack thread.`,
    data: {
      files: toDownload.map(f => ({ name: f.name, mimetype: f.mimetype })),
      skipped: result.skipped.length,
    },
  });

  const destDir = params.destDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'watchtower-slack-files-')));
  await fs.mkdir(destDir, { recursive: true });

  for (const file of toDownload) {
    try {
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        result.skipped.push({ name: file.name, mimetype: file.mimetype, reason: `http_${response.status}` });
        // A 403 on url_private_download is almost always the token, not the
        // file: the scope can be ticked in the app config yet never granted
        // because the app wasn't reinstalled. `auth.test` → x-oauth-scopes tells.
        const hint =
          response.status === 403
            ? " — the bot token likely lacks 'files:read' (add it to the miniOG Slack app and reinstall)"
            : '';
        logStep?.({
          stage: 'files.download.http_error',
          message: `Failed to download ${file.name}: HTTP ${response.status}${hint}`,
          level: 'WARN',
          data: { fileName: file.name, status: response.status },
        });
        continue;
      }

      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > MAX_FILE_BYTES) {
        result.skipped.push({ name: file.name, mimetype: file.mimetype, reason: 'too_large' });
        logStep?.({
          stage: 'files.download.too_large',
          message: `Skipping ${file.name}: ${(contentLength / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit.`,
          level: 'WARN',
          data: { fileName: file.name, bytes: contentLength },
        });
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_FILE_BYTES) {
        result.skipped.push({ name: file.name, mimetype: file.mimetype, reason: 'too_large' });
        continue;
      }

      const ext = extensionForMimetype(file.mimetype) || path.extname(file.name).replace('.', '');
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = path.join(destDir, `${file.id}-${safeName}${ext ? `.${ext}` : ''}`);

      await fs.writeFile(destPath, buffer);

      const isImage = IMAGE_MIMETYPES.has(file.mimetype);
      if (isImage) {
        result.imagePaths.push(destPath);
      } else {
        result.documentPaths.push(destPath);
      }
      result.allPaths.push(destPath);
    } catch (error) {
      result.skipped.push({ name: file.name, mimetype: file.mimetype, reason: 'download_error' });
      logStep?.({
        stage: 'files.download.error',
        message: `Error downloading ${file.name}: ${String(error)}`,
        level: 'WARN',
        data: { fileName: file.name, error: String(error) },
      });
    }
  }

  logStep?.({
    stage: 'files.download.done',
    message: `Downloaded ${result.allPaths.length} file(s): ${result.imagePaths.length} image(s), ${result.documentPaths.length} document(s). ${result.skipped.length} skipped.`,
    data: {
      images: result.imagePaths.length,
      documents: result.documentPaths.length,
      skipped: result.skipped,
    },
  });

  return result;
}

/**
 * Prompt note for thread attachments the agent can't see. Without it a failed
 * download is indistinguishable from "nothing was attached", and the agent
 * tells the user there was no screenshot when there was one.
 */
export function formatUnreadableAttachmentsNote(skipped: DownloadSlackFilesResult['skipped']): string {
  if (skipped.length === 0) return '';
  const list = skipped.map(s => `${s.name} (${describeSkipReason(s.reason)})`).join(', ');
  return (
    `\n\n[Attachments in this thread that you could NOT open: ${list}. ` +
    'They were attached — never tell the user nothing was attached. If the request depends on one, ' +
    "say you couldn't open it and ask for its content another way (a description, the page URL, or pasted text).]"
  );
}

function describeSkipReason(reason: string): string {
  if (reason === 'unsupported_mimetype') return 'unsupported file type';
  if (reason === 'max_files_exceeded') return `over the ${MAX_FILES}-file limit`;
  if (reason === 'too_large') return 'over the 10MB limit';
  if (reason.startsWith('http_')) return `download failed, HTTP ${reason.slice('http_'.length)}`;
  return 'download failed';
}

/** @deprecated Use downloadSlackFiles instead */
export async function downloadSlackImages(params: {
  files: SlackFileAttachment[];
  botToken: string;
  destDir?: string;
}): Promise<string[]> {
  const result = await downloadSlackFiles(params);
  return result.imagePaths;
}

function extensionForMimetype(mimetype: string): string {
  switch (mimetype) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    case 'text/plain':
      return 'txt';
    case 'text/markdown':
      return 'md';
    case 'text/csv':
      return 'csv';
    case 'application/json':
      return 'json';
    default:
      return '';
  }
}
