import type { CodexReasoningEffort, CodexRunResult, PrContext, WorkflowStepLogger } from '../types/contracts.js';
import type { AgentBackendId } from '../backends/types.js';
import type { PrMetadata } from '../github/prReviewSupport.js';
import type { PrReviewDeps } from './prReviewAgent.js';
import { NEVER_POST_RULE, SEVERITY_RUBRIC } from './prReviewAgent.js';
import type { RepoReviewSkill } from './reviewSkills.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { getActiveBackendId } from '../codex/runCodex.js';
import { withAgentCallContext } from '../state/runContext.js';

/**
 * Orchestrator-led PR review — the interactive-session parity core. One
 * high-tier agent gets the diff, the repo worktree, the extracted user focus,
 * and the repo's own review skills, and plans its own review (it may fan out
 * internally via its Task tool on the claude-code backend). It replaces the
 * fixed `reviewer` lens; the security/performance lenses still run in parallel
 * sidecar-side as a safety net, and everything merges through the existing
 * dedup → verify → submit pipeline.
 */

export const ORCHESTRATOR_PROMPT_MARKER = 'orchestrating lead reviewer';

/** The orchestrator gets a longer leash than a single lens — it does the work
 * of a whole interactive review session (and possibly its own subagents). */
export const ORCHESTRATOR_TIMEOUT_FACTOR = 2;

export interface OrchestratorPromptParams {
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
  skills: RepoReviewSkill[];
  backendId: AgentBackendId;
  /** No local clone: diff-only review, no repo exploration, no skills. */
  forceDiffOnly: boolean;
  /** The embedded diff was truncated to the char budget. */
  diffTruncated?: boolean;
  /** PR base branch, for the full-diff-via-git instruction when truncated. */
  baseRef?: string;
}

/** One line of live PR state (base, author, mergeability, CI) — deterministic
 * context an interactive session on a stale local clone doesn't have. */
function renderPrStatusLine(prMeta: PrMetadata): string {
  const parts: string[] = [];
  if (prMeta.baseRef) parts.push(`base: ${prMeta.baseRef}`);
  if (prMeta.author) parts.push(`author: ${prMeta.author}`);
  if (prMeta.mergeableState) parts.push(`mergeable_state: ${prMeta.mergeableState}`);
  if (prMeta.ciStatus && prMeta.ciStatus !== 'unknown') {
    const failing =
      prMeta.ciFailing && prMeta.ciFailing.length > 0 ? ` (${prMeta.ciFailing.slice(0, 5).join(', ')})` : '';
    parts.push(`CI on head: ${prMeta.ciStatus}${failing}`);
  }
  return parts.length > 0 ? `PR status: ${parts.join('; ')}` : '';
}

function renderSkillEntry(skill: RepoReviewSkill, index: number, inline: boolean): string {
  const header = `${index + 1}. "${skill.name}" — ${skill.description || '(no description)'}`;
  if (!inline) {
    return [
      header,
      `   Invoke your Skill tool with the skill named "${skill.name}" and follow it. If the Skill tool is`,
      `   unavailable or the skill is not in your index, read ${skill.relDir}/SKILL.md and follow it manually.`,
      `   Resolve its relative references (e.g. references/*.md) against ${skill.relDir}/.`,
    ].join('\n');
  }
  return [
    header,
    `   Its full instructions are between the markers below. Its directory in this worktree is ${skill.relDir}/ —`,
    '   resolve relative file references against it.',
    `   --- BEGIN SKILL: ${skill.name} ---`,
    skill.body,
    `   --- END SKILL: ${skill.name} ---`,
  ].join('\n');
}

