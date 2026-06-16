import type { AgentContext, AgentRole } from './types.js';
import { sanitizeForBranch, buildSlackThreadLink } from '../workflows/shared/workflowUtils.js';
import { getActiveBackendId } from '../codex/runCodex.js';

function serializePreviousSteps(ctx: AgentContext): string {
  if (ctx.previousSteps.length === 0) return 'No previous agent steps.';
  return ctx.previousSteps
    .map(
      step =>
        `[${step.role}] status=${step.status} duration=${step.durationMs}ms findings=${step.findings.length}\nOutput: ${JSON.stringify(step.output, null, 2)}`,
    )
    .join('\n\n');
}

function policyBlock(ctx: AgentContext): string {
  if (!ctx.policyPack) return 'No explicit policy pack assigned.';
  return [`Active policy pack: ${ctx.policyPack.packName}`, ...ctx.policyPack.rules.map(r => `- ${r}`)].join('\n');
}

/** The approved plan the coder/reviewer/verifier all read off the planner step. */
function planFromSteps(ctx: AgentContext): { planMarkdown: string; scope: string; affectedFiles: string[] } {
  const plannerStep = ctx.previousSteps.find(s => s.role === 'planner');
  const plannerOutput = (plannerStep?.output ?? {}) as Record<string, unknown>;
  const planMarkdown = typeof plannerOutput.planMarkdown === 'string' ? plannerOutput.planMarkdown : '';
  const scope = typeof plannerOutput.scope === 'string' ? plannerOutput.scope : 'medium';
  const affectedFiles = Array.isArray(plannerOutput.affectedFiles)
    ? (plannerOutput.affectedFiles as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];
  return { planMarkdown, scope, affectedFiles };
}

/**
 * Renders the coder's ACTUAL diff for the reviewer/verifier (#388). They run in the
 * coder's worktree, so when the diff isn't pre-captured they can still fall back to
 * `git diff`. Compares-against-reality beats trusting the coder's self-report.
 */
function coderDiffSection(ctx: AgentContext): string {
  if (!ctx.coderDiff || ctx.coderDiff.diff.trim().length === 0) {
    return 'Actual code changes (git diff): not captured — run `git diff` in the worktree to inspect the real changes before judging.';
  }
  const truncNote = ctx.coderDiff.truncated
    ? '\n…(diff truncated — run `git diff` in the worktree for the full change)'
    : '';
  return `Actual code changes (git diff vs base — review THIS, not the coder's summary):
\`\`\`diff
${ctx.coderDiff.diff}
\`\`\`${truncNote}`;
}

