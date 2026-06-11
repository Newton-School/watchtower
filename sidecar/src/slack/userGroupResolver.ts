import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';

export interface ResolvedUserGroup {
  /** Slack subteam ID (e.g. "S02HXP05ZNJ") — the only thing `<!subteam^…>` mentions accept. */
  id: string;
  handle: string;
  members: string[];
}

/**
 * Resolves a Slack user group handle (e.g., "core-dev") to its subteam ID and
 * member user IDs. Uses usergroups.list to find the group by handle, then
 * usergroups.users.list to fetch its members.
 *
 * Returns undefined when the handle doesn't exist (not a failure — the caller
 * skips it, matching the previous empty-members semantics).
 */
export async function resolveUserGroup(slack: WebClient, handle: string): Promise<ResolvedUserGroup | undefined> {
  const normalizedHandle = handle.replace(/^@/, '').trim().toLowerCase();
  if (!normalizedHandle) return undefined;

  try {
    const groupsResponse = await slack.usergroups.list({ include_disabled: false });
    const groups = groupsResponse.usergroups ?? [];
    const group = groups.find(g => g.handle?.toLowerCase() === normalizedHandle);

    if (!group?.id) {
      logger.warn({ handle: normalizedHandle }, 'Slack user group not found by handle');
      return undefined;
    }

    const membersResponse = await slack.usergroups.users.list({ usergroup: group.id });
    const members = membersResponse.users ?? [];

    logger.info(
      { handle: normalizedHandle, groupId: group.id, memberCount: members.length },
      'resolved Slack user group members',
    );

    return { id: group.id, handle: normalizedHandle, members };
  } catch (error) {
    // Re-throw on Slack API failure so the caller can decide whether to
    // overwrite the access-group cache. Returning an empty result here
    // previously caused setResolvedGroupMembers() to wipe the live allowlist
    // on transient outages, locking out legitimate group-only users until
    // the next successful refresh.
    logger.error({ handle: normalizedHandle, error: String(error) }, 'failed to resolve Slack user group');
    throw error;
  }
}
