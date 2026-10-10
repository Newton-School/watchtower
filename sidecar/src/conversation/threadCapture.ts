import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { parseMiniogSubcommand } from '../router/intentParser.js';
import type { JobStore } from '../state/jobStore.js';
import type { CapturedMessage, RecordMessagesResult } from '../state/conversationStore.js';
import type { AppConfig, SlackEventEnvelope, WorkflowStepLogger } from '../types/contracts.js';
import type { ThreadMessage } from '../slack/threadContext.js';

/**
 * Conversation capture: persists miniOG Slack threads into the conversation
 * store. Three paths feed it —
 *   1. intake (index.ts): the thread fetched for every mention is captured
 *      as a side effect, registering the thread as tracked;
 *   2. the live tap (captureLiveMessage): every subsequent message event in a
 *      tracked thread is appended, including miniOG's own replies, edits and
 *      deletions;
 *   3. the sweeper (threadSweeper.ts): periodic reconciliation re-fetch for
 *      anything the socket missed.
 * All writes dedupe on (channel_id, thread_ts, message_ts), so the paths are
 * idempotent by construction.
 *
 * Privacy floors: IMs and MPIMs are never captured; private channels are
 * captured with visibility='private' (excluded from cross-channel recall).
 */

const CHANNEL_META_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Message subtypes that are channel noise, not conversation content. */
const NON_CONTENT_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'message_replied',
]);

export type CaptureDecision = 'org' | 'private' | 'skip';

/**
 * Envelopes synthesized by the sidecar itself (slash commands, message
 * shortcuts, reaction-resume, launchpad) are NOT real Slack messages — their
 * eventTs is an action/command ts that exists nowhere in the channel history.
 * Capturing them would plant phantom transcript rows and, worse, advance
 * last_activity_ts past real messages the sweeper still needs to backfill.
 * Catch-up `replay:` envelopes ARE real messages and stay capturable.
 */
export function isSyntheticEnvelope(event: Pick<SlackEventEnvelope, 'eventId' | 'ingestSource'>): boolean {
  if (event.ingestSource === 'launchpad') return true;
  return (
    event.eventId.startsWith('command:') ||
    event.eventId.startsWith('shortcut:') ||
    event.eventId.startsWith('reaction-resume:') ||
    event.eventId.startsWith('launchpad:')
  );
}

/**
 * Dossier/memory meta-commands ("whoami", "remember …", "forget thread
 * confirm") are bot plumbing, not conversation content. Keeping them out of
 * the transcript also keeps the forget-thread participant gate honest — the
 * forget command itself must never make its sender a "participant".
 */
export function isMiniogCommandMessage(config: AppConfig, text: string | undefined): boolean {
  if (!text || !text.includes(`<@${config.botUserId}>`)) return false;
  return parseMiniogSubcommand(text) !== null;
}

/**
 * Static (no-API) capture decision from what the event envelope carries.
 * `resolveChannelMeta` refines 'org' with a conversations.info lookup at
 * thread-creation time — a modern private channel can have a C-prefixed id,
 * so the prefix alone can't prove a channel is public.
 */
export function shouldCapture(channelType: string | undefined, channelId: string): CaptureDecision {
  if (channelType === 'im' || channelType === 'mpim') return 'skip';
  if (channelId.startsWith('D')) return 'skip';
  if (channelType === 'group' || channelId.startsWith('G')) return 'private';
  return 'org';
}

interface ChannelMeta {
  name?: string;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
}

interface ChannelMetaCacheEntry {
  meta: ChannelMeta;
  fetchedAt: number;
}

const channelMetaCache = new Map<string, ChannelMetaCacheEntry>();
const nameCache = new Map<string, { name: string | null; fetchedAt: number }>();

/** Test-only: clear the module-level caches. */
export function __resetThreadCaptureCachesForTests(): void {
  channelMetaCache.clear();
  nameCache.clear();
}

/**
 * Cached conversations.info lookup — channel name + privacy flags. Returns
 * null on API failure (callers fall back to the static decision).
 */
export async function resolveChannelMeta(client: WebClient, channelId: string): Promise<ChannelMeta | null> {
  const cached = channelMetaCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CHANNEL_META_TTL_MS) {
    return cached.meta;
  }
  try {
    const response = await client.conversations.info({ channel: channelId });
    const channel = response.channel as
      | { name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean }
      | undefined;
    const meta: ChannelMeta = {
      name: channel?.name || undefined,
      isPrivate: Boolean(channel?.is_private),
      isIm: Boolean(channel?.is_im),
      isMpim: Boolean(channel?.is_mpim),
    };
    channelMetaCache.set(channelId, { meta, fetchedAt: Date.now() });
    return meta;
  } catch (err) {
    // WARN, not debug: an unknown channel meta forces visibility to fail
    // closed ('private'), and a systematic failure (e.g. missing scope) should
    // be visible in logs, not silent.
    logger.warn({ channelId, err: String(err) }, 'conversation capture: conversations.info failed');
    return null;
  }
}

