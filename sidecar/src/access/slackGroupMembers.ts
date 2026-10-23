import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { resolveUserGroup } from '../slack/userGroupResolver.js';

/** What the copy needs from the job store. */
export interface SlackGroupBundleStore {
  listBundleSlackGroups(): Array<{ name: string; handles: string[] }>;
  addSlackGroupMembersToBundle(name: string, userIds: string[]): string[];
}

/**
 * Bundles used to take their people from Slack user groups (@core-dev and the
 * like), read again every 30 minutes. They now list people directly, edited in
 * Settings. This copies each bundle's Slack group members onto it once, so
 * nobody who had access loses it, and then forgets the groups. A bundle whose
 * groups could not all be read keeps them, to be tried again; a group Slack no
 * longer has adds nobody.
 */
export async function copySlackGroupMembers(params: {
  store: SlackGroupBundleStore;
  slack: Pick<WebClient, 'usergroups'>;
}): Promise<{ copied: string[]; pending: string[] }> {
  const copied: string[] = [];
  const pending: string[] = [];
  for (const { name, handles } of params.store.listBundleSlackGroups()) {
    const members: string[] = [];
    let unread = false;
    for (const handle of handles) {
      try {
        const group = await resolveUserGroup(params.slack, handle);
        if (group) members.push(...group.members);
      } catch {
        // resolveUserGroup logged it.
        unread = true;
      }
    }
    if (unread) {
      pending.push(name);
      continue;
    }
    const added = params.store.addSlackGroupMembersToBundle(name, members);
    copied.push(name);
    logger.info(
      { bundle: name, handles, added },
      'access: copied Slack user group members onto the bundle; it no longer reads Slack groups',
    );
  }
  if (pending.length > 0) {
    logger.warn({ pending }, 'access: could not read Slack user groups for these bundles; trying again later');
  }
  return { copied, pending };
}
