import fs from 'node:fs/promises';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';

export interface ScreenshotEntry {
  /** Absolute path to a screenshot the agent captured. */
  path: string;
  /** Short human caption describing the state shown. */
  caption?: string;
}

export interface ParsedQaReply {
  /** Report text with the screenshot manifest stripped — safe to post to Slack. */
  visibleText: string;
  screenshots: ScreenshotEntry[];
}

const MAX_SCREENSHOTS = 8;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// The QA agent ends its final message with a manifest of the screenshots it
// captured, delimited by this marker, so we can upload the actual PNGs to the
// thread and keep them out of the visible report text. Everything from the
// marker to the end of the message is the manifest.
const MANIFEST_MARKER_RE = /===SCREENSHOTS===\s*([\s\S]*)$/;

/**
 * Split a QA agent reply into the visible report text and the screenshot
 * manifest. The manifest is a JSON array of `{ path, caption }` after a
 * `===SCREENSHOTS===` marker (optionally fenced). A missing or malformed
 * manifest is non-fatal: the full reply (minus a present-but-broken marker)
 * is returned as visible text with no screenshots.
 */
export function parseScreenshotManifest(reply: string): ParsedQaReply {
  const match = MANIFEST_MARKER_RE.exec(reply);
  if (!match) {
    return { visibleText: reply.trim(), screenshots: [] };
  }

  const visibleText = reply.slice(0, match.index).trim();

  let screenshots: ScreenshotEntry[] = [];
  try {
    const body = match[1]
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      screenshots = parsed
        .filter(
          (entry): entry is { path: string; caption?: unknown } => Boolean(entry) && typeof entry.path === 'string',
        )
        .map(entry => ({
          path: entry.path,
          caption: typeof entry.caption === 'string' ? entry.caption : undefined,
        }));
    }
  } catch {
    // Malformed manifest — drop the screenshots, keep the report.
  }

  return { visibleText, screenshots };
}

/**
 * Upload QA screenshots into a Slack thread via `filesUploadV2`. Best-effort:
 * validates each file exists and is within size limits, caps the count, and
 * swallows upload errors (returning the number actually uploaded) so a Slack
 * hiccup never fails the QA run. Mirrors the Bearer-auth file IO in
 * `imageDownloader.ts`, but in reverse.
 */
export async function uploadScreenshots(params: {
  slack: WebClient;
  channelId: string;
  threadTs?: string;
  screenshots: ScreenshotEntry[];
  logStep?: WorkflowStepLogger;
}): Promise<number> {
  const { slack, channelId, threadTs, screenshots, logStep } = params;
  if (screenshots.length === 0) {
    logStep?.({
      stage: 'qa.evidence.skip',
      message: 'No screenshots in the QA report manifest — nothing to upload.',
      data: { listed: 0 },
    });
    return 0;
  }

  const candidates = screenshots.slice(0, MAX_SCREENSHOTS);
  logStep?.({
    stage: 'qa.evidence.start',
    message: `Preparing screenshot upload: ${screenshots.length} listed${
      screenshots.length > MAX_SCREENSHOTS ? `, capped to ${MAX_SCREENSHOTS}` : ''
    }.`,
    data: { listed: screenshots.length, capped: candidates.length, channelId, threadTs },
  });

  const uploads: Array<{ file: Buffer; filename: string; title: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const shot of candidates) {
    try {
      const stat = await fs.stat(shot.path);
      if (!stat.isFile()) {
        skipped.push({ path: shot.path, reason: 'not_a_file' });
        continue;
      }
      if (stat.size === 0) {
        skipped.push({ path: shot.path, reason: 'empty' });
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.push({ path: shot.path, reason: `too_large_${stat.size}b` });
        continue;
      }
      const buffer = await fs.readFile(shot.path);
      const filename = path.basename(shot.path) || `screenshot-${uploads.length + 1}.png`;
      uploads.push({ file: buffer, filename, title: shot.caption ?? filename });
    } catch (err) {
      skipped.push({ path: shot.path, reason: `unreadable: ${String(err)}` });
    }
  }

  logStep?.({
    stage: 'qa.evidence.validated',
    message: `Screenshot validation: ${uploads.length} ready, ${skipped.length} skipped.`,
    level: skipped.length > 0 ? 'WARN' : 'INFO',
    data: { ready: uploads.length, skipped },
  });

  if (uploads.length === 0) {
    logStep?.({
      stage: 'qa.evidence.none',
      message: `No valid screenshots to upload (of ${screenshots.length} listed).`,
      level: 'WARN',
      data: { skipped },
    });
    return 0;
  }

  const totalBytes = uploads.reduce((sum, u) => sum + u.file.length, 0);
  logStep?.({
    stage: 'qa.evidence.upload_attempt',
    message: `Calling filesUploadV2 with ${uploads.length} file(s) (~${Math.round(totalBytes / 1024)}KB) — requires the bot 'files:write' scope.`,
    data: { count: uploads.length, totalBytes, filenames: uploads.map(u => u.filename), channelId, threadTs },
  });

  try {
    await slack.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      file_uploads: uploads,
    });
    logStep?.({
      stage: 'qa.evidence.uploaded',
      message: `Uploaded ${uploads.length} screenshot(s) to the QA thread.`,
      data: { count: uploads.length, totalBytes },
    });
    return uploads.length;
  } catch (error) {
    const info = describeSlackError(error);
    // Surface the `files:write` scope gap explicitly — it's the single most
    // common reason QA screenshots silently don't appear, and the raw Slack
    // error (`missing_scope`) is otherwise easy to miss in the log noise.
    if (info.isMissingScope) {
      logStep?.({
        stage: 'qa.evidence.missing_scope',
        level: 'ERROR',
        message:
          "Screenshot upload rejected: the bot token lacks the 'files:write' scope. " +
          'Add it as a Bot Token Scope on the miniOG Slack app and reinstall to the workspace ' +
          `(needed=${info.needed ?? 'files:write'}, provided=${info.provided ?? 'unknown'}). ` +
          'The QA text report still posted; only the screenshots were dropped.',
        data: { count: uploads.length, needed: info.needed, provided: info.provided, slackError: info.slackError },
      });
      return 0;
    }
    logStep?.({
      stage: 'qa.evidence.upload_failed',
      message: `Screenshot upload failed (${uploads.length} file(s)): ${info.slackError ?? String(error)}`,
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
