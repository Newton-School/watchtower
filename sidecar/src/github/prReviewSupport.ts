import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig, CodexRunResult, PrContext, WorkflowStepLogger } from '../types/contracts.js';
import type { AgentFinding } from '../agents/types.js';
import type { ReviewEvent, SubmitPrReviewResult } from './submitPrReview.js';

const execFileAsync = promisify(execFile);

export const SUPPORTED_PR_REPOS = ['newton-web', 'newton-api'] as const;
const FINDING_SEVERITIES = new Set<AgentFinding['severity']>(['critical', 'high', 'medium', 'low', 'info']);

export type PrReviewRole = 'reviewer' | 'security' | 'performance';
export const PR_REVIEW_ROLES: readonly PrReviewRole[] = ['reviewer', 'security', 'performance'];
export type AttachablePrReviewFinding = AgentFinding & { file: string; line: number };

export interface NormalizedPrReviewAgentOutput {
  role: PrReviewRole;
  findings: AgentFinding[];
  attachableFindings: AttachablePrReviewFinding[];
  unattachableFindings: AgentFinding[];
  summaryNotes: string[];
  invalidFindings: number;
}

export function mapRepoPath(config: AppConfig, pr: PrContext): string | null {
  if (pr.repo === 'newton-web') {
    return config.repoPaths.newtonWeb;
  }
  if (pr.repo === 'newton-api') {
    return config.repoPaths.newtonApi;
  }
  return null;
}

export async function fetchPrHeadSha(params: {
  prContext: PrContext;
  githubToken?: string;
  logStep?: WorkflowStepLogger;
}): Promise<string | undefined> {
  const { prContext, githubToken, logStep } = params;
  const url = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      logStep?.({
        stage: 'pr_review.head_sha.fetch_failed',
        message: 'Failed to fetch PR head SHA from GitHub API.',
        level: 'WARN',
        data: {
          status: response.status,
          statusText: response.statusText,
        },
      });
      return undefined;
    }

    const payload = (await response.json()) as {
      head?: {
        sha?: unknown;
      };
    };

    return typeof payload.head?.sha === 'string' ? payload.head.sha : undefined;
  } catch (error) {
    logStep?.({
      stage: 'pr_review.head_sha.fetch_error',
      message: 'Error while fetching PR head SHA from GitHub API.',
      level: 'WARN',
      data: {
        error: String(error),
      },
    });
    return undefined;
  }
}

export interface PrMetadata {
  headSha?: string;
  headRef?: string;
  title?: string;
  body?: string;
}

export async function fetchPrMetadata(params: {
  prContext: PrContext;
  githubToken?: string;
  logStep?: WorkflowStepLogger;
}): Promise<PrMetadata> {
  const { prContext, githubToken, logStep } = params;
  const url = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return {};
    const payload = (await response.json()) as Record<string, unknown>;
    const head = payload.head as Record<string, unknown> | undefined;
    return {
      headSha: typeof head?.sha === 'string' ? head.sha : undefined,
      headRef: typeof head?.ref === 'string' ? head.ref : undefined,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      body: typeof payload.body === 'string' ? payload.body : undefined,
    };
  } catch (error) {
    logStep?.({
      stage: 'pr_review.metadata.error',
      message: `Failed to fetch PR metadata: ${String(error)}`,
      level: 'WARN',
    });
    return {};
  }
}

/**
 * Reason a PR diff fetch returned short/empty content. Carried back to the
 * caller so the user-facing failure message can be specific.
 */
type DiffFetchReason = 'ok' | 'too_large' | 'fetch_failed' | 'empty';

export interface PrDiffResult {
  diff: string;
  /** Whether the returned diff was truncated to fit the char budget. */
  truncated: boolean;
  /** Total file count when known (only the files-endpoint fallback knows this). */
  totalFiles?: number;
  /** Reason explaining `diff === ''` or partial content. 'ok' = full diff. */
  reason: DiffFetchReason;
  /** GitHub HTTP status if the first call failed, for telemetry. */
  status?: number;
  /** True when the diff was reconstructed via the /pulls/<n>/files paginated endpoint. */
  viaFilesFallback?: boolean;
}

