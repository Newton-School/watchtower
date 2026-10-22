import type { SlackEventEnvelope } from '../../types/contracts.js';

/**
 * The person a run is for: who miniOG asks, waits on and lets stop it at its
 * gates. A run the owner started for someone else from the app (a re-run, an
 * answer that picks a paused run up again, a Launchpad retrigger) is still
 * theirs; permissions stay with `event.userId`, the owner (issue #343).
 */
export function requesterOf(task: { event: Pick<SlackEventEnvelope, 'userId' | 'requestedForUserId'> }): string {
  return task.event.requestedForUserId ?? task.event.userId;
}
