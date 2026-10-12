import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { downloadSlackFiles, formatUnreadableAttachmentsNote } from './imageDownloader.js';
import type { SlackFileAttachment } from './imageDownloader.js';

/** How much of one attached text document goes into the prompt. */
const DOCUMENT_CLIP_CHARS = 8000;

export interface ThreadAttachments {
  /**
   * Downloaded images and PDFs, by local path. The backend names them in the
   * prompt and opens their folder to the Read tool, which can view both.
   */
  imagePaths: string[];
  /** Prompt block with the content of attached text documents; empty when there are none. */
  documentContext: string;
  /** Prompt note naming the attachments that could not be opened; empty when all were. */
  unreadableNote: string;
}

const NONE: ThreadAttachments = { imagePaths: [], documentContext: '', unreadableNote: '' };

/**
 * Download a thread's attachments and turn them into what an agent prompt
 * needs: image paths, the text of documents, and a note for every file that
 * could not be opened.
 *
 * Never throws. A failed download must not stop the run, but the agent still
 * has to learn the files exist: otherwise it answers "no screenshot came
 * through" about a screenshot that is sitting in the thread (issue #433).
 */
export async function collectThreadAttachments(params: {
  files: SlackFileAttachment[];
  botToken: string;
  logStep?: WorkflowStepLogger;
}): Promise<ThreadAttachments> {
  const { files, botToken, logStep } = params;
  if (files.length === 0) {
    return NONE;
  }
  try {
    const result = await downloadSlackFiles({ files, botToken, logStep });
    const parts: string[] = [];
    // A PDF read as text is a page of bytes in the prompt. It is opened by path instead.
    const pdfPaths = result.documentPaths.filter(isPdf);
    for (const docPath of result.documentPaths.filter(docPath => !isPdf(docPath))) {
      try {
        const content = await fs.readFile(docPath, 'utf8');
        parts.push(`--- ${path.basename(docPath)} ---\n${content.slice(0, DOCUMENT_CLIP_CHARS)}`);
      } catch {
        // Non-fatal: skip unreadable docs
      }
    }
    return {
      imagePaths: [...result.imagePaths, ...pdfPaths],
      documentContext: parts.length > 0 ? `\n\nAttached documents from thread:\n${parts.join('\n\n')}` : '',
      unreadableNote: formatUnreadableAttachmentsNote(result.skipped),
    };
  } catch {
    return {
      ...NONE,
      unreadableNote: formatUnreadableAttachmentsNote(
        files.map(f => ({ name: f.name, mimetype: f.mimetype, reason: 'download_error' })),
      ),
    };
  }
}

function isPdf(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

/**
 * Order a thread's files for a run that can take only a few: the message that
 * triggered the run first, then the rest newest first. The downloader keeps
 * the first eight, and in a long thread the oldest eight are rarely the ones
 * the question is about.
 */
export function filesForTrigger(
  messages: Array<{ ts: string; files?: SlackFileAttachment[] }>,
  triggerTs: string,
): SlackFileAttachment[] {
  const trigger = messages.filter(m => m.ts === triggerTs);
  const rest = messages.filter(m => m.ts !== triggerTs).sort((a, b) => Number(b.ts) - Number(a.ts));
  const seen = new Set<string>();
  const files: SlackFileAttachment[] = [];
  for (const message of [...trigger, ...rest]) {
    for (const file of message.files ?? []) {
      if (!seen.has(file.id)) {
        seen.add(file.id);
        files.push(file);
      }
    }
  }
  return files;
}
