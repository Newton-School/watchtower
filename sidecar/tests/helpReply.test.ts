import { describe, expect, it } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import { buildHelpReply, isHelpRequest } from '../src/router/helpReply.js';
import type { AppConfig } from '../src/types/contracts.js';

const group = (manualUserIds: string, allowedChannelIds: string, allowIm = false) => ({
  manualUserIds,
  allowedChannelIds,
  allowIm,
  allowMpim: false,
});

function makeConfig(marketing = true, mode: 'enforce' | 'audit' = 'enforce'): AppConfig {
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
        mode,
        groups: {
          viewer: group('UVIEWER,UBOTH', 'C-PM', true),
          reviewer: group('UREVIEW,UBOTH', 'C-DEV'),
          builder: group('UPM', 'C-PM'),
          admin: { ...group('UADMIN', 'C-PM,C-DEV', true), allowMpim: true },
          owner: group('', ''),
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

  it('tells a reviewer in #development about reviews, and labels the rest by the tier that has them', () => {
    const text = buildHelpReply({ config: makeConfig(), userId: 'UREVIEW', channelId: 'C-DEV', role: 'dev' });
    const lines = text.split('\n');
    expect(lines[1]).toContain('Review a pull request');
    expect(lines[1]).toContain('review &lt;PR link&gt;');
    expect(text).not.toContain('Make a change and open a PR');
    expect(text).toContain('Builders: changes, staging links, browser QA.');
    expect(text).toContain('Admins only: deploys.');
    expect(text).not.toContain('<PR link>');
  });

  it('says which of their tools work in another channel', () => {
    // UBOTH is a viewer in C-PM and a reviewer in C-DEV, asking in C-PM.
    const text = buildHelpReply({ config: makeConfig(), userId: 'UBOTH', channelId: 'C-PM' });
    expect(text).toContain('Answer questions about the product');
    expect(text).toContain('Not in this channel, but enabled for you elsewhere: PR reviews.');
    expect(text).toContain('Builders: changes, staging links, browser QA.');
  });

  it('tells someone who is not enabled here that an admin can enable them', () => {
    const text = buildHelpReply({ config: makeConfig(), userId: 'UPM', channelId: 'C-OTHER', role: 'pm' });
    expect(text).toBe(
      "I'm not set up for you in this channel yet. An admin can enable me; until then I can only answer this.",
    );
  });

  it('in audit mode says what the router does: a channel request is served, a DM is not', () => {
    const text = buildHelpReply({ config: makeConfig(true, 'audit'), userId: 'USTRANGER', channelId: 'C-OTHER' });
    expect(text).toContain('Answer questions about the product');
    expect(text).toContain('Deploy to production');
    expect(text).not.toContain('not set up');
    const dm = buildHelpReply({
      config: makeConfig(true, 'audit'),
      userId: 'USTRANGER',
      channelId: 'D1',
      channelType: 'im',
    });
    expect(dm).toContain('not set up for you here');
  });

  it('survives a role value the dossier column could hold but the type does not', () => {
    const text = buildHelpReply({ config: makeConfig(), userId: 'UPM', channelId: 'C-PM', role: 'wizard' as never });
    expect(text).toContain("Here's what I can do for you in this channel.");
  });

  it('gives the owner everything, and does not mention www pages when the marketing site is not configured', () => {
    const text = buildHelpReply({ config: makeConfig(false), userId: 'UOWNER', channelId: 'C-DEV' });
    expect(text).toContain('Review a pull request');
    expect(text).toContain('Deploy to production');
    expect(text).toContain('*Make a change and open a PR for it.* _e.g. "rename the "Mentor evaluation" label');
    expect(text).not.toContain('www');
    expect(text).not.toContain('Admins only');
  });

  it('says "here" in a DM, and does not ask for a tag', () => {
    const text = buildHelpReply({
      config: makeConfig(),
      userId: 'UADMIN',
      channelId: 'D1',
      channelType: 'im',
      role: 'dev',
    });
    expect(text.startsWith("Here's what I can do for you here. Send me the ask in one message:")).toBe(true);
  });
});
