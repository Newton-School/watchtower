import type { WorkflowIntent } from '../types/contracts.js';
import { formatElapsed } from '../slack/progressMessage.js';
import { toolForIntent } from './toolRegistry.js';

/**
 * The first line a requester reads (issue #588).
 *
 * A lookup answers in a couple of minutes; a change run posts a plan after a
 * few and ships an hour later. Requesters could not tell which they were in,
 * and a request picked up 20 to 72 minutes late after the host slept got the
 * same reactions as a prompt one, so one requester had already asked a person
 * in the meantime. Now the run opens with what to expect, and says so when
 * it is late. Each tool's expectation lives on its registry entry.
 */

/** A pickup later than this is said out loud. */
export const LATE_PICKUP_MS = 5 * 60_000;
/**
 * Beyond this the message time cannot be trusted (a clock off by years, a
 * fixture). The catch-up replays up to a day back, and the delay is measured
 * after its scan and the queue, so the cap sits above the lookback.
 */
const PLAUSIBLE_DELAY_MAX_MS = 26 * 3_600_000;
/** A host clock slightly behind Slack's makes a prompt pickup look negative: read as zero. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** How long after the message was sent the job started, or undefined when the message time is unusable. */
export function pickupDelayMs(eventTs: string | undefined, now = Date.now()): number | undefined {
  const sentAt = Number(eventTs) * 1000;
  if (!Number.isFinite(sentAt) || sentAt <= 0) return undefined;
  const delay = now - sentAt;
  if (delay < -CLOCK_SKEW_TOLERANCE_MS || delay > PLAUSIBLE_DELAY_MAX_MS) return undefined;
  return Math.max(0, delay);
}

export function acknowledgementText(params: {
  intent: WorkflowIntent;
  pickupDelayMs?: number;
  /** A change request about a PR named in the message (merge, close) runs a quick action, not a plan. */
  aboutExistingPr?: boolean;
  /**
   * The event did not come from the person's message just now: a desktop
   * retrigger reuses the thread's root time, a restart re-run its original
   * time. Neither is a late pickup to apologise for.
   */
  replayed?: boolean;
}): string | undefined {
  const late = !params.replayed && params.pickupDelayMs !== undefined && params.pickupDelayMs > LATE_PICKUP_MS;
  const planIntent = params.intent === 'IMPLEMENTATION' || params.intent === 'OWNER_AUTOPILOT';
  const expectation = planIntent && params.aboutExistingPr ? undefined : toolForIntent(params.intent)?.expectation;
  if (!late && !expectation) return undefined;
  // "Late", not "offline": the time may have gone to a dead socket, a sleeping
  // host, or a queue behind other runs. The log row has the number either way.
  const apology = late
    ? `Sorry for the wait: I'm only picking this up ${formatElapsed(params.pickupDelayMs as number)} after you sent it.`
    : '';
  return [apology, expectation].filter(Boolean).join(' ');
}