/**
 * Resolve Slack user IDs to display names: user_dossiers first (no API cost),
 * users.info fallback for the rest (piggybacking a dossier firstSeen capture,
 * mirroring prepareWorkflowContext). Cached 6h in-process.
 */
export async function resolveDisplayNames(
  client: WebClient,
  store: JobStore,
  userIds: string[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return resolved;

  const known = store.conversationStore().getKnownUserNames(unique);
  for (const [id, name] of known) resolved.set(id, name);

  const now = Date.now();
  for (const userId of unique) {
    if (resolved.has(userId)) continue;
    const cached = nameCache.get(userId);
    if (cached && now - cached.fetchedAt < NAME_CACHE_TTL_MS) {
      if (cached.name) resolved.set(userId, cached.name);
      continue;
    }
    try {
      const info = await client.users.info({ user: userId });
      const displayName = info.user?.profile?.display_name || undefined;
      const realName = info.user?.real_name || info.user?.profile?.real_name || undefined;
      const name = displayName || realName || info.user?.name || null;
      nameCache.set(userId, { name, fetchedAt: now });
      if (name) resolved.set(userId, name);
      try {
        store.dossierStore().firstSeen({
          userId,
          displayName,
          realName,
          tz: info.user?.tz || undefined,
          email: info.user?.profile?.email || undefined,
        });
      } catch {
        // dossier capture is a bonus, never a blocker
      }
    } catch (err) {
      nameCache.set(userId, { name: null, fetchedAt: now });
      logger.debug({ userId, err: String(err) }, 'conversation capture: users.info failed');
    }
  }
  return resolved;
}

function isBotMessage(config: AppConfig, message: { user: string; subtype?: string; botId?: string }): boolean {
  return message.user === config.botUserId || message.subtype === 'bot_message' || Boolean(message.botId);
}

function toCaptured(config: AppConfig, message: ThreadMessage, names: Map<string, string>): CapturedMessage {
  return {
    messageTs: message.ts,
    userId: message.user,
    displayName: names.get(message.user),
    isBot: isBotMessage(config, message),
    subtype: message.subtype,
    text: message.text,
    files: message.files?.map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype })),
  };
}

export interface CaptureThreadParams {
  client: WebClient;
  store: JobStore;
  config: AppConfig;
  channelId: string;
  threadTs: string;
  channelType?: string;
  messages: ThreadMessage[];
  logStep?: WorkflowStepLogger;
}

/**
 * Persist an already-fetched thread (intake and sweeper path). Resolves
 * channel meta + display names, then records everything in one transaction.
 * Returns null when the channel is excluded (IM/MPIM) or capture failed.
 */
export async function captureThreadFromMessages(params: CaptureThreadParams): Promise<RecordMessagesResult | null> {
  const { client, store, config, channelId, threadTs, channelType, messages, logStep } = params;
  const decision = shouldCapture(channelType, channelId);
  if (decision === 'skip') return null;

  try {
    const meta = await resolveChannelMeta(client, channelId);
    if (meta?.isIm || meta?.isMpim) return null;
    // Fail CLOSED: without authoritative meta, only a static 'private' signal
    // is trusted; an unverified channel passes undefined and the store
    // defaults new threads to 'private' (a later successful lookup heals it
    // to 'org' — the store treats a known value as authoritative).
    const visibility: 'org' | 'private' | undefined = meta
      ? meta.isPrivate
        ? 'private'
        : 'org'
      : decision === 'private'
        ? 'private'
        : undefined;

    const humanIds = messages.filter(m => !isBotMessage(config, m)).map(m => m.user);
    const names = await resolveDisplayNames(client, store, humanIds);

    const captured = messages
      .filter(m => m.ts && !NON_CONTENT_SUBTYPES.has(m.subtype ?? '') && !isMiniogCommandMessage(config, m.text))
      .map(m => toCaptured(config, m, names));

    // Never create an empty thread row (e.g. a synthetic threadTs whose Slack
    // fetch returned nothing) — zombie rows would sit in 'active' forever.
    if (captured.length === 0 && !store.conversationStore().isTracked(channelId, threadTs)) {
      return null;
    }

    const result = store.conversationStore().recordMessages({
      channelId,
      threadTs,
      channelType: meta?.isPrivate ? 'group' : (channelType ?? 'channel'),
      channelName: meta?.name,
      visibility,
      messages: captured,
    });

    if ('skipped' in result) return result;
    logStep?.({
      stage: 'conversation.capture',
      message: `Captured thread into the conversation store (${result.inserted} new message(s)).`,
      data: { channelId, threadTs, inserted: result.inserted, visibility },
    });
    return result;
  } catch (err) {
    logger.warn({ channelId, threadTs, err: String(err) }, 'conversation capture: thread capture failed');
    return null;
  }
}

