import type { WebClient } from '@slack/web-api';
import type { SlackEventEnvelope } from '../types/contracts.js';

/**
 * Messages that came in while their thread was held by a running job, and so
 * started nothing (one job per thread, issue #261). A job that holds its
 * thread only to wait on people, like the deploy offer after a merge (issue
 * #703), may ask for the message that ended its wait to run once the thread
 * is free, instead of asking its author to send it again.
 */

export interface HeldMessage {
  event: SlackEventEnvelope;
  client: WebClient;
  atMs: number;
}

/** Long enough to outlast the longest wait that asks for a replay. */
const HOLD_MS = 3 * 60 * 60 * 1000;
const MAX_HELD = 200;

const held = new Map<string, HeldMessage>();
const replays = new Map<string, HeldMessage[]>();

const messageKey = (channelId: string, ts: string) => `${channelId}:${ts}`;
const threadKey = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;

function prune(nowMs: number): void {
  for (const [key, entry] of held) {
    if (nowMs - entry.atMs > HOLD_MS) held.delete(key);
  }
  for (const [key, entries] of replays) {
    const fresh = entries.filter(entry => nowMs - entry.atMs <= HOLD_MS);
    if (fresh.length === 0) replays.delete(key);
    else replays.set(key, fresh);
  }
  while (held.size > MAX_HELD) held.delete(held.keys().next().value as string);
}

/** Called for a message skipped because its thread was busy. */
export function holdBusyThreadMessage(event: SlackEventEnvelope, client: WebClient, nowMs = Date.now()): void {
  prune(nowMs);
  held.set(messageKey(event.channelId, event.eventTs), { event, client, atMs: nowMs });
}

/**
 * Asks for a held message to run once its thread is free. `seen` is the
 * message as the thread shows it now: one edited since it arrived would run
 * its old words, so it is not run. `not_held` when it never reached this
 * process (or arrived before it started), so the caller can ask its author
 * to send it again instead.
 */
export function replayAfterThreadFrees(
  channelId: string,
  threadTs: string,
  messageTs: string,
  seen: { text: string; edited?: boolean },
): 'replayed' | 'changed' | 'not_held' {
  const entry = held.get(messageKey(channelId, messageTs));
  if (!entry || entry.event.threadTs !== threadTs) return 'not_held';
  held.delete(messageKey(channelId, messageTs));
  if (seen.edited || seen.text.trim() !== (entry.event.text ?? '').trim()) return 'changed';
  const key = threadKey(channelId, threadTs);
  replays.set(key, [...(replays.get(key) ?? []), entry]);
  return 'replayed';
}

/** The messages to run now that the thread is free, oldest first. */
export function takeThreadReplays(channelId: string, threadTs: string): HeldMessage[] {
  const key = threadKey(channelId, threadTs);
  const entries = replays.get(key) ?? [];
  replays.delete(key);
  return entries;
}

/** The event id a replayed message runs under: its own id was spent when it was skipped. */
export const THREAD_REPLAY_EVENT_PREFIX = 'thread-replay:';

export function __resetBusyThreadMessagesForTests(): void {
  held.clear();
  replays.clear();
}
