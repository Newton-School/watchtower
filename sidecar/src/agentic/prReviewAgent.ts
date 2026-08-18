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
import type { CodexExecutionProfile } from '../codex/modelProfiles.js';
import { ORCHESTRATOR_TIMEOUT_FACTOR, runOrchestratorReview } from './prReviewOrchestrator.js';
import { discoverReviewSkills, extractChangedPaths } from './reviewSkills.js';
import type { RepoReviewSkill } from './reviewSkills.js';
import { classifyChangedPaths, runPrBuildGate } from '../devServer/devServerManager.js';
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
  /** Repo review skills the orchestrator actually applied (skills-led review). */
  appliedSkills?: string[];
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
  discoverSkills: typeof discoverReviewSkills;
  runBuildGate: typeof runPrBuildGate;
}

export const defaultPrReviewDeps: PrReviewDeps = {
  fetchMetadata: fetchPrMetadata,
  fetchDiff: fetchPrDiff,
  resolveHeadSha: fetchPrHeadSha,
  submitReview: submitPrReview,
  checkoutPr: checkoutPrBranch,
  resolveWorkspaceFn: resolveWorkspace,
  runAgent: runCodex,
  discoverSkills: discoverReviewSkills,
  runBuildGate: runPrBuildGate,
};

/** Rollout switch for the orchestrator-led review. Default ON; set
 * WATCHTOWER_PR_REVIEW_ORCHESTRATED=0 to fall back to the classic 3-lens
 * fan-out exactly as it behaved before the redesign. */
function orchestratedReviewEnabled(): boolean {
  return (process.env.WATCHTOWER_PR_REVIEW_ORCHESTRATED ?? '1') !== '0';
}

/** Shared severity rubric — byte-identical across the one-shot, lens, and
 * orchestrator prompts so calibration (and the pinned prompt tests) never drift. */
export const SEVERITY_RUBRIC = `- Severity — calibrate against this rubric (web/api review); only report issues actually present in the diff, never pre-existing code:
  - critical: exploitable or data-destroying in production — auth bypass, SQL/command injection, secret/PII leak, an unguarded destructive query (e.g. user input concatenated into a raw SQL string).
  - high: a likely runtime break or security/perf regression on a real path — unhandled rejection on the happy path, missing authz on a new mutating endpoint, an N+1 added inside a request handler.
  - medium: a real bug behind a narrower condition or a meaningful gap — edge case mishandled, missing validation on a non-critical field, absent error handling, missing test for new branching logic.
  - low: localized correctness/maintainability nits with little blast radius — a narrow off-by-one in a bounded loop, minor readability/naming, a redundant re-render.
  - info: non-actionable observations or style notes that don't require a change.`;

/** Pinned invariant: the agent never posts — submitPrReview is the sole GitHub write path. */
export const NEVER_POST_RULE =
  '- You must NOT post anything to GitHub or Slack. Do not run `gh`, `git push`, `curl`, or any network command — submission is handled for you.';

export function buildAgenticPrReviewPrompt(params: {
  recallBlock: string;
  prContext: PrContext;
  prMeta: PrMetadata;
  policyBlock: string;
  threadContext: string;
  diff: string;
  userFocusBlock?: string;
  /** When true, omit the tool-use instructions (degraded one-shot retry). */
  oneShot?: boolean;
}): string {
  const { recallBlock, prContext, prMeta, policyBlock, threadContext, diff, userFocusBlock, oneShot } = params;

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

${userFocusBlock ? `${userFocusBlock}\n\n` : ''}Thread context:
${threadContext}

${toolGuidance}

Review across three lenses; tag every finding with its "role":
- "reviewer": logic errors, bugs, edge cases, missing error handling, test coverage, regressions, readability, naming
- "security": SQL/command injection, XSS, broken authn/authz, secrets or PII exposure, insecure deserialization, CSRF/SSRF, path traversal, unsafe eval, missing input validation — changed code only
- "performance": N+1 queries, unbounded loops/recursion, memory leaks, unnecessary re-renders, heavy imports, missing indexes or pagination, sync blocking in async paths — changed code only

Rules:
- Findings MUST anchor to the diff: exact file path plus the "+"-side (new file) line number.
  Real observations that cannot be mapped to an exact diff location go in "summaryNotes" — never invent a location.
${SEVERITY_RUBRIC}
${NEVER_POST_RULE}
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
  userFocusBlock?: string;
  /** The PR-head checkout FAILED — the worktree shows the default branch. */
  checkoutDegraded?: boolean;
  /** Deterministic install/build verdict, when the gate ran (deps/runtime PRs). */
  buildStatusBlock?: string;
  /** Prior-review findings context for re-reviews (addressed/unaddressed/regressed). */
  priorReviewBlock?: string;
};