export async function fetchPrDiff(params: {
  prContext: PrContext;
  githubToken?: string;
  maxChars?: number;
}): Promise<PrDiffResult> {
  const { prContext, githubToken, maxChars = 100_000 } = params;
  const url = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github.diff' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  try {
    const response = await fetch(url, { headers });
    if (response.ok) {
      const diff = await response.text();
      if (!diff) return { diff: '', truncated: false, reason: 'empty' };
      if (diff.length > maxChars) {
        return {
          diff: `${diff.slice(0, maxChars)}\n\n... [diff truncated — too large for full review]`,
          truncated: true,
          reason: 'ok',
        };
      }
      return { diff, truncated: false, reason: 'ok' };
    }

    // GitHub caps the diff endpoint at 300 files and returns 406 with
    // `errors[].code === "too_large"` for anything bigger. Fall back to the
    // paginated files endpoint, which has no such cap.
    if (response.status === 406) {
      const errorBody = await response.text().catch(() => '');
      if (errorBody.includes('too_large') || errorBody.includes('exceeded the maximum number of files')) {
        return await fetchPrDiffViaFilesEndpoint({ prContext, githubToken, maxChars });
      }
      return { diff: '', truncated: false, reason: 'fetch_failed', status: 406 };
    }

    return { diff: '', truncated: false, reason: 'fetch_failed', status: response.status };
  } catch {
    return { diff: '', truncated: false, reason: 'fetch_failed' };
  }
}

/**
 * Files-endpoint fallback for PRs that exceed GitHub's 300-file diff cap.
 * Paginates `/pulls/<n>/files` (100 per page), reconstructs a synthetic
 * unified diff from each file's `patch` field, and truncates to maxChars.
 * Returns `reason: 'too_large'` when at least one page came back but the
 * reconstructed diff couldn't fit the budget, so the caller can post a
 * specific failure message.
 */
async function fetchPrDiffViaFilesEndpoint(params: {
  prContext: PrContext;
  githubToken?: string;
  maxChars: number;
}): Promise<PrDiffResult> {
  const { prContext, githubToken, maxChars } = params;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const baseUrl = `https://api.github.com/repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}/files`;
  const perPage = 100;
  let page = 1;
  const chunks: string[] = [];
  let totalFiles = 0;
  let runningLen = 0;
  let truncated = false;

  try {
    while (true) {
      const response = await fetch(`${baseUrl}?per_page=${perPage}&page=${page}`, { headers });
      if (!response.ok) {
        // First-page failure → we have nothing to return.
        if (page === 1) {
          return { diff: '', truncated: false, reason: 'fetch_failed', status: response.status };
        }
        break;
      }
      const filesPage = (await response.json()) as Array<{
        filename?: string;
        status?: string;
        additions?: number;
        deletions?: number;
        patch?: string;
      }>;
      if (!Array.isArray(filesPage) || filesPage.length === 0) break;

      for (const file of filesPage) {
        totalFiles += 1;
        const header = `diff --git a/${file.filename ?? '<unknown>'} b/${file.filename ?? '<unknown>'}\n`;
        const statusLine =
          file.status === 'removed'
            ? `--- a/${file.filename}\n+++ /dev/null\n`
            : file.status === 'added'
              ? `--- /dev/null\n+++ b/${file.filename}\n`
              : `--- a/${file.filename}\n+++ b/${file.filename}\n`;
        // For removed-only files GitHub may not include a patch; fall back to
        // a one-line summary so the reviewer still sees the file was removed.
        const body =
          file.patch ??
          `[file ${file.status ?? 'changed'} — +${file.additions ?? 0} / -${file.deletions ?? 0} lines, patch omitted by GitHub]\n`;
        const chunk = `${header}${statusLine}${body}\n`;
        if (runningLen + chunk.length > maxChars) {
          truncated = true;
          break;
        }
        chunks.push(chunk);
        runningLen += chunk.length;
      }
      if (truncated) break;
      if (filesPage.length < perPage) break;
      page += 1;
    }
  } catch {
    if (chunks.length === 0) {
      return { diff: '', truncated: false, reason: 'fetch_failed' };
    }
    // Partial-page fetch failed; return what we have so far.
  }

  if (chunks.length === 0) {
    return { diff: '', truncated: false, reason: 'empty', totalFiles, viaFilesFallback: true };
  }

  const tail = truncated
    ? `\n\n... [diff truncated at ${maxChars.toLocaleString()} chars; PR has ${totalFiles}+ files]`
    : '';
  return {
    diff: chunks.join('') + tail,
    truncated,
    totalFiles,
    reason: truncated ? 'too_large' : 'ok',
    viaFilesFallback: true,
  };
}

