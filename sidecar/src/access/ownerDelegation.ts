import type { WorkspaceMembership, WorkspaceMembershipReason } from '../slack/workspaceMembership.js';
import type { NormalizedTask, NormalizedThreadMessage } from '../types/contracts.js';

/**
 * Owner-tag delegation (issue #398).
 *
 * A message that tags an owner (theOG) rather than miniOG is written to a
 * person, and people tag the owner expecting it handled. miniOG handles it as
 * the owner's assistant: when the person who tagged fails their own access
 * check, the request runs on the owner's authority instead of drawing an
 * access error. Only the permission check changes. Everything that decides
 * how the work runs (worktree isolation, guarded prompts, attribution) still
 * sees the person who tagged: `isOwnerAuthor` is never set.
 *
 * Someone the owner's authority cannot be lent to (a guest, a Slack Connect
 * external, a bot, a deactivated account, or a tag outside a channel) gets
 * silence, never an access error: they did not ask miniOG for anything.
 *
 * The owner's decisions of 2026-09-21. Kill switch:
 * `WATCHTOWER_OWNER_TAG_DELEGATION=0` restores the access error.
 */

export function isOwnerTagDelegationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WATCHTOWER_OWNER_TAG_DELEGATION?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/** A message that tags an owner and not miniOG: addressed to a person. */
export function isPureOwnerTag(task: Pick<NormalizedTask, 'mentionType'>): boolean {
  return task.mentionType === 'owner';
}

/** The owner a message tags, in config order. */
export function taggedOwnerId(text: string | undefined, ownerIds: string[]): string | undefined {
  if (!text) return undefined;
  return ownerIds.find(ownerId => text.includes(`<@${ownerId}>`) || text.includes(`<@${ownerId}|`));
}

/**
 * Has an owner posted in the thread, other than in the tag itself? Then the
 * owner is already in the conversation, or answered before miniOG picked the
 * tag up, and miniOG stays out.
 */
export function ownerInThread(
  messages: Array<Pick<NormalizedThreadMessage, 'user' | 'ts'>>,
  tagTs: string,
  ownerIds: string[],
): { present: boolean; ownerId?: string; ts?: string } {
  const hit = messages.find(message => message.ts !== tagTs && ownerIds.includes(message.user));
  return hit ? { present: true, ownerId: hit.user, ts: hit.ts } : { present: false };
}

/**
 * Delegation only happens in a channel (public or private). A catch-up
 * envelope can lack a channel type, so an unknown type counts only for a `C…`
 * id; a legacy `G…` id may be a group DM, and fails closed.
 */
export function isDelegableChannel(channelType: string | undefined, channelId: string): boolean {
  if (channelType === 'channel' || channelType === 'group') return true;
  if (channelType === 'im' || channelType === 'mpim') return false;
  return !channelType && channelId.startsWith('C');
}

export type OwnerDelegationDecision =
  | { kind: 'delegate'; ownerId: string; inherited: boolean }
  | { kind: 'silent'; ownerId: string; reason: 'channel_not_delegable' | WorkspaceMembershipReason }
  | { kind: 'n/a' };

/**
 * Consulted only after the requester's own access check denied. A requester
 * who is allowed on their own is never delegated.
 */
export async function decideOwnerDelegation(params: {
  task: NormalizedTask;
  ownerIds: string[];
  resolveMembership: (userId: string) => Promise<WorkspaceMembership>;
  env?: NodeJS.ProcessEnv;
}): Promise<OwnerDelegationDecision> {
  const { task, ownerIds, resolveMembership, env } = params;
  if (task.isOwnerAuthor || !isOwnerTagDelegationEnabled(env)) return { kind: 'n/a' };

  const inherited = Boolean(task.inheritedDelegationOwnerId);
  const ownerId =
    task.inheritedDelegationOwnerId ??
    (isPureOwnerTag(task) ? (taggedOwnerId(task.event.text, ownerIds) ?? ownerIds[0]) : undefined);
  if (!ownerId) return { kind: 'n/a' };

  if (!isDelegableChannel(task.event.channelType, task.event.channelId)) {
    return { kind: 'silent', ownerId, reason: 'channel_not_delegable' };
  }
  const membership = await resolveMembership(task.event.userId);
  if (!membership.eligible) return { kind: 'silent', ownerId, reason: membership.reason };

  return { kind: 'delegate', ownerId, inherited };
}
