import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { parseFileManifest, uploadAttachments, type AttachmentLimits } from './fileAttachments.js';

/**
 * Webapp-QA adapter over the generic attachment plumbing in
 * `fileAttachments.ts`. QA keeps its own manifest marker, step-log vocabulary
 * (`qa.evidence.*`) and tighter limits — screenshots are many and small, where
 * an informational reply attaches one large CSV — but the validation, upload
 * and `files:write` scope classification are shared with every other agentic
 * reply rather than duplicated here.
 */

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

const SCREENSHOT_MARKER = '===SCREENSHOTS===';

const QA_LIMITS: AttachmentLimits = {
  maxFiles: 8,
  maxFileBytes: 5 * 1024 * 1024,
};

/**
 * Split a QA agent reply into the visible report text and the screenshot
 * manifest. The manifest is a JSON array of `{ path, caption }` after a
 * `===SCREENSHOTS===` marker (optionally fenced). A missing or malformed
 * manifest is non-fatal: the full reply (minus a present-but-broken marker)
 * is returned as visible text with no screenshots.
 */
export function parseScreenshotManifest(reply: string): ParsedQaReply {
  const { visibleText, attachments } = parseFileManifest(reply, SCREENSHOT_MARKER);
  return { visibleText, screenshots: attachments };
}

/**
 * Upload QA screenshots into a Slack thread. Best-effort: validates each file
 * exists and is within size limits, caps the count, and swallows upload errors
 * (returning the number actually uploaded) so a Slack hiccup never fails the
 * QA run. Mirrors the Bearer-auth file IO in `imageDownloader.ts`, but in
 * reverse.
 */
export async function uploadScreenshots(params: {
  slack: WebClient;
  channelId: string;
  threadTs?: string;
  screenshots: ScreenshotEntry[];
  logStep?: WorkflowStepLogger;
}): Promise<number> {
  const { slack, channelId, threadTs, screenshots, logStep } = params;
  return uploadAttachments({
    slack,
    channelId,
    threadTs,
    attachments: screenshots,
    logStep,
    stagePrefix: 'qa.evidence',
    noun: 'screenshot',
    limits: QA_LIMITS,
  });
}
