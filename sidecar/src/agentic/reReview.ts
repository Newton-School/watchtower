import type { AgentFinding } from '../agents/types.js';
import { hasFileInDiff, isAnchorInDiff, type HunkIndex } from '../github/diffHunks.js';
import type { NormalizedPrReviewAgentOutput } from '../github/prReviewSupport.js';

/**
 * A second review of a PR is a follow-up on the first, not a second first
 * review (issue #451).
 *
 * An author wrote "review again, resolved and replied on the comments" and
 * got 20 comments after 13, 19 of them points that had not been raised the
 * first time, 18 of them low or info, most on code that had not changed.
 * Nothing said which of the 13 were now addressed.
 *
 * A follow-up does two things: it says what became of each earlier finding,
 * and it looks for new problems in the code that changed since. A new point
 * on code that has not changed is left out unless it is high or critical:
 * the author has had one pass on that code already.
 */

/** One finding from the earlier review, as stored. */
export interface EarlierFinding {
  severity: string;
  message: string;
  file?: string;
  line?: number;
}

/** How a lead reviewer marks an earlier finding it is raising again. */
const CARRIED_OVER_RE = /^\s*(?:\*\*)?(still open|regressed)\b/i;
/** How it records one that the new commits dealt with. */
const ADDRESSED_NOTE_RE = /^\s*addressed since last review\b/i;

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3),
  );

/** Share of the smaller message's words that the two have in common. */
function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * Whether a finding is one from the earlier review coming back. The reviewer
 * is asked to say so in its first words; a finding in the same file that says
 * much the same thing counts too, in case it did not.
 */
export function isCarriedOver(finding: AgentFinding, earlier: EarlierFinding[]): boolean {
  if (CARRIED_OVER_RE.test(finding.message)) return true;
  return earlier.some(prior => prior.file === finding.file && overlap(prior.message, finding.message) >= 0.6);
}

export interface FollowUpStats {
  /** Findings the earlier review reported. */
  earlierTotal: number;
  /** Of those, how many the reviewer recorded as dealt with. */
  addressed: number;
  /** Of those, how many are raised again. */
  stillOpen: number;
  /** New findings that are reported. */
  newFindings: number;
  /** New low/medium points on code unchanged since the earlier review, which are not reported. */
  leftOut: number;
}

export interface FollowUpResult {
  outputs: NormalizedPrReviewAgentOutput[];
  stats: FollowUpStats;
}

const isBlocking = (finding: AgentFinding): boolean => finding.severity === 'critical' || finding.severity === 'high';

/**
 * Applies the follow-up rule to a finished review.
 *
 * Kept: every finding carried over from the earlier review; every high or
 * critical finding; every finding anchored in code that changed since the
 * earlier review; and findings with no location, which have nowhere to be
 * judged against. Left out: the rest.
 *
 * `changedSince` is undefined when the diff since the earlier commit could
 * not be had. Nothing is left out then: an unscoped follow-up is noisier, a
 * wrongly scoped one hides findings.
 */
export function applyFollowUpScope(params: {
  outputs: NormalizedPrReviewAgentOutput[];
  earlier: EarlierFinding[];
  changedSince: HunkIndex | undefined;
}): FollowUpResult {
  const { earlier, changedSince } = params;
  let stillOpen = 0;
  let newFindings = 0;
  let leftOut = 0;

  const inScope = (finding: AgentFinding): boolean => {
    if (isCarriedOver(finding, earlier)) {
      stillOpen += 1;
      return true;
    }
    const keep =
      !changedSince ||
      isBlocking(finding) ||
      !finding.file ||
      (typeof finding.line === 'number'
        ? isAnchorInDiff(changedSince, finding.file, finding.line)
        : hasFileInDiff(changedSince, finding.file));
    if (keep) newFindings += 1;
    else leftOut += 1;
    return keep;
  };

  const outputs = params.outputs.map(output => {
    const kept = new Set(output.findings.filter(inScope));
    return {
      ...output,
      findings: output.findings.filter(finding => kept.has(finding)),
      attachableFindings: output.attachableFindings.filter(finding => kept.has(finding)),
      unattachableFindings: output.unattachableFindings.filter(finding => kept.has(finding)),
    };
  });

  // Only the lead reviewer is asked to account for the earlier findings, so
  // its notes are the count. It cannot exceed what is left after "still open".
  const notes = params.outputs
    .filter(output => output.role === 'reviewer')
    .flatMap(output => output.summaryNotes)
    .filter(note => ADDRESSED_NOTE_RE.test(note)).length;
  const addressed = Math.max(0, Math.min(notes, earlier.length - Math.min(stillOpen, earlier.length)));

  return { outputs, stats: { earlierTotal: earlier.length, addressed, stillOpen, newFindings, leftOut } };
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** What became of the earlier findings, in one line for the thread and the PR. */
export function formatFollowUpLine(stats: FollowUpStats, earlierSha: string): string {
  const { earlierTotal, addressed, stillOpen, newFindings, leftOut } = stats;
  const unaccounted = Math.max(0, earlierTotal - addressed - Math.min(stillOpen, earlierTotal));
  const earlierPart =
    earlierTotal === 0
      ? 'it had no findings'
      : `of its ${plural(earlierTotal, 'finding', 'findings')}, ${addressed} addressed, ${stillOpen} still open${unaccounted > 0 ? `, ${unaccounted} not re-assessed` : ''}`;
  const leftOutPart =
    leftOut > 0
      ? ` ${plural(leftOut, 'further low or medium point', 'further low or medium points')} on code unchanged since then ${leftOut === 1 ? 'was' : 'were'} left out.`
      : '';
  return `Follow-up on my review at ${earlierSha.slice(0, 7)}: ${earlierPart}; ${newFindings} new in the code changed since.${leftOutPart}`;
}
