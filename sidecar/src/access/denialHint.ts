import { channelsAllowingLevel } from './control.js';
import { isDelegableChannel, isOwnerTagDelegationEnabled } from './ownerDelegation.js';
import type { AccessControlConfig, AccessLevel, AppConfig } from '../types/contracts.js';

/** At most this many channels are named; past it the line gets long and the first few are enough. */
const MAX_CHANNELS = 3;

/**
 * What a person denied because "this channel is not enabled" can do instead
 * (issue #618). A designer asked for a review of their own PR in #development
 * and was told to contact an admin, while the same ask, tagging the owner,
 * ran on the owner's authority. The denial itself is kept word for word (the
 * three deny reasons and their copy, PR #197); this line follows it.
 *
 * Direct mentions still get their own access check: the owner decided that a
 * tagger's later "@miniOG" asks do not inherit the owner's authority. So this
 * says where to ask, it does not serve the ask.
 */
export function channelDenialHint(params: {
  config: AppConfig;
  accessControl?: AccessControlConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  requiredLevel: AccessLevel;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const { config, userId, channelId, channelType } = params;
  if (channelType === 'im' || channelType === 'mpim') return undefined;

  const elsewhere = channelsAllowingLevel({
    config,
    accessControl: params.accessControl,
    userId,
    requiredLevel: params.requiredLevel,
  })
    .filter(id => id !== channelId)
    .slice(0, MAX_CHANNELS);
  const owner = config.ownerSlackUserIds[0];
  const ownerTag =
    owner && isOwnerTagDelegationEnabled(params.env) && isDelegableChannel(channelType, channelId) ? owner : undefined;

  const where = elsewhere.length > 0 ? `ask me in ${joinOr(elsewhere.map(id => `<#${id}>`))}` : '';
  const tag = ownerTag ? `tag <@${ownerTag}> here and I'll take it on for them` : '';
  if (where && tag) return `You can ${where}, or ${tag}.`;
  if (where) return `You can ${where}.`;
  if (tag) return `You can ${tag}.`;
  return undefined;
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
