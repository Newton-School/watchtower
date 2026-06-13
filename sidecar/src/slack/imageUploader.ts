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
  if (screenshots.length === 0) return 0;

  const candidates = screenshots.slice(0, MAX_SCREENSHOTS);
  const uploads: Array<{ file: Buffer; filename: string; title: string }> = [];

  for (const shot of candidates) {
    try {
      const stat = await fs.stat(shot.path);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;
      const buffer = await fs.readFile(shot.path);
      const filename = path.basename(shot.path) || `screenshot-${uploads.length + 1}.png`;
      uploads.push({ file: buffer, filename, title: shot.caption ?? filename });
    } catch {
      // File missing / unreadable — skip it.
    }
  }

  if (uploads.length === 0) {
    logStep?.({
      stage: 'qa.evidence.none',
      message: `No valid screenshots to upload (of ${screenshots.length} listed).`,
      level: 'WARN',
    });
    return 0;
  }

  try {
    await slack.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      file_uploads: uploads,
    });
    logStep?.({
      stage: 'qa.evidence.uploaded',
      message: `Uploaded ${uploads.length} screenshot(s) to the QA thread.`,
      data: { count: uploads.length },
    });
    return uploads.length;
  } catch (error) {
    logStep?.({
      stage: 'qa.evidence.upload_failed',
      message: `Screenshot upload failed: ${String(error)}`,
      level: 'WARN',
    });
    return 0;
  }
}
