import type { WebClient } from '@slack/web-api';
import { getBundlesForConfig } from '../access/control.js';
import { detectMention } from '../router/intentParser.js';
import { isStopCommand } from '../router/stopIntent.js';
import { logger } from '../logging/logger.js';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { catchUpParkedAnswers } from './parkedAnswerCatchup.js';

const CATCHUP_STATE_KEY = 'mention_catchup_cursor_ts';
// Start of the gap a thread sweep has not finished yet (epoch seconds), or ''.
const SWEEP_STATE_KEY = 'mention_catchup_sweep_since';
const CATCHUP_INTERVAL_MS = 2 * 60 * 1000;
const CATCHUP_LOOKBACK_SECONDS = 60 * 60 * 24;
const CATCHUP_PAGE_SIZE = 200;
// Hard ceiling on how many messages we accumulate in memory per channel per
// scan. Steady-state ticks cover ~2-minute windows (far below this), so the cap
// only ever engages on the first run or after a long downtime in a very busy
// channel — exactly the case where unbounded `do/while(cursor)` pagination
// would balloon the array. conversations.history returns newest-first, so the
// most recent (most likely still-actionable) mentions are the ones we keep.
const CATCHUP_MAX_MESSAGES_PER_CHANNEL = 1000;
// Same bound for one thread's replies. conversations.replies pages
// oldest-first, so a pathological >cap thread keeps its oldest replies and can
// miss the newest — the warn line in fetchThreadReplies makes that visible.
const CATCHUP_MAX_REPLIES_PER_THREAD = 1000;
// A thread whose job finished this recently is still read every scan: a
// follow-up there is the likeliest mention to arrive as a thread reply.
const RECENT_JOB_THREAD_HOURS = 6;
// Replay ids queued in this process, so a reply the intake drops without a
// record (no job, no event row) is not queued again on every scan.
const REPLAYED_MEMORY = 2000;
// A sweep after a gap opens at most this many threads, newest activity first.
const SWEEP_MAX_THREADS = 40;
// ...one Slack call this far apart: about 40 a minute, under the roughly 50 a
// minute conversations.history and conversations.replies allow.
const SWEEP_PACE_MS = 1500;
// Catchup is a recovery scanner — it walks `conversations.history` and replays
// mentions whose live socket delivery we may have missed. Deletions only flow
// through the live socket path (where processMessageDeleted reacts); a
// deletion that landed while the sidecar was down can't be retroactively
// resurrected from history anyway, so this scanner intentionally still skips
// `message_deleted` rows it stumbles across.
const NON_ACTIONABLE_SUBTYPES = new Set(['message_changed', 'message_deleted', 'bot_message']);

/**
 * Window start for a catch-up scan. Normally we resume a few seconds before the
 * stored cursor. But the cursor only ever moves forward, so a single jump of the
 * system clock into the future (or a future-dated message) parks it ahead of
 * real time *permanently* — and a future cursor makes `oldest` skip every real
 * message until the wall clock catches up, silently blinding catch-up for the
 * whole gap. When the stored cursor is ahead of `nowTs`, treat it as corrupt and
 * fall back to the lookback window so the scanner self-heals. (RCA: a clock
 * bounce parked the cursor ~6 days ahead and dropped a PR-review mention.)
 */
export function effectiveOldestTs(storedCursor: number, nowTs: number, lookbackSeconds: number): number {
  const valid = Number.isFinite(storedCursor) && storedCursor > 0 && storedCursor <= nowTs;
  return valid ? Math.max(0, storedCursor - 5) : nowTs - lookbackSeconds;
}

type CatchupStore = Pick<
  JobStore,
  | 'getState'
  | 'setState'
  | 'hasEvent'
  | 'recordEvent'
  | 'hasJobForEventTs'
  | 'listKnownChannels'
  | 'threadsWithRecentJobs'
> &
  Parameters<typeof catchUpParkedAnswers>[0]['store'];

type CatchupDeps = {
  webClient: WebClient;
  config: AppConfig;
  store: CatchupStore;
  enqueue: (event: SlackEventEnvelope, client: WebClient, source: 'socket' | 'catchup') => Promise<void>;
  /** Messages the live socket delivered in this process: already handled, never replayed. */
  deliveredLive?: (channelId: string, ts: string) => boolean;
  /** Whether a job runs in the thread right now; without it, the jobs table's view when the pass began. */
  threadActive?: (channelId: string, threadTs: string) => boolean;
  nowMs?: () => number;
  /** Gap between a sweep's Slack calls; tests set 0. */
  paceMs?: number;
};

