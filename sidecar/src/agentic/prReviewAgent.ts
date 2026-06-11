import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type { AgentFinding } from '../agents/types.js';
import type { AppConfig, CodexRunResult, NormalizedTask, PrContext, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { submitPrReview } from '../github/submitPrReview.js';
import type { ReviewEvent, SubmitPrReviewResult } from '../github/submitPrReview.js';
import {
  buildEmptyDiffMessage,
  buildGithubReviewSummary,
  checkoutPrBranch,
  countBySeverity,
  fetchPrDiff,
  fetchPrHeadSha,
  fetchPrMetadata,
  formatSlackReviewSummary,
  splitAgenticOutputByRole,
  NO_NEW_CHANGES_TEXT,
} from '../github/prReviewSupport.js';
import type { PrMetadata, PrDiffResult } from '../github/prReviewSupport.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';

/**
 * Per-PR review outcome. A job reviewing N PRs carries N of these in
 * `result.outcomes`; the dedup guard (jobStore.findLatestReviewedPrHeadSha)
 * reads them per-PR so a partially-failed batch still dedups its completed
 * reviews.
 */
export interface PrReviewOutcome {
  prUrl: string;
  repo: string;
  number: number;
  /** SKIPPED = no new commits since the last review (dedup). */
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  prHeadSha?: string;
  hasBlockingFindings: boolean;
  totalFindings: number;
  severityCounts: Partial<Record<AgentFinding['severity'], number>>;
  reviewEvent?: ReviewEvent;
  submissionMode?: string;
  commentsPosted?: number;
  fileLevelPosted?: number;
  droppedOutsideDiff?: number;
  error?: string;
}

/**
 * IO seams for tests — every network/git/CLI touchpoint is injectable so the
 * module is testable without spawning processes or hitting GitHub.
 */
export interface PrReviewDeps {
  fetchMetadata: typeof fetchPrMetadata;
  fetchDiff: typeof fetchPrDiff;
  resolveHeadSha: typeof fetchPrHeadSha;
  submitReview: typeof submitPrReview;
  checkoutPr: typeof checkoutPrBranch;
  resolveWorkspaceFn: typeof resolveWorkspace;
  runAgent: typeof runCodex;
}

export const defaultPrReviewDeps: PrReviewDeps = {
  fetchMetadata: fetchPrMetadata,
  fetchDiff: fetchPrDiff,
  resolveHeadSha: fetchPrHeadSha,
  submitReview: submitPrReview,
  checkoutPr: checkoutPrBranch,
  resolveWorkspaceFn: resolveWorkspace,
  runAgent: runCodex,
};

export function buildAgenticPrReviewPrompt(params: {
  recallBlock: string;
  prContext: PrContext;
  prMeta: PrMetadata;
  policyBlock: string;
  threadContext: string;
  diff: string;
  /** When true, omit the tool-use instructions (degraded one-shot retry). */
  oneShot?: boolean;
}): string {
  const { recallBlock, prContext, prMeta, policyBlock, threadContext, diff, oneShot } = params;

  const toolGuidance = oneShot
    ? 'Analyze the diff below directly. Do not explore the repository — produce your findings from the diff alone.'
    : `You are running inside a git worktree of ${prContext.repo} with PR #${prContext.number} checked out.
The full unified diff is included below, and the entire repository is available — use your native
Read/Grep/Glob tools to open surrounding code, callers, and tests to VERIFY each suspicion before
reporting it. Do not report a finding you could have disproven by reading the file.`;

  return `${recallBlock}You are miniOG's PR reviewer.

PR: ${prContext.url}
${prMeta.title ? `Title: ${prMeta.title}` : ''}
${prMeta.body ? `Description: ${prMeta.body}` : ''}

Policy:
${policyBlock}

Thread context:
${threadContext}

${toolGuidance}

Review across three lenses; tag every finding with its "role":
- "reviewer": logic errors, bugs, edge cases, missing error handling, test coverage, regressions, readability, naming
- "security": SQL/command injection, XSS, broken authn/authz, secrets or PII exposure, insecure deserialization, CSRF/SSRF, path traversal, unsafe eval, missing input validation — changed code only
- "performance": N+1 queries, unbounded loops/recursion, memory leaks, unnecessary re-renders, heavy imports, missing indexes or pagination, sync blocking in async paths — changed code only

Rules:
- Findings MUST anchor to the diff: exact file path plus the "+"-side (new file) line number.
  Real observations that cannot be mapped to an exact diff location go in "summaryNotes" — never invent a location.
- Severity: critical | high | medium | low | info. Only report issues actually present in the diff — do not flag pre-existing code.
- You must NOT post anything to GitHub or Slack. Do not run \`gh\`, \`git push\`, \`curl\`, or any network command — submission is handled for you.
- Your final message must be ONLY this JSON object (no prose, no code fences):

{
  "findings": [{ "role": "reviewer"|"security"|"performance", "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }],
  "summaryNotes": string[],
  "summary": string
}

PR Diff:
\`\`\`diff
${diff}
\`\`\``.trim();
}

function failedOutcome(prContext: PrContext, error: string, prHeadSha?: string): PrReviewOutcome {
  return {
    prUrl: prContext.url,
    repo: prContext.repo,
    number: prContext.number,
    status: 'FAILED',
    prHeadSha,
    hasBlockingFindings: false,
    totalFindings: 0,
    severityCounts: {},
    error,
  };
}

/**
 * Review one PR end-to-end: dedup check → worktree checkout → diff fetch →
 * agentic run (with a degraded one-shot retry on hard failure) → GitHub
 * submission via the hunk-validating submitPrReview → per-PR Slack summary.
 *
 * Failures are contained to this PR's outcome — the orchestrator keeps
 * reviewing the rest of the batch. The deterministic failure ladder is the
 * anti-bug-B requirement from issue #334: an agent CLI failure produces a
 * specific in-thread message, never an admin-clarify prompt, never silence.
 */
export async function reviewSinglePr(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  prContext: PrContext;
  baseRepoPath: string;
  recallBlock: string;
  policyBlock: string;
  threadContext: string;
  githubToken?: string;
  previousReview?: { jobId: string; prHeadSha: string; updatedAt: string };
  deps?: Partial<PrReviewDeps>;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<PrReviewOutcome> {
  const {
    task,
    config,
    slack,
    prContext,
    baseRepoPath,
    recallBlock,
    policyBlock,
    threadContext,
    githubToken,
    previousReview,
    logStep,
    signal,
  } = params;
  const deps: PrReviewDeps = { ...defaultPrReviewDeps, ...params.deps };

  const postToThread = async (text: string) => {
    await slack.chat
      .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text })
      .catch(() => {});
  };

  // 1. No-new-changes dedup, per PR.
  const currentPrHeadSha = await deps.resolveHeadSha({ prContext, githubToken, logStep });
  if (currentPrHeadSha && previousReview && previousReview.prHeadSha === currentPrHeadSha) {
    await postToThread(`${NO_NEW_CHANGES_TEXT}\n${prContext.url}`);
    logStep?.({
      stage: 'agentic.pr_review.pr.dedup_skipped',
      message: `Skipped ${prContext.repo}#${prContext.number} — no new commits since the last review.`,
      data: { prUrl: prContext.url, prHeadSha: currentPrHeadSha, previousJobId: previousReview.jobId },
    });
    return {
      prUrl: prContext.url,
      repo: prContext.repo,
      number: prContext.number,
      status: 'SKIPPED',
      prHeadSha: currentPrHeadSha,
      hasBlockingFindings: false,
      totalFindings: 0,
      severityCounts: {},
    };
  }

  // 2. Per-PR worktree. Keyed by threadTs + PR number so two same-repo PRs in
  //    one thread can't clobber each other's checkout.
  const repoPath = deps.resolveWorkspaceFn(baseRepoPath, `${task.event.threadTs}--pr-${prContext.number}`);

  // 3. Diff fetch (TS-side: the same bytes feed the agent prompt AND the
  //    submitPrReview hunk validator, eliminating agent/validator drift).
  const prMeta = await deps.fetchMetadata({ prContext, githubToken, logStep });
  const prHeadSha = currentPrHeadSha ?? prMeta.headSha;
  const diffResult: PrDiffResult = await deps.fetchDiff({ prContext, githubToken });
  if (!diffResult.diff) {
    logStep?.({
      stage: 'agentic.pr_review.pr.diff_empty',
      message: `PR diff fetch produced no content (reason=${diffResult.reason}, status=${diffResult.status ?? 'n/a'}).`,
      level: 'ERROR',
      data: { prUrl: prContext.url, reason: diffResult.reason, status: diffResult.status },
    });
    const failureMessage = buildEmptyDiffMessage(diffResult, prContext);
    await postToThread(failureMessage);
    return failedOutcome(prContext, failureMessage, prHeadSha);
  }

  logStep?.({
    stage: 'agentic.pr_review.pr.diff_fetched',
    message: `Fetched PR diff (${diffResult.diff.length} chars${diffResult.truncated ? ', truncated' : ''}).`,
    data: {
      prUrl: prContext.url,
      diffChars: diffResult.diff.length,
      truncated: diffResult.truncated,
      totalFiles: diffResult.totalFiles,
      reason: diffResult.reason,
    },
  });

  if (diffResult.viaFilesFallback) {
    const fileCount = diffResult.totalFiles ?? '300+';
    await postToThread(
      diffResult.truncated
        ? `Heads up — this PR is huge (${fileCount} files). GitHub refused the full diff endpoint, so I'm reviewing a best-effort sample reconstructed from the first ~${Math.round(diffResult.diff.length / 1000)}k chars of the files-endpoint pagination. Consider splitting into smaller PRs for a thorough review.`
        : `Heads up — this PR is huge (${fileCount} files). GitHub refused the full diff endpoint, so I'm reviewing a reconstruction via the files-endpoint pagination.`,
    );
  }

  // 4. Checkout so the agent's verification reads see the actual PR code.
  //    Non-fatal: on failure the agent still has the full diff in-prompt.
  await deps.checkoutPr(repoPath, prContext.number, logStep);

  // 5. Agentic run with the deterministic failure ladder.
  const profile = highReasoningProfile(getActiveBackendId());
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'agentic-pr-review-result.schema.json');
  const promptParams = {
    recallBlock,
    prContext,
    prMeta,
    policyBlock,
    threadContext,
    diff: diffResult.diff,
  };

  let agentResult: CodexRunResult | undefined;
  try {
    agentResult = await deps.runAgent({
      cwd: repoPath,
      prompt: buildAgenticPrReviewPrompt(promptParams),
      outputSchemaPath: schemaPath,
      githubToken,
      ...profile,
      timeoutMs: config.prReviewTimeoutMs,
      onLog: logStep,
      signal,
    });
  } catch (error) {
    agentResult = undefined;
    logStep?.({
      stage: 'agentic.pr_review.pr.agent_threw',
      message: `Agentic review run threw: ${String(error)}`,
      level: 'WARN',
      data: { prUrl: prContext.url },
    });
  }

  if (signal?.aborted) {
    return failedOutcome(prContext, 'Review aborted before completion.', prHeadSha);
  }

  if (!agentResult?.ok || !agentResult.parsedJson) {
    logStep?.({
      stage: 'agentic.pr_review.fallback.one_shot',
      message: 'Agentic run failed — retrying as a degraded diff-only one-shot.',
      level: 'WARN',
      data: {
        prUrl: prContext.url,
        ok: agentResult?.ok ?? false,
        exitCode: agentResult?.exitCode ?? null,
        parsedJson: Boolean(agentResult?.parsedJson),
      },
    });
    try {
      agentResult = await deps.runAgent({
        cwd: repoPath,
        prompt: buildAgenticPrReviewPrompt({ ...promptParams, oneShot: true }),
        outputSchemaPath: schemaPath,
        githubToken,
        ...profile,
        timeoutMs: config.prReviewTimeoutMs,
        onLog: logStep,
        signal,
      });
    } catch (error) {
      agentResult = undefined;
      logStep?.({
        stage: 'agentic.pr_review.pr.agent_threw',
        message: `One-shot fallback threw: ${String(error)}`,
        level: 'WARN',
        data: { prUrl: prContext.url },
      });
    }
  }

  if (!agentResult?.ok || !agentResult.parsedJson) {
    const failureMessage =
      `Review of ${prContext.url} failed (agent error${agentResult?.exitCode != null ? `, exit ${agentResult.exitCode}` : ''}, retried once). ` +
      'Re-trigger with another mention to retry.';
    logStep?.({
      stage: 'agentic.pr_review.pr.failed',
      message: `Review failed after one-shot retry for ${prContext.repo}#${prContext.number}.`,
      level: 'ERROR',
      data: { prUrl: prContext.url, exitCode: agentResult?.exitCode ?? null },
    });
    await postToThread(failureMessage);
    return failedOutcome(prContext, failureMessage, prHeadSha);
  }

  // 6. Normalize role-tagged findings into the per-role shape the submission
  //    and summary formatters expect. All severity validation and
  //    attachable/unattachable splitting is unchanged from the legacy path.
  const normalizedOutputs = splitAgenticOutputByRole(agentResult);
  const allFindings = normalizedOutputs.flatMap(output => output.findings);
  const summaryNotesCount = normalizedOutputs.reduce((sum, output) => sum + output.summaryNotes.length, 0);

  logStep?.({
    stage: 'agentic.pr_review.pr.agent_done',
    message: `Agentic review produced ${allFindings.length} finding(s) and ${summaryNotesCount} note(s).`,
    data: {
      prUrl: prContext.url,
      findings: allFindings.length,
      summaryNotes: summaryNotesCount,
      durationMs: agentResult.durationMs,
    },
  });

  // 7. Submit the formal GitHub review through the hunk-validating path —
  //    the ONLY GitHub write path; the agent itself is forbidden from posting.
  let reviewResult: SubmitPrReviewResult | undefined;
  if (prHeadSha) {
    reviewResult = await deps.submitReview({
      owner: prContext.owner,
      repo: prContext.repo,
      pullNumber: prContext.number,
      commitId: prHeadSha,
      findingsByRole: normalizedOutputs.map(output => ({ role: output.role, findings: output.findings })),
      summary: buildGithubReviewSummary(normalizedOutputs),
      githubToken,
      prDiff: diffResult.diff,
      logStep,
    });

    logStep?.({
      stage: 'agentic.pr_review.pr.github_review.submitted',
      message: `GitHub PR review submitted: ${reviewResult.event} (${reviewResult.commentsPosted}/${reviewResult.attemptedComments} inline, ${reviewResult.fileLevelPosted}/${reviewResult.fileLevelAttempted} file-level, ${reviewResult.droppedOutsideDiff} dropped outside diff, mode=${reviewResult.submissionMode}).`,
      data: { prUrl: prContext.url, ...reviewResult },
    });
  } else {
    logStep?.({
      stage: 'agentic.pr_review.pr.github_review.skipped',
      message: 'Skipped GitHub review submission because the PR head SHA was unavailable.',
      level: 'WARN',
      data: { prUrl: prContext.url },
    });
  }

  // 8. Per-PR Slack summary, the format users know — plus an explicit
  //    blocking-findings warning that does NOT fail the job (issue #334 bug D).
  const hasBlockingFindings = allFindings.some(f => f.severity === 'critical' || f.severity === 'high');
  const blockingCount = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high').length;
  const baseSummary = formatSlackReviewSummary(normalizedOutputs, prContext.url, reviewResult);
  await postToThread(
    hasBlockingFindings
      ? `${baseSummary}\n⚠️ ${blockingCount} blocking-severity finding(s) — please address before merge.`
      : baseSummary,
  );
  logStep?.({
    stage: 'agentic.pr_review.pr.summary_posted',
    message: `Posted review summary for ${prContext.repo}#${prContext.number}.`,
    data: { prUrl: prContext.url },
  });

  return {
    prUrl: prContext.url,
    repo: prContext.repo,
    number: prContext.number,
    status: 'SUCCESS',
    prHeadSha,
    hasBlockingFindings,
    totalFindings: allFindings.length,
    severityCounts: countBySeverity(allFindings),
    reviewEvent: reviewResult?.event,
    submissionMode: reviewResult?.submissionMode ?? 'skipped',
    commentsPosted: reviewResult?.commentsPosted ?? 0,
    fileLevelPosted: reviewResult?.fileLevelPosted ?? 0,
    droppedOutsideDiff: reviewResult?.droppedOutsideDiff ?? 0,
  };
}
