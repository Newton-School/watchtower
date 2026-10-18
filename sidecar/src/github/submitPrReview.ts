import type { AgentFinding } from '../agents/types.js';
import { logger } from '../logging/logger.js';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { hasFileInDiff, isAnchorInDiff, parseDiffHunks, type HunkIndex } from './diffHunks.js';

const TRANSIENT_RETRY_DELAY_MS = 1500;
const ERROR_BODY_LOG_LIMIT = 1000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncateErrorBody(body: string): string {
  if (body.length <= ERROR_BODY_LOG_LIMIT) return body;
  return `${body.slice(0, ERROR_BODY_LOG_LIMIT)}…[truncated ${body.length - ERROR_BODY_LOG_LIMIT} chars]`;
}

function logGithubRejection(
  logStep: WorkflowStepLogger | undefined,
  attempt: string,
  status: number,
  errorBody: string,
  context: { owner: string; repo: string; pullNumber: number },
): void {
  const truncated = truncateErrorBody(errorBody);
  logger.warn({ status, errorBody: truncated, attempt, ...context }, 'GitHub PR review submission rejected');
  logStep?.({
    level: 'WARN',
    stage: 'pr_review.github_review.rejected',
    message: `GitHub rejected ${attempt} (HTTP ${status}).`,
    data: { attempt, status, errorBody: truncated, ...context },
  });
}

function logGithubThrew(
  logStep: WorkflowStepLogger | undefined,
  attempt: string,
  error: unknown,
  context: { owner: string; repo: string; pullNumber: number },
): void {
  const message = String(error);
  logger.warn({ error: message, attempt, ...context }, 'GitHub PR review submission threw');
  logStep?.({
    level: 'WARN',
    stage: 'pr_review.github_review.threw',
    message: `GitHub PR review submission threw on ${attempt}: ${message}`,
    data: { attempt, error: message, ...context },
  });
}

/**
 * How long a call to GitHub may take. The review POST used to be a bare
 * `fetch`: when a response was lost it waited out the runtime's default, five
 * minutes, with the review already on the PR (issue #449).
 */
export const __reviewHttp = { postTimeoutMs: 30_000, readTimeoutMs: 15_000 };

function githubHeaders(githubToken: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'Content-Type': 'application/json',
  };
}

async function postReviewOnce(url: string, githubToken: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: githubHeaders(githubToken),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(__reviewHttp.postTimeoutMs),
  });
}

async function githubGet(url: string, githubToken: string): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: githubHeaders(githubToken),
    signal: AbortSignal.timeout(__reviewHttp.readTimeoutMs),
  });
}

/** A failed call in words for a person: "timed out after 30s", "HTTP 502", "network error (fetch failed)". */
function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `timed out after ${Math.round(__reviewHttp.postTimeoutMs / 1000)}s`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `network error (${message})`;
}

const normalizeBody = (text: unknown): string => (typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '');

/** A review's clock may differ from ours; anything submitted this long before the attempt is not it. */
const LANDED_CLOCK_SKEW_MS = 120_000;

type LandedCheck = { found: true; reviewId: number; commentsPosted: number } | { found: false } | { found: 'unknown' };

/**
 * Asks GitHub whether the review we just tried to post is on the PR.
 *
 * A timeout, a dropped connection or a 5xx says nothing about whether the
 * POST was applied: the review that was reported as "skipped" had been on the
 * PR for five minutes, with 16 inline comments. It is recognised by what we
 * sent: the same commit, the same body, submitted since the attempt began.
 * `unknown` means the question itself could not be answered, and the caller
 * must not retry on that: a blind retry posts the review twice.
 */
