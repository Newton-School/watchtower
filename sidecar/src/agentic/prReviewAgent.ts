import path from 'node:path';
import os from 'node:os';
import type { WebClient } from '@slack/web-api';
import type { AgentFinding } from '../agents/types.js';
import type {
  AppConfig,
  CodexReasoningEffort,
  CodexRunResult,
  NormalizedTask,
  PrContext,
  WorkflowStepLogger,
} from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile, lightweightProfile, profileForAgentRole } from '../codex/modelProfiles.js';
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
  normalizePrReviewAgentOutput,
  splitAgenticOutputByRole,
  PR_REVIEW_ROLES,
  NO_NEW_CHANGES_TEXT,
} from '../github/prReviewSupport.js';
import type {
  NormalizedPrReviewAgentOutput,
  PrMetadata,
  PrDiffResult,
  PrReviewRole,
} from '../github/prReviewSupport.js';
import { isAnchorInDiff, parseDiffHunks } from '../github/diffHunks.js';
import { resolveWorkspace } from '../workspaces/workspaceManager.js';
import { withAgentCallContext } from '../state/runContext.js';

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
- Severity — calibrate against this rubric (web/api review); only report issues actually present in the diff, never pre-existing code:
  - critical: exploitable or data-destroying in production — auth bypass, SQL/command injection, secret/PII leak, an unguarded destructive query (e.g. user input concatenated into a raw SQL string).
  - high: a likely runtime break or security/perf regression on a real path — unhandled rejection on the happy path, missing authz on a new mutating endpoint, an N+1 added inside a request handler.
  - medium: a real bug behind a narrower condition or a meaningful gap — edge case mishandled, missing validation on a non-critical field, absent error handling, missing test for new branching logic.
  - low: localized correctness/maintainability nits with little blast radius — a narrow off-by-one in a bounded loop, minor readability/naming, a redundant re-render.
  - info: non-actionable observations or style notes that don't require a change.
- You must NOT post anything to GitHub or Slack. Do not run \`gh\`, \`git push\`, \`curl\`, or any network command — submission is handled for you.
- Your final message must be ONLY this JSON object (no prose, no code fences):

{
  "findings": [{ "role": "reviewer"|"security"|"performance", "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file"?: string, "line"?: number, "suggestion"?: string }],
  // file + line are OPTIONAL: omit them for summary-level findings instead of inventing a location (those become summaryNotes).
  "summaryNotes": string[],
  "summary": string
}

PR Diff:
\`\`\`diff
${diff}
\`\`\``.trim();
}

// ---------------------------------------------------------------------------
// Multi-agent fan-out review ("ultracode" pattern): three parallel lens
// specialists (reviewer / security / performance), an adversarial skeptic that
// re-reads the code to refute blocking-severity findings, and a synthesis pass
// that dedups across lenses. Emits the SAME NormalizedPrReviewAgentOutput[] the
// legacy single-agent path produced, so the submit + summary code is unchanged.
// ---------------------------------------------------------------------------

type ReviewPromptParams = {
  recallBlock: string;
  prContext: PrContext;
  prMeta: PrMetadata;
  policyBlock: string;
  threadContext: string;
  diff: string;
};

const SEVERITY_RANK: Record<AgentFinding['severity'], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** On a cross-lens collision the higher-severity finding wins; ties break by
 * lens — security framing is the most actionable, performance the least. */
const LENS_PRIORITY: Record<PrReviewRole, number> = { security: 2, reviewer: 1, performance: 0 };

const LENS_DIRECTIVE: Record<PrReviewRole, string> = {
  reviewer: 'logic errors, bugs, edge cases, missing error handling, test coverage, regressions, readability, naming',
  security:
    'SQL/command injection, XSS, broken authn/authz, secrets or PII exposure, insecure deserialization, CSRF/SSRF, path traversal, unsafe eval, missing input validation — changed code only',
  performance:
    'N+1 queries, unbounded loops/recursion, memory leaks, unnecessary re-renders, heavy imports, missing indexes or pagination, sync blocking in async paths — changed code only',
};