/** What one scan or sweep carries over to the next. */
export type CatchupState = {
  replayed: Set<string>;
};

export function newCatchupState(): CatchupState {
  return { replayed: new Set() };
}

export interface MentionCatchup {
  /**
   * The socket may have missed messages since then (the host slept, or the
   * socket was dead): sweep every recent thread with replies since that
   * time, not just the threads miniOG has jobs in.
   */
  sweepThreadsSince(epochSeconds: number): void;
}

/**
 * Runs `work` unless the last run is still going. A scan that outlasts its
 * interval, or a sweep asked for again mid-sweep, would otherwise run twice at
 * once and queue the same reply twice.
 */
export function skipWhileRunning(work: () => Promise<void>, what: string): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await work();
    } catch (error) {
      logger.warn({ component: 'slack-catchup', error: String(error) }, `${what} failed`);
    } finally {
      running = false;
    }
  };
}

/**
 * Queue recovered events without waiting for them: the intake runs a queued
 * job to its end before it returns, so a scan that waited would stop for the
 * whole job. Events in one thread still go one after another, each once the
 * last is processed, as when the scan waited: queued together, two of them
 * could both pass the one-job-per-thread check before either registered, and
 * a stop would then end only one. A stop itself never waits: it is for the
 * job ahead of it.
 */
export function detachPerThread(enqueue: CatchupDeps['enqueue']): CatchupDeps['enqueue'] {
  const threads = new Map<string, Promise<void>>();
  return async (event, client, source) => {
    const run = () =>
      enqueue(event, client, source).catch(error => {
        logger.warn({ component: 'slack-catchup', eventId: event.eventId, error: String(error) }, 'replay failed');
      });
    if (isStopCommand(event.text)) {
      void run();
      return;
    }
    const key = `${event.channelId}:${event.threadTs}`;
    const next = (threads.get(key) ?? Promise.resolve()).then(run);
    threads.set(key, next);
    void next.finally(() => {
      if (threads.get(key) === next) threads.delete(key);
    });
  };
}

/**
 * Sweeps after a gap, one at a time and off the scan's path: a sweep is paced
 * and can take minutes. Until one finishes, the gap's start stays in
 * sidecar_state, so a crash mid-sweep sweeps it again on the next start,
 * rather than from the scan position the 2-minute scans have moved past it.
 */
export class ThreadSweeper {
  private pending: number | null = null;
  private inProgress: number | null = null;
  private unfinished: number | null = null;
  private readonly runQueued: () => Promise<void>;

  constructor(
    private readonly deps: CatchupDeps,
    private readonly state: CatchupState,
  ) {
    this.runQueued = skipWhileRunning(async () => {
      while (this.pending !== null) {
        const since = this.pending;
        this.pending = null;
        this.inProgress = since;
        this.save();
        try {
          await runThreadSweep(this.deps, this.state, since);
        } catch (error) {
          // Kept for the next request, and the next start; not retried in a loop.
          this.unfinished = this.unfinished === null ? since : Math.min(this.unfinished, since);
          logger.warn({ component: 'slack-catchup', since, error: String(error) }, 'thread sweep failed');
        } finally {
          this.inProgress = null;
          this.save();
        }
      }
    }, 'thread sweep');
  }

  /** At start: the gap a sweep never finished, or else the last scan before the stop. */
  resume(lastScanBoundary: number): Promise<void> {
    const saved = Number(this.deps.store.getState(SWEEP_STATE_KEY) || 0);
    return this.request(Number.isFinite(saved) && saved > 0 ? Math.min(saved, lastScanBoundary) : lastScanBoundary);
  }

  request(sinceEpochSeconds: number): Promise<void> {
    this.pending = Math.min(sinceEpochSeconds, this.pending ?? Infinity, this.unfinished ?? Infinity);
    this.unfinished = null;
    this.save();
    return this.runQueued();
  }

  private save(): void {
    const open = [this.pending, this.inProgress, this.unfinished].filter((since): since is number => since !== null);
    this.deps.store.setState(SWEEP_STATE_KEY, open.length > 0 ? String(Math.min(...open)) : '');
  }
}

