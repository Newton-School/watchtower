import { placesAllowingLevel } from './control.js';
import type { AccessControlConfig, AccessLevel, AppConfig } from '../types/contracts.js';

/** At most this many channels are named; past it the line gets long and the first few are enough. */
const MAX_CHANNELS = 3;

/**
 * Where a person denied because "this channel is not enabled" (or "DMs are
 * not enabled") can ask instead (issue #618). A designer asked for a review
 * of their own PR in #development and was only told to contact an admin,
 * though the same request was open to them in the product channel. The
 * denial itself is kept word for word (the three deny reasons and their copy,
 * PR #197); this line follows it.
 *
 * It names only places the person's own access already covers: channels,
 * and a DM when one of their groups allows it. It does not point at tagging
 * the owner, which would run the request on the owner's authority: telling
 * everyone that in public would make every channel limit a suggestion, and
 * whether direct mentions should get that authority is the owner's call.
 */
export function channelDenialHint(params: {
  config: AppConfig;
  accessControl?: AccessControlConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  requiredLevel: AccessLevel;
}): { text: string; channels: string[]; dm: boolean } | undefined {
  const { config, userId, channelId, channelType, requiredLevel } = params;
  // A replayed DM can arrive without a type; its id still says what it is.
  const inOneToOneDm = channelType === 'im' || (!channelType && channelId.startsWith('D'));
  const places = placesAllowingLevel({ config, accessControl: params.accessControl, userId, requiredLevel });
  const channels = places.channels.filter(id => id !== channelId).slice(0, MAX_CHANNELS);
  const dm = places.dm && !inOneToOneDm;

  const routes: string[] = [];
  if (channels.length > 0) routes.push(`ask me in ${joinOr(channels.map(id => `<#${id}>`))}`);
  if (dm) routes.push('DM me');
  if (routes.length === 0) return undefined;
  return { text: `You can ${joinRoutes(routes)}.`, channels, dm };
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** Routes are clauses, so they take a comma before the last "or". */
function joinRoutes(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}
