import { describe, expect, it } from 'vitest';
import { acknowledgementText, pickupDelayMs } from '../src/router/acknowledgement.js';

describe('pickupDelayMs', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');

  it('reads the delay from a Slack ts, and gives up on times it cannot trust', () => {
    expect(pickupDelayMs(String((now - 90_000) / 1000), now)).toBe(90_000);
    expect(pickupDelayMs('111.22', now)).toBeUndefined();
    expect(pickupDelayMs(String((now - 2 * 24 * 3_600_000) / 1000), now)).toBeUndefined();
    expect(pickupDelayMs(String((now + 60_000) / 1000), now)).toBeUndefined();
    expect(pickupDelayMs(undefined, now)).toBeUndefined();
    expect(pickupDelayMs('not a ts', now)).toBeUndefined();
  });
});

describe('acknowledgementText', () => {
  it('says what to expect for the runs that take a while', () => {
    expect(acknowledgementText({ intent: 'INFORMATIONAL' })).toBe(
      'On it. A lookup like this usually takes a couple of minutes.',
    );
    expect(acknowledgementText({ intent: 'INVESTIGATION' })).toContain('about five minutes');
    expect(acknowledgementText({ intent: 'IMPLEMENTATION' })).toContain('post a plan for approval');
    expect(acknowledgementText({ intent: 'WEBAPP_QA' })).toContain('browser check');
  });

  it('says nothing for a chat, a review, a deploy, or a change about an existing PR', () => {
    expect(acknowledgementText({ intent: 'CONVERSATIONAL' })).toBeUndefined();
    expect(acknowledgementText({ intent: 'PR_REVIEW' })).toBeUndefined();
    expect(acknowledgementText({ intent: 'DEPLOY' })).toBeUndefined();
    expect(acknowledgementText({ intent: 'IMPLEMENTATION', aboutExistingPr: true })).toBeUndefined();
  });

  it('opens with an apology when the pickup was late, alone when nothing else is due', () => {
    expect(acknowledgementText({ intent: 'INFORMATIONAL', pickupDelayMs: 4 * 60_000 })).toBe(
      'On it. A lookup like this usually takes a couple of minutes.',
    );
    expect(acknowledgementText({ intent: 'INFORMATIONAL', pickupDelayMs: 42 * 60_000 })).toBe(
      'Sorry, I was offline for a while and only just saw this, 42 min after you sent it. On it. A lookup like this usually takes a couple of minutes.',
    );
    expect(acknowledgementText({ intent: 'PR_REVIEW', pickupDelayMs: 72 * 60_000 })).toBe(
      'Sorry, I was offline for a while and only just saw this, 1 h 12 min after you sent it.',
    );
  });
});