export function startMentionCatchup(deps: CatchupDeps): MentionCatchup {
  const state = newCatchupState();
  const detached: CatchupDeps = { ...deps, enqueue: detachPerThread(deps.enqueue) };
  const scan = skipWhileRunning(() => runMentionCatchup(detached, state), 'missed mention catch-up scan');
  const sweeper = new ThreadSweeper(detached, state);

  // While the sidecar was down nothing at all was delivered, thread replies
  // included: sweep threads from the last scan before it.
  const storedCursor = Number(deps.store.getState(CATCHUP_STATE_KEY) ?? 0);
  void scan();
  void sweeper.resume(effectiveOldestTs(storedCursor, Math.floor(now(deps) / 1000), CATCHUP_LOOKBACK_SECONDS));
  setInterval(() => void scan(), CATCHUP_INTERVAL_MS);
  return {
    sweepThreadsSince(epochSeconds) {
      void sweeper.request(epochSeconds);
    },
  };
}

function now(deps: Pick<CatchupDeps, 'nowMs'>): number {
  return deps.nowMs ? deps.nowMs() : Date.now();
}

function replayIdFor(channelId: string, ts: string): string {
  return `replay:${channelId}:${ts}`;
}

/** Handled already: queued by catch-up, delivered by the socket, recorded, or a job's own message. */
function alreadySeen(deps: CatchupDeps, state: CatchupState, channelId: string, ts: string): boolean {
  const replayEventId = replayIdFor(channelId, ts);
  return (
    state.replayed.has(replayEventId) ||
    Boolean(deps.deliveredLive?.(channelId, ts)) ||
    deps.store.hasEvent(replayEventId) ||
    deps.store.hasJobForEventTs(channelId, ts)
  );
}

function remember(state: CatchupState, replayEventId: string): void {
  state.replayed.add(replayEventId);
  if (state.replayed.size > REPLAYED_MEMORY) {
    state.replayed.delete(state.replayed.values().next().value as string);
  }
}

/**
 * Queue the bot mentions among a thread's replies that nothing has handled.
 * Only mentions of miniOG: an owner tag in a thread reply never reached the
 * intake live either. A reply miniOG answered later is recorded instead,
 * except a stop while the thread's job still runs: its later posts are
 * progress, not an answer to the stop.
 */
async function recoverThreadMentions(
  deps: CatchupDeps,
  state: CatchupState,
  thread: { channelId: string; parentTs: string; active: boolean },
  replies: Array<Record<string, unknown>>,
): Promise<number> {
  const { config, store, webClient } = deps;
  const { channelId, parentTs } = thread;
  let queued = 0;
  for (const reply of replies) {
    const replyTs = String(reply.ts ?? '');
    if (!replyTs || replyTs === parentTs) continue;
    const candidate = actionableMention(reply, config);
    if (!candidate || candidate.type !== 'bot') continue;
    if (alreadySeen(deps, state, channelId, replyTs)) continue;
    const replayEventId = replayIdFor(channelId, replyTs);

    const replyEpoch = toEpochSeconds(replyTs);
    const answeredLater = replies.some(
      other => String(other.user ?? '') === config.botUserId && toEpochSeconds(String(other.ts ?? '')) > replyEpoch,
    );
    // Asked now, not when the pass began: a job may have started since.
    const active = deps.threadActive ? deps.threadActive(channelId, parentTs) : thread.active;
    if (answeredLater && !(active && isStopCommand(candidate.text))) {
      store.recordEvent(replayEventId, channelId, parentTs);
      continue;
    }

    remember(state, replayEventId);
    await deps.enqueue(
      {
        eventId: replayEventId,
        channelId,
        threadTs: parentTs,
        eventTs: replyTs,
        userId: candidate.userId,
        text: candidate.text,
        messageSubtype: candidate.subtype || undefined,
        rawEvent: reply,
      },
      webClient,
      'catchup',
    );
    queued += 1;
  }
  return queued;
}

function recentJobThreadsSince(deps: CatchupDeps): string {
  return new Date(now(deps) - RECENT_JOB_THREAD_HOURS * 60 * 60 * 1000).toISOString();
}