/**
 * Build the user-facing Slack message when we couldn't get any reviewable
 * diff content. Differentiates between the three failure modes so the user
 * knows whether to split the PR (too large), retry (transient fetch error),
 * or check the PR (empty / closed).
 */
export function buildEmptyDiffMessage(result: PrDiffResult, prContext: PrContext): string {
  if (result.reason === 'too_large') {
    return (
      `PR ${prContext.owner}/${prContext.repo}#${prContext.number} is too large to review in one shot — ` +
      `GitHub caps the diff endpoint at 300 files and the files-endpoint fallback also exhausted the size budget. ` +
      'Split the PR into smaller chunks (e.g. by directory) or ping me with a specific subset of paths to review.'
    );
  }
  if (result.reason === 'fetch_failed') {
    const statusNote = result.status ? ` (HTTP ${result.status})` : '';
    return (
      `Couldn't fetch the diff for ${prContext.owner}/${prContext.repo}#${prContext.number}${statusNote}. ` +
      'Check that the PR is open and accessible, then re-trigger.'
    );
  }
  return (
    `PR ${prContext.owner}/${prContext.repo}#${prContext.number} returned no diff content — ` +
    'looks empty. Confirm the PR has changes and re-trigger.'
  );
}

export async function checkoutPrBranch(
  repoPath: string,
  prNumber: number,
  logStep?: WorkflowStepLogger,
): Promise<boolean> {
  try {
    // Fetch the PR head ref and checkout
    await execFileAsync('git', ['fetch', 'origin', `pull/${prNumber}/head`], {
      cwd: repoPath,
      timeout: 60_000,
    });
    await execFileAsync('git', ['checkout', 'FETCH_HEAD'], {
      cwd: repoPath,
      timeout: 15_000,
    });
    logStep?.({ stage: 'pr_review.checkout.done', message: `Checked out PR #${prNumber} head in worktree.` });
    return true;
  } catch (error) {
    logStep?.({
      stage: 'pr_review.checkout.failed',
      message: `Failed to checkout PR branch: ${String(error)}`,
      level: 'WARN',
    });
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSeverity(value: unknown): AgentFinding['severity'] | undefined {
  if (typeof value !== 'string' || !FINDING_SEVERITIES.has(value as AgentFinding['severity'])) {
    return undefined;
  }
  return value as AgentFinding['severity'];
}

function normalizeLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeFinding(value: unknown): AgentFinding | undefined {
  if (!isRecord(value)) return undefined;

  const severity = normalizeSeverity(value.severity);
  const category = normalizeString(value.category);
  const message = normalizeString(value.message);

  if (!severity || !category || !message) {
    return undefined;
  }

  return {
    severity,
    category,
    message,
    file: normalizeString(value.file),
    line: normalizeLine(value.line),
    suggestion: normalizeString(value.suggestion),
  };
}

function hasAttachableLocation(finding: AgentFinding): finding is AttachablePrReviewFinding {
  return (
    typeof finding.file === 'string' && finding.file.length > 0 && typeof finding.line === 'number' && finding.line > 0
  );
}

function extractSummaryNotes(output: Record<string, unknown>): string[] {
  const raw = output.summaryNotes;
  if (!Array.isArray(raw)) return [];
  return raw.map(note => normalizeString(note)).filter((note): note is string => Boolean(note));
}

export function normalizePrReviewAgentOutput(
  role: PrReviewRole,
  result: CodexRunResult,
): NormalizedPrReviewAgentOutput {
  const output = result.parsedJson ?? {};
  const rawFindings = Array.isArray(output.findings) ? output.findings : [];
  const findings = rawFindings
    .map(finding => normalizeFinding(finding))
    .filter((finding): finding is AgentFinding => Boolean(finding));

  return {
    role,
    findings,
    attachableFindings: findings.filter(hasAttachableLocation),
    unattachableFindings: findings.filter(finding => !hasAttachableLocation(finding)),
    summaryNotes: extractSummaryNotes(output),
    invalidFindings: rawFindings.length - findings.length,
  };
}

/**
 * Split a single agentic run's role-tagged findings into the three per-role
 * outputs the GitHub submission and summary formatters expect. Findings with
 * a missing/unknown role land under 'reviewer'; summary notes are not
 * role-tagged in the agentic schema so they're attributed to 'reviewer'.
 */
export function splitAgenticOutputByRole(result: CodexRunResult): NormalizedPrReviewAgentOutput[] {
  const output = result.parsedJson ?? {};
  const rawFindings = Array.isArray(output.findings) ? output.findings : [];

  const byRole: Record<PrReviewRole, unknown[]> = { reviewer: [], security: [], performance: [] };
  for (const finding of rawFindings) {
    const role =
      isRecord(finding) && typeof finding.role === 'string' && (PR_REVIEW_ROLES as string[]).includes(finding.role)
        ? (finding.role as PrReviewRole)
        : 'reviewer';
    byRole[role].push(finding);
  }

  return PR_REVIEW_ROLES.map(role =>
    normalizePrReviewAgentOutput(role, {
      ...result,
      parsedJson: {
        findings: byRole[role],
        summaryNotes: role === 'reviewer' ? (output.summaryNotes ?? []) : [],
      },
    }),
  );
}

function buildSeverityBreakdown(findings: AgentFinding[]): string {
  const severityOrder: AgentFinding['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];
  const counts = new Map<AgentFinding['severity'], number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return severityOrder
    .filter(severity => (counts.get(severity) ?? 0) > 0)
    .map(severity => `${counts.get(severity)} ${severity}`)
    .join(', ');
}

export function countBySeverity(findings: AgentFinding[]): Partial<Record<AgentFinding['severity'], number>> {
  const counts: Partial<Record<AgentFinding['severity'], number>> = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

function deriveReviewEvent(
  findings: AgentFinding[],
  reviewEvent?: ReviewEvent,
  summaryNotesCount = 0,
): ReviewEvent | undefined {
  if (reviewEvent) return reviewEvent;
  if (findings.length > 0 || summaryNotesCount > 0) {
    return 'COMMENT';
  }
  return 'APPROVE';
}

function buildSummaryOnlyFinding(role: string, finding: AgentFinding): string {
  const suggestion = finding.suggestion ? ` Suggestion: ${finding.suggestion}` : '';
  return `- [${role.toUpperCase()} - ${finding.severity.toUpperCase()}] ${finding.message}${suggestion}`;
}

export function buildGithubReviewSummary(outputs: NormalizedPrReviewAgentOutput[]): string {
  const allFindings = outputs.flatMap(output => output.findings);
  const attachableFindings = outputs.flatMap(output => output.attachableFindings);
  const unattachableFindings = outputs.flatMap(output =>
    output.unattachableFindings.map(finding => ({ role: output.role, finding })),
  );
  const summaryNotes = outputs.flatMap(output => output.summaryNotes.map(note => ({ role: output.role, note })));

  if (allFindings.length === 0 && summaryNotes.length === 0) {
    return 'Watchtower review complete - no actionable findings. Good to go.';
  }

  const lines: string[] = [];

  if (allFindings.length > 0) {
    lines.push(`Watchtower found ${allFindings.length} issue(s) in this PR.`);
  } else {
    lines.push('Watchtower review complete - no line-attachable findings were identified.');
  }

  if (attachableFindings.length > 0) {
    lines.push(`${attachableFindings.length} inline comment(s) were prepared from line-mapped findings.`);
  }
  if (unattachableFindings.length > 0) {
    lines.push(`${unattachableFindings.length} finding(s) could not be attached inline and are listed below.`);
  }
  if (summaryNotes.length > 0) {
    lines.push(`${summaryNotes.length} summary note(s) are listed below.`);
  }

  if (unattachableFindings.length > 0 || summaryNotes.length > 0) {
    lines.push('', 'Summary-only review notes:');
    for (const { role, finding } of unattachableFindings) {
      lines.push(buildSummaryOnlyFinding(role, finding));
    }
    for (const { role, note } of summaryNotes) {
      lines.push(`- [${role.toUpperCase()} NOTE] ${note}`);
    }
  }

  return lines.join('\n');
}

export function formatSlackReviewSummary(
  outputs: NormalizedPrReviewAgentOutput[],
  prUrl: string,
  reviewResult?: SubmitPrReviewResult,
): string {
  const allFindings = outputs.flatMap(output => output.findings);
  const totalFindings = allFindings.length;
  const totalSummaryNotes = outputs.reduce((sum, output) => sum + output.summaryNotes.length, 0);
  const resolvedEvent = deriveReviewEvent(allFindings, reviewResult?.event, totalSummaryNotes);
  const verdict = resolvedEvent === 'APPROVE' ? '✅' : resolvedEvent === 'REQUEST_CHANGES' ? '🚫' : '💬';

  // When the GitHub token is missing, findings are computed but never posted —
  // surface that explicitly so a skip reads as "couldn't post" not "all clear".
  const noToken = reviewResult?.fallbackReason === 'no_token';
  const skippedReason = noToken ? ' (no GitHub token — nothing was posted to the PR)' : '';

  if (totalFindings === 0 && totalSummaryNotes === 0) {
    if (reviewResult?.submissionMode === 'skipped') {
      return `*PR Review Complete* - No actionable findings. GitHub review submission was skipped${skippedReason}. ${verdict}\n${prUrl}`;
    }
    return `*PR Review Complete* - No actionable findings. Good to go. ${verdict}\n${prUrl}`;
  }

  const breakdown = totalFindings > 0 ? ` (${buildSeverityBreakdown(allFindings)})` : '';

  if (totalFindings === 0) {
    if (reviewResult?.submissionMode === 'skipped') {
      return `*PR Review Complete* - ${totalSummaryNotes} review note(s) identified, but GitHub review submission was skipped${skippedReason}. ${verdict}\n${prUrl}`;
    }
    return `*PR Review Complete* - ${totalSummaryNotes} review note(s) were posted in the review summary. No inline comments were attached. ${verdict}\n${prUrl}`;
  }

  if (!reviewResult || reviewResult.submissionMode === 'skipped') {
    return `*PR Review Complete* - ${totalFindings} findings identified, but GitHub review submission was skipped${skippedReason}${breakdown} ${verdict}\n${prUrl}`;
  }

  const placedParts: string[] = [];
  if (reviewResult.commentsPosted > 0) placedParts.push(`${reviewResult.commentsPosted} inline`);
  if (reviewResult.fileLevelPosted > 0) placedParts.push(`${reviewResult.fileLevelPosted} file-level`);
  const totalPlaced = reviewResult.commentsPosted + reviewResult.fileLevelPosted;

  const dropReasons: string[] = [];
  if (reviewResult.droppedOutsideDiff > 0) {
    dropReasons.push(`${reviewResult.droppedOutsideDiff} outside the PR diff`);
  }
  const unplaced = totalFindings - totalPlaced - reviewResult.droppedOutsideDiff;
  if (unplaced > 0) {
    dropReasons.push(`${unplaced} without an anchor`);
  }

  if (totalPlaced === 0) {
    // Every finding was dropped because its anchor fell outside the diff — the
    // review summary posts but ZERO findings reach the PR inline. Make that loud.
    const allOutsideDiff = reviewResult.droppedOutsideDiff > 0 && reviewResult.droppedOutsideDiff === totalFindings;
    if (allOutsideDiff) {
      return `*PR Review Complete* - ⚠️ all ${totalFindings} finding(s) fell outside the PR diff and could NOT be posted inline; only the review summary was posted${breakdown} ${verdict}\n${prUrl}`;
    }
    const reason = dropReasons.length > 0 ? ` — ${dropReasons.join(', ')}` : '';
    return `*PR Review Complete* - ${totalFindings} findings identified; review summary posted, no inline comments attached${reason}${breakdown} ${verdict}\n${prUrl}`;
  }

  const placed = placedParts.join(' + ') + ' posted';
  const droppedClause = dropReasons.length > 0 ? `; ${dropReasons.join(', ')} dropped` : '';
  return `*PR Review Complete* - ${totalFindings} findings identified; ${placed}${droppedClause}${breakdown} ${verdict}\n${prUrl}`;
}

export const NO_NEW_CHANGES_TEXT =
  'No new commits since the last review. Same diff, same verdict. Push an update and I will rerun.';

export function buildOutOfScopePrReply(userId: string, allowedPrOrg: string): string {
  return `<@${userId}> this PR is outside supported review scope. I can only review PRs in the \`${allowedPrOrg}\` org.`;
}