export interface CaptureLiveParams {
  store: JobStore;
  config: AppConfig;
  event: SlackEventEnvelope;
}

/**
 * Live tap for the full message firehose. MUST stay cheap: gated on a single
 * prepared `isTracked` SELECT before doing any work, so untracked channels
 * cost one indexed lookup per message. Runs BEFORE the subtype/bot gates in
 * processEvent so edits, deletions, and miniOG's own replies are captured.
 */
export function captureLiveMessage(params: CaptureLiveParams): boolean {
  const { store, config, event } = params;
  if (!event.channelId) return false;
  if (isSyntheticEnvelope(event)) return false;
  if (shouldCapture(event.channelType, event.channelId) === 'skip') return false;

  try {
    const conversations = store.conversationStore();

    if (event.messageSubtype === 'message_deleted') {
      const deletedTs = event.deletedTs ?? event.previousMessage?.ts;
      if (!deletedTs) return false;
      if (conversations.isTracked(event.channelId, event.threadTs)) {
        return conversations.deleteMessage(event.channelId, event.threadTs, deletedTs);
      }
      // Slack sometimes omits previous_message, in which case the envelope's
      // threadTs is the deleted message's own ts, not its thread — fall back
      // to blanking by (channel, message_ts) so deleted text never lingers.
      return conversations.deleteMessageByTs(event.channelId, deletedTs);
    }

    if (event.messageSubtype === 'message_changed') {
      const edited = (event.rawEvent as { message?: Record<string, unknown> }).message;
      const messageTs = typeof edited?.ts === 'string' ? edited.ts : undefined;
      const text = typeof edited?.text === 'string' ? edited.text : undefined;
      const threadTs = typeof edited?.thread_ts === 'string' ? edited.thread_ts : messageTs;
      if (!messageTs || text === undefined || !threadTs) return false;
      if (!conversations.isTracked(event.channelId, threadTs)) return false;
      if (conversations.updateMessageText(event.channelId, threadTs, messageTs, text)) return true;
      // Row not captured yet (edit raced ahead of an in-flight snapshot
      // insert): record the POST-edit message now so the stale pre-edit text
      // can never land via a later INSERT OR IGNORE.
      if (isMiniogCommandMessage(config, text)) return false;
      const editedUser = typeof edited?.user === 'string' ? edited.user : '';
      const editedBotId = typeof edited?.bot_id === 'string' ? edited.bot_id : undefined;
      const editedSubtype = typeof edited?.subtype === 'string' ? edited.subtype : undefined;
      const upserted = conversations.recordMessages({
        channelId: event.channelId,
        threadTs,
        channelType: event.channelType,
        messages: [
          {
            messageTs,
            userId: editedUser,
            isBot: isBotMessage(config, { user: editedUser, subtype: editedSubtype, botId: editedBotId }),
            subtype: editedSubtype,
            text,
          },
        ],
      });
      return !('skipped' in upserted) && upserted.inserted > 0;
    }

    if (event.messageSubtype && NON_CONTENT_SUBTYPES.has(event.messageSubtype)) return false;
    if (!event.eventTs || !event.threadTs) return false;
    if (isMiniogCommandMessage(config, event.text)) return false;
    if (!conversations.isTracked(event.channelId, event.threadTs)) return false;

    const raw = event.rawEvent as { bot_id?: unknown; files?: Array<Record<string, unknown>> };
    const botId = typeof raw.bot_id === 'string' ? raw.bot_id : undefined;
    const files = raw.files
      ?.filter(f => typeof f.id === 'string' && typeof f.name === 'string' && typeof f.mimetype === 'string')
      .map(f => ({ id: f.id as string, name: f.name as string, mimetype: f.mimetype as string }));
    const names = event.userId ? conversations.getKnownUserNames([event.userId]) : new Map<string, string>();

    const result = conversations.recordMessages({
      channelId: event.channelId,
      threadTs: event.threadTs,
      channelType: event.channelType,
      messages: [
        {
          messageTs: event.eventTs,
          userId: event.userId ?? '',
          displayName: event.userId ? names.get(event.userId) : undefined,
          isBot: isBotMessage(config, { user: event.userId ?? '', subtype: event.messageSubtype, botId }),
          subtype: event.messageSubtype,
          text: event.text ?? '',
          files,
        },
      ],
    });
    return !('skipped' in result) && result.inserted > 0;
  } catch (err) {
    logger.warn(
      { channelId: event.channelId, threadTs: event.threadTs, err: String(err) },
      'conversation capture: live tap failed',
    );
    return false;
  }
}
