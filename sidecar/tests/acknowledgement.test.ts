import { describe, expect, it } from 'vitest';
import { acknowledgementText, pickupDelayMs } from '../src/router/acknowledgement.js';

describe('pickupDelayMs', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');

  it('reads the delay from a Slack ts, and gives up on times it cannot trust', () => {
    expect(pickupDelayMs(String((now - 90_000) / 1000), now)).toBe(90_000);
    expect(pickupDelayMs('111.22', now)).toBeUndefined();
    expect(pickupDelayMs(String((now - 2 * 24 * 3_600_000) / 1000), now)).toBeUndefined();
    expect(pickupDelayMs(String((now + 5 * 60_000) / 1000), now)).toBeUndefined();
    expect(pickupDelayMs(undefined, now)).toBeUndefined();
    expect(pickupDelayMs('not a ts', now)).toBeUndefined();
  });

  it('reads a host clock slightly behind Slack as a prompt pickup, not an unreadable one', () => {
    expect(pickupDelayMs(String((now + 400) / 1000), now)).toBe(0);
  });

  it('still reads the oldest mention the catch-up can replay', () => {
    expect(pickupDelayMs(String((now - 24 * 3_600_000 - 10_000) / 1000), now)).toBe(24 * 3_600_000 + 10_000);
  });
});

describe('acknowledgementText', () => {
  it('says what to expect for the runs that take a while, from the tool registry', () => {
    expect(acknowledgementText({ intent: 'INFORMATIONAL' })).toBe(
      'On it. A lookup like this usually takes a couple of minutes.',
    );
    expect(acknowledgementText({ intent: 'IMPLEMENTATION' })).toContain('post a plan for approval');
    expect(acknowledgementText({ intent: 'OWNER_AUTOPILOT' })).toContain('post a plan for approval');
    expect(acknowledgementText({ intent: 'WEBAPP_QA' })).toContain('browser check');
  });

  it('says nothing for a chat, a review, an investigation, a deploy, or a change about a PR in the message', () => {
    expect(acknowledgementText({ intent: 'CONVERSATIONAL' })).toBeUndefined();
    expect(acknowledgementText({ intent: 'PR_REVIEW' })).toBeUndefined();
    // The investigation opens with its own scope line.
    expect(acknowledgementText({ intent: 'INVESTIGATION' })).toBeUndefined();
    expect(acknowledgementText({ intent: 'DEPLOY' })).toBeUndefined();
    expect(acknowledgementText({ intent: 'IMPLEMENTATION', aboutExistingPr: true })).toBeUndefined();
  });

  it('opens with an apology when the pickup was late, alone when nothing else is due', () => {
    expect(acknowledgementText({ intent: 'INFORMATIONAL', pickupDelayMs: 4 * 60_000 })).toBe(
      'On it. A lookup like this usually takes a couple of minutes.',
    );
    expect(acknowledgementText({ intent: 'INFORMATIONAL', pickupDelayMs: 42 * 60_000 })).toBe(
      "Sorry for the wait: I'm only picking this up 42 min after you sent it. On it. A lookup like this usually takes a couple of minutes.",
    );
    expect(acknowledgementText({ intent: 'PR_REVIEW', pickupDelayMs: 72 * 60_000 })).toBe(
      "Sorry for the wait: I'm only picking this up 1 h 12 min after you sent it.",
    );
  });

  it('does not apologise for a replayed event: a desktop retrigger or a restart re-run', () => {
    expect(acknowledgementText({ intent: 'PR_REVIEW', pickupDelayMs: 3 * 3_600_000, replayed: true })).toBeUndefined();
    expect(acknowledgementText({ intent: 'INFORMATIONAL', pickupDelayMs: 3 * 3_600_000, replayed: true })).toBe(
      'On it. A lookup like this usually takes a couple of minutes.',
    );
  });
});