/** Only blocking-severity findings (these drive the ⚠️ Slack warning and the
 * REQUEST_CHANGES signal) go through adversarial verification. */
const VERIFY_FLOOR_RANK = SEVERITY_RANK.high;
/** Hard cap on verifier CLI runs per PR so a finding-heavy PR can't spawn dozens
 * of subprocesses. Budgeted by run cost (a critical spends 3 — best-of-3 vote —
 * and a high spends 1), so the true subprocess ceiling stays at this number
 * regardless of severity mix. Findings beyond the budget pass through unverified. */
const MAX_VERIFICATIONS = 20;
/** Verifier runs in flight at a time. A critical's best-of-3 votes run together,
 * so a batch of criticals can briefly exceed this — acceptable, criticals are rare. */
const VERIFY_CONCURRENCY = 3;

/** Verifier CLI runs a finding spends: critical → best-of-3, everything else → single. */
function verificationCost(finding: AgentFinding): number {
  return finding.severity === 'critical' ? 3 : 1;
}

const VERIFIER_PROMPT_MARKER = 'skeptical PR-review verifier';

function severityRank(severity: AgentFinding['severity']): number {
  return SEVERITY_RANK[severity];
}

/**
 * Single-lens prompt. Reuses the preamble / policy / thread / tool-guidance and
 * the severity rubric verbatim from buildAgenticPrReviewPrompt, but instructs
 * the agent to review through ONE lens only — so security gets its own
 * high-reasoning run instead of sharing one prompt's budget with two other
 * lenses. The pinned "MUST NOT post" invariant is preserved in every lens.
 */
export function buildLensPrompt(params: {
  lens: PrReviewRole;
  recallBlock: string;
  prContext: PrContext;
  prMeta: PrMetadata;
  policyBlock: string;
  threadContext: string;
  diff: string;
  /** When true, omit tool-use instructions (no local clone / degraded retry). */
  oneShot?: boolean;
}): string {
  const { lens, recallBlock, prContext, prMeta, policyBlock, threadContext, diff, oneShot } = params;

  const toolGuidance = oneShot
    ? 'Analyze the diff below directly. Do not explore the repository — produce your findings from the diff alone.'
    : `You are running inside a git worktree of ${prContext.repo} with PR #${prContext.number} checked out.
The full unified diff is included below, and the entire repository is available — use your native
Read/Grep/Glob tools to open surrounding code, callers, and tests to VERIFY each suspicion before
reporting it. Do not report a finding you could have disproven by reading the file.`;

  return `${recallBlock}You are miniOG's PR ${lens} specialist.

PR: ${prContext.url}
${prMeta.title ? `Title: ${prMeta.title}` : ''}
${prMeta.body ? `Description: ${prMeta.body}` : ''}

Policy:
${policyBlock}

Thread context:
${threadContext}

${toolGuidance}

Review ONLY through the "${lens}" lens: ${LENS_DIRECTIVE[lens]}.
Do not report findings that belong to other lenses — another specialist covers them. Set "role": "${lens}" on every finding.

Rules:
- Findings MUST anchor to the diff: exact file path plus the "+"-side (new file) line number.
  Real observations that cannot be mapped to an exact diff location go in "summaryNotes" — never invent a location.
- Severity — calibrate against this rubric (web/api review); only report issues actually present in the diff, never pre-existing code:
  - critical: exploitable or data-destroying in production — auth bypass, SQL/command injection, secret/PII leak, an unguarded destructive query (e.g. user input concatenated into a raw SQL string).
  - high: a likely runtime break or security/perf regression on a real path — unhandled rejection on the happy path, missing authz on a new mutating endpoint, an N+1 added inside a request handler.
  - medium: a real bug behind a narrower condition or a meaningful gap — edge case mishandled, missing validation on a non-critical field, absent error handling, missing test for new branching logic.
  - low: localized correctness/maintainability nits with little blast radius — a narrow off-by-one in a bounded loop, minor readability/naming, a redundant re-render.
  - info: non-actionable observations or style notes that don't require a change.
- You must NOT post anything to GitHub or Slack. Do not run \`gh\`, \`git push\`, \`curl\`, or any network command — submission is handled for you.
- Your final message must be ONLY this JSON object (no prose, no code fences):

{
  "findings": [{ "role": "${lens}", "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file"?: string, "line"?: number, "suggestion"?: string }],
  // file + line are OPTIONAL: omit them for summary-level findings instead of inventing a location (those become summaryNotes).
  "summaryNotes": string[],
  "summary": string
}

PR Diff:
\`\`\`diff
${diff}
\`\`\``.trim();
}

