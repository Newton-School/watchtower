import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  CodexRunResult,
  NormalizedTask,
  PrContext,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import type { AgentFinding } from '../agents/types.js';
import { assertThreadParentExists, fetchThreadContext } from '../slack/threadContext.js';
import { extractPrContext } from '../router/intentParser.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import { buildMentionSystemPrompt } from '../codex/mentionSystemPrompt.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { assembleRecall } from '../codex/recallAssembler.js';
import type { RecallCapableStore } from '../state/dossierStore.js';
import { highReasoningProfile, profileForAgentRole } from '../codex/modelProfiles.js';
import { githubAuthModeHint, resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { submitPrReview } from '../github/submitPrReview.js';
import type { ReviewEvent, SubmitPrReviewResult } from '../github/submitPrReview.js';
import { buildPrReviewerPrompt, buildPrSecurityPrompt, buildPrPerformancePrompt } from '../agents/prReviewPrompts.js';
import type { PipelineStore } from '../agents/pipeline.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';

const execFileAsync = promisify(execFile);

const SUPPORTED_PR_REPOS = ['newton-web', 'newton-api'] as const;
const FINDING_SEVERITIES = new Set<AgentFinding['severity']>(['critical', 'high', 'medium', 'low', 'info']);

type PrReviewRole = 'reviewer' | 'security' | 'performance';
type AttachablePrReviewFinding = AgentFinding & { file: string; line: number };

interface NormalizedPrReviewAgentOutput {
  role: PrReviewRole;
  findings: AgentFinding[];
  attachableFindings: AttachablePrReviewFinding[];
  unattachableFindings: AgentFinding[];
  summaryNotes: string[];
  invalidFindings: number;
}

function mapRepoPath(config: AppConfig, pr: PrContext): string | null {
  if (pr.repo === 'newton-web') {
    return config.repoPaths.newtonWeb;
  }
  if (pr.repo === 'newton-api') {
    return config.repoPaths.newtonApi;
  }
  return null;
}

async function fetchPrHeadSha(params: {
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

interface PrMetadata {
  headSha?: string;
  headRef?: string;
  title?: string;
  body?: string;
}

async function fetchPrMetadata(params: {
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

async function fetchPrDiff(params: {
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
function buildEmptyDiffMessage(result: PrDiffResult, prContext: PrContext): string {
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

async function checkoutPrBranch(repoPath: string, prNumber: number, logStep?: WorkflowStepLogger): Promise<boolean> {
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

  if (totalFindings === 0 && totalSummaryNotes === 0) {
    if (reviewResult?.submissionMode === 'skipped') {
      return `*PR Review Complete* - No actionable findings. GitHub review submission was skipped. ${verdict}\n${prUrl}`;
    }
    return `*PR Review Complete* - No actionable findings. Good to go. ${verdict}\n${prUrl}`;
  }

  const breakdown = totalFindings > 0 ? ` (${buildSeverityBreakdown(allFindings)})` : '';

  if (totalFindings === 0) {
    if (reviewResult?.submissionMode === 'skipped') {
      return `*PR Review Complete* - ${totalSummaryNotes} review note(s) identified, but GitHub review submission was skipped. ${verdict}\n${prUrl}`;
    }
    return `*PR Review Complete* - ${totalSummaryNotes} review note(s) were posted in the review summary. No inline comments were attached. ${verdict}\n${prUrl}`;
  }

  if (!reviewResult || reviewResult.submissionMode === 'skipped') {
    return `*PR Review Complete* - ${totalFindings} findings identified, but GitHub review submission was skipped${breakdown} ${verdict}\n${prUrl}`;
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
    const reason = dropReasons.length > 0 ? ` — ${dropReasons.join(', ')}` : '';
    return `*PR Review Complete* - ${totalFindings} findings identified; review summary posted, no inline comments attached${reason}${breakdown} ${verdict}\n${prUrl}`;
  }

  const placed = placedParts.join(' + ') + ' posted';
  const droppedClause = dropReasons.length > 0 ? `; ${dropReasons.join(', ')} dropped` : '';
  return `*PR Review Complete* - ${totalFindings} findings identified; ${placed}${droppedClause}${breakdown} ${verdict}\n${prUrl}`;
}

const NO_NEW_CHANGES_TEXT =
  'No new commits since the last review. Same diff, same verdict. Push an update and I will rerun.';

function buildOutOfScopePrReply(userId: string, allowedPrOrg: string): string {
  return `<@${userId}> this PR is outside supported review scope. I can review \`${allowedPrOrg}/newton-web\` and \`${allowedPrOrg}/newton-api\`.`;
}

export async function runPrReviewWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store?: Pick<JobStore, 'findLatestReviewedPrHeadSha' | 'getChannelPolicyPack'> &
    Partial<PipelineStore> &
    RecallCapableStore;
  resolvePrHeadSha?: (input: {
    prContext: PrContext;
    githubToken?: string;
    logStep?: WorkflowStepLogger;
  }) => Promise<string | undefined>;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, resolvePrHeadSha, jobId: _jobId, logStep, signal } = params;

  logStep?.({
    stage: 'pr_review.context.fetch.start',
    message: 'Fetching Slack thread context for PR review.',
  });

  // Pre-flight: if the source mention is gone, fetchThreadContext below would
  // throw thread_not_found and the dispatcher would mark this FAILED. The
  // actual cause is benign (user deleted), so short-circuit to CANCELLED. See
  // processMessageDeleted in index.ts for the orphan-promotion RCA.
  const parentAlive = await assertThreadParentExists(slack, task.event.channelId, task.event.threadTs);
  if (!parentAlive) {
    logStep?.({
      stage: 'pr_review.source_deleted',
      level: 'WARN',
      message: 'Source mention no longer exists — aborting PR review.',
      data: { channelId: task.event.channelId, threadTs: task.event.threadTs },
    });
    return {
      workflow: 'PR_REVIEW',
      status: 'CANCELLED',
      message: 'Source message deleted before PR review ran.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  const threadMessages = await fetchThreadContext(slack, task.event.channelId, task.event.threadTs);
  const threadTexts = threadMessages.map(message => message.text);
  const prContext = task.prContext ?? extractPrContext(threadTexts);

  logStep?.({
    stage: 'pr_review.context.fetch.done',
    message: 'Fetched Slack thread context.',
    data: { messages: threadMessages.length },
  });

  if (!prContext) {
    logStep?.({
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `<@${task.event.userId}> drop the GitHub PR URL in this thread and i will pick it up. Format: \`https://github.com/Newton-School/<repo>/pull/<number>\``,
    });

    return {
      workflow: 'PR_REVIEW',
      status: 'PAUSED',
      message: 'Missing PR context; asked for PR URL in thread.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  if (prContext.owner !== config.allowedPrOrg) {
    logStep?.({
      stage: 'pr_review.guard.org_rejected',
      message: 'PR org is not allowed by policy.',
      level: 'WARN',
      data: {
        owner: prContext.owner,
        allowedOrg: config.allowedPrOrg,
      },
    });

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: buildOutOfScopePrReply(task.event.userId, config.allowedPrOrg),
    });

    notifyDesktop(
      'Watchtower PR review skipped',
      `PR org ${prContext.owner} is not allowed. Only ${config.allowedPrOrg} is supported.`,
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'PR org not allowed; informed requester in thread.',
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  if (!SUPPORTED_PR_REPOS.includes(prContext.repo as (typeof SUPPORTED_PR_REPOS)[number])) {
    logStep?.({
      stage: 'pr_review.guard.repo_out_of_scope',
      message: 'PR repository is outside of supported review scope.',
      level: 'WARN',
      data: {
        owner: prContext.owner,
        repo: prContext.repo,
        supportedRepos: [...SUPPORTED_PR_REPOS],
      },
    });

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: buildOutOfScopePrReply(task.event.userId, config.allowedPrOrg),
    });

    notifyDesktop(
      'Watchtower PR review skipped',
      `PR repo ${prContext.owner}/${prContext.repo} is outside supported scope.`,
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'PR repo out of scope; informed requester in thread.',
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const baseRepoPath = mapRepoPath(config, prContext);
  if (!baseRepoPath) {
    logStep?.({
      stage: 'pr_review.guard.repo_unmapped',
      message: 'PR repository is not mapped to a configured local path.',
      level: 'WARN',
      data: {
        owner: prContext.owner,
        repo: prContext.repo,
      },
    });

    notifyDesktop(
      'Watchtower unmapped PR repo',
      `No local repo mapping for ${prContext.owner}/${prContext.repo}; skipping auto execution.`,
    );
    return {
      workflow: 'PR_REVIEW',
      status: 'SKIPPED',
      message: 'Repo unmapped; desktop notification only.',
      notifyDesktop: true,
      slackPosted: false,
    };
  }

  const repoPath = resolveWorkspace(baseRepoPath, task.event.threadTs);

  const githubToken = await resolveGithubTokenForCodex();

  logStep?.({
    stage: 'pr_review.github.auth_resolved',
    message: 'Resolved GitHub auth mode for Codex execution.',
    data: { tokenInjected: Boolean(githubToken) },
  });

  const headShaResolver = resolvePrHeadSha ?? fetchPrHeadSha;
  const currentPrHeadSha = await headShaResolver({
    prContext,
    githubToken,
    logStep,
  });

  if (currentPrHeadSha) {
    logStep?.({
      stage: 'pr_review.head_sha.fetched',
      message: 'Fetched current PR head SHA.',
      data: {
        prHeadSha: currentPrHeadSha,
      },
    });

    const previous = store?.findLatestReviewedPrHeadSha({
      channelId: task.event.channelId,
      threadTs: task.event.threadTs,
      prUrl: prContext.url,
    });

    if (previous && previous.prHeadSha === currentPrHeadSha) {
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: NO_NEW_CHANGES_TEXT,
      });

      logStep?.({
        stage: 'pr_review.no_new_changes',
        message: 'Skipped PR review because there are no new commits since last successful review.',
        level: 'INFO',
        data: {
          prHeadSha: currentPrHeadSha,
          previousJobId: previous.jobId,
          previousReviewedAt: previous.updatedAt,
        },
      });

      return {
        workflow: 'PR_REVIEW',
        status: 'SKIPPED',
        message: 'No new changes since last review.',
        notifyDesktop: false,
        slackPosted: true,
        result: {
          prUrl: prContext.url,
          prHeadSha: currentPrHeadSha,
          previousReviewedAt: previous.updatedAt,
        },
      };
    }
  }

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: 'PR review in progress. I will drop findings here shortly.',
  });

  logStep?.({
    stage: 'pr_review.slack.ack_posted',
    message: 'Posted PR review start acknowledgement to Slack thread.',
    data: { prUrl: prContext.url },
  });

  const policyPack = store?.getChannelPolicyPack(task.event.channelId);
  const policyBlock = policyPack
    ? [`Active policy pack: ${policyPack.packName}`, ...policyPack.rules.map(rule => `- ${rule}`)].join('\n')
    : 'No explicit policy pack assigned for this channel.';

  // --- Multi-agent pipeline path ---
  if (config.multiAgentEnabled) {
    logStep?.({
      stage: 'pr_review.pipeline.start',
      message: 'Running PR review through parallel multi-agent pipeline.',
    });

    const threadContext = threadTexts.join('\n---\n');
    const pipelineStart = Date.now();

    // 1. Fetch PR metadata and diff
    const prMeta = await fetchPrMetadata({ prContext, githubToken, logStep });
    const prHeadSha = currentPrHeadSha ?? prMeta.headSha;

    const diffResult = await fetchPrDiff({ prContext, githubToken });
    const diff = diffResult.diff;
    if (!diff) {
      logStep?.({
        stage: 'pr_review.diff.empty',
        message: `PR diff fetch produced no content (reason=${diffResult.reason}, status=${diffResult.status ?? 'n/a'}).`,
        level: 'ERROR',
        data: { reason: diffResult.reason, status: diffResult.status, totalFiles: diffResult.totalFiles },
      });
      const failureMessage = buildEmptyDiffMessage(diffResult, prContext);
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: failureMessage,
        })
        .catch(() => {});
      return {
        workflow: 'PR_REVIEW',
        status: 'FAILED',
        message: failureMessage,
        notifyDesktop: true,
        slackPosted: true,
      };
    }

    logStep?.({
      stage: 'pr_review.diff.fetched',
      message:
        diffResult.reason === 'too_large'
          ? `Fetched PR diff via files-endpoint fallback (${diff.length} chars, ${diffResult.totalFiles ?? '?'}+ files, truncated).`
          : `Fetched PR diff (${diff.length} chars${diffResult.truncated ? ', truncated' : ''}).`,
      data: {
        diffChars: diff.length,
        prTitle: prMeta.title,
        truncated: diffResult.truncated,
        totalFiles: diffResult.totalFiles,
        reason: diffResult.reason,
      },
    });

    // If GitHub refused the full diff endpoint (PR exceeds the 300-file cap),
    // surface it in-thread so the requester knows we fell back to the
    // /pulls/<n>/files reconstruction. Includes whether content was truncated.
    if (diffResult.viaFilesFallback) {
      const fileCount = diffResult.totalFiles ?? '300+';
      const headsUp = diffResult.truncated
        ? `Heads up — this PR is huge (${fileCount} files). GitHub refused the full diff endpoint, so I'm reviewing a best-effort sample reconstructed from the first ~${Math.round(diff.length / 1000)}k chars of the files-endpoint pagination. Consider splitting into smaller PRs for a thorough review.`
        : `Heads up — this PR is huge (${fileCount} files). GitHub refused the full diff endpoint, so I'm reviewing a reconstruction via the files-endpoint pagination.`;
      await slack.chat
        .postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: headsUp,
        })
        .catch(() => {});
    }

    // 2. Checkout PR branch so agents see the actual PR code
    await checkoutPrBranch(repoPath, prContext.number, logStep);

    // Phase G: assemble recall once and prepend to all three review prompts
    // (reviewer, security, performance). Empty for unknown users; safe.
    let recallBlock = '';
    if (store?.dossierStore && store.recentSignalsForUser && task.event.userId) {
      try {
        const recall = await assembleRecall({
          userId: task.event.userId,
          workflow: 'PR_REVIEW',
          store: store as unknown as JobStore,
          vaultRoot: store.readVaultSettings?.().vaultPath ?? null,
        });
        if (recall.promptBlock) {
          recallBlock = `${recall.promptBlock}\n\n`;
          logStep?.({
            stage: 'workflow.recall.injected',
            message: `Injected recall (${recall.estimatedTokens} tokens, ${recall.sources.join(',')}).`,
            data: { sources: recall.sources, estimatedTokens: recall.estimatedTokens, workflow: 'PR_REVIEW' },
          });
        }
      } catch (err) {
        logStep?.({
          stage: 'workflow.recall.failed',
          level: 'WARN',
          message: 'recall assembly failed; running without it',
          data: { error: (err as Error).message, workflow: 'PR_REVIEW' },
        });
      }
    }

    // 3. Build PR-specific prompts with diff included
    const reviewerPrompt =
      recallBlock +
      buildPrReviewerPrompt({
        diff,
        prTitle: prMeta.title,
        prBody: prMeta.body,
        threadContext,
        prContext,
        policyBlock,
      });
    const securityPrompt = recallBlock + buildPrSecurityPrompt({ diff, prTitle: prMeta.title, prContext });
    const performancePrompt = recallBlock + buildPrPerformancePrompt({ diff, prTitle: prMeta.title, prContext });

    // 4. Run all 3 review agents in parallel
    await slack.chat
      .postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: 'Running reviewer, security, and performance checks in parallel...',
      })
      .catch(() => {});

    const reviewerProfile = profileForAgentRole('reviewer', getActiveBackendId());
    const securityProfile = profileForAgentRole('security', getActiveBackendId());
    const performanceProfile = profileForAgentRole('performance', getActiveBackendId());

    const schemaDir = path.resolve(process.cwd(), 'schemas');

    const _perAgentTimeoutMs = Math.floor(config.prReviewTimeoutMs / 3);

    const [reviewerResult, securityResult, performanceResult] = await Promise.all([
      runCodex({
        cwd: repoPath,
        prompt: reviewerPrompt,
        outputSchemaPath: path.join(schemaDir, 'agent-reviewer-result.schema.json'),
        githubToken,
        ...reviewerProfile,
        // timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
      }),
      runCodex({
        cwd: repoPath,
        prompt: securityPrompt,
        outputSchemaPath: path.join(schemaDir, 'agent-security-result.schema.json'),
        githubToken,
        ...securityProfile,
        // timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
      }),
      runCodex({
        cwd: repoPath,
        prompt: performancePrompt,
        outputSchemaPath: path.join(schemaDir, 'agent-performance-result.schema.json'),
        githubToken,
        ...performanceProfile,
        // timeoutMs: perAgentTimeoutMs,
        onLog: logStep,
      }),
    ]);

    // 5. Normalize findings from each agent and separate delivery-ready comments from summary-only notes.
    const normalizedOutputs = [
      normalizePrReviewAgentOutput('reviewer', reviewerResult),
      normalizePrReviewAgentOutput('security', securityResult),
      normalizePrReviewAgentOutput('performance', performanceResult),
    ];
    const allFindings = normalizedOutputs.flatMap(output => output.findings);
    const attachableFindings = normalizedOutputs.flatMap(output => output.attachableFindings);
    const unattachableFindings = normalizedOutputs.flatMap(output => output.unattachableFindings);
    const summaryNotesCount = normalizedOutputs.reduce((sum, output) => sum + output.summaryNotes.length, 0);

    const totalDurationMs = Date.now() - pipelineStart;
    logStep?.({
      stage: 'pr_review.pipeline.done',
      message: `Parallel PR review complete in ${Math.round(totalDurationMs / 1000)}s — ${allFindings.length} finding(s).`,
      data: {
        totalDurationMs,
        totalFindings: allFindings.length,
        attachableFindings: attachableFindings.length,
        unattachableFindings: unattachableFindings.length,
        summaryNotes: summaryNotesCount,
        reviewer: {
          ok: reviewerResult.ok,
          findings: normalizedOutputs[0].findings.length,
          attachableFindings: normalizedOutputs[0].attachableFindings.length,
          unattachableFindings: normalizedOutputs[0].unattachableFindings.length,
          summaryNotes: normalizedOutputs[0].summaryNotes.length,
          invalidFindings: normalizedOutputs[0].invalidFindings,
        },
        security: {
          ok: securityResult.ok,
          findings: normalizedOutputs[1].findings.length,
          attachableFindings: normalizedOutputs[1].attachableFindings.length,
          unattachableFindings: normalizedOutputs[1].unattachableFindings.length,
          summaryNotes: normalizedOutputs[1].summaryNotes.length,
          invalidFindings: normalizedOutputs[1].invalidFindings,
        },
        performance: {
          ok: performanceResult.ok,
          findings: normalizedOutputs[2].findings.length,
          attachableFindings: normalizedOutputs[2].attachableFindings.length,
          unattachableFindings: normalizedOutputs[2].unattachableFindings.length,
          summaryNotes: normalizedOutputs[2].summaryNotes.length,
          invalidFindings: normalizedOutputs[2].invalidFindings,
        },
      },
    });

    // 6. Submit formal GitHub PR review with inline comments
    let reviewResult: SubmitPrReviewResult | undefined;
    if (prHeadSha) {
      reviewResult = await submitPrReview({
        owner: prContext.owner,
        repo: prContext.repo,
        pullNumber: prContext.number,
        commitId: prHeadSha,
        // Pass the raw findings list — submitPrReview splits them into inline
        // (file+line inside a hunk), file-level (file in diff, no line), and
        // dropped (outside the diff). Pre-validation against prDiff prevents
        // GitHub from 422-ing the whole batch when a single entry is off-hunk.
        findingsByRole: normalizedOutputs.map(output => ({ role: output.role, findings: output.findings })),
        summary: buildGithubReviewSummary(normalizedOutputs),
        githubToken,
        prDiff: diff,
        logStep,
      });

      logStep?.({
        stage: 'pr_review.github_review.submitted',
        message: `GitHub PR review submitted: ${reviewResult.event} (${reviewResult.commentsPosted}/${reviewResult.attemptedComments} inline, ${reviewResult.fileLevelPosted}/${reviewResult.fileLevelAttempted} file-level, ${reviewResult.droppedOutsideDiff} dropped outside diff, mode=${reviewResult.submissionMode}).`,
        data: {
          ...reviewResult,
          totalFindings: allFindings.length,
          attachableFindings: attachableFindings.length,
          unattachableFindings: unattachableFindings.length,
          summaryNotes: summaryNotesCount,
        },
      });
    } else {
      logStep?.({
        stage: 'pr_review.github_review.skipped',
        message: 'Skipped GitHub PR review submission because the PR head SHA was unavailable.',
        level: 'WARN',
        data: {
          totalFindings: allFindings.length,
          attachableFindings: attachableFindings.length,
          unattachableFindings: unattachableFindings.length,
          summaryNotes: summaryNotesCount,
        },
      });
    }

    // 7. Post formatted summary to Slack
    const hasCriticalOrHigh = allFindings.some(f => f.severity === 'critical' || f.severity === 'high');
    const blockingCount = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
    const baseSummary = formatSlackReviewSummary(normalizedOutputs, prContext.url, reviewResult);
    const slackSummary = hasCriticalOrHigh
      ? `${baseSummary}\n⚠️ ${blockingCount} blocking-severity finding(s) — please address before merge.`
      : baseSummary;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: slackSummary,
    });

    // A completed review is SUCCESS regardless of finding severity — FAILED is
    // reserved for the workflow itself failing. The verdict travels in
    // `result` so consumers (reactions, learning signals, dedup) stop
    // conflating "review found blockers" with "review broke" (issue #334).
    return {
      workflow: 'PR_REVIEW',
      status: 'SUCCESS',
      message: slackSummary,
      notifyDesktop: false,
      slackPosted: true,
      result: {
        ...(prHeadSha ? { prHeadSha } : {}),
        prUrl: prContext.url,
        verdict: hasCriticalOrHigh ? 'blocking_findings' : 'clean',
        hasBlockingFindings: hasCriticalOrHigh,
        totalFindings: allFindings.length,
        attachableFindings: attachableFindings.length,
        unattachableFindings: unattachableFindings.length,
        summaryNotes: summaryNotesCount,
        reviewEvent: reviewResult?.event,
        attemptedComments: reviewResult?.attemptedComments ?? 0,
        commentsPosted: reviewResult?.commentsPosted ?? 0,
        submissionMode: reviewResult?.submissionMode ?? 'skipped',
        fallbackReason: reviewResult?.fallbackReason,
      },
    };
  }

  // --- Single-agent path (legacy) ---
  const prompt = `
${buildMentionSystemPrompt({ task, workflow: 'PR_REVIEW', toneMode: task.toneMode })}

You are executing Watchtower PR review automation.

Context:
- PR URL: ${prContext.url}
- Repository path: ${repoPath}
- GitHub auth mode: ${githubAuthModeHint(Boolean(githubToken))}
- Policy pack:
${policyBlock}

Requirements:
1. Use the frontend-pr-review skill for analysis.
2. If findings exist, use comment-it skill to post inline GitHub review comments.
3. If no actionable findings, post exactly one PR comment: "No actionable findings. Good to go."
4. Return strict JSON matching schema with fields: status, summary, prUrl.
`.trim();

  const request: CodexRunRequest = {
    cwd: repoPath,
    prompt,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/pr-review-result.schema.json'),
    githubToken,
    ...highReasoningProfile(getActiveBackendId()),
    // timeoutMs: config.prReviewTimeoutMs,
    onLog: logStep,
    signal,
  };

  logStep?.({
    stage: 'pr_review.codex.start',
    message: 'Starting Codex PR review execution with high-reasoning profile.',
    data: {
      repoPath,
    },
  });

  const result = await runCodex(request);

  logStep?.({
    stage: 'pr_review.codex.finish',
    message: 'Codex PR review execution finished.',
    level: result.ok ? 'INFO' : 'WARN',
    data: {
      ok: result.ok,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      parsedJson: Boolean(result.parsedJson),
    },
  });

  if (!result.ok || !result.parsedJson) {
    const errorText = result.timedOut
      ? 'PR review timed out.'
      : `PR review failed (exit=${result.exitCode ?? 'unknown'}).`;

    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `${errorText} I could not close this loop right now. Check desktop notifications for details.`,
    });

    logStep?.({
      stage: 'pr_review.slack.failure_posted',
      message: 'Posted PR review failure status to Slack thread.',
      level: 'ERROR',
      data: {
        errorText,
      },
    });

    notifyDesktop('Watchtower PR review failed', `${errorText} thread=${task.event.threadTs}`);

    return {
      workflow: 'PR_REVIEW',
      status: 'FAILED',
      message: errorText,
      notifyDesktop: true,
      slackPosted: true,
    };
  }

  const summary = String(result.parsedJson.summary ?? 'Review completed.');
  const prUrl = String(result.parsedJson.prUrl ?? prContext.url);

  logStep?.({
    stage: 'pr_review.result.parsed',
    message: 'Parsed PR review result payload.',
    data: {
      summary,
      prUrl,
    },
  });

  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: `PR review done. ${summary}\n${prUrl}`,
  });

  logStep?.({
    stage: 'pr_review.slack.success_posted',
    message: 'Posted PR review completion status to Slack thread.',
    data: {
      prUrl,
    },
  });

  return {
    workflow: 'PR_REVIEW',
    status: 'SUCCESS',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: {
      ...result.parsedJson,
      ...(currentPrHeadSha ? { prHeadSha: currentPrHeadSha } : {}),
    },
  };
}