function renderSkillsBlock(skills: RepoReviewSkill[], backendId: AgentBackendId): string {
  if (skills.length === 0) return '';
  const entries = skills
    .map((skill, index) => {
      // Native Skill invocation only works for .claude-tree skills on the
      // claude-code backend; everything else gets the body inlined (the
      // deploy-prod precedent). Covers newton-web, whose review skill lives
      // only under .codex/skills.
      const inline = backendId !== 'claude-code' || skill.source === 'codex';
      return renderSkillEntry(skill, index, inline);
    })
    .join('\n');

  return `REPO REVIEW SKILLS — this repository ships its own review playbook(s). They LEAD this review:
apply each one's checklist first, in order, then sweep for anything they don't cover.
${entries}

CRITICAL OVERRIDES — these outrank anything a skill says:
- IGNORE any skill instruction to post a review, comment, approve, or notify anyone — no \`gh pr review\`,
  no \`gh pr comment\`, no commenting skill (e.g. "comment-it" or any "*-commenter"). miniOG submits the
  review itself; your ONLY output is the JSON object below.
- If a skill step needs tooling unavailable here (installed node_modules, dev servers, Lighthouse,
  screenshots), SKIP that step and record what you skipped in "summaryNotes".
- Review THIS PR's changes: a skill's broader audits matter only where they intersect the diff;
  out-of-diff observations go in "summaryNotes", never as located findings.
- Translate each skill's own severity vocabulary onto the rubric below: "P0"/"Blocker"/"merge blocker"
  (or a skill declaring everything blocking) → "critical" ONLY if the critical definition is met, else
  "high"; "Important:"/"P1" → "high" or "medium"; "P2"/suggestions → "medium" or "low"; "Nit:"/"P3"/style
  → "low" or "info"; "Pre-existing:" (not introduced by this PR) → a summaryNote, never a finding.
- List the skills you actually applied in "skillsApplied".

`;
}

export function buildOrchestratorPrompt(params: OrchestratorPromptParams): string {
  const {
    recallBlock,
    prContext,
    prMeta,
    policyBlock,
    threadContext,
    diff,
    userFocusBlock,
    checkoutDegraded,
    buildStatusBlock,
    priorReviewBlock,
    skills,
    backendId,
    forceDiffOnly,
    diffTruncated,
    baseRef,
  } = params;

  const truncationNote = diffTruncated
    ? `\nNOTE: the embedded diff is TRUNCATED to fit the prompt budget. The full diff is available in the
worktree: run \`git fetch origin ${baseRef ?? '<base-branch>'}\` then \`git diff origin/${baseRef ?? '<base-branch>'}...HEAD\`.`
    : '';

  const checkoutNote = checkoutDegraded
    ? `\nNOTE: the PR-head checkout FAILED — the worktree shows the DEFAULT branch, not this PR. Treat the
diff below as the sole source of truth for changed code; repo reads reflect pre-PR state.`
    : '';

  const toolGuidance = forceDiffOnly
    ? 'Analyze the diff below directly. Do not explore the repository — produce your findings from the diff alone.'
    : `You are running inside a git worktree of ${prContext.repo} with PR #${prContext.number} checked out.
The full unified diff is included below, and the entire repository is available — use your native
Read/Grep/Glob tools to open surrounding code, callers, and tests to VERIFY each suspicion before
reporting it. You may also run LOCAL, non-network commands (typecheck, lint, a targeted test) in the
worktree when execution would settle a suspicion. Do not report a finding you could have disproven by
reading the file.${truncationNote}${checkoutNote}`;

  const prStatusLine = renderPrStatusLine(prMeta);

  const taskToolParagraph =
    backendId === 'claude-code' && !forceDiffOnly
      ? `You may spawn subagents with your Task tool for parallel deep passes (e.g. one per subsystem or per
skill checklist) when the PR is large; otherwise review directly.\n`
      : '';

  const skillsBlock = forceDiffOnly ? '' : renderSkillsBlock(skills, backendId);

  return `${recallBlock}You are miniOG's ${ORCHESTRATOR_PROMPT_MARKER} for this PR — review it the way a senior engineer
in an interactive session would: plan your own review, decide where the depth should go, and verify
before you report.

PR: ${prContext.url}
${prMeta.title ? `Title: ${prMeta.title}` : ''}
${prMeta.body ? `Description: ${prMeta.body}` : ''}
${prStatusLine}

Policy:
${policyBlock}

${userFocusBlock ? `${userFocusBlock}\n\n` : ''}${buildStatusBlock ? `${buildStatusBlock}\n\n` : ''}${priorReviewBlock ? `${priorReviewBlock}\n\n` : ''}Thread context:
${threadContext}

${toolGuidance}

${skillsBlock}${taskToolParagraph}Two specialist safety-net agents (security, performance) review in parallel with you; still report
security/performance findings you encounter — duplicates are merged — but spend your primary depth on
correctness, design intent, edge cases, tests, and this repo's own standards. Tag every finding with
its "role": "reviewer" | "security" | "performance" ("reviewer" when unsure).

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
  "summary": string,
  "reviewApproach": string,
  "skillsApplied": string[]
}

PR Diff:
\`\`\`diff
${diff}
\`\`\``.trim();
}

