import { describe, expect, it } from 'vitest';
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
  const hint = (params: Partial<Parameters<typeof channelDenialHint>[0]>) =>
    channelDenialHint({
      config,
      userId: 'UDESIGNER',
      channelId: 'C-DEV',
      channelType: 'channel',
      requiredLevel: 'reviewer',
      ...params,
    })?.text;

  it('names the channels the person can ask in, and never points at the owner', () => {
    const text = hint({});
    expect(text).toBe('You can ask me in <#C-PM> or <#C-BUGS>.');
    expect(text).not.toContain('<@');
  });

  it('does not name the channel the person is already in', () => {
    expect(hint({ channelId: 'C-BUGS' })).toBe('You can ask me in <#C-PM>.');
  });

  it('adds "DM me" when one of their groups allows DMs, including from a group DM', () => {
    expect(hint({ userId: 'UADMIN', requiredLevel: 'admin' })).toBe('You can ask me in <#C-PM>, or DM me.');
    expect(hint({ userId: 'UADMIN', requiredLevel: 'admin', channelId: 'G1', channelType: 'mpim' })).toBe(
      'You can ask me in <#C-PM>, or DM me.',
    );
  });

  it('does not offer a DM from inside one, even when the event has no type', () => {
    expect(hint({ userId: 'UADMIN', requiredLevel: 'admin', channelId: 'D1', channelType: 'im' })).toBe(
      'You can ask me in <#C-PM>.',
    );
    expect(hint({ userId: 'UADMIN', requiredLevel: 'admin', channelId: 'D1', channelType: undefined })).toBe(
      'You can ask me in <#C-PM>.',
    );
  });

  it('says nothing when there is nowhere else to go', () => {
    expect(hint({ userId: 'UVIEWER', channelId: 'C-PM', requiredLevel: 'viewer' })).toBeUndefined();
  });

  it('reports what it offered, for the log', () => {
    expect(
      channelDenialHint({
        config,
        userId: 'UADMIN',
        channelId: 'C-DEV',
        channelType: 'channel',
        requiredLevel: 'admin',
      }),
    ).toEqual({ text: 'You can ask me in <#C-PM>, or DM me.', channels: ['C-PM'], dm: true });
  });
});