export function buildPlannerPrompt(ctx: AgentContext): string {
  return `
You are the PLANNER agent in a multi-agent pipeline.

Your role: Analyze the task, identify risks, and produce a structured plan for downstream agents.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}
Policy: ${policyBlock(ctx)}

Thread context:
${ctx.threadContext}

${ctx.prContext ? `PR context: ${ctx.prContext.url} (${ctx.prContext.owner}/${ctx.prContext.repo}#${ctx.prContext.number})` : ''}

IMPORTANT: "requiresCodeChanges" rules:
- Set to true when the user requests ANY implementation, feature, fix, change, or modification — even if similar code already exists in the repo.
- The user's explicit request takes priority. If they say "I want to…", "add…", "implement…", "fix…", "block…", "create…", "change…", or "update…" — that is an implementation request and requiresCodeChanges MUST be true.
- Set to false for purely informational requests (explain, describe, list, check status, answer a question) where NO file changes are needed.
- Set to false for operational/lifecycle actions that do NOT modify source code: merge PR, close PR, deploy, run tests, restart service, check CI status, approve PR, assign reviewers.
- The key distinction: if the user wants to CHANGE source code files → true. If the user wants to perform a git/GitHub/infrastructure action on existing code → false.

CLARIFICATION (\`clarificationNeeded\`):
- If the task is ambiguous and you CANNOT safely decide which files to change or which behavior the user wants, set \`clarificationNeeded\` to ONE specific question for the requester. Keep it short and concrete — the kind of question that unblocks planning in one exchange.
- Prefer clarifying over guessing when the stakes are writes: wrong endpoint, wrong page, wrong repo, wrong function signature, etc.
- Do NOT ask a clarification for things you can reasonably infer from thread context, repo layout, or common sense. Only ask when there is a real fork in the plan.
- When \`clarificationNeeded\` is set, still fill in the other fields with your best provisional guess; the plan will be re-generated after the user answers.
- Set to null (or omit) when no clarification is needed.

Return strict JSON:
{
  "plan": string[],                  // ordered steps for execution
  "affectedFiles": string[],         // files likely to be touched
  "scope": "small" | "medium" | "large",
  "requiresCodeChanges": boolean,
  "clarificationNeeded": string | null  // single question for the requester, or null
}
`.trim();
}

export function buildPlannerPlanModePrompt(ctx: AgentContext): string {
  return `
You are the PLANNER for a multi-agent coding pipeline. You are running in plan mode: explore the repo with read-only tools, then produce a concrete implementation plan via ExitPlanMode.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}
Policy: ${policyBlock(ctx)}

Thread context:
${ctx.threadContext}

${ctx.prContext ? `PR context: ${ctx.prContext.url} (${ctx.prContext.owner}/${ctx.prContext.repo}#${ctx.prContext.number})` : ''}

What to produce in your ExitPlanMode plan (markdown is fine; the downstream coder agent reads it verbatim):
- A short summary of the user's intent.
- The concrete files you expect to touch, with brief rationale per file.
- An ordered list of implementation steps.
- A scope tag on its own line, exactly one of: \`Scope: small\`, \`Scope: medium\`, or \`Scope: large\`. Treat anything under ~50 lines across 1–2 files as small; multi-file feature work as medium; cross-cutting refactors or new subsystems as large. Coder agent uses this to decide whether to include tests in the PR.
- A code-changes tag on its own line, exactly one of: \`Requires code changes: yes\` or \`Requires code changes: no\`. Set \`no\` ONLY for purely informational requests (explain, describe, list, check status, answer a question) or operational/lifecycle actions that do NOT modify source (merge PR, close PR, deploy, run tests, restart service). For ANY implementation, feature, fix, change, or modification of source files set \`yes\`; when in doubt, \`yes\`.
- Anything the coder MUST avoid (existing patterns, deprecated APIs, owner conventions).

Use the read tools (grep, file reads) to ground every claim — do not guess at file paths or function signatures. If the task is genuinely ambiguous and you cannot safely pick a direction, say so at the top of the plan with a short clarifying question; otherwise commit to a direction.
`.trim();
}

export function buildCoderPrompt(ctx: AgentContext): string {
  const reviewerFeedback = ctx.previousSteps.filter(s => s.role === 'reviewer');
  const { planMarkdown, scope, affectedFiles } = planFromSteps(ctx);

  return `
You are the CODER agent in a multi-agent pipeline.

Your role: Implement the plan from the planner agent. Write code, create tests, commit, and open a PR.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}
Plan scope: ${scope}
${affectedFiles.length > 0 ? `Likely files to touch: ${affectedFiles.map(f => `\`${f}\``).join(', ')}` : ''}

Plan to implement:
${planMarkdown || 'No plan markdown available.'}

${reviewerFeedback.length > 0 ? `Reviewer feedback (address these issues):\n${reviewerFeedback.map(r => r.findings.map(f => `- [${f.severity}] ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}`).join('\n')).join('\n')}` : ''}

Thread context:
${ctx.threadContext}

Requirements:
1. Work EXCLUSIVELY in ${ctx.repoPath}. This is an isolated git worktree prepared for you.
   - DO NOT \`cd\` out of this directory for ANY reason.
   - DO NOT run git commands against any other clone or path (e.g., paths under the user's home directory).
   - DO NOT \`git clone\` anything — the working tree you were given is the only repo you may touch.
   - If the worktree appears to be the wrong repo for the task (files from the planner's scope are missing), return {"status":"failed","summary":"wrong-repo-assigned: …"} instead of switching directories. A supervisor will re-run the task with the correct repo.
2. Create a NEW branch named ${ctx.requestedBy ? `${sanitizeForBranch(ctx.requestedBy)}/` : ''}<short-task-name>-${ctx.task.event.threadTs.replace('.', '-')} (the suffix ensures uniqueness — do NOT reuse or checkout an existing branch)
3. Implement changes and write tests to verify correctness. Run the tests to make sure everything works.
   IMPORTANT: If the planner scope is "small" or "medium", do NOT include test files in the commit or PR — only commit the source code changes. Delete or git-restore any test files you created before committing. For "large" scope, include tests in the PR.
4. Commit and open a PR to the default branch.${ctx.requestedBy ? ` Prefix the PR title with [${ctx.requestedBy} via miniOG], e.g. "[${ctx.requestedBy} via miniOG] Fix button text".` : ''}
   In the PR description, always include this at the top:
   > Requested by **${ctx.requestedBy ?? 'Unknown'}** via Slack · [View thread](${buildSlackThreadLink(ctx.task.event.channelId, ctx.task.event.threadTs)})

   And this metadata block at the end:
   ---
   **Raised by:** miniOG (Watchtower)${ctx.requestedBy ? `\n   **Triggered by:** ${ctx.requestedBy} via Slack` : ''}
   **Workflow:** ${ctx.workflowIntent}
   **Thread:** ${ctx.task.event.threadTs}
5. When creating the PR with \`gh pr create\`, include the flag \`--label miniog\` to tag it
6. Do not run destructive git commands

Return strict JSON:
{
  "filesChanged": string[],
  "summary": string,
  "testsAdded": string[],
  "branch": string,
  "prUrl": string          // URL of the PR you created (empty string if PR creation failed)
}
`.trim();
}

export function buildReviewerPrompt(ctx: AgentContext): string {
  const { planMarkdown, scope, affectedFiles } = planFromSteps(ctx);
  const coderOutput = ctx.previousSteps.find(s => s.role === 'coder');

  return `
You are the REVIEWER agent in a multi-agent pipeline.

Your role: Review the code changes for correctness, maintainability, and — above all — conformance to the approved plan.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}
Policy: ${policyBlock(ctx)}

Approved plan (the admin signed off on THIS — review against it):
${planMarkdown || 'No plan markdown available.'}
${affectedFiles.length > 0 ? `Planned files: ${affectedFiles.map(f => `\`${f}\``).join(', ')}` : ''}
Plan scope: ${scope}

Coder's self-reported output (do NOT trust this over the diff):
${coderOutput ? JSON.stringify(coderOutput.output, null, 2) : 'No coder output.'}

${coderDiffSection(ctx)}

PLAN CONFORMANCE (hard gate — check this FIRST):
Compare the ACTUAL diff above against the approved plan's intent — not the coder's
self-description. If the diff does NOT accomplish the approved plan — e.g. it makes a
different or narrower change, implements the original request instead of the revised
plan, touches the wrong files, or only partially implements it — you MUST:
  • set "approved": false, and
  • add a finding { "severity": "high", "category": "plan-mismatch", "message": "<what the plan asked vs what the diff actually does>" }.
Do not approve work that diverges from the approved plan, even if the code is clean.
(Use "high", not "critical", so the coder gets a chance to correct on the same branch.)

Review checklist:
- Does the diff actually implement the approved plan? (see PLAN CONFORMANCE above)
- Are there logic errors, edge cases, or regressions?
- Are tests adequate and meaningful?
- Is the code clean, readable, and maintainable?
- Are there any missing error handlers or boundary conditions?

Return strict JSON:
{
  "approved": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }],
  "blockers": string[]
}
`.trim();
}

export function buildSecurityPrompt(ctx: AgentContext): string {
  return `
You are the SECURITY agent in a multi-agent pipeline.

Your role: Audit the code changes for security vulnerabilities and compliance issues.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Previous agent results:
${serializePreviousSteps(ctx)}

Security audit checklist:
1. SQL injection, command injection, XSS
2. Broken authentication or authorization
3. Sensitive data exposure (tokens, keys, PII in logs)
4. Insecure deserialization
5. Known CVE patterns in dependencies
6. Secrets or credentials in code
7. CSRF and SSRF vulnerabilities
8. Path traversal
9. Unsafe eval or dynamic code execution
10. Missing input validation at system boundaries

Return strict JSON:
{
  "approved": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }],
  "overallSeverity": "clean" | "low" | "medium" | "high" | "critical"
}
`.trim();
}

export function buildPerformancePrompt(ctx: AgentContext): string {
  return `
You are the PERFORMANCE agent in a multi-agent pipeline.

Your role: Analyze code changes for performance issues and optimization opportunities.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Previous agent results:
${serializePreviousSteps(ctx)}

Performance audit checklist:
1. N+1 database queries
2. Unbounded iterations or recursion
3. Memory leaks (unclosed streams, retained references)
4. Unnecessary React re-renders
5. Large bundle size additions
6. Missing database indexes for new queries
7. Unoptimized images or assets
8. Synchronous blocking in async paths
9. Excessive network round trips
10. Missing pagination or limits on data fetches

Return strict JSON:
{
  "approved": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }]
}
`.trim();
}

export function buildVerifierPrompt(ctx: AgentContext): string {
  const { planMarkdown, scope, affectedFiles } = planFromSteps(ctx);

  return `
You are the VERIFIER agent in a multi-agent pipeline.

Your role: Verify that all previous agent outputs are consistent, tests pass, and the approved plan's requirements are actually met by the code.

Workflow: ${ctx.workflowIntent}
Repository: ${ctx.repoPath}

Approved plan (verify the code fulfils THIS):
${planMarkdown || 'No plan markdown available.'}
${affectedFiles.length > 0 ? `Planned files: ${affectedFiles.map(f => `\`${f}\``).join(', ')}` : ''}
Plan scope: ${scope}

${coderDiffSection(ctx)}

Previous agent results:
${serializePreviousSteps(ctx)}

Verification checklist:
1. Run the project's test suite and confirm tests pass
2. PLAN CONFORMANCE: confirm the ACTUAL diff above fulfils the approved plan's intent — not just that some files changed. If the diff implements a different or narrower change than the approved plan, set "verified": false, "requirementsMet": false, and add a { "severity": "high", "category": "plan-mismatch", "message": "<plan vs diff>" } finding.
3. Confirm reviewer and security findings were addressed (if any)
4. Validate the PR is in a mergeable state
5. Check that no regressions were introduced

Return strict JSON:
{
  "verified": boolean,
  "testsPassed": boolean,
  "requirementsMet": boolean,
  "findings": [{ "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file": string, "line": number, "suggestion": string }]
}
`.trim();
}

const PROMPT_BUILDERS: Record<AgentRole, (ctx: AgentContext) => string> = {
  planner: buildPlannerPrompt,
  coder: buildCoderPrompt,
  reviewer: buildReviewerPrompt,
  security: buildSecurityPrompt,
  performance: buildPerformancePrompt,
  verifier: buildVerifierPrompt,
};

export function buildPromptForRole(role: AgentRole, ctx: AgentContext): string {
  if (role === 'planner' && getActiveBackendId() === 'claude-code') {
    return buildPlannerPlanModePrompt(ctx);
  }
  return PROMPT_BUILDERS[role](ctx);
}
