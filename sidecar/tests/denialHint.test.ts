import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelsAllowingLevel, toResolvedAccessControlConfig } from '../src/access/control.js';
import { channelDenialHint } from '../src/access/denialHint.js';
import type { AppConfig } from '../src/types/contracts.js';

const group = (manualUserIds: string, allowedChannelIds: string) => ({
  slackUserGroupHandle: '',
  manualUserIds,
  allowedChannelIds,
  allowIm: false,
  allowMpim: false,
});

const config = {
  ownerSlackUserIds: ['UOWNER'],
  accessControl: toResolvedAccessControlConfig(
    {
      mode: 'enforce',
      groups: {
        viewer: group('UVIEWER', 'C-PM'),
        reviewer: group('', ''),
        // A designer: builder in the product channel and the bugs channel, not in #development.
        builder: group('UDESIGNER', 'C-PM,C-BUGS'),
        admin: group('UADMIN', 'C-PM,C-DEV'),
        owner: group('', ''),
      },
    },
    ['UOWNER'],
  ),
} as unknown as AppConfig;

afterEach(() => vi.unstubAllEnvs());

describe('channelsAllowingLevel', () => {
  it('lists the channels of the bundles that grant the level, and nothing for a level the person lacks', () => {
    expect(channelsAllowingLevel({ config, userId: 'UDESIGNER', requiredLevel: 'reviewer' })).toEqual([
      'C-PM',
      'C-BUGS',
    ]);
    expect(channelsAllowingLevel({ config, userId: 'UVIEWER', requiredLevel: 'viewer' })).toEqual(['C-PM']);
    expect(channelsAllowingLevel({ config, userId: 'UVIEWER', requiredLevel: 'reviewer' })).toEqual([]);
  });
});

describe('channelDenialHint', () => {
  it('names where the person can ask, and offers tagging the owner in a channel', () => {
    expect(
      channelDenialHint({
        config,
        userId: 'UDESIGNER',
        channelId: 'C-DEV',
        channelType: 'channel',
        requiredLevel: 'reviewer',
      }),
    ).toBe("You can ask me in <#C-PM> or <#C-BUGS>, or tag <@UOWNER> here and I'll take it on for them.");
  });

  it('does not name the channel the person is already in', () => {
    const hint = channelDenialHint({
      config,
      userId: 'UDESIGNER',
      channelId: 'C-BUGS',
      channelType: 'channel',
      requiredLevel: 'reviewer',
    });
    expect(hint).toBe("You can ask me in <#C-PM>, or tag <@UOWNER> here and I'll take it on for them.");
  });

  it('leaves out the owner tag when delegation is switched off', () => {
    vi.stubEnv('WATCHTOWER_OWNER_TAG_DELEGATION', '0');
    expect(
      channelDenialHint({
        config,
        userId: 'UDESIGNER',
        channelId: 'C-DEV',
        channelType: 'channel',
        requiredLevel: 'reviewer',
      }),
    ).toBe('You can ask me in <#C-PM> or <#C-BUGS>.');
  });

  it('says nothing in a DM, where an owner tag is not delegated', () => {
    expect(
      channelDenialHint({ config, userId: 'UDESIGNER', channelId: 'D1', channelType: 'im', requiredLevel: 'reviewer' }),
    ).toBeUndefined();
  });

  it('offers only the owner tag when no other channel is open to the person', () => {
    expect(
      channelDenialHint({
        config,
        userId: 'UVIEWER',
        channelId: 'C-DEV',
        channelType: 'channel',
        requiredLevel: 'viewer',
      }),
    ).toBe("You can ask me in <#C-PM>, or tag <@UOWNER> here and I'll take it on for them.");
    vi.stubEnv('WATCHTOWER_OWNER_TAG_DELEGATION', '0');
    expect(
      channelDenialHint({
        config,
        userId: 'UVIEWER',
        channelId: 'C-PM',
        channelType: 'channel',
        requiredLevel: 'viewer',
      }),
    ).toBeUndefined();
  });
});
