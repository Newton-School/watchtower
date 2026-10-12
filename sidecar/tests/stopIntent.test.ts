import { describe, expect, it } from 'vitest';
import { decideStop, isStopCommand, normalizeControlText } from '../src/router/stopIntent.js';

describe('normalizeControlText', () => {
  it('drops mentions, a forwarding footer, case and punctuation', () => {
    expect(normalizeControlText('<@UBOT1> Stop!')).toBe('stop');
    expect(normalizeControlText('no <@UBOT1> -')).toBe('no');
    expect(normalizeControlText("<@UBOT1> don't deploy *Sent using* <@UCLAUDE>")).toBe('dont deploy');
  });
});

describe('isStopCommand', () => {
  // The messages people actually sent while trying to stop a run (issue #435).
  it.each(['<@UBOT1> stop', '<@UBOT1> u can cancel ur task', 'no <@UBOT1> -', '<@UBOT1> no deployment'])(
    'recognises %s',
    text => {
      expect(isStopCommand(text)).toBe(true);
    },
  );

  it.each([
    '<@UBOT1> cancel',
    '<@UBOT1> Abort.',
    '<@UBOT1> never mind',
    '<@UBOT1> please stop',
    '<@UBOT1> stop it',
    '<@UBOT1> cancel the review',
    '<@UBOT1> you can stop',
    '<@UBOT1> please cancel your task',
    "<@UBOT1> don't merge it",
    '<@UBOT1> stop *Sent using* <@UCLAUDE>',
  ])('recognises %s', text => {
    expect(isStopCommand(text)).toBe(true);
  });

  // A false positive cancels real work, so anything that is more than a stop is not one.
  it.each([
    '<@UBOT1> stop using the old endpoint and add the new one',
    '<@UBOT1> cancel the subscription flow for expired users',
    "<@UBOT1> don't stop",
    '<@UBOT1> why did it stop?',
    '<@UBOT1> no, use the other repo',
    '<@UBOT1> stop the banner from showing on logged-out pages',
    '<@UBOT1> review this',
    '<@UBOT1>',
    '',
  ])('does not treat %s as a stop', text => {
    expect(isStopCommand(text)).toBe(false);
  });
});

describe('decideStop', () => {
  const base = {
    isBotMention: true,
    text: '<@UBOT1> stop',
    senderId: 'UREQ',
    activeJob: { requestedBy: 'UREQ' },
    adminUserIds: ['UADMIN'],
    ownerUserIds: ['UOWNER'],
  };

  it('lets the person who asked for the job stop it', () => {
    expect(decideStop(base)).toEqual({ stop: true });
  });

  it('lets an admin or an owner stop it', () => {
    expect(decideStop({ ...base, senderId: 'UADMIN' })).toEqual({ stop: true });
    expect(decideStop({ ...base, senderId: 'UOWNER' })).toEqual({ stop: true });
  });

  it('does not let a bystander stop it', () => {
    expect(decideStop({ ...base, senderId: 'UOTHER' })).toEqual({ stop: false, reason: 'not_allowed' });
  });

  it('needs the message to be addressed to the bot', () => {
    expect(decideStop({ ...base, isBotMention: false })).toEqual({ stop: false, reason: 'not_addressed' });
  });

  it('ignores a message that is not a stop', () => {
    expect(decideStop({ ...base, text: '<@UBOT1> stop using X and add Y' })).toEqual({
      stop: false,
      reason: 'not_a_stop',
    });
  });

  it('does nothing when no job is running in the thread', () => {
    expect(decideStop({ ...base, activeJob: undefined })).toEqual({ stop: false, reason: 'no_active_job' });
  });

  it('does not treat an unknown requester as a match for an unknown sender', () => {
    expect(decideStop({ ...base, senderId: '', activeJob: { requestedBy: undefined } })).toEqual({
      stop: false,
      reason: 'not_allowed',
    });
  });
});
