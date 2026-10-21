import { placesAllowingLevel } from './control.js';
import { isDelegableChannel, isOwnerTagDelegationEnabled } from './ownerDelegation.js';
import type { AccessControlConfig, AccessLevel, AppConfig } from '../types/contracts.js';

/** At most this many channels are named; past it the line gets long and the first few are enough. */
const MAX_CHANNELS = 3;

/**
 * What a person denied because "this channel is not enabled" (or "DMs are
 * not enabled") can do instead (issue #618). A designer asked for a review of
 * their own PR in #development and was told to contact an admin, while the
 * same request, tagging the owner, ran on the owner's authority. The denial
 * itself is kept word for word (the three deny reasons and their copy, PR
 * #197); this line follows it.
 *
 * Direct mentions still get their own access check: the owner decided that a
 * tagger's later "@miniOG" asks do not inherit the owner's authority. So this
 * says where to ask, it does not serve the ask.
 *
 * The owner is named, never @-mentioned: a mention would notify them on
 * every denial. The owner route is offered only where it would work: in a
 * channel, with delegation on, for a request the owner's authority actually
 * carries through (not a deploy, which checks the requester again), to a
 * person the workspace says can be delegated to, in a thread the owner has
 * not already joined (miniOG then stays out of an owner tag).
 */
export function channelDenialHint(params: {
  config: AppConfig;
  accessControl?: AccessControlConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  requiredLevel: AccessLevel;
  /** The owner's display name, for "tag theOG"; without it the owner route is not offered. */
  ownerName?: string;
  /** Whether an owner tag from this person would be delegated: a full workspace member. */
  delegable: boolean;
  /** An owner has already posted in this thread. */
  ownerInThread: boolean;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const { config, userId, channelId, channelType, requiredLevel } = params;
  const isDM = channelType === 'im' || channelType === 'mpim';
  const places = placesAllowingLevel({ config, accessControl: params.accessControl, userId, requiredLevel });
  const channels = places.channels.filter(id => id !== channelId).slice(0, MAX_CHANNELS);

  const routes: string[] = [];
  if (channels.length > 0) routes.push(`ask me in ${joinOr(channels.map(id => `<#${id}>`))}`);
  if (!isDM && places.dm) routes.push('DM me');
  const ownerRouteWorks =
    !isDM &&
    Boolean(params.ownerName) &&
    requiredLevel !== 'admin' &&
    requiredLevel !== 'owner' &&
    params.delegable &&
    !params.ownerInThread &&
    isOwnerTagDelegationEnabled(params.env) &&
    isDelegableChannel(channelType, channelId);
  if (ownerRouteWorks) routes.push(`post the same request here tagging ${params.ownerName} instead of me`);

  if (routes.length === 0) return undefined;
  return `You can ${joinRoutes(routes)}.`;
}

/** Routes are clauses, so they take a comma before the last "or". */
function joinRoutes(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