async function findLandedReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  summary: string;
  githubToken: string;
  attemptStartedAtMs: number;
}): Promise<LandedCheck> {
  const { owner, repo, pullNumber, commitId, summary, githubToken, attemptStartedAtMs } = params;
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  try {
    const reviews: Array<Record<string, unknown>> = [];
    const first = await githubGet(`${base}?per_page=100`, githubToken);
    if (!first.ok) return { found: 'unknown' };
    const firstPage: unknown = await first.json();
    if (!Array.isArray(firstPage)) return { found: 'unknown' };
    reviews.push(...(firstPage as Array<Record<string, unknown>>));
    // Reviews are listed oldest first: on a long-lived PR ours is on the last page.
    const lastPage = /<([^>]+)>;\s*rel="last"/.exec(first.headers.get('link') ?? '')?.[1];
    if (lastPage) {
      const last = await githubGet(lastPage, githubToken);
      if (!last.ok) return { found: 'unknown' };
      const lastItems: unknown = await last.json();
      if (!Array.isArray(lastItems)) return { found: 'unknown' };
      reviews.push(...(lastItems as Array<Record<string, unknown>>));
    }

    const wanted = normalizeBody(summary);
    const ours = reviews
      .filter(review => {
        const submittedAt = Date.parse(String(review.submitted_at ?? ''));
        return (
          review.commit_id === commitId &&
          normalizeBody(review.body) === wanted &&
          Number.isFinite(submittedAt) &&
          submittedAt >= attemptStartedAtMs - LANDED_CLOCK_SKEW_MS
        );
      })
      .pop();
    if (!ours || typeof ours.id !== 'number') return { found: false };

    // How many of the inline comments it carries. A failure here does not
    // un-land the review; it only leaves the count unknown.
    let commentsPosted = 0;
    try {
      const comments = await githubGet(`${base}/${ours.id}/comments?per_page=100`, githubToken);
      const items: unknown = comments.ok ? await comments.json() : [];
      commentsPosted = Array.isArray(items) ? items.length : 0;
    } catch {
      commentsPosted = 0;
    }
    return { found: true, reviewId: ours.id, commentsPosted };
  } catch {
    return { found: 'unknown' };
  }
}

