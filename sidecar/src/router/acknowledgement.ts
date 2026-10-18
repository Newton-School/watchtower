import type { WorkflowIntent } from '../types/contracts.js';
import { formatElapsed } from '../slack/progressMessage.js';

/**
 * The first line a requester reads (issue #588).
 *
 * A lookup answers in a couple of minutes; a change run posts a plan after a
 * few and ships an hour later. Requesters could not tell which they were in,
 * and a request picked up 20 to 72 minutes late after the host slept got the
 * same reactions as a prompt one, so one requester had already asked a person
 * in the meantime. Now the run opens with what to expect, and says so when
 * it is late.
 */

/** A pickup later than this is said out loud. */
export const LATE_PICKUP_MS = 5 * 60_000;
/**
 * Beyond this the message time cannot be trusted (a clock off by years, a
 * fixture): the catch-up never replays anything older than a day.
 */
const PLAUSIBLE_DELAY_MAX_MS = 24 * 3_600_000;

/** How long after the message was sent the job started, or undefined when the message time is unusable. */
export function pickupDelayMs(eventTs: string | undefined, now = Date.now()): number | undefined {
  const sentAt = Number(eventTs) * 1000;
  if (!Number.isFinite(sentAt) || sentAt <= 0) return undefined;
  const delay = now - sentAt;
  if (delay < 0 || delay > PLAUSIBLE_DELAY_MAX_MS) return undefined;
  return delay;
}

/**
 * What to expect, by what is about to run. The figures are the typical run
 * over the last 30 days: lookups about two minutes, investigations about
 * five, a plan a few minutes in and the change under an hour after approval.
 * Reviews post their own opening line; a chat answers at once.
 */
const EXPECTATIONS: Partial<Record<WorkflowIntent, string>> = {
  INFORMATIONAL: 'On it. A lookup like this usually takes a couple of minutes.',
  INVESTIGATION: "On it. I'll look into it and report back, usually within about five minutes.",
  IMPLEMENTATION:
    "On it. I'll post a plan for approval in a few minutes; the change itself usually takes under an hour after that.",
  OWNER_AUTOPILOT:
    "On it. I'll post a plan for approval in a few minutes; the change itself usually takes under an hour after that.",
  WEBAPP_QA: 'On it. A browser check usually takes five to ten minutes.',
};

export function acknowledgementText(params: {
  intent: WorkflowIntent;
  pickupDelayMs?: number;
  /** A change request about an existing PR (merge, close) runs a quick action, not a plan. */
  aboutExistingPr?: boolean;
}): string | undefined {
  const late = params.pickupDelayMs !== undefined && params.pickupDelayMs > LATE_PICKUP_MS;
  const planIntent = params.intent === 'IMPLEMENTATION' || params.intent === 'OWNER_AUTOPILOT';
  const expectation = planIntent && params.aboutExistingPr ? undefined : EXPECTATIONS[params.intent];
  if (!late && !expectation) return undefined;
  const apology = late
    ? `Sorry, I was offline for a while and only just saw this, ${formatElapsed(params.pickupDelayMs as number)} after you sent it.`
    : '';
  return [apology, expectation].filter(Boolean).join(' ');
}
