import { describe, expect, it } from 'vitest';
import { UNSUPPORTED_GENERIC_REPLY, unsupportedReply } from '../src/router/unsupportedReply.js';

describe('unsupportedReply (issue #606)', () => {
  it('names what miniOG cannot do and who can', () => {
    expect(unsupportedReply({ cannot: 'set reminders', whoCan: "Slack's /remind" })).toBe(
      "I can't set reminders: none of my tools reach that. Slack's /remind can help with that. " +
        'Mention me with "help" to see what I can do here.',
    );
  });

  it('leaves out who can when the router could not tell', () => {
    expect(unsupportedReply({ cannot: 'file Jira tickets' })).toBe(
      'I can\'t file Jira tickets: none of my tools reach that. Mention me with "help" to see what I can do here.',
    );
  });

  it('reads the phrase the way the model tends to write it', () => {
    for (const cannot of [
      "I can't grant access.",
      'I can’t grant access',
      'I cannot grant access',
      'cannot grant access',
      'Unable to grant access',
      'not able to grant access',
      "I'm unable to grant access",
      'I am unable to grant access',
      'I am not able to grant access',
      'To grant access',
      'Grant access!',
    ]) {
      expect(unsupportedReply({ cannot })).toMatch(/^I can't grant access: /);
    }
    // An acronym keeps its capitals.
    expect(unsupportedReply({ cannot: 'SSH into the prod box' })).toMatch(/^I can't SSH into the prod box: /);
  });

  it('never posts a mention, a ping or a link the model wrote', () => {
    expect(unsupportedReply({ cannot: 'add <@U123> to <!subteam^S1|@core-dev>', whoCan: 'an admin' })).toBe(
      UNSUPPORTED_GENERIC_REPLY,
    );
    expect(unsupportedReply({ cannot: 'open https://example.com/admin for you' })).toBe(UNSUPPORTED_GENERIC_REPLY);
    expect(unsupportedReply({ cannot: 'grant access', whoCan: 'an admin <!here>' })).not.toMatch(/[<>]|admin/);
  });

  it.each([
    ['bold', 'grant *admin* access'],
    ['italic', 'grant _admin_ access'],
    ['strikethrough', 'grant ~admin~ access'],
    ['code', 'run `pkill` for you'],
    ['www', 'log in to www.example for you'],
    ['a domain', 'reset passwords on example.com'],
    ['an Indian domain', 'update records on newtonschool.co'],
    ['an .app domain', 'open my.app for you'],
    ['a host name', 'restart admin.example.internal'],
  ])('posts no phrase with %s in it', (_kind, cannot) => {
    expect(unsupportedReply({ cannot })).toBe(UNSUPPORTED_GENERIC_REPLY);
    expect(unsupportedReply({ cannot: 'grant access', whoCan: cannot })).toBe(
      'I can\'t grant access: none of my tools reach that. Mention me with "help" to see what I can do here.',
    );
  });

  it('keeps a slash command and an ordinary full stop out of the domain check', () => {
    expect(unsupportedReply({ cannot: 'set a reminder', whoCan: "Slack's /remind" })).toContain(
      "Slack's /remind can help with that.",
    );
    expect(unsupportedReply({ cannot: 'set up Node.js on your laptop' })).toMatch(/^I can't set up Node.js on your/);
  });

  it.each(['n/a', 'N/A.', 'na', 'none', 'None.', 'null', 'unknown', 'no one', 'Noone', 'nobody', '-', '---', ' none '])(
    'treats %j as no value',
    placeholder => {
      expect(unsupportedReply({ cannot: 'send emails', whoCan: placeholder })).toBe(
        'I can\'t send emails: none of my tools reach that. Mention me with "help" to see what I can do here.',
      );
      expect(unsupportedReply({ cannot: placeholder })).toBe(UNSUPPORTED_GENERIC_REPLY);
    },
  );

  it('falls back to a plain line when there is no usable phrase', () => {
    expect(unsupportedReply({})).toBe(UNSUPPORTED_GENERIC_REPLY);
    expect(unsupportedReply({ cannot: '   ', whoCan: 'an admin' })).toBe(UNSUPPORTED_GENERIC_REPLY);
    expect(unsupportedReply({ cannot: "I can't" })).toBe(UNSUPPORTED_GENERIC_REPLY);
    // A paragraph is not a name for the action, and is not cut mid-word either.
    expect(unsupportedReply({ cannot: 'grant access '.repeat(20) })).toBe(UNSUPPORTED_GENERIC_REPLY);
  });

  it('drops an unusable "who can" and keeps the rest', () => {
    expect(unsupportedReply({ cannot: 'send emails', whoCan: '<@U123>' })).toBe(
      'I can\'t send emails: none of my tools reach that. Mention me with "help" to see what I can do here.',
    );
  });
});