interface PrReviewComment {
  path: string;
  line: number;
  body: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
/** `comment`: GitHub would not take a review, so the findings went in as a PR comment (issue #590). */
export type PrReviewSubmissionMode = 'inline' | 'summary_only' | 'comment' | 'skipped';
export type PrReviewFallbackReason = 'missing_location' | 'github_rejected_comments' | 'no_token' | 'pending_review';

/** GitHub's 422 when the account already has an unsubmitted (PENDING) review on the PR. */
const PENDING_REVIEW_RE = /one pending review per pull request/i;

/** GitHub's own reason for refusing a request: the first entry of `errors`, else `message`. */
export function githubRefusalReason(errorBody: string): string {
  try {
    const parsed = JSON.parse(errorBody) as { message?: unknown; errors?: unknown };
    const first = Array.isArray(parsed.errors) ? parsed.errors[0] : undefined;
    const fromErrors =
      typeof first === 'string'
        ? first
        : first && typeof first === 'object' && typeof (first as { message?: unknown }).message === 'string'
          ? (first as { message: string }).message
          : '';
    return fromErrors || (typeof parsed.message === 'string' ? parsed.message : '') || 'no reason given';
  } catch {
    return errorBody.slice(0, 160) || 'no reason given';
  }
}

export interface SubmitPrReviewResult {
  submitted: boolean;
  event: ReviewEvent;
  /** Inline comments we attempted to post in the batched review body. */
  attemptedComments: number;
  /** Inline comments GitHub actually accepted. */
  commentsPosted: number;
  /**
   * Findings that had a file+line but the line wasn't inside a diff hunk;
   * they were filtered out before the review POST so we don't trip GitHub's
   * all-or-nothing validation.
   */
  droppedOutsideDiff: number;
  /** File-level follow-up POSTs attempted after the review submission. */
  fileLevelAttempted: number;
  /** File-level follow-ups GitHub accepted. */
  fileLevelPosted: number;
  submissionMode: PrReviewSubmissionMode;
  fallbackReason?: PrReviewFallbackReason;
  /**
   * When nothing was posted because the call to GitHub failed: why, in words
   * for the thread ("timed out after 30s", "HTTP 502"). Absent when GitHub
   * refused the review or there was nothing to send it with.
   */
  failureReason?: string;
  /**
   * The POST failed and GitHub could not be asked whether the review exists.
   * It may be on the PR. Nothing was retried, so that it cannot be there twice.
   */
  unconfirmed?: boolean;
}

function determineReviewEvent(findings: AgentFinding[]): ReviewEvent {
  if (findings.length > 0) return 'COMMENT';
  return 'APPROVE';
}

function buildCommentBody(f: AgentFinding, role: string): string {
  const tag = `**[${role.toUpperCase()} — ${f.severity.toUpperCase()}]**`;
  const suggestion = f.suggestion ? `\n\n> 💡 **Suggestion:** ${f.suggestion}` : '';
  return `${tag} ${f.message}${suggestion}`;
}

interface FileLevelFinding {
  path: string;
  body: string;
}

/**
 * Split findings into inline candidates, file-level candidates, and drops.
 * When `hunkIndex` is provided, an inline candidate is only kept if its
 * (file, line) is inside a diff hunk; otherwise GitHub will 422 the whole
 * review batch. File-level candidates are kept when the file itself appears
 * in the diff (even if no specific line is given).
 */
function classifyFindings(
  findingsByRole: Array<{ role: string; findings: AgentFinding[] }>,
  hunkIndex: HunkIndex | undefined,
): {
  inlineComments: PrReviewComment[];
  fileLevelFindings: FileLevelFinding[];
  droppedOutsideDiff: number;
} {
  const inlineComments: PrReviewComment[] = [];
  const fileLevelFindings: FileLevelFinding[] = [];
  let droppedOutsideDiff = 0;

  for (const { role, findings } of findingsByRole) {
    for (const f of findings) {
      const hasLine = typeof f.line === 'number' && f.line > 0;
      if (!f.file) continue;

      if (hasLine) {
        if (!hunkIndex || isAnchorInDiff(hunkIndex, f.file, f.line as number)) {
          inlineComments.push({
            path: f.file,
            line: f.line as number,
            body: buildCommentBody(f, role),
          });
        } else {
          droppedOutsideDiff++;
        }
        continue;
      }

      // File-only finding. Only post as a file-level comment if the file
      // itself is in the diff — otherwise there's nothing to anchor to.
      if (!hunkIndex || hasFileInDiff(hunkIndex, f.file)) {
        fileLevelFindings.push({
          path: f.file,
          body: buildCommentBody(f, role),
        });
      }
    }
  }

  return { inlineComments, fileLevelFindings, droppedOutsideDiff };
}

async function postFileLevelComments(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  findings: FileLevelFinding[];
  githubToken: string;
}): Promise<{ attempted: number; posted: number }> {
  const { owner, repo, pullNumber, commitId, findings, githubToken } = params;
  if (findings.length === 0) return { attempted: 0, posted: 0 };

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments`;
  let posted = 0;

  for (const f of findings) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: githubHeaders(githubToken),
        body: JSON.stringify({
          commit_id: commitId,
          path: f.path,
          body: f.body,
          subject_type: 'file',
        }),
        signal: AbortSignal.timeout(__reviewHttp.postTimeoutMs),
      });
      if (response.ok) {
        posted++;
      } else {
        const errorBody = await response.text().catch(() => '');
        logger.warn(
          { status: response.status, errorBody, owner, repo, pullNumber, path: f.path },
          'File-level PR comment rejected by GitHub',
        );
      }
    } catch (err) {
      logger.warn(
        { error: String(err), owner, repo, pullNumber, path: f.path },
        'File-level PR comment threw during submission',
      );
    }
  }

  return { attempted: findings.length, posted };
}

export async function submitPrReview(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  findingsByRole: Array<{ role: string; findings: AgentFinding[] }>;
  summary: string;
  githubToken?: string;
  /**
   * Raw unified-diff text for the PR as returned by GitHub's .diff endpoint.
   * When present, inline comment candidates are validated against hunk
   * ranges so we never hand GitHub a batch it'll reject wholesale, and
   * file-only findings are posted as `subject_type: 'file'` follow-ups.
   */
  prDiff?: string;
  /**
   * Findings that are written into `summary` instead of being passed here
   * (issue #441). They still make this a review with findings: without the
   * count, a PR whose findings were all low would be submitted as APPROVE.
   */
  findingsInBody?: number;
  /**
   * Optional workflow step logger. When provided, GitHub rejection details
   * (HTTP status + truncated error body) are persisted to job_logs so
   * post-mortems can read the exact reason out of SQLite instead of
   * grepping process stdout.
   */
  logStep?: WorkflowStepLogger;
}): Promise<SubmitPrReviewResult> {
  const { owner, repo, pullNumber, commitId, findingsByRole, summary, githubToken, prDiff, logStep } = params;
  const errorContext = { owner, repo, pullNumber };

  const allFindings = findingsByRole.flatMap(r => r.findings);
  const event: ReviewEvent =
    allFindings.length + (params.findingsInBody ?? 0) > 0 ? 'COMMENT' : determineReviewEvent(allFindings);
  const hunkIndex = prDiff ? parseDiffHunks(prDiff) : undefined;

  const { inlineComments, fileLevelFindings, droppedOutsideDiff } = classifyFindings(findingsByRole, hunkIndex);
  const attemptedComments = inlineComments.length;
  const missingLocationFallback =
    allFindings.length > 0 && attemptedComments === 0 && fileLevelFindings.length === 0
      ? 'missing_location'
      : undefined;

  if (!githubToken) {
    logger.warn('No GitHub token available — skipping PR review submission');
    return {
      submitted: false,
      event,
      attemptedComments,
      commentsPosted: 0,
      droppedOutsideDiff,
      fileLevelAttempted: fileLevelFindings.length,
      fileLevelPosted: 0,
      submissionMode: 'skipped',
      fallbackReason: 'no_token',
    };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  const fullPayload = { commit_id: commitId, event, body: summary, comments: inlineComments };
  const bodyOnlyPayload = { commit_id: commitId, event, body: summary, comments: [] };

  /**
   * One POST, and what it left behind. A deterministic refusal (4xx) created
   * nothing. A timeout, a dropped connection or a 5xx may have: GitHub is
   * asked before anything is retried or reported (issue #449).
   */
  type PostAttempt =
    | { kind: 'accepted' }
    | { kind: 'landed'; commentsPosted: number }
    | { kind: 'rejected'; githubReason: string }
    | { kind: 'not_landed'; reason: string }
    | { kind: 'unknown'; reason: string };

  const attemptPost = async (payload: unknown, labels: { rejected: string; threw: string }): Promise<PostAttempt> => {
    const attemptStartedAtMs = Date.now();
    let response: Response | undefined;
    let reason: string;
    try {
      response = await postReviewOnce(url, githubToken, payload);
      if (response.ok) return { kind: 'accepted' };
      const errorBody = await response.text().catch(() => '');
      logGithubRejection(logStep, labels.rejected, response.status, errorBody, errorContext);
      // Rate limited: refused before anything was processed.
      if (response.status === 429) return { kind: 'not_landed', reason: 'rate limited (HTTP 429)' };
      if (response.status < 500) return { kind: 'rejected', githubReason: githubRefusalReason(errorBody) };
      reason = `HTTP ${response.status}`;
    } catch (error) {
      logGithubThrew(logStep, labels.threw, error, errorContext);
      reason = describeFailure(error);
    }

    const landed = await findLandedReview({
      owner,
      repo,
      pullNumber,
      commitId,
      summary,
      githubToken,
      attemptStartedAtMs,
    });
    if (landed.found === true) {
      logStep?.({
        level: 'WARN',
        stage: 'pr_review.github_review.landed_after_error',
        message: `The review POST failed here (${reason}) but the review is on the PR, with ${landed.commentsPosted} inline comment(s).`,
        data: { reason, reviewId: landed.reviewId, commentsPosted: landed.commentsPosted, ...errorContext },
      });
      return { kind: 'landed', commentsPosted: landed.commentsPosted };
    }
    if (landed.found === 'unknown') {
      logStep?.({
        level: 'WARN',
        stage: 'pr_review.github_review.unconfirmed',
        message: `The review POST failed (${reason}) and GitHub could not be asked whether it landed — not retrying, so it cannot be posted twice.`,
        data: { reason, ...errorContext },
      });
      return { kind: 'unknown', reason };
    }
    return { kind: 'not_landed', reason };
  };

  /** A POST that failed and is confirmed absent is tried once more. Nothing else is. */
  const postWithOneRetry = async (
    payload: unknown,
    labels: { rejected: string; threw: string },
  ): Promise<PostAttempt> => {
    const first = await attemptPost(payload, labels);
    if (first.kind !== 'not_landed') return first;
    await delay(TRANSIENT_RETRY_DELAY_MS);
    return attemptPost(payload, { rejected: `${labels.rejected} (retry)`, threw: `${labels.threw} (retry)` });
  };

  const notPosted = (attempt: PostAttempt, fallbackReason?: PrReviewFallbackReason): SubmitPrReviewResult => ({
    submitted: false,
    event,
    attemptedComments,
    commentsPosted: 0,
    droppedOutsideDiff,
    fileLevelAttempted: fileLevelFindings.length,
    fileLevelPosted: 0,
    submissionMode: 'skipped',
    fallbackReason,
    ...(attempt.kind === 'not_landed' || attempt.kind === 'unknown' ? { failureReason: attempt.reason } : {}),
    // A refusal says why: it used to leave the thread with no reason at all (issue #590).
    ...(attempt.kind === 'rejected' ? { failureReason: `GitHub refused it: ${attempt.githubReason}` } : {}),
    ...(attempt.kind === 'unknown' ? { unconfirmed: true } : {}),
  });

  const posted = async (
    commentsPosted: number,
    mode: PrReviewSubmissionMode,
    fallbackReason?: PrReviewFallbackReason,
  ): Promise<SubmitPrReviewResult> => {
    const fileLevel = await postFileLevelComments({
      owner,
      repo,
      pullNumber,
      commitId,
      findings: fileLevelFindings,
      githubToken,
    });
    return {
      submitted: true,
      event,
      attemptedComments,
      commentsPosted,
      droppedOutsideDiff,
      fileLevelAttempted: fileLevel.attempted,
      fileLevelPosted: fileLevel.posted,
      submissionMode: mode,
      fallbackReason,
    };
  };

  /**
   * GitHub allows one pending review per person per PR. miniOG reviews as the
   * owner's account, so an unsubmitted draft of theirs blocks every review,
   * however often it is retried. The findings go in as a PR comment instead,
   * and the thread is told how to clear the draft (issue #590).
   */
  const postAsComment = async (): Promise<SubmitPrReviewResult> => {
    const inlineList =
      inlineComments.length > 0
        ? `\n\n**Inline findings** (posted here, not on the lines):\n${inlineComments
            .map(
              comment =>
                `- \`${comment.path}:${comment.line}\` ${comment.body.split('\n').find(line => line.trim()) ?? ''}`,
            )
            .join('\n')}`
        : '';
    const body = `_This review is a comment because GitHub would not take a review: this account has an unsubmitted pending review on the PR._\n\n${summary}${inlineList}`;
    try {
      const response = await postReviewOnce(
        `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`,
        githubToken,
        { body },
      );
      if (response.ok) {
        logStep?.({
          level: 'WARN',
          stage: 'pr_review.github_review.posted_as_comment',
          message:
            'GitHub refused the review (a pending review from this account is open on the PR); posted the findings as a PR comment.',
          data: errorContext,
        });
        return {
          submitted: true,
          event,
          attemptedComments,
          commentsPosted: 0,
          droppedOutsideDiff,
          fileLevelAttempted: fileLevelFindings.length,
          fileLevelPosted: 0,
          submissionMode: 'comment',
          fallbackReason: 'pending_review',
        };
      }
      return notPosted({
        kind: 'not_landed',
        reason: `GitHub refused the review because this account has a pending review open on the PR, and posting it as a comment failed too (HTTP ${response.status})`,
      });
    } catch (error) {
      return notPosted({
        kind: 'not_landed',
        reason: `GitHub refused the review because this account has a pending review open on the PR, and posting it as a comment failed too (${describeFailure(error)})`,
      });
    }
  };

  const full = await postWithOneRetry(fullPayload, {
    rejected: 'review POST with inline comments',
    threw: 'review POST',
  });
  if (full.kind === 'accepted' || full.kind === 'landed') {
    const commentsPosted = full.kind === 'accepted' ? inlineComments.length : full.commentsPosted;
    return posted(commentsPosted, commentsPosted > 0 ? 'inline' : 'summary_only', missingLocationFallback);
  }
  if (full.kind !== 'rejected') {
    return notPosted(full, missingLocationFallback);
  }
  // A pending review blocks the body-only retry just the same.
  if (PENDING_REVIEW_RE.test(full.githubReason)) {
    return postAsComment();
  }

  // GitHub refused the batch, which it does whole when one comment's anchor is
  // bad. Last resort: drop the inline comments and post the body alone. This
  // only kicks in when pre-validation wasn't enough (e.g. diff drift because a
  // new commit landed between the agents running and this POST).
  if (inlineComments.length === 0) {
    return notPosted(full, missingLocationFallback);
  }
  const bodyOnly = await postWithOneRetry(bodyOnlyPayload, {
    rejected: 'body-only retry',
    threw: 'body-only review POST',
  });
  if (bodyOnly.kind === 'accepted' || bodyOnly.kind === 'landed') {
    return posted(0, 'summary_only', 'github_rejected_comments');
  }
  if (bodyOnly.kind === 'rejected' && PENDING_REVIEW_RE.test(bodyOnly.githubReason)) {
    return postAsComment();
  }
  return notPosted(bodyOnly, 'github_rejected_comments');
}
