import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placesAllowingLevel, toResolvedAccessControlConfig } from '../src/access/control.js';
import { channelDenialHint } from '../src/access/denialHint.js';
import type { AppConfig } from '../src/types/contracts.js';

const group = (manualUserIds: string, allowedChannelIds: string, allowIm = false) => ({
  slackUserGroupHandle: '',
  manualUserIds,
  allowedChannelIds,
  allowIm,
  allowMpim: false,
});

const accessControl = toResolvedAccessControlConfig(
  {
    mode: 'enforce',
    groups: {
      viewer: group('UVIEWER', 'C-PM'),
      reviewer: group('', ''),
      // A designer: builder in the product channel and the bugs channel, not in #development.
      builder: group('UDESIGNER', 'C-PM,C-BUGS'),
      admin: group('UADMIN', 'C-PM', true),
      owner: group('', ''),
    },
  },
  ['UOWNER'],
);
const config = { ownerSlackUserIds: ['UOWNER'], accessControl } as unknown as AppConfig;

const base = {
  config,
  channelType: 'channel',
  ownerName: 'theOG',
  delegable: true,
  ownerInThread: false,
};

beforeEach(() => vi.stubEnv('WATCHTOWER_OWNER_TAG_DELEGATION', '1'));
afterEach(() => vi.unstubAllEnvs());

describe('placesAllowingLevel', () => {
  it('lists the channels of the bundles that grant the level, and whether one allows DMs', () => {
    expect(placesAllowingLevel({ config, userId: 'UDESIGNER', requiredLevel: 'reviewer' })).toEqual({
      channels: ['C-PM', 'C-BUGS'],
      dm: false,
    });
    expect(placesAllowingLevel({ config, userId: 'UADMIN', requiredLevel: 'admin' })).toEqual({
      channels: ['C-PM'],
      dm: true,
    });
    expect(placesAllowingLevel({ config, userId: 'UVIEWER', requiredLevel: 'reviewer' })).toEqual({
      channels: [],
      dm: false,
    });
  });

  it('reads an explicit access-control config the same way, as the router passes it', () => {
    expect(
      placesAllowingLevel({ config: {} as AppConfig, accessControl, userId: 'UDESIGNER', requiredLevel: 'builder' }),
    ).toEqual({ channels: ['C-PM', 'C-BUGS'], dm: false });
  });
});

describe('channelDenialHint', () => {
  it('names where the person can ask, and the owner route by name, never as a mention', () => {
    const hint = channelDenialHint({ ...base, userId: 'UDESIGNER', channelId: 'C-DEV', requiredLevel: 'reviewer' });
    expect(hint).toBe(
      'You can ask me in <#C-PM> or <#C-BUGS>, or post the same request here tagging theOG instead of me.',
    );
    expect(hint).not.toContain('<@');
  });

  it('does not name the channel the person is already in', () => {
    expect(channelDenialHint({ ...base, userId: 'UDESIGNER', channelId: 'C-BUGS', requiredLevel: 'reviewer' })).toBe(
      'You can ask me in <#C-PM>, or post the same request here tagging theOG instead of me.',
    );
  });

  it('offers only the owner route when no other channel is open to the person', () => {
    expect(channelDenialHint({ ...base, userId: 'UVIEWER', channelId: 'C-PM', requiredLevel: 'viewer' })).toBe(
      'You can post the same request here tagging theOG instead of me.',
    );
  });

  it('leaves out the owner route where it would not work', () => {
    const cases = [
      { label: 'delegation off', env: { WATCHTOWER_OWNER_TAG_DELEGATION: '0' } },
      { label: 'not a full member', delegable: false },
      { label: 'owner already in the thread', ownerInThread: true },
      { label: 'owner name unknown', ownerName: undefined },
    ];
    for (const { label, ...override } of cases) {
      expect(
        channelDenialHint({ ...base, ...override, userId: 'UDESIGNER', channelId: 'C-DEV', requiredLevel: 'reviewer' }),
        label,
      ).toBe('You can ask me in <#C-PM> or <#C-BUGS>.');
    }
  });

  it('never offers the owner route for a deploy, which checks the requester again', () => {
    expect(channelDenialHint({ ...base, userId: 'UADMIN', channelId: 'C-DEV', requiredLevel: 'admin' })).toBe(
      'You can ask me in <#C-PM>, or DM me.',
    );
  });

  it('in a DM names the channels, and not the owner route', () => {
    expect(
      channelDenialHint({
        ...base,
        userId: 'UDESIGNER',
        channelId: 'D1',
        channelType: 'im',
        requiredLevel: 'reviewer',
      }),
    ).toBe('You can ask me in <#C-PM> or <#C-BUGS>.');
  });

  it('says nothing when there is nowhere else to go', () => {
    expect(
      channelDenialHint({
        ...base,
        ownerName: undefined,
        userId: 'UVIEWER',
        channelId: 'C-PM',
        requiredLevel: 'viewer',
      }),
    ).toBeUndefined();
  });
});