// Exported for unit tests; production runs it through startMentionCatchup.
export async function runMentionCatchup(deps: CatchupDeps, state: CatchupState = newCatchupState()): Promise<void> {
  const { webClient, config, store, enqueue } = deps;
  const nowTs = Math.floor(now(deps) / 1000);
  const storedCursorRaw = store.getState(CATCHUP_STATE_KEY);
  const storedCursor = storedCursorRaw ? Number(storedCursorRaw) : 0;
  const oldestTs = effectiveOldestTs(storedCursor, nowTs, CATCHUP_LOOKBACK_SECONDS);
  if (storedCursor > nowTs) {
    logger.warn(
      { component: 'slack-catchup', storedCursor, nowTs },
      'catch-up cursor is ahead of the clock (clock skew?) — resetting to the lookback window so recovery self-heals',
    );
  }

  logger.info(
    {
      component: 'slack-catchup',
      oldestTs,
      cursorTs: storedCursor || null,
    },
    'starting missed mention catch-up scan',
  );

  const channelIds = await discoverChannels(webClient, store, config);
  logger.info(
    {
      component: 'slack-catchup',
      channels: channelIds.length,
    },
    'resolved channels for missed mention catch-up',
  );

  let recovered = 0;
  let scannedMessages = 0;

  // Thread replies never appear in conversations.history, so an @mention
  // posted inside a thread was invisible here whenever the socket was down:
  // a "stop", a follow-up, a review ask (RCA 2026-07-29, issue #587). Every
  // scan reads the threads miniOG has a running, paused or recent job in.
  for (const thread of store.threadsWithRecentJobs(recentJobThreadsSince(deps))) {
    const replies = await fetchThreadReplies(webClient, thread.channelId, thread.threadTs, oldestTs);
    scannedMessages += replies.length;
    recovered += await recoverThreadMentions(
      deps,
      state,
      { channelId: thread.channelId, parentTs: thread.threadTs, active: thread.active },
      replies,
    );
  }

  for (const channelId of channelIds) {
    const historyMessages = await fetchChannelHistory(webClient, channelId, oldestTs);
    if (historyMessages.length === 0) {
      continue;
    }

    const ordered = historyMessages
      .filter(message => typeof message.ts === 'string' && message.ts.length > 0)
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    for (const message of ordered) {
      const eventTs = String(message.ts ?? '');
      if (!eventTs) {
        continue;
      }

      scannedMessages += 1;

      const candidate = actionableMention(message, config);
      if (!candidate) {
        continue;
      }
      const { text, userId, subtype } = candidate;

      if (alreadySeen(deps, state, channelId, eventTs)) {
        continue;
      }
      const replayEventId = replayIdFor(channelId, eventTs);
      // Before the await below, so a sweep running alongside never queues it too.
      remember(state, replayEventId);

      const threadTs = String(message.thread_ts ?? message.ts ?? '');
      const alreadyResponded = await hasBotResponseAfterMention(
        webClient,
        channelId,
        threadTs,
        eventTs,
        config.botUserId,
      );
      if (alreadyResponded) {
        store.recordEvent(replayEventId, channelId, threadTs);
        continue;
      }

      const envelope: SlackEventEnvelope = {
        eventId: replayEventId,
        channelId,
        threadTs,
        eventTs,
        userId,
        text,
        messageSubtype: subtype || undefined,
        rawEvent: message as Record<string, unknown>,
      };

      await enqueue(envelope, webClient, 'catchup');
      recovered += 1;
    }
  }

  // Advance to "now" only — never to a future-dated message timestamp. Combined
  // with the future-cursor self-heal in effectiveOldestTs, this keeps a clock
  // skew or stray future-dated message from permanently parking the cursor ahead
  // of real time and blinding the scanner.
  const nextCursor = nowTs;
  store.setState(CATCHUP_STATE_KEY, String(nextCursor));

  // Plain replies to a question miniOG asked are invisible to the scan above,
  // which looks for mentions; a restart used to lose them (issue #431).
  let answersRecovered = 0;
  try {
    answersRecovered = await catchUpParkedAnswers({ webClient, config, store, enqueue });
  } catch (error) {
    logger.warn({ component: 'slack-catchup', error: String(error) }, 'parked-answer catch-up failed');
  }

  logger.info(
    {
      component: 'slack-catchup',
      recovered,
      answersRecovered,
      scannedMessages,
      nextCursor,
    },
    'completed missed mention catch-up scan',
  );
}

