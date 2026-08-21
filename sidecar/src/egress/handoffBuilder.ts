import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { fetchThreadContext } from '../slack/threadContext.js';
import type { JobStore } from '../state/jobStore.js';
import type { ConversationMessageRow, ConversationThreadRow } from '../state/conversationStore.js';
import { GITHUB_EGRESS_SURFACE } from './githubPublisher.js';
import { renderHandoffBundle, slugify } from './threadMarkdownRenderer.js';

/**
 * Builds the `@miniOG handoff` context bundle for a thread: synthesized
 * summary + decisions + condensed transcript, paste-ready for the user's own
 * Claude (claude.ai or Claude Code). Prefers the conversation store; falls
 * back to a live Slack fetch for threads that were never captured (private
 * channels before tracking, IMs, brand-new threads).
 */

export interface HandoffBundle {
  markdown: string;
  title: string;
  /** 'store' when built from captured+synthesized data, 'live' from a raw fetch. */
  source: 'store' | 'live';
  /** URL of the published knowledge-base file, when the thread has one. */
  githubUrl?: string;
}

function liveThreadStub(
  channelId: string,
  threadTs: string,
  messages: ConversationMessageRow[],
): ConversationThreadRow {
  const firstHuman = messages.find(m => !m.isBot && m.text.trim());
  const title =
    firstHuman?.text
      .replace(/<@[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Slack thread';
  const participants = new Map<string, { userId: string; isBot: boolean; messageCount: number }>();
  for (const m of messages) {
    const entry = participants.get(m.userId) ?? { userId: m.userId, isBot: m.isBot, messageCount: 0 };
    entry.messageCount += 1;
    participants.set(m.userId, entry);
  }
  const nowIso = new Date().toISOString();
  return {
    id: 0,
    channelId,
    threadTs,
    channelType: 'channel',
    visibility: 'org',
    status: 'active',
    title,
    summary: undefined,
    decisions: [],
    actionItems: [],
    participants: [...participants.values()],
    messageCount: messages.length,
    firstMessageTs: messages[0]?.messageTs,
    lastActivityTs: messages[messages.length - 1]?.messageTs,
    lastCapturedAt: undefined,
    synthesizedAt: undefined,
    synthesizedMessageCount: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export async function buildHandoffBundle(params: {
  slack: WebClient;
  store: JobStore;
  channelId: string;
  threadTs: string;
  /** Bot user id for speaker labeling on the live-fetch fallback. */
  botUserId?: string;
}): Promise<HandoffBundle | null> {
  const { slack, store, channelId, threadTs, botUserId } = params;

  let slackPermalink: string | undefined;
  try {
    const response = await slack.chat.getPermalink({ channel: channelId, message_ts: threadTs });
    slackPermalink = typeof response.permalink === 'string' ? response.permalink : undefined;
  } catch {
    // cosmetic; the textual channel/thread ref suffices
  }

  try {
    const conversations = store.conversationStore();
    const thread = conversations.getThread(channelId, threadTs);
    if (thread && thread.status !== 'forgotten' && thread.messageCount > 0) {
      // Newest-first + reverse: the default ascending LIMIT keeps the OLDEST
      // rows — the handoff must carry the newest context on long threads.
      const messages = conversations.getMessages(thread.id, { limit: 200, order: 'desc' }).reverse();
      const exported = store.exportLog().get(GITHUB_EGRESS_SURFACE, channelId, threadTs);
      const githubUrl = exported?.status === 'SUCCESS' ? exported.targetUrl : undefined;
      return {
        markdown: renderHandoffBundle(thread, messages, { slackPermalink, githubUrl }),
        title: thread.title ?? 'Slack thread',
        source: 'store',
        githubUrl,
      };
    }
  } catch (err) {
    logger.warn({ channelId, threadTs, err: String(err) }, 'handoff: conversation store read failed');
  }

  // Live fallback: the thread was never captured (or the store is unhappy).
  const fetched = await fetchThreadContext(slack, channelId, threadTs).catch(() => []);
  if (fetched.length === 0) return null;
  const names = (() => {
    try {
      return store.conversationStore().getKnownUserNames(fetched.map(m => m.user));
    } catch {
      return new Map<string, string>();
    }
  })();
  const messages: ConversationMessageRow[] = fetched.map((m, index) => ({
    id: index,
    threadId: 0,
    channelId,
    threadTs,
    messageTs: m.ts,
    userId: m.user,
    displayName: names.get(m.user),
    isBot: m.user === botUserId || m.subtype === 'bot_message' || Boolean(m.botId),
    subtype: m.subtype,
    text: m.text,
    files: [],
    edited: false,
    capturedAt: new Date().toISOString(),
  }));
  const stub = liveThreadStub(channelId, threadTs, messages);
  return {
    markdown: renderHandoffBundle(stub, messages, { slackPermalink }),
    title: stub.title ?? 'Slack thread',
    source: 'live',
  };
}

/** Filename for the `file` delivery variant. */
export function handoffFileName(title: string, now = new Date()): string {
  return `handoff-${slugify(title, 40)}-${now.toISOString().slice(0, 10)}.md`;
}
