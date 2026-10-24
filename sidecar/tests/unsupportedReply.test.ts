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
    for (const cannot of ["I can't grant access.", 'I cannot grant access', 'To grant access', 'Grant access!']) {
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