/**
 * After a gap, read the replies of every thread with replies since then: the
 * one place a thread-reply mention in a thread miniOG has no job in can be
 * found. Parents up to the lookback old are read for their reply metadata,
 * only threads with a reply after the gap are opened, the newest first and at
 * most SWEEP_MAX_THREADS of them, and the Slack calls are spaced out: every
 * wake and every start sweeps, and a burst would hit conversations.replies'
 * rate limit, whose Retry-After pause holds every other call of the client,
 * run posts included.
 */
export async function runThreadSweep(deps: CatchupDeps, state: CatchupState, sinceEpochSeconds: number): Promise<void> {
  const { webClient, config, store } = deps;
  const nowTs = Math.floor(now(deps) / 1000);
  const since = Math.max(nowTs - CATCHUP_LOOKBACK_SECONDS, sinceEpochSeconds);
  const paceMs = deps.paceMs ?? SWEEP_PACE_MS;
  const pace = () => (paceMs > 0 ? new Promise(resolve => setTimeout(resolve, paceMs)) : Promise.resolve());
  const jobThreads = deps.threadActive
    ? new Map<string, boolean>()
    : new Map(
        store
          .threadsWithRecentJobs(recentJobThreadsSince(deps))
          .map(thread => [`${thread.channelId}:${thread.threadTs}`, thread.active]),
      );

  const threads: Array<{ channelId: string; parentTs: string; latestReply: number }> = [];
  for (const channelId of await discoverChannels(webClient, store, config)) {
    const parents = await fetchChannelHistory(webClient, channelId, nowTs - CATCHUP_LOOKBACK_SECONDS);
    for (const parent of parents) {
      const latestReply = toEpochSeconds(String(parent.latest_reply ?? ''));
      if (Number(parent.reply_count ?? 0) > 0 && latestReply > since) {
        threads.push({ channelId, parentTs: String(parent.ts ?? ''), latestReply });
      }
    }
    await pace();
  }
  threads.sort((a, b) => b.latestReply - a.latestReply);
  if (threads.length > SWEEP_MAX_THREADS) {
    logger.warn(
      { component: 'slack-catchup', threads: threads.length, cap: SWEEP_MAX_THREADS },
      'thread sweep found more threads than it reads; the oldest are left out',
    );
  }

  let recovered = 0;
  for (const thread of threads.slice(0, SWEEP_MAX_THREADS)) {
    const replies = await fetchThreadReplies(webClient, thread.channelId, thread.parentTs, since);
    const active = jobThreads.get(`${thread.channelId}:${thread.parentTs}`) ?? false;
    recovered += await recoverThreadMentions(deps, state, { ...thread, active }, replies);
    await pace();
  }
  logger.info(
    { component: 'slack-catchup', since, threads: Math.min(threads.length, SWEEP_MAX_THREADS), recovered },
    'completed thread sweep',
  );
}

type ActionableMention = { text: string; userId: string; subtype: string; type: 'bot' | 'owner' };

/**
 * The gate both passes share: no edits, deletions or bot posts, nothing from
 * miniOG itself, and a mention of miniOG or an owner. Whether it was handled
 * already is the caller's to check.
 */
function actionableMention(message: Record<string, unknown>, config: AppConfig): ActionableMention | null {
  const subtype = message.subtype ? String(message.subtype) : '';
  if (subtype && NON_ACTIONABLE_SUBTYPES.has(subtype)) {
    return null;
  }
  const text = String(message.text ?? '');
  const userId = String(message.user ?? '');
  if (!text || !userId || userId === config.botUserId) {
    return null;
  }
  const mention = detectMention(text, config);
  if (mention.type !== 'bot' && mention.type !== 'owner') {
    return null;
  }
  return { text, userId, subtype, type: mention.type };
}

async function discoverChannels(client: WebClient, store: CatchupStore, config: AppConfig): Promise<string[]> {
  const accessChannels = getBundlesForConfig(config).flatMap(bundle => bundle.allowedChannelIds);
  const channelSet = new Set<string>([
    ...store.listKnownChannels(500),
    ...config.allowedChannelsForBugFix,
    ...accessChannels,
  ]);

  let cursor: string | undefined;
  try {
    do {
      const response = await client.users.conversations({
        cursor,
        limit: 200,
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
      });

      const channels = response.channels ?? [];
      for (const channel of channels) {
        if (channel.id) {
          channelSet.add(channel.id);
        }
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        error: String(error),
      },
      'failed to enumerate channels via users.conversations; falling back to known channels',
    );
  }

  return Array.from(channelSet);
}