/** Adversarial skeptic prompt for one finding — default to refuting. */
function buildVerifierPrompt(params: {
  finding: AgentFinding & { lens: PrReviewRole };
  diff: string;
  oneShot: boolean;
}): string {
  const { finding, diff, oneShot } = params;
  const evidence = oneShot
    ? 'You have ONLY the diff below, not the repository. Refute the finding if the diff alone does not substantiate it.'
    : `Open ${finding.file ?? 'the referenced file'}${
        typeof finding.line === 'number' ? ` around line ${finding.line}` : ''
      } with your Read/Grep tools and read the REAL code plus its callers and guards — not the diff summary, not the claim's wording.`;

  return `You are a ${VERIFIER_PROMPT_MARKER}. Another agent (the "${finding.lens}" lens) made the claim below about a PR. Your job is to REFUTE it. Default to REFUTED unless you can positively confirm the issue from the actual code.

Finding under scrutiny:
- lens: ${finding.lens}
- severity: ${finding.severity}
- category: ${finding.category}
- message: ${finding.message}
${finding.file ? `- file: ${finding.file}\n` : ''}${typeof finding.line === 'number' ? `- line: ${finding.line}\n` : ''}${finding.suggestion ? `- suggestion: ${finding.suggestion}\n` : ''}
${evidence}

Confirm ALL of the following, or REFUTE:
1. The issue is real in the actual code (not a misreading of the diff).
2. It lives in code THIS PR changed (anchored in the diff below).
3. The stated severity is justified by the rubric — if it is overstated, return verdict "confirmed" with a corrected, lower "severity".

You must NOT post anything to GitHub or Slack. Do not run \`gh\`, \`git push\`, \`curl\`, or any network command.

Your final message must be ONLY this JSON object (no prose, no code fences):
{ "verdict": "confirmed" | "refuted", "severity"?: "critical"|"high"|"medium"|"low"|"info", "reason"?: string }

PR Diff:
\`\`\`diff
${diff}
\`\`\``.trim();
}

/**
 * Run one lens specialist with a per-lens degradation ladder: tier-1 at the
 * role's profile + tools, tier-2 at medium reasoning + tools. A lens that fails
 * both tiers simply contributes nothing — the other lenses still post (graceful
 * degradation, the improvement over the legacy all-or-nothing single agent).
 */
