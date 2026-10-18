import { describe, expect, it } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import { buildHelpReply, isHelpRequest } from '../src/router/helpReply.js';
import type { AppConfig } from '../src/types/contracts.js';

function makeConfig(marketing = true): AppConfig {
  return {
    ownerSlackUserIds: ['UOWNER'],
    coreDevSlackUserIds: ['UOWNER'],
    repoPaths: {
      newtonWeb: '/repos/newton-web',
      newtonApi: '/repos/newton-api',
      ...(marketing ? { newtonMarketingWeb: '/repos/newton-marketing-web' } : {}),
    },
    accessControl: toResolvedAccessControlConfig(
      {
        mode: 'enforce',
        groups: {
          viewer: {
            slackUserGroupHandle: '',
            manualUserIds: 'UVIEWER',
            allowedChannelIds: 'C-PM',
            allowIm: true,
            allowMpim: false,
          },
          reviewer: {
            slackUserGroupHandle: '',
            manualUserIds: 'UREVIEW',
            allowedChannelIds: 'C-DEV',
            allowIm: false,
            allowMpim: false,
          },
          builder: {
            slackUserGroupHandle: '',
            manualUserIds: 'UPM',
            allowedChannelIds: 'C-PM',
            allowIm: false,
            allowMpim: false,
          },
          admin: {
            slackUserGroupHandle: '',
            manualUserIds: 'UADMIN',
            allowedChannelIds: 'C-PM,C-DEV',
            allowIm: true,
            allowMpim: true,
          },
          owner: {
            slackUserGroupHandle: '',
            manualUserIds: '',
            allowedChannelIds: '',
            allowIm: false,
            allowMpim: false,
          },
        },
      },
      ['UOWNER'],
    ),
  } as unknown as AppConfig;
}

describe('isHelpRequest', () => {
  it('reads the plain ways of asking for help', () => {
    for (const text of [
      'help',
      'Help!',
      'help me',
      'what can you do?',
      'what can you do here',
      'What all can you do',
      'how can you help me?',
      'how do I use you',
      'show me your commands',
      'hey, what can you do',
      'help *Sent using* <@U0ACB8RHKED>',
    ]) {
      expect(isHelpRequest(text), text).toBe(true);
    }
  });

  it('does not read a request that happens to contain the word', () => {
    for (const text of [
      'help me change the footer copy to 2026',
      'can you help with this PR https://github.com/x/y/pull/1',
      'what can you do about the failing build?',
      '',
    ]) {
      expect(isHelpRequest(text), text).toBe(false);
    }
  });
});

describe('buildHelpReply', () => {
  it('tells a PM in the product channel what they can ask for, changes first', () => {
    const text = buildHelpReply({ config: makeConfig(), userId: 'UPM', channelId: 'C-PM', role: 'pm' });
    const lines = text.split('\n');
    expect(lines[0]).toBe("Here's what I can do for you in this channel. Tag me with the ask in one message:");
    expect(lines[1]).toContain('Make a change and open a PR for it: copy, numbers, images, PDFs on www pages, or code');
    expect(lines[1]).toContain('change 93% to 98.3%');
    expect(text).toContain('Answer questions about the product, the code and the data');
    expect(text).toContain('Look into a problem and report the cause');
    // Tiers are cumulative: a builder also reviews and runs browser QA.
    expect(text).toContain('Admins only: deploys.');
    expect(text).toContain('give me the URL and a screenshot');
  });

  it('tells a reviewer in #development about reviews, and where their other tools work', () => {
    const text = buildHelpReply({ config: makeConfig(), userId: 'UREVIEW', channelId: 'C-DEV', role: 'dev' });
    expect(text.split('\n')[1]).toContain('Review a pull request');
    expect(text).not.toContain('Make a change and open a PR');
  });

  it('tells someone who is not enabled here that an admin can enable them', () => {
    const text = buildHelpReply({ config: makeConfig(), userId: 'UPM', channelId: 'C-DEV', role: 'pm' });
    expect(text).toBe(
      "I'm not set up for you in this channel yet. An admin can enable me; until then I can only answer this.",
    );
  });

  it('gives the owner everything, and does not mention www pages when the marketing site is not configured', () => {
    const text = buildHelpReply({ config: makeConfig(false), userId: 'UOWNER', channelId: 'C-DEV' });
    expect(text).toContain('Review a pull request');
    expect(text).toContain('Deploy to production');
    expect(text).toContain('*Make a change and open a PR for it.*');
    expect(text).not.toContain('www pages');
    expect(text).not.toContain('Admins only');
  });

  it('says "here" in a DM', () => {
    const text = buildHelpReply({
      config: makeConfig(),
      userId: 'UADMIN',
      channelId: 'D1',
      channelType: 'im',
      role: 'dev',
    });
    expect(text.startsWith("Here's what I can do for you here.")).toBe(true);
  });
});