// Exported for unit testing of the per-channel accumulation cap.
export async function fetchChannelHistory(
  client: WebClient,
  channelId: string,
  oldestTs: number,
): Promise<Array<Record<string, unknown>>> {
  const oldest = String(oldestTs);
  const messages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.conversations.history({
        channel: channelId,
        oldest,
        inclusive: false,
        limit: CATCHUP_PAGE_SIZE,
        cursor,
      });

      for (const message of response.messages ?? []) {
        messages.push(message as unknown as Record<string, unknown>);
      }

      cursor = response.response_metadata?.next_cursor || undefined;

      // Bound the in-memory accumulation. Once we hit the per-channel cap, stop
      // paginating rather than walking the entire backlog of a busy channel
      // into a single array. Newest-first ordering means we've kept the most
      // recent messages; older ones are left for the live socket (or are stale
      // anyway, since the cursor advances to "now" after every scan).
      if (cursor && messages.length >= CATCHUP_MAX_MESSAGES_PER_CHANNEL) {
        logger.warn(
          {
            component: 'slack-catchup',
            channelId,
            accumulated: messages.length,
            cap: CATCHUP_MAX_MESSAGES_PER_CHANNEL,
          },
          'channel history hit per-channel cap during catch-up; stopping pagination',
        );
        break;
      }
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        error: String(error),
      },
      'failed to fetch channel history during missed mention catch-up',
    );
  }

  return messages;
}

// Exported for unit testing of the per-thread accumulation cap.
export async function fetchThreadReplies(
  client: WebClient,
  channelId: string,
  threadTs: string,
  oldestTs: number,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        oldest: String(oldestTs),
        inclusive: false,
        limit: CATCHUP_PAGE_SIZE,
        cursor,
      });

      for (const message of response.messages ?? []) {
        messages.push(message as unknown as Record<string, unknown>);
      }

      cursor = response.response_metadata?.next_cursor || undefined;

      if (cursor && messages.length >= CATCHUP_MAX_REPLIES_PER_THREAD) {
        logger.warn(
          {
            component: 'slack-catchup',
            channelId,
            threadTs,
            accumulated: messages.length,
            cap: CATCHUP_MAX_REPLIES_PER_THREAD,
          },
          'thread replies hit per-thread cap during catch-up; stopping pagination',
        );
        break;
      }
    } while (cursor);
  } catch (error) {
    // A thread in a channel the token can't read (no groups:history) or one
    // that is gone fails the same way every scan: not worth a warning each time.
    const code = (error as { data?: { error?: string } }).data?.error ?? '';
    const quiet = ['missing_scope', 'not_in_channel', 'channel_not_found', 'thread_not_found'].includes(code);
    (quiet ? logger.debug.bind(logger) : logger.warn.bind(logger))(
      { component: 'slack-catchup', channelId, threadTs, error: String(error) },
      'failed to fetch thread replies during missed mention catch-up',
    );
  }

  // `oldest` + inclusive:false can still return the parent; keep replies after the boundary.
  return messages.filter(message => toEpochSeconds(String(message.ts ?? '')) > oldestTs);
}

async function hasBotResponseAfterMention(
  client: WebClient,
  channelId: string,
  threadTs: string,
  mentionTs: string,
  botUserId: string,
): Promise<boolean> {
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 200,
    });
    const mentionEpoch = toEpochSeconds(mentionTs);
    for (const message of response.messages ?? []) {
      const ts = String(message.ts ?? '');
      if (!ts) {
        continue;
      }
      if (String(message.user ?? '') === botUserId && toEpochSeconds(ts) > mentionEpoch) {
        return true;
      }
    }
    return false;
  } catch (error) {
    // Don't collapse a transient conversations.replies failure into "yes
    // already responded" — that previously caused catch-up to record the
    // replay marker and silently drop the mention forever. Returning false
    // here lets catch-up enqueue the replayed mention; processEvent's
    // hasJobForEventTs dedup gate will still suppress an actual double-run
    // if the bot did in fact reply.
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        threadTs,
        error: String(error),
      },
      'failed to inspect thread replies while checking missed mention response status; treating as not-yet-responded so catch-up retries',
    );
    return false;
  }
}

function toEpochSeconds(ts: string): number {
  const value = Number(ts);
  return Number.isFinite(value) ? value : 0;
}