/** One persisted finding from a prior review of the same PR. */
export interface PriorReviewFinding {
  role: string;
  severity: string;
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

const MAX_PRIOR_FINDINGS_IN_PROMPT = 20;

function buildPriorReviewBlock(previousSha: string, priorFindings: PriorReviewFinding[]): string {
  const shown = priorFindings.slice(0, MAX_PRIOR_FINDINGS_IN_PROMPT);
  const lines = shown.map(
    f =>
      `- [${f.severity.toUpperCase()}][${f.role}] ${f.file ? `${f.file}${typeof f.line === 'number' ? `:${f.line}` : ''} — ` : ''}${f.message}`,
  );
  if (priorFindings.length > shown.length) lines.push(`- … and ${priorFindings.length - shown.length} more.`);
  return `PRIOR REVIEW — I previously reviewed this PR at commit ${previousSha.slice(0, 10)} and reported:
${lines.join('\n')}
The PR has new commits since. To see exactly what changed, run \`git diff ${previousSha.slice(0, 10)}...HEAD\` in the worktree.
For each prior finding, judge whether the new commits ADDRESSED it, left it UNADDRESSED, or REGRESSED it:
fold unaddressed/regressed ones into your findings (re-anchored to the current diff), and record addressed
ones in "summaryNotes" as "Addressed since last review: <short description>".`;
}

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
 * of subprocesses. Budgeted by WORST-CASE run cost (a critical spends 3 votes,
 * a high spends up to 2 — primary + adjudication of a refute), so the true
 * subprocess ceiling stays at this number regardless of severity mix. Findings
 * beyond the budget pass through unverified. */
const MAX_VERIFICATIONS = 30;
/** Verifier runs in flight at a time. A critical's 3 votes run together,
 * so a batch of criticals can briefly exceed this — acceptable, criticals are rare. */
const VERIFY_CONCURRENCY = 3;

type VerifierTier = 'primary' | 'adjudicator';

/**
 * Two-tier verification (quality-parity fix): the lens agents run at the high
 * tier, so a light-tier skeptic must not be able to solo-veto their blocking
 * findings. Primary votes run the light model at HIGH effort; a primary refute
 * of a `high` finding is adjudicated by the high-tier model at medium effort,
 * and a critical's best-of-3 includes one adjudicator vote. Deliberately a
 * local table, not ROLE_TIER — that record is shared with the implementation
 * pipeline (narrow-exception precedent: the planner case in modelProfiles.ts).
 */
function verifierProfile(tier: VerifierTier): { model: string; reasoningEffort: CodexReasoningEffort } {
  return tier === 'adjudicator'
    ? { ...highReasoningProfile(getActiveBackendId()), reasoningEffort: 'medium' }
    : { ...lightweightProfile(getActiveBackendId()), reasoningEffort: 'high' };
}

/** Worst-case verifier CLI runs a finding can spend: critical → 3 votes,
 * everything else → primary + possible adjudication. */
function verificationCost(finding: AgentFinding): number {
  return finding.severity === 'critical' ? 3 : 2;
}

/** Prompt-marker substrings — exported so tests route fake agents by marker
 * instead of incidental phrasing. */
export const VERIFIER_PROMPT_MARKER = 'skeptical PR-review verifier';
export const ADJUDICATOR_PROMPT_MARKER = 'senior adjudicator';

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
  userFocusBlock?: string;
  checkoutDegraded?: boolean;
  buildStatusBlock?: string;
  /** When true, omit tool-use instructions (no local clone / degraded retry). */
  oneShot?: boolean;
}): string {
  const {
    lens,
    recallBlock,
    prContext,
    prMeta,
    policyBlock,
    threadContext,
    diff,
    userFocusBlock,
    checkoutDegraded,
    buildStatusBlock,
    oneShot,
  } = params;

  const toolGuidance = oneShot
    ? 'Analyze the diff below directly. Do not explore the repository — produce your findings from the diff alone.'
    : `You are running inside a git worktree of ${prContext.repo} with PR #${prContext.number} checked out.
The full unified diff is included below, and the entire repository is available — use your native
Read/Grep/Glob tools to open surrounding code, callers, and tests to VERIFY each suspicion before
reporting it. Do not report a finding you could have disproven by reading the file.${
        checkoutDegraded
          ? `\nNOTE: the PR-head checkout FAILED — the worktree shows the DEFAULT branch, not this PR. Treat the
diff below as the sole source of truth for changed code; repo reads reflect pre-PR state.`
          : ''
      }`;

  return `${recallBlock}You are miniOG's PR ${lens} specialist.

PR: ${prContext.url}
${prMeta.title ? `Title: ${prMeta.title}` : ''}
${prMeta.body ? `Description: ${prMeta.body}` : ''}

Policy:
${policyBlock}

${userFocusBlock ? `${userFocusBlock}\n\n` : ''}${buildStatusBlock ? `${buildStatusBlock}\n\n` : ''}Thread context:
${threadContext}

${toolGuidance}

Review ONLY through the "${lens}" lens: ${LENS_DIRECTIVE[lens]}.
Do not report findings that belong to other lenses — another specialist covers them. Set "role": "${lens}" on every finding.

Rules:
- Findings MUST anchor to the diff: exact file path plus the "+"-side (new file) line number.
  Real observations that cannot be mapped to an exact diff location go in "summaryNotes" — never invent a location.
${SEVERITY_RUBRIC}
${NEVER_POST_RULE}
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

/** Adversarial skeptic prompt for one finding — default to refuting. The
 * adjudicator tier gets the same contract with a senior, independent framing. */
function buildVerifierPrompt(params: {
  finding: AgentFinding & { lens: PrReviewRole };
  diff: string;
  oneShot: boolean;
  tier?: VerifierTier;
}): string {
  const { finding, diff, oneShot, tier } = params;
  const evidence = oneShot
    ? 'You have ONLY the diff below, not the repository. Refute the finding if the diff alone does not substantiate it.'
    : `Open ${finding.file ?? 'the referenced file'}${
        typeof finding.line === 'number' ? ` around line ${finding.line}` : ''
      } with your Read/Grep tools and read the REAL code plus its callers and guards — not the diff summary, not the claim's wording.`;

  const roleLine =
    tier === 'adjudicator'
      ? `You are a ${ADJUDICATOR_PROMPT_MARKER} — a ${VERIFIER_PROMPT_MARKER} of last resort. Another agent (the "${finding.lens}" lens) made the claim below about a PR. Deliver an independent verdict on the evidence alone: confirm it ONLY if you can positively establish the issue from the actual code; otherwise refute it.`
      : `You are a ${VERIFIER_PROMPT_MARKER}. Another agent (the "${finding.lens}" lens) made the claim below about a PR. Your job is to REFUTE it. Default to REFUTED unless you can positively confirm the issue from the actual code.`;

  return `${roleLine}

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
  /** Orchestrated mode upgrades the performance lens to the high tier without
   * touching the shared ROLE_TIER table (which the implementation pipeline pins). */
  profileOverride?: CodexExecutionProfile;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ lens: PrReviewRole; result?: CodexRunResult; ok: boolean }> {
  const { lens, deps, cwd, promptParams, schemaPath, githubToken, timeoutMs, forceDiffOnly, logStep, signal } = params;
  const prUrl = promptParams.prContext.url;
  const profile = params.profileOverride ?? profileForAgentRole(lens, getActiveBackendId());
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
  tier?: VerifierTier;
  githubToken?: string;
  timeoutMs?: number;
  verifierSchemaPath: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ verdict: 'confirmed' | 'refuted'; severityOverride?: AgentFinding['severity']; inconclusive: boolean }> {
  const { deps, cwd, finding, diff, oneShot, githubToken, timeoutMs, verifierSchemaPath, logStep, signal } = params;
  const tier = params.tier ?? 'primary';
  const profile = verifierProfile(tier);

  let result: CodexRunResult | undefined;
  try {
    result = await withAgentCallContext({ role: 'verifier' }, () =>
      deps.runAgent({
        cwd,
        prompt: buildVerifierPrompt({ finding, diff, oneShot, tier }),
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

/** Verify one finding. high → one primary vote, with a primary refute
 * adjudicated by the high tier (a light-tier skeptic can no longer solo-veto
 * a high-tier lens finding); critical → 3 votes (2 primary + 1 adjudicator),
 * dropped on ≥2 refutes, since a false critical is the most costly. */
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
  const { finding, logStep } = params;
  if (finding.severity !== 'critical') {
    const primary = await runVerifier({ ...params, tier: 'primary' });
    if (primary.verdict === 'confirmed') return primary;
    const adjudication = await runVerifier({ ...params, tier: 'adjudicator' });
    logStep?.({
      stage: 'agentic.pr_review.verify.adjudicated',
      message: `Adjudicator ${adjudication.verdict === 'refuted' ? 'upheld' : 'overturned'} the primary refutation.`,
      data: { verdict: adjudication.verdict, severity: finding.severity, file: finding.file, line: finding.line },
    });
    return adjudication;
  }
  const votes = await Promise.all([
    runVerifier({ ...params, tier: 'primary' }),
    runVerifier({ ...params, tier: 'primary' }),
    runVerifier({ ...params, tier: 'adjudicator' }),
  ]);
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

/** A finding tagged with where it came from. `viaOrchestrator` marks findings
 * from the orchestrated lead review (skills-led) — they win severity ties. */
type CollectedFinding = AgentFinding & { lens: PrReviewRole; viaOrchestrator?: boolean };

/** Collapse cross-lens duplicates: same file:line:message (or, for
 * summary-level findings, same message). The higher-severity finding wins;
 * ties prefer the orchestrator's framing (skills lead), then break by lens
 * priority (security > reviewer > performance). */
function dedupeFindings(findings: CollectedFinding[]): CollectedFinding[] {
  const norm = (message: string) => message.toLowerCase().replace(/\s+/g, ' ').trim();
  const keyOf = (f: CollectedFinding) =>
    typeof f.line === 'number' && f.file ? `${f.file}:${f.line}:${norm(f.message)}` : `note:${norm(f.message)}`;

  const byKey = new Map<string, CollectedFinding>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    const sameSeverity = severityRank(finding.severity) === severityRank(existing.severity);
    const orchTiebreak =
      Number(Boolean(finding.viaOrchestrator)) > Number(Boolean(existing.viaOrchestrator)) ||
      (Boolean(finding.viaOrchestrator) === Boolean(existing.viaOrchestrator) &&
        LENS_PRIORITY[finding.lens] > LENS_PRIORITY[existing.lens]);
    const better = severityRank(finding.severity) > severityRank(existing.severity) || (sameSeverity && orchTiebreak);
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

/**
 * Orchestrator-led review (tier 1) with the classic fan-out as tier 2:
 * the orchestrator (skills-led lead reviewer) runs in parallel with the
 * security/performance safety-net lenses; on orchestrator double-failure the
 * classic `reviewer` lens fills its slot (security/perf results are REUSED,
 * not re-run). Returns `undefined` only when every source failed — the caller
 * then runs the diff-only one-shot (tier 3) so a review never goes silent.
 */
async function runOrchestratedReview(params: {
  deps: PrReviewDeps;
  config: AppConfig;
  cwd: string;
  promptParams: ReviewPromptParams;
  skills: RepoReviewSkill[];
  schemaPath: string;
  orchestratorSchemaPath: string;
  verifierSchemaPath: string;
  githubToken?: string;
  hasLocalRepo: boolean;
  diffTruncated?: boolean;
  baseRef?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<
  | {
      outputs: NormalizedPrReviewAgentOutput[];
      agentResult: CodexRunResult;
      appliedSkills: string[];
      degradedToFanout: boolean;
    }
  | undefined
> {
  const {
    deps,
    config,
    cwd,
    promptParams,
    skills,
    schemaPath,
    orchestratorSchemaPath,
    verifierSchemaPath,
    githubToken,
    hasLocalRepo,
    diffTruncated,
    baseRef,
    logStep,
    signal,
  } = params;
  const prUrl = promptParams.prContext.url;
  const forceDiffOnly = !hasLocalRepo;
  const timeoutMs = config.prReviewTimeoutMs;
  const backendId = getActiveBackendId();

  if (signal?.aborted) return undefined;

  logStep?.({
    stage: 'agentic.pr_review.fanout.start',
    message: 'Orchestrated review: lead orchestrator + security/performance safety net.',
    data: { prUrl, lenses: ['orchestrator', 'security', 'performance'], skills: skills.map(skill => skill.name) },
  });

  const safetyLenses: PrReviewRole[] = ['security', 'performance'];
  const [orch, ...lensResults] = await Promise.all([
    runOrchestratorReview({
      deps,
      cwd,
      promptParams: { ...promptParams, skills, backendId, forceDiffOnly, diffTruncated, baseRef },
      schemaPath: orchestratorSchemaPath,
      githubToken,
      timeoutMs: timeoutMs ? timeoutMs * ORCHESTRATOR_TIMEOUT_FACTOR : timeoutMs,
      logStep,
      signal,
    }),
    ...safetyLenses.map(lens =>
      runReviewLens({
        lens,
        deps,
        cwd,
        promptParams,
        schemaPath,
        githubToken,
        timeoutMs,
        forceDiffOnly,
        // Quality-first: perf coverage at the high tier in orchestrated mode
        // (ROLE_TIER keeps its lightweight default for the classic path).
        profileOverride:
          lens === 'performance' ? { ...highReasoningProfile(backendId), reasoningEffort: 'high' } : undefined,
        logStep,
        signal,
      }),
    ),
  ]);

  if (signal?.aborted) return undefined;

  // Tier 2: orchestrator dead → the classic reviewer lens fills its slot.
  let reviewerLens: { lens: PrReviewRole; result?: CodexRunResult; ok: boolean } | undefined;
  const degradedToFanout = !orch.ok;
  if (degradedToFanout) {
    logStep?.({
      stage: 'agentic.pr_review.fallback.fanout',
      level: 'WARN',
      message: 'Orchestrator unavailable — running the standard reviewer lens (classic fan-out).',
      data: { prUrl },
    });
    reviewerLens = await runReviewLens({
      lens: 'reviewer',
      deps,
      cwd,
      promptParams,
      schemaPath,
      githubToken,
      timeoutMs,
      forceDiffOnly,
      logStep,
      signal,
    });
  }

  const okLenses = [
    ...(reviewerLens?.ok && reviewerLens.result ? [reviewerLens] : []),
    ...lensResults.filter(r => r.ok && r.result),
  ];
  const failedLenses = [
    ...(reviewerLens && !reviewerLens.ok ? (['reviewer'] as PrReviewRole[]) : []),
    ...lensResults.filter(r => !r.ok).map(r => r.lens),
  ];

  const orchOutputs = orch.ok && orch.result ? splitAgenticOutputByRole(orch.result) : undefined;

  if (!orchOutputs && okLenses.length === 0) {
    logStep?.({
      stage: 'agentic.pr_review.fallback.fanout_collapsed',
      level: 'WARN',
      message: 'Orchestrator and every lens failed — falling back to a diff-only one-shot.',
      data: { prUrl },
    });
    return undefined;
  }

  logStep?.({
    stage: 'agentic.pr_review.fanout.done',
    message: `Fan-out: orchestrator ${orch.ok ? 'ok' : 'failed'}, ${okLenses.length} lens(es) ok.`,
    data: { prUrl, orchestratorOk: orch.ok, okLenses: okLenses.map(r => r.lens), failedLenses },
  });
  if (failedLenses.length > 0) {
    logStep?.({
      stage: 'agentic.pr_review.fanout.partial',
      level: 'WARN',
      message: `Partial fan-out: lens(es) [${failedLenses.join(', ')}] failed; continuing with the rest.`,
      data: { prUrl, failedLenses },
    });
  }

  if (signal?.aborted) return undefined;

  // Collect findings from the orchestrator (role-tagged) and the lenses.
  const collected: CollectedFinding[] = [];
  const summaryNotesByLens: Partial<Record<PrReviewRole, string[]>> = {};
  const addNotes = (role: PrReviewRole, notes: string[]) => {
    if (notes.length > 0) summaryNotesByLens[role] = [...(summaryNotesByLens[role] ?? []), ...notes];
  };
  if (orchOutputs) {
    for (const output of orchOutputs) {
      for (const finding of output.findings) collected.push({ ...finding, lens: output.role, viaOrchestrator: true });
      addNotes(output.role, output.summaryNotes);
    }
  }
  for (const { lens, result } of okLenses) {
    const norm = normalizePrReviewAgentOutput(lens, result as CodexRunResult);
    for (const finding of norm.findings) collected.push({ ...finding, lens });
    addNotes(lens, norm.summaryNotes);
  }

  const beforeDedupe = collected.length;
  const deduped = dedupeFindings(collected);

  // Adversarially verify blocking-severity findings (orchestrator and lens
  // findings alike — the safety net applies to the skills-led review too).
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

  const representative = (orch.ok && orch.result ? orch.result : okLenses[0].result) as CodexRunResult;
  const outputs = PR_REVIEW_ROLES.map(role =>
    normalizePrReviewAgentOutput(role, {
      ...representative,
      parsedJson: {
        findings: finalFindings.filter(f => f.lens === role),
        summaryNotes: summaryNotesByLens[role] ?? [],
      },
    }),
  );

  return { outputs, agentResult: representative, appliedSkills: orch.skillsApplied, degradedToFanout };
}

/**
 * Enforce "changed code only" for security/performance findings: the prompt
 * restricts them to changed code, but nothing validated that their anchor
 * actually lands in a diff hunk. If it falls on pre-existing (unchanged)
 * code, demote it to a summary note rather than posting an inline comment on
 * code this PR didn't touch. reviewer-role findings are untouched.
 * Mutates `outputs` in place; returns the demotion count.
 */
export function enforceChangedCodeGate(
  outputs: NormalizedPrReviewAgentOutput[],
  diff: string,
  prUrl: string,
  logStep?: WorkflowStepLogger,
): number {
  const hunkIndex = parseDiffHunks(diff);
  let downgradedChangedCode = 0;
  for (const output of outputs) {
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
      data: { prUrl, downgradedChangedCode },
    });
  }
  return downgradedChangedCode;
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
  userFocusBlock?: string;
  githubToken?: string;
  previousReview?: { jobId: string; prHeadSha: string; updatedAt: string };
  /** Findings persisted by the previous review of this PR, for re-review context. */
  priorFindings?: PriorReviewFinding[];
  /** Persist this review's findings (durable memory). Must never throw into the review. */
  persistFindings?: (input: {
    findings: Array<PriorReviewFinding>;
    appliedSkills: string[];
    prHeadSha?: string;
    author?: string;
  }) => void;
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
    userFocusBlock,
    githubToken,
    previousReview,
    priorFindings,
    persistFindings,
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
  //    Non-fatal, but no longer silent: on failure the prompts say the worktree
  //    shows the default branch and the Slack summary carries a warning.
  //    Skipped for diff-only repos (no local clone).
  let checkoutOk = true;
  if (hasLocalRepo) {
    checkoutOk = await deps.checkoutPr(repoPath, prContext.number, logStep);
  }
  const checkoutDegraded = hasLocalRepo && !checkoutOk;

  const orchestrated = orchestratedReviewEnabled();
  const changedPaths = extractChangedPaths(diffResult.diff);

  // 4b. Deterministic build gate for deps/runtime-affecting PRs (the
  //     webapp-QA runtime-PR RCA, applied to review): npm ci + build against
  //     the PR's own lockfile/Node version. Evidence no verifier can refute.
  //     Non-fatal: a gate crash just means no BUILD STATUS block.
  let buildStatusBlock: string | undefined;
  let buildGateFailed = false;
  if (orchestrated && hasLocalRepo && checkoutOk && !signal?.aborted) {
    const changed = classifyChangedPaths(changedPaths);
    if (changed.depsChanged || changed.runtimeChanged) {
      try {
        const gate = await deps.runBuildGate({ worktreePath: repoPath, prNumber: prContext.number, signal, logStep });
        buildGateFailed = !gate.ok;
        buildStatusBlock = gate.ok
          ? `BUILD STATUS (deterministic — ran before this review): npm ci${gate.buildScript ? ` + ${gate.buildScript}` : ''} PASSED under Node ${gate.nodeVersion}.`
          : `BUILD STATUS (deterministic — ran before this review): FAILED at the ${gate.failedStage} stage under Node ${gate.nodeVersion}. Report this as a finding (severity per the rubric). Output tail:\n${gate.outputTail}`;
      } catch (error) {
        logStep?.({
          stage: 'agentic.pr_review.build_gate.threw',
          level: 'WARN',
          message: `Build gate threw (non-fatal): ${String(error)}`,
          data: { prUrl: prContext.url },
        });
      }
    }
  }

  // 5. Orchestrated review (tier 1): a skills-led lead orchestrator + the
  //    security/performance safety-net lenses run in parallel; blocking
  //    findings are adversarially verified, and the survivors are synthesized
  //    into the per-role outputs the submission + summary code already
  //    consumes. The ladder never goes silent (issue #334): orchestrator dead
  //    → classic reviewer lens (tier 2); everything dead → diff-only one-shot
  //    (tier 3); that dead too → explicit in-thread failure (tier 4).
  //    WATCHTOWER_PR_REVIEW_ORCHESTRATED=0 restores the classic fan-out.
  const profile = highReasoningProfile(getActiveBackendId());
  const schemaPath = path.resolve(process.cwd(), 'schemas', 'agentic-pr-review-result.schema.json');
  const orchestratorSchemaPath = path.resolve(process.cwd(), 'schemas', 'pr-review-orchestrator-result.schema.json');
  const verifierSchemaPath = path.resolve(process.cwd(), 'schemas', 'pr-review-verifier.schema.json');
  const priorReviewBlock =
    previousReview && priorFindings && priorFindings.length > 0
      ? buildPriorReviewBlock(previousReview.prHeadSha, priorFindings)
      : undefined;

  const promptParams = {
    recallBlock,
    prContext,
    prMeta,
    policyBlock,
    threadContext,
    diff: diffResult.diff,
    userFocusBlock,
    checkoutDegraded,
    buildStatusBlock,
    priorReviewBlock,
  };
  let normalizedOutputs: NormalizedPrReviewAgentOutput[] | undefined;
  let agentResult: CodexRunResult | undefined;
  let appliedSkills: string[] = [];
  let degradedToFanout = false;

  // 5a. Repo review skills — committed in the worktree, classified by a cheap
  //     model call, and handed to the orchestrator as the review's playbook.
  //     Skipped for diff-only repos (no worktree) and in classic mode.
  let skills: RepoReviewSkill[] = [];
  if (orchestrated && hasLocalRepo && !signal?.aborted) {
    const discovery = await deps.discoverSkills({
      worktreePath: repoPath,
      prContext,
      prTitle: prMeta.title,
      changedPaths,
      runAgent: deps.runAgent,
      logStep,
      signal,
    });
    skills = discovery.applicable;
  }

  const orchestratedResult = orchestrated
    ? await runOrchestratedReview({
        deps,
        config,
        cwd: repoPath,
        promptParams,
        skills,
        schemaPath,
        orchestratorSchemaPath,
        verifierSchemaPath,
        githubToken,
        hasLocalRepo,
        diffTruncated: diffResult.truncated,
        baseRef: prMeta.baseRef,
        logStep,
        signal,
      })
    : undefined;
  const classicResult = !orchestrated
    ? await runMultiAgentReview({
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
      })
    : undefined;
  const multi = orchestratedResult ?? classicResult;

  if (signal?.aborted) {
    return failedOutcome(prContext, 'Review aborted before completion.', prHeadSha);
  }

  if (orchestratedResult) {
    normalizedOutputs = orchestratedResult.outputs;
    agentResult = orchestratedResult.agentResult;
    appliedSkills = orchestratedResult.appliedSkills;
    degradedToFanout = orchestratedResult.degradedToFanout;
  } else if (classicResult) {
    normalizedOutputs = classicResult.outputs;
    agentResult = classicResult.agentResult;
  }
  if (!multi) {
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

  if (!normalizedOutputs || !agentResult) {
    // Unreachable: every path above either assigned both or returned. Guarded
    // so the compiler (and a future refactor) can't silently break it.
    return failedOutcome(prContext, 'Review produced no output.', prHeadSha);
  }

  enforceChangedCodeGate(normalizedOutputs, diffResult.diff, prContext.url, logStep);

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
      summary: buildGithubReviewSummary(normalizedOutputs, appliedSkills),
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
  //    Blocking findings are previewed inline (full text lives on the PR), and
  //    a degraded run says so — silent degradation was quality gap #5.
  const blockingFindings = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high');
  const hasBlockingFindings = blockingFindings.length > 0;
  const baseSummary = formatSlackReviewSummary(normalizedOutputs, prContext.url, reviewResult, appliedSkills);
  const summaryParts = [baseSummary];
  if (hasBlockingFindings) {
    summaryParts.push(`⚠️ ${blockingFindings.length} blocking-severity finding(s) — please address before merge.`);
    const preview = blockingFindings
      .slice(0, 3)
      .map(
        f =>
          `• [${f.severity.toUpperCase()}] ${f.file ? `${f.file}${typeof f.line === 'number' ? `:${f.line}` : ''} — ` : ''}${f.message}`,
      );
    if (blockingFindings.length > 3) preview.push(`… and ${blockingFindings.length - 3} more on the PR.`);
    summaryParts.push(preview.join('\n'));
  }
  if (buildGateFailed) {
    summaryParts.push('🔴 npm ci/build FAILED for this PR under its own lockfile — details in the review.');
  }
  if (prMeta.ciStatus === 'failing') {
    summaryParts.push(`🔴 CI is failing on the PR head (${(prMeta.ciFailing ?? []).slice(0, 3).join(', ')}).`);
  }
  if (checkoutDegraded) {
    summaryParts.push(
      '⚠️ Could not check out the PR head — repo verification ran against the default branch; the diff itself was still reviewed in full.',
    );
  }
  if (degradedToFanout) {
    summaryParts.push('_orchestrated review unavailable — ran the standard 3-lens review._');
  }
  await postToThread(summaryParts.join('\n'));
  logStep?.({
    stage: 'agentic.pr_review.pr.summary_posted',
    message: `Posted review summary for ${prContext.repo}#${prContext.number}.`,
    data: { prUrl: prContext.url },
  });

  // Persist the findings (durable review memory — feeds re-review context and
  // future cross-PR recall). Caller-provided and fail-safe by contract.
  persistFindings?.({
    findings: normalizedOutputs.flatMap(output =>
      output.findings.map(f => ({
        role: output.role,
        severity: f.severity,
        category: f.category,
        message: f.message,
        file: f.file,
        line: f.line,
        suggestion: f.suggestion,
      })),
    ),
    appliedSkills,
    prHeadSha,
    author: prMeta.author,
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
    ...(appliedSkills.length > 0 ? { appliedSkills } : {}),
  };
}
