import type { WorkflowIntent, WorkflowResult } from '../../types/contracts.js';

/**
 * A cancelled run is its own terminal state (issue #438).
 *
 * Aborting a job kills its agent, and every workflow reads a dead agent as a
 * failure: it posts failure copy, the job is recorded FAILED over the
 * CANCELLED the canceller wrote, and the failure doctor diagnoses a "timeout".
 * These two helpers keep an abort from being reported as a failure.
 */

/** What a workflow returns when it notices the run was cancelled. Posts nothing. */
export function cancelledResult(workflow: WorkflowIntent): WorkflowResult {
  return { workflow, status: 'CANCELLED', message: 'Cancelled.', notifyDesktop: false, slackPosted: false };
}

/**
 * Applied to whatever the workflow returned. An aborted run that came back
 * FAILED is CANCELLED. Anything else is left alone: a run that finished
 * (SUCCESS), parked (PAUSED) or skipped before the abort landed did what it says.
 */
export function settleAbortedResult(result: WorkflowResult, aborted: boolean): WorkflowResult {
  if (!aborted || result.status !== 'FAILED') return result;
  // The workflow's failure text describes a dead agent, not what happened; it
  // must not become the job's message or the requester's memory of the run.
  return { ...result, status: 'CANCELLED', message: 'Cancelled before it finished.', notifyDesktop: false };
}
