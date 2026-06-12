import type { WorkflowIntent } from '../types/contracts.js';
import { extractPrContext } from './intentParser.js';

export interface PausedJobSummary {
  id: string;
  workflow: WorkflowIntent;
}

/**
 * Why the paused job is sitting there. Set by the caller from job_logs
 * because jobs.workflow is too coarse — owner-mention work lands in the
 * column as OWNER_AUTOPILOT even when the classifier later routes it to
 * PR_REVIEW, so the column alone can't tell us what kind of follow-up to
 * accept as a resume signal.
 */
export type PauseSignal = 'pr_review_awaiting_url' | 'pr_review_target_choice' | 'usage_limit_retry' | undefined;

/** Replies that resume a job paused on a Claude usage limit (issue #342). */
const USAGE_LIMIT_RESUME_RE = /\b(resume|retry|continue|go|try again)\b/i;

/**
 * Selector vocabulary accepted as a target-choice reply — mirrors the
 * qualifiers resolvePrReviewTargets understands ("both"/"all", repo names,
 * "#123"), so whatever resumes the job will also resolve to targets.
 */
const TARGET_CHOICE_RE = /\b(both|all|frontend|front-end|web|newton-web|backend|back-end|api|newton-api)\b|#\d{2,}\b/i;

export interface PausedResumeDecision {
  resume: boolean;
  reason: string;
  paused?: PausedJobSummary;
  /**
   * When set, the caller should force this intent on the synthesized task.
   * Target-choice replies ("both", "web", "#123") carry no review verb or
   * URL, so neither the deterministic gate nor the AI classifier can be
   * trusted to route them back to PR_REVIEW.
   */
  forceIntent?: WorkflowIntent;
}

/**
 * Decide whether a follow-up Slack reply in a paused-job's thread should be
 * treated as a resume signal — bypassing the @miniOG mention requirement that
 * processEvent normally enforces.
 *
 * A paused workflow that explicitly asked the user to reply in-thread (e.g.
 * PR_REVIEW asking for a missing PR URL) needs to be able to pick up that
 * reply even though the user didn't re-tag the bot. Without this, the
 * mention-detect gate silently drops the reply, leaving the user staring at
 * the bot's "drop the URL in this thread" prompt forever.
 *
 * Resume only fires when the reply carries the input the paused workflow
 * actually asked for — otherwise small talk in a paused thread would
 * spuriously resurrect the workflow.
 */
export function decidePausedResume(params: {
  pausedJob: PausedJobSummary | undefined;
  pauseSignal: PauseSignal;
  eventText: string;
}): PausedResumeDecision {
  const { pausedJob, pauseSignal, eventText } = params;

  if (!pausedJob) {
    return { resume: false, reason: 'no_paused_job' };
  }

  if (pauseSignal === 'pr_review_awaiting_url') {
    if (extractPrContext([eventText])) {
      return { resume: true, reason: 'pr_review_url_reply', paused: pausedJob };
    }
    return { resume: false, reason: 'pr_review_no_url_in_reply' };
  }

  if (pauseSignal === 'usage_limit_retry') {
    if (USAGE_LIMIT_RESUME_RE.test(eventText)) {
      return { resume: true, reason: 'usage_limit_retry_reply', paused: pausedJob };
    }
    return { resume: false, reason: 'usage_limit_no_resume_keyword' };
  }

  if (pauseSignal === 'pr_review_target_choice') {
    if (extractPrContext([eventText]) || TARGET_CHOICE_RE.test(eventText)) {
      return {
        resume: true,
        reason: 'pr_review_target_choice_reply',
        paused: pausedJob,
        forceIntent: 'PR_REVIEW',
      };
    }
    return { resume: false, reason: 'pr_review_no_target_in_reply' };
  }

  return { resume: false, reason: `unhandled_pause_signal:${pauseSignal ?? 'unknown'}` };
}