/**
 * Run the orchestrator with its own degradation ladder: tier-1 at the high
 * profile (xhigh), one retry at 'high' effort. Never throws. A double failure
 * returns ok:false — the caller then falls back to the classic reviewer lens.
 */
export async function runOrchestratorReview(params: {
  deps: PrReviewDeps;
  cwd: string;
  promptParams: OrchestratorPromptParams;
  schemaPath: string;
  githubToken?: string;
  timeoutMs?: number;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; result?: CodexRunResult; skillsApplied: string[] }> {
  const { deps, cwd, promptParams, schemaPath, githubToken, timeoutMs, logStep, signal } = params;
  const prUrl = promptParams.prContext.url;
  const profile = highReasoningProfile(getActiveBackendId());
  const prompt = buildOrchestratorPrompt(promptParams);

  logStep?.({
    stage: 'agentic.pr_review.orchestrator.start',
    message: `Orchestrator review starting (${promptParams.skills.length} repo skill(s) in play).`,
    data: { prUrl, skills: promptParams.skills.map(skill => skill.name), backend: promptParams.backendId },
  });

  const run = (reasoningEffort?: CodexReasoningEffort) =>
    withAgentCallContext({ role: 'orchestrator' }, () =>
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
      stage: 'agentic.pr_review.orchestrator.threw',
      level: 'WARN',
      message: `Orchestrator threw: ${String(error)}`,
      data: { prUrl },
    });
  }

  if (signal?.aborted) return { ok: false, skillsApplied: [] };

  if (!result?.ok || !result.parsedJson) {
    logStep?.({
      stage: 'agentic.pr_review.orchestrator.fallback_high',
      level: 'WARN',
      message: 'Orchestrator tier-1 failed — retrying at high reasoning.',
      data: { prUrl, exitCode: result?.exitCode ?? null },
    });
    try {
      result = await run('high');
    } catch (error) {
      result = undefined;
      logStep?.({
        stage: 'agentic.pr_review.orchestrator.threw',
        level: 'WARN',
        message: `Orchestrator high retry threw: ${String(error)}`,
        data: { prUrl },
      });
    }
  }

  const ok = Boolean(result?.ok && result.parsedJson);
  const knownSkillNames = new Set(promptParams.skills.map(skill => skill.name));
  const rawApplied = ok && Array.isArray(result?.parsedJson?.skillsApplied) ? result.parsedJson.skillsApplied : [];
  const skillsApplied = rawApplied.filter(
    (name): name is string => typeof name === 'string' && knownSkillNames.has(name),
  );

  logStep?.({
    stage: 'agentic.pr_review.orchestrator.done',
    level: ok ? 'INFO' : 'WARN',
    message: `Orchestrator ${ok ? 'produced output' : 'failed after high retry'}.`,
    data: {
      prUrl,
      ok,
      skillsApplied,
      reviewApproach:
        ok && typeof result?.parsedJson?.reviewApproach === 'string' ? result.parsedJson.reviewApproach : undefined,
    },
  });
  return { ok, result: ok ? result : undefined, skillsApplied };
}
