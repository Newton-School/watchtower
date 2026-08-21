import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';

export interface FileAttachment {
  /** Absolute path to a file the agent produced. */
  path: string;
  /** Short human caption describing what the file holds. */
  caption?: string;
}

export interface ParsedAttachmentReply {
  /** Reply text with the manifest stripped — safe to post to Slack. */
  visibleText: string;
  attachments: FileAttachment[];
}

export interface AttachmentLimits {
  /** Hard cap on how many files one reply may attach. */
  maxFiles: number;
  /** Hard cap on the size of a single file, in bytes. */
  maxFileBytes: number;
}

/**
 * Extensions miniOG is allowed to hand to Slack. This is an ALLOWLIST, not a
 * denylist, and it is a security control rather than a convenience: the agent
 * that produces the manifest runs `Bash` inside real repo clones, so a
 * prompt-injected or simply confused run could otherwise name
 * `~/.ssh/id_rsa` or a `.env` and have the sidecar publish it into a Slack
 * channel. Anything without an extension on this list is refused, which
 * already covers `id_rsa`, `*.pem`, `*.key`, and friends.
 */
const ALLOWED_EXTENSIONS = new Set([
  // tabular / structured data — the common "give me the full list" case
  '.csv',
  '.tsv',
  '.json',
  '.ndjson',
  '.yaml',
  '.yml',
  '.xml',
  '.sql',
  // text + reports
  '.txt',
  '.md',
  '.log',
  '.html',
  '.pdf',
  // diffs
  '.diff',
  '.patch',
  // images (the webapp-QA screenshot path)
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
]);

/**
 * Basenames that look like secret material even when the extension is
 * allowed — `credentials.json`, `api-key.txt`, `service-account.secret.json`.
 * Defense in depth behind {@link ALLOWED_EXTENSIONS}.
 */
const SECRET_NAME_RE = /(^|[._-])(secrets?|credentials?|passwo?rd|token|api[._-]?key|private[._-]?key)([._-]|$)/i;

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFiles: 5,
  maxFileBytes: 20 * 1024 * 1024,
};

/**
 * Gate a single path against the allowlist. Returns `undefined` when the file
 * may be uploaded, or a short machine-readable reason when it may not — the
 * reason is surfaced in the `*.validated` / `*.none` step logs so a refusal is
 * visible in the job trail instead of looking like a silent drop.
 */
export function attachmentRefusalReason(filePath: string): string | undefined {
  const base = path.basename(filePath);
  // Dotfiles (`.env`, `.env.production`, `.npmrc`, `.netrc`, `.git-credentials`)
  // are refused outright — several carry credentials and none are legitimate
  // things for miniOG to post into a channel.
  if (base.startsWith('.')) {
    return 'dotfile_refused';
  }
  const ext = path.extname(base).toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    return `extension_not_allowed_${ext || 'none'}`;
  }
  if (SECRET_NAME_RE.test(base)) {
    return 'secret_like_filename_refused';
  }
  return undefined;
}

/** Human-readable list of what an agent is allowed to attach, for prompts. */
export function allowedAttachmentExtensions(): string[] {
  return [...ALLOWED_EXTENSIONS].sort();
}

/**
 * Split an agent reply into the visible text and its file manifest.
 *
 * The agent ends its final message with `marker` followed by a JSON array of
 * `{ path, caption }`, so the sidecar can upload the real files and keep the
 * bookkeeping out of the Slack text. A missing or malformed manifest is
 * non-fatal: the reply (minus a present-but-broken marker) comes back as
 * visible text with no attachments.
 */
