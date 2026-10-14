import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';

/**
 * Is this Slack user a full member of our workspace? Owner-tag delegation
 * (access/ownerDelegation.ts) only lends the owner's authority to full
 * members — guests, Slack Connect externals, bots and deactivated accounts
 * get nothing, and miniOG stays silent on their owner-tags.
 */
export type WorkspaceMembershipReason = 'member' | 'guest' | 'external' | 'bot' | 'deleted' | 'lookup_failed';

export interface WorkspaceMembership {
  eligible: boolean;
  reason: WorkspaceMembershipReason;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const membershipCache = new Map<string, { value: WorkspaceMembership; expiresAt: number }>();
let workspaceIdentity: Promise<{ teamId?: string; enterpriseId?: string } | undefined> | undefined;

async function resolveWorkspaceIdentity(
  slack: WebClient,
): Promise<{ teamId?: string; enterpriseId?: string } | undefined> {
  if (!workspaceIdentity) {
    workspaceIdentity = Promise.resolve()
      .then(() => slack.auth.test())
      .then(res => ({
        teamId: typeof res.team_id === 'string' ? res.team_id : undefined,
        enterpriseId: typeof res.enterprise_id === 'string' && res.enterprise_id ? res.enterprise_id : undefined,
      }))
      .catch(err => {
        // Don't memoize a failure — the next lookup retries auth.test.
        workspaceIdentity = undefined;
        logger.warn({ err: String(err) }, 'workspace membership: auth.test failed');
        return undefined;
      });
  }
  return workspaceIdentity;
}

type SlackUser = {
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  team_id?: string;
  enterprise_user?: { enterprise_id?: string };
};

function classify(user: SlackUser, workspace: { teamId?: string; enterpriseId?: string }): WorkspaceMembership {
  if (user.deleted) return { eligible: false, reason: 'deleted' };
  if (user.is_bot || user.is_app_user) return { eligible: false, reason: 'bot' };
  if (user.is_restricted || user.is_ultra_restricted) return { eligible: false, reason: 'guest' };
  if (user.is_stranger) return { eligible: false, reason: 'external' };
  // Enterprise Grid: members of sibling workspaces share the enterprise id
  // but not the team id — the enterprise is the trust boundary there.
  if (workspace.enterpriseId) {
    const userEnterprise = user.enterprise_user?.enterprise_id;
    return userEnterprise === workspace.enterpriseId
      ? { eligible: true, reason: 'member' }
      : { eligible: false, reason: 'external' };
  }
  if (!user.team_id || !workspace.teamId) return { eligible: false, reason: 'lookup_failed' };
  return user.team_id === workspace.teamId
    ? { eligible: true, reason: 'member' }
    : { eligible: false, reason: 'external' };
}

/**
 * Resolve (and cache for 6h) whether `userId` is a full workspace member.
 * Fails closed: any lookup error is `lookup_failed` and is NOT cached, so the
 * next owner-tag retries.
 */
export async function resolveWorkspaceMembership(params: {
  slack: WebClient;
  userId: string;
  now?: number;
}): Promise<WorkspaceMembership> {
  const { slack, userId } = params;
  const now = params.now ?? Date.now();
  const cached = membershipCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.value;

  const workspace = await resolveWorkspaceIdentity(slack);
  if (!workspace) return { eligible: false, reason: 'lookup_failed' };

  try {
    const info = await slack.users.info({ user: userId });
    const user = info.user as SlackUser | undefined;
    if (!user) return { eligible: false, reason: 'lookup_failed' };
    const value = classify(user, workspace);
    if (value.reason !== 'lookup_failed') {
      membershipCache.set(userId, { value, expiresAt: now + CACHE_TTL_MS });
    }
    return value;
  } catch (err) {
    logger.warn({ userId, err: String(err) }, 'workspace membership: users.info failed');
    return { eligible: false, reason: 'lookup_failed' };
  }
}

export function __resetWorkspaceMembershipForTests(): void {
  membershipCache.clear();
  workspaceIdentity = undefined;
}