async function runReviewLens(params: {
  lens: PrReviewRole;
  deps: PrReviewDeps;
  cwd: string;
  promptParams: ReviewPromptParams;
  schemaPath: string;
  githubToken?: string;
  timeoutMs?: number;
  forceDiffOnly: boolean;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ lens: PrReviewRole; result?: CodexRunResult; ok: boolean }> {
  const { lens, deps, cwd, promptParams, schemaPath, githubToken, timeoutMs, forceDiffOnly, logStep, signal } = params;
  const prUrl = promptParams.prContext.url;
  const profile = profileForAgentRole(lens, getActiveBackendId());
  const prompt = buildLensPrompt({ lens, ...promptParams, oneShot: forceDiffOnly });

  const run = (reasoningEffort?: CodexReasoningEffort) =>
    withAgentCallContext({ role: lens }, () =>
      deps.runAgent({
        cwd,
        prompt,
        outputSchemaPath: schemaPath,
        githubToken,
        ...profile,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        timeoutMs,
        onLog: logStep,
        signal,
      }),
    );

  let result: CodexRunResult | undefined;
  try {
    result = await run();
  } catch (error) {
    result = undefined;
    logStep?.({
      stage: `agentic.pr_review.lens.${lens}.threw`,
      level: 'WARN',
      message: `Lens ${lens} threw: ${String(error)}`,
      data: { prUrl },
    });
  }

  if (signal?.aborted) return { lens, ok: false };

  if (!result?.ok || !result.parsedJson) {
    logStep?.({
      stage: `agentic.pr_review.lens.${lens}.fallback_medium`,
      level: 'WARN',
      message: `Lens ${lens} tier-1 failed — retrying at medium reasoning (tools still available).`,
      data: { prUrl, exitCode: result?.exitCode ?? null },
    });
    try {
      result = await run('medium');
    } catch (error) {
      result = undefined;
      logStep?.({
        stage: `agentic.pr_review.lens.${lens}.threw`,
        level: 'WARN',
        message: `Lens ${lens} medium retry threw: ${String(error)}`,
        data: { prUrl },
      });
    }
  }

  const ok = Boolean(result?.ok && result.parsedJson);
  logStep?.({
    stage: `agentic.pr_review.lens.${lens}.done`,
    level: ok ? 'INFO' : 'WARN',
    message: `Lens ${lens} ${ok ? 'produced output' : 'failed after medium retry'}.`,
    data: { prUrl, ok },
  });
  return { lens, result: ok ? result : undefined, ok };
}

/** One verifier run. FAILS OPEN — a crashed/timed-out skeptic keeps the finding
 * (verdict 'confirmed', inconclusive true); only an explicit refute drops it. */
async function runVerifier(params: {
  deps: PrReviewDeps;
  cwd: string;
  finding: AgentFinding & { lens: PrReviewRole };
  diff: string;
  oneShot: boolean;
  githubToken?: string;
  timeoutMs?: number;
  verifierSchemaPath: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ verdict: 'confirmed' | 'refuted'; severityOverride?: AgentFinding['severity']; inconclusive: boolean }> {
  const { deps, cwd, finding, diff, oneShot, githubToken, timeoutMs, verifierSchemaPath, logStep, signal } = params;
  const profile = lightweightProfile(getActiveBackendId());

  let result: CodexRunResult | undefined;
  try {
    result = await withAgentCallContext({ role: 'verifier' }, () =>
      deps.runAgent({
        cwd,
        prompt: buildVerifierPrompt({ finding, diff, oneShot }),
        outputSchemaPath: verifierSchemaPath,
        githubToken,
        ...profile,
        timeoutMs,
        onLog: logStep,
        signal,
      }),
    );
  } catch (error) {
    logStep?.({
      stage: 'agentic.pr_review.verify.inconclusive',
      level: 'WARN',
      message: `Verifier threw — keeping finding (fail-open): ${String(error)}`,
      data: {},
    });
    return { verdict: 'confirmed', inconclusive: true };
  }

  if (!result?.ok || !result.parsedJson) {
    logStep?.({
      stage: 'agentic.pr_review.verify.inconclusive',
      level: 'WARN',
      message: 'Verifier produced no parseable verdict — keeping finding (fail-open).',
      data: {},
    });
    return { verdict: 'confirmed', inconclusive: true };
  }

  const verdict = result.parsedJson.verdict === 'refuted' ? 'refuted' : 'confirmed';
  // Only honor a DOWNGRADE (the prompt asks the verifier to lower an overstated
  // severity). Ignore an escalation — it would otherwise promote a single-vote
  // 'high' to 'critical' behind the best-of-3 gate that real criticals get.
  const rawSeverity = result.parsedJson.severity;
  const severityOverride =
    typeof rawSeverity === 'string' &&
    rawSeverity in SEVERITY_RANK &&
    SEVERITY_RANK[rawSeverity as AgentFinding['severity']] < SEVERITY_RANK[finding.severity]
      ? (rawSeverity as AgentFinding['severity'])
      : undefined;
  return { verdict, severityOverride, inconclusive: false };
}

/** Verify one finding. high → single vote; critical → best-of-3 majority
 * (dropped on ≥2 refutes), since a false critical is the most costly. */
async function verifyOneFinding(params: {
  deps: PrReviewDeps;
  cwd: string;
  finding: AgentFinding & { lens: PrReviewRole };
  diff: string;
  oneShot: boolean;
  githubToken?: string;
  timeoutMs?: number;
  verifierSchemaPath: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ verdict: 'confirmed' | 'refuted'; severityOverride?: AgentFinding['severity']; inconclusive: boolean }> {
  if (params.finding.severity !== 'critical') {
    return runVerifier(params);
  }
  const votes = await Promise.all([0, 1, 2].map(() => runVerifier(params)));
  const refutes = votes.filter(v => v.verdict === 'refuted').length;
  const inconclusive = votes.some(v => v.inconclusive);
  if (refutes >= 2) {
    return { verdict: 'refuted', inconclusive };
  }
  const severityOverride = votes.find(v => v.verdict === 'confirmed' && v.severityOverride)?.severityOverride;
  return { verdict: 'confirmed', severityOverride, inconclusive };
}

/**
 * Adversarial verify phase. Bounded: only the candidates passed in (blocking
 * severity), capped at MAX_VERIFICATIONS, VERIFY_CONCURRENCY at a time. Returns
 * the survivors (refuted findings dropped, severity overrides applied). The
 * capped overflow is kept unverified rather than silently dropped.
 */
async function verifyFindings(params: {
  deps: PrReviewDeps;
  cwd: string;
  candidates: Array<AgentFinding & { lens: PrReviewRole }>;
  diff: string;
  oneShot: boolean;
  githubToken?: string;
  timeoutMs?: number;
  verifierSchemaPath: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<Array<AgentFinding & { lens: PrReviewRole }>> {
  const { candidates, logStep, signal } = params;
  // Fill the verifier-run budget greedily (criticals cost 3, others 1) so the
  // total subprocess count never exceeds MAX_VERIFICATIONS for any severity mix.
  const toVerify: Array<AgentFinding & { lens: PrReviewRole }> = [];
  const overflow: Array<AgentFinding & { lens: PrReviewRole }> = [];
  let budget = MAX_VERIFICATIONS;
  for (const finding of candidates) {
    const cost = verificationCost(finding);
    if (cost <= budget) {
      toVerify.push(finding);
      budget -= cost;
    } else {
      overflow.push(finding);
    }
  }
  const capped = overflow.length > 0;
  if (capped) {
    logStep?.({
      stage: 'agentic.pr_review.verify.capped',
      level: 'WARN',
      message: `Verification budget (${MAX_VERIFICATIONS} runs) reached; ${overflow.length} of ${candidates.length} blocking finding(s) pass through unverified.`,
      data: { cap: MAX_VERIFICATIONS, total: candidates.length, unverified: overflow.length },
    });
  }

  const survivors: Array<AgentFinding & { lens: PrReviewRole }> = [...overflow];
  let refuted = 0;
  let inconclusive = 0;

  for (let i = 0; i < toVerify.length; i += VERIFY_CONCURRENCY) {
    if (signal?.aborted) {
      // On abort keep the remaining unverified candidates (fail-open).
      survivors.push(...toVerify.slice(i));
      break;
    }
    const batch = toVerify.slice(i, i + VERIFY_CONCURRENCY);
    const verdicts = await Promise.all(batch.map(finding => verifyOneFinding({ ...params, finding })));
    batch.forEach((finding, idx) => {
      const v = verdicts[idx];
      if (v.inconclusive) inconclusive += 1;
      if (v.verdict === 'refuted') {
        refuted += 1;
        return;
      }
      survivors.push(v.severityOverride ? { ...finding, severity: v.severityOverride } : finding);
    });
  }

  const confirmed = toVerify.length - refuted;
  logStep?.({
    stage: 'agentic.pr_review.verify.done',
    message: `Verify: ${survivors.length} kept (${confirmed} confirmed + ${overflow.length} unverified), ${refuted} refuted, ${inconclusive} inconclusive of ${toVerify.length} checked.`,
    data: {
      candidates: candidates.length,
      checked: toVerify.length,
      confirmed,
      refuted,
      inconclusive,
      unverifiedKept: overflow.length,
      kept: survivors.length,
    },
  });
  return survivors;
}

/** Collapse cross-lens duplicates: same file:line:message (or, for
 * summary-level findings, same message). The higher-severity finding wins;
 * ties break by lens priority (security > reviewer > performance). */
function dedupeFindings(
  findings: Array<AgentFinding & { lens: PrReviewRole }>,
): Array<AgentFinding & { lens: PrReviewRole }> {
  const norm = (message: string) => message.toLowerCase().replace(/\s+/g, ' ').trim();
  const keyOf = (f: AgentFinding & { lens: PrReviewRole }) =>
    typeof f.line === 'number' && f.file ? `${f.file}:${f.line}:${norm(f.message)}` : `note:${norm(f.message)}`;

  const byKey = new Map<string, AgentFinding & { lens: PrReviewRole }>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    const better =
      severityRank(finding.severity) > severityRank(existing.severity) ||
      (severityRank(finding.severity) === severityRank(existing.severity) &&
        LENS_PRIORITY[finding.lens] > LENS_PRIORITY[existing.lens]);
    if (better) byKey.set(key, finding);
  }
  return [...byKey.values()];
}

/**
 * The fan-out → verify → synthesize orchestrator. Returns the per-role outputs
 * the downstream submit/summary code consumes, plus a representative
 * CodexRunResult (for the existing agent_done durationMs log). Returns
 * `undefined` only when ALL THREE lenses fail — the caller then runs the
 * legacy diff-only one-shot so a review never goes silent (issue #334).
 */
async function runMultiAgentReview(params: {
  deps: PrReviewDeps;
  config: AppConfig;
  cwd: string;
  promptParams: ReviewPromptParams;
  schemaPath: string;
  verifierSchemaPath: string;
  githubToken?: string;
  hasLocalRepo: boolean;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ outputs: NormalizedPrReviewAgentOutput[]; agentResult: CodexRunResult } | undefined> {
  const {
    deps,
    config,
    cwd,
    promptParams,
    schemaPath,
    verifierSchemaPath,
    githubToken,
    hasLocalRepo,
    logStep,
    signal,
  } = params;
  const prUrl = promptParams.prContext.url;
  const forceDiffOnly = !hasLocalRepo;
  const timeoutMs = config.prReviewTimeoutMs;

  if (signal?.aborted) return undefined;

  // Phase 1: fan out the three lenses in parallel (reads only on the worktree).
  logStep?.({
    stage: 'agentic.pr_review.fanout.start',
    message: 'Fanning out 3 review lenses (reviewer, security, performance).',
    data: { prUrl, lenses: PR_REVIEW_ROLES },
  });
  const lensResults = await Promise.all(
    PR_REVIEW_ROLES.map(lens =>
      runReviewLens({
        lens,
        deps,
        cwd,
        promptParams,
        schemaPath,
        githubToken,
        timeoutMs,
        forceDiffOnly,
        logStep,
        signal,
      }),
    ),
  );

  const okLenses = lensResults.filter(r => r.ok && r.result);
  const failedLenses = lensResults.filter(r => !r.ok).map(r => r.lens);
  logStep?.({
    stage: 'agentic.pr_review.fanout.done',
    message: `Fan-out: ${okLenses.length}/${PR_REVIEW_ROLES.length} lenses ok.`,
    data: { prUrl, okLenses: okLenses.map(r => r.lens), failedLenses },
  });

  if (okLenses.length === 0) {
    logStep?.({
      stage: 'agentic.pr_review.fallback.fanout_collapsed',
      level: 'WARN',
      message: 'All review lenses failed — falling back to a diff-only one-shot.',
      data: { prUrl },
    });
    return undefined;
  }
  if (failedLenses.length > 0) {
    logStep?.({
      stage: 'agentic.pr_review.fanout.partial',
      level: 'WARN',
      message: `Partial fan-out: lens(es) [${failedLenses.join(', ')}] failed; continuing with the rest.`,
      data: { prUrl, failedLenses },
    });
  }

  if (signal?.aborted) return undefined;

  // Phase 2: collect findings (tagged with their lens) + per-lens summary notes.
  const collected: Array<AgentFinding & { lens: PrReviewRole }> = [];
  const summaryNotesByLens: Partial<Record<PrReviewRole, string[]>> = {};
  for (const { lens, result } of okLenses) {
    const norm = normalizePrReviewAgentOutput(lens, result as CodexRunResult);
    for (const finding of norm.findings) collected.push({ ...finding, lens });
    if (norm.summaryNotes.length > 0) summaryNotesByLens[lens] = norm.summaryNotes;
  }

  const beforeDedupe = collected.length;
  const deduped = dedupeFindings(collected);

  // Phase 3: adversarially verify blocking-severity findings only.
  const blocking = deduped.filter(f => severityRank(f.severity) >= VERIFY_FLOOR_RANK);
  const nonBlocking = deduped.filter(f => severityRank(f.severity) < VERIFY_FLOOR_RANK);
  let finalFindings = deduped;
  if (blocking.length > 0) {
    logStep?.({
      stage: 'agentic.pr_review.verify.start',
      message: `Verifying ${blocking.length} blocking finding(s).`,
      data: { prUrl, candidates: blocking.length },
    });
    const survivors = await verifyFindings({
      deps,
      cwd,
      candidates: blocking,
      diff: promptParams.diff,
      oneShot: forceDiffOnly,
      githubToken,
      timeoutMs,
      verifierSchemaPath,
      logStep,
      signal,
    });
    finalFindings = [...nonBlocking, ...survivors];
  }

  logStep?.({
    stage: 'agentic.pr_review.synth.done',
    message: `Synthesized ${finalFindings.length} finding(s) from ${beforeDedupe} (deduped to ${deduped.length}).`,
    data: { prUrl, beforeDedupe, afterDedupe: deduped.length, final: finalFindings.length },
  });

  // Phase 4: re-bucket per role and normalize, so attachable/unattachable
  // splitting stays identical to the legacy path.
  const representative = okLenses[0].result as CodexRunResult;
  const outputs = PR_REVIEW_ROLES.map(role =>
    normalizePrReviewAgentOutput(role, {
      ...representative,
      parsedJson: {
        findings: finalFindings.filter(f => f.lens === role),
        summaryNotes: summaryNotesByLens[role] ?? [],
      },
    }),
  );

  return { outputs, agentResult: representative };
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
  /** Local clone path, or null when the repo isn't cloned locally (diff-only review). */
  baseRepoPath: string | null;
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
  if (!currentPrHeadSha && previousReview) {
    // Head SHA didn't resolve (fetch threw / returned undefined), so the dedup
    // guard below can't fire — we'll do a full re-review even though one may not
    // be needed. Log it so the silent re-review is observable. Behavior unchanged.
    logStep?.({
      stage: 'agentic.pr_review.pr.dedup_skipped_no_head_sha',
      message: `Could not resolve head SHA for ${prContext.repo}#${prContext.number}; bypassing no-new-changes dedup and re-reviewing in full.`,
      level: 'WARN',
      data: { prUrl: prContext.url, previousJobId: previousReview.jobId, previousPrHeadSha: previousReview.prHeadSha },
    });
  }
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

  // 2. Per-PR worktree (when the repo is cloned locally). Repos without a local
  //    clone are reviewed from the diff alone — no checkout, tmp cwd (#10).
  const hasLocalRepo = Boolean(baseRepoPath);
  const repoPath = hasLocalRepo
    ? await deps.resolveWorkspaceFn(baseRepoPath as string, `${task.event.threadTs}--pr-${prContext.number}`)
    : os.tmpdir();

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
  //    Skipped for diff-only repos (no local clone).
  if (hasLocalRepo) {
    await deps.checkoutPr(repoPath, prContext.number, logStep);
  }

  // 5. Multi-agent fan-out review (the "ultracode" pattern). Three lens
  //    specialists (reviewer/security/performance) run in parallel, blocking
  //    findings are adversarially verified, and the survivors are synthesized
  //    into the per-role outputs the submission + summary code already
  //    consumes. If all three lenses fail, collapse to the legacy diff-only
  //    one-shot so a review never goes silent (issue #334).
  const profile = highReasoningProfile(getActiveBackendId());
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'agentic-pr-review-result.schema.json');
  const verifierSchemaPath = path.resolve(process.cwd(), 'schemas', 'pr-review-verifier.schema.json');
  const promptParams = {
    recallBlock,
    prContext,
    prMeta,
    policyBlock,
    threadContext,
    diff: diffResult.diff,
  };
  let normalizedOutputs: NormalizedPrReviewAgentOutput[] | undefined;
  let agentResult: CodexRunResult | undefined;

  const multi = await runMultiAgentReview({
    deps,
    config,
    cwd: repoPath,
    promptParams,
    schemaPath,
    verifierSchemaPath,
    githubToken,
    hasLocalRepo,
    logStep,
    signal,
  });

  if (signal?.aborted) {
    return failedOutcome(prContext, 'Review aborted before completion.', prHeadSha);
  }

  if (multi) {
    normalizedOutputs = multi.outputs;
    agentResult = multi.agentResult;
  } else {
    // Collapse fallback: every lens failed → one degraded diff-only one-shot.
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
    logStep?.({
      stage: 'agentic.pr_review.fallback.one_shot',
      message: 'Fan-out collapsed (all lenses failed) — ran a degraded diff-only one-shot.',
      level: 'WARN',
      data: { prUrl: prContext.url, ok: agentResult?.ok ?? false, exitCode: agentResult?.exitCode ?? null },
    });

    if (signal?.aborted) {
      return failedOutcome(prContext, 'Review aborted before completion.', prHeadSha);
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

    // Normalize the one-shot's role-tagged findings into the per-role shape.
    normalizedOutputs = splitAgenticOutputByRole(agentResult);
  }

  // Enforce "changed code only" for security/performance findings: the prompt
  // restricts them to changed code, but nothing validated that their anchor
  // actually lands in a diff hunk. If it falls on pre-existing (unchanged)
  // code, demote it to a summary note rather than posting an inline comment on
  // code this PR didn't touch. reviewer-role findings are untouched.
  const hunkIndex = parseDiffHunks(diffResult.diff);
  let downgradedChangedCode = 0;
  for (const output of normalizedOutputs) {
    if (output.role !== 'security' && output.role !== 'performance') continue;
    const kept: AgentFinding[] = [];
    for (const f of output.findings) {
      if (typeof f.line === 'number' && f.file && !isAnchorInDiff(hunkIndex, f.file, f.line)) {
        downgradedChangedCode++;
        output.summaryNotes.push(
          `[${output.role.toUpperCase()} - ${f.severity.toUpperCase()}] ${f.message} (flagged at ${f.file}:${f.line}, outside the PR diff — confirm it applies to changed code)`,
        );
        continue;
      }
      kept.push(f);
    }
    output.findings = kept;
    output.attachableFindings = output.attachableFindings.filter(a => kept.includes(a));
    output.unattachableFindings = output.unattachableFindings.filter(u => kept.includes(u));
  }
  if (downgradedChangedCode > 0) {
    logStep?.({
      stage: 'agentic.pr_review.pr.changed_code_downgraded',
      message: `Downgraded ${downgradedChangedCode} security/performance finding(s) anchored outside the PR diff to summary notes.`,
      data: { prUrl: prContext.url, downgradedChangedCode },
    });
  }

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