export function parseFileManifest(reply: string, marker: string): ParsedAttachmentReply {
  const markerRe = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([\\s\\S]*)$`);
  const match = markerRe.exec(reply);
  if (!match) {
    return { visibleText: reply.trim(), attachments: [] };
  }

  const visibleText = reply.slice(0, match.index).trim();

  let attachments: FileAttachment[] = [];
  try {
    const body = match[1]
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      attachments = parsed
        .filter(
          (entry): entry is { path: string; caption?: unknown } => Boolean(entry) && typeof entry.path === 'string',
        )
        .map(entry => ({
          path: entry.path,
          caption: typeof entry.caption === 'string' ? entry.caption : undefined,
        }));
    }
  } catch {
    // Malformed manifest — drop the attachments, keep the reply.
  }

  return { visibleText, attachments };
}

/**
 * Upload agent-produced files into a Slack thread via `filesUploadV2`.
 *
 * Best-effort by design: it validates each path against the allowlist, checks
 * the file exists and fits the size cap, caps the count, and swallows Slack
 * errors (returning how many actually landed) so an upload hiccup never fails
 * the run that produced the files. The text reply is posted separately by the
 * caller and always survives.
 *
 * `stagePrefix` / `noun` let callers keep their own step-log vocabulary — the
 * webapp-QA path reports `qa.evidence.*` / "screenshot", agentic replies
 * report `agentic.files.*` / "file".
 */
export async function uploadAttachments(params: {
  slack: WebClient;
  channelId: string;
  threadTs?: string;
  attachments: FileAttachment[];
  logStep?: WorkflowStepLogger;
  stagePrefix?: string;
  noun?: string;
  limits?: AttachmentLimits;
}): Promise<number> {
  const {
    slack,
    channelId,
    threadTs,
    attachments,
    logStep,
    stagePrefix = 'agentic.files',
    noun = 'file',
    limits = DEFAULT_ATTACHMENT_LIMITS,
  } = params;
  const stage = (suffix: string) => `${stagePrefix}.${suffix}`;

  if (attachments.length === 0) {
    logStep?.({
      stage: stage('skip'),
      message: `No ${noun}s in the reply manifest — nothing to upload.`,
      data: { listed: 0 },
    });
    return 0;
  }

  const candidates = attachments.slice(0, limits.maxFiles);
  logStep?.({
    stage: stage('start'),
    message: `Preparing ${noun} upload: ${attachments.length} listed${
      attachments.length > limits.maxFiles ? `, capped to ${limits.maxFiles}` : ''
    }.`,
    data: { listed: attachments.length, capped: candidates.length, channelId, threadTs },
  });

  const uploads: Array<{ file: Buffer; filename: string; title: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const attachment of candidates) {
    const refusal = attachmentRefusalReason(attachment.path);
    if (refusal) {
      skipped.push({ path: attachment.path, reason: refusal });
      continue;
    }
    try {
      const stat = await fs.stat(attachment.path);
      if (!stat.isFile()) {
        skipped.push({ path: attachment.path, reason: 'not_a_file' });
        continue;
      }
      if (stat.size === 0) {
        skipped.push({ path: attachment.path, reason: 'empty' });
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        skipped.push({ path: attachment.path, reason: `too_large_${stat.size}b` });
        continue;
      }
      const buffer = await fs.readFile(attachment.path);
      const filename = path.basename(attachment.path) || `${noun}-${uploads.length + 1}`;
      uploads.push({ file: buffer, filename, title: attachment.caption ?? filename });
    } catch (err) {
      skipped.push({ path: attachment.path, reason: `unreadable: ${String(err)}` });
    }
  }

  logStep?.({
    stage: stage('validated'),
    message: `${noun[0].toUpperCase()}${noun.slice(1)} validation: ${uploads.length} ready, ${skipped.length} skipped.`,
    level: skipped.length > 0 ? 'WARN' : 'INFO',
    data: { ready: uploads.length, skipped },
  });

  if (uploads.length === 0) {
    logStep?.({
      stage: stage('none'),
      message: `No valid ${noun}s to upload (of ${attachments.length} listed).`,
      level: 'WARN',
      data: { skipped },
    });
    return 0;
  }

  const totalBytes = uploads.reduce((sum, u) => sum + u.file.length, 0);
  logStep?.({
    stage: stage('upload_attempt'),
    message: `Calling filesUploadV2 with ${uploads.length} ${noun}(s) (~${Math.round(totalBytes / 1024)}KB) — requires the bot 'files:write' scope.`,
    data: { count: uploads.length, totalBytes, filenames: uploads.map(u => u.filename), channelId, threadTs },
  });

  try {
    await slack.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      file_uploads: uploads,
    });
    logStep?.({
      stage: stage('uploaded'),
      message: `Uploaded ${uploads.length} ${noun}(s) to the thread.`,
      data: { count: uploads.length, totalBytes },
    });
    return uploads.length;
  } catch (error) {
    const info = describeSlackError(error);
    // Surface the `files:write` scope gap explicitly — it's the single most
    // common reason attachments silently don't appear, and the raw Slack error
    // (`missing_scope`) is otherwise easy to miss in the log noise.
    if (info.isMissingScope) {
      logStep?.({
        stage: stage('missing_scope'),
        level: 'ERROR',
        message:
          `${noun[0].toUpperCase()}${noun.slice(1)} upload rejected: the bot token lacks the 'files:write' scope. ` +
          'Add it as a Bot Token Scope on the miniOG Slack app and reinstall to the workspace ' +
          `(needed=${info.needed ?? 'files:write'}, provided=${info.provided ?? 'unknown'}). ` +
          `The text reply still posted; only the ${noun}s were dropped.`,
        data: { count: uploads.length, needed: info.needed, provided: info.provided, slackError: info.slackError },
      });
      return 0;
    }
    logStep?.({
      stage: stage('upload_failed'),
      message: `${noun[0].toUpperCase()}${noun.slice(1)} upload failed (${uploads.length} file(s)): ${info.slackError ?? String(error)}`,
      level: 'WARN',
      data: { count: uploads.length, slackError: info.slackError },
    });
    return 0;
  }
}

/**
 * Pull the useful bits out of a thrown Slack Web API error. `@slack/web-api`
 * attaches the raw API response to `error.data` (e.g.
 * `{ ok:false, error:'missing_scope', needed:'files:write', provided:'chat:write,...' }`),
 * which lets us classify the `files:write` scope gap precisely rather than
 * stringifying an opaque error.
 */
function describeSlackError(error: unknown): {
  slackError?: string;
  needed?: string;
  provided?: string;
  isMissingScope: boolean;
} {
  const data = (error as { data?: Record<string, unknown> } | null)?.data;
  const slackError = typeof data?.error === 'string' ? (data.error as string) : undefined;
  const needed = typeof data?.needed === 'string' ? (data.needed as string) : undefined;
  const provided = typeof data?.provided === 'string' ? (data.provided as string) : undefined;
  const isMissingScope = slackError === 'missing_scope' || /missing_scope/.test(String(error));
  return { slackError, needed, provided, isMissingScope };
}
