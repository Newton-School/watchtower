import type { WorkflowIntent, WorkflowStepLog } from '../types/contracts.js';

export type FailureDiagnosis = {
  errorKind: string;
  summary: string;
  actions: string[];
};

export function diagnoseFailure(input: {
  workflow: WorkflowIntent;
  message: string;
  logs: WorkflowStepLog[];
}): FailureDiagnosis | undefined {
  const haystack = `${input.message}\n${input.logs
    .map(entry => `${entry.stage} ${entry.message} ${JSON.stringify(entry.data ?? {})}`)
    .join('\n')}`.toLowerCase();
  const codexParseFailureCount = input.logs.filter(
    entry =>
      entry.stage === 'codex.output.parse_failed' ||
      entry.stage === 'codex.output.schema_failed' ||
      entry.stage === 'codex.output.schema_invalid',
  ).length;

  if (
    haystack.includes('hit your session limit') ||
    haystack.includes('hit your usage limit') ||
    haystack.includes('usage limit reached') ||
    haystack.includes('pipeline.usage_limit') ||
    haystack.includes('agent.usage_limit')
  ) {
    return {
      errorKind: 'USAGE_LIMIT',
      summary: 'The Claude account hit its session/usage limit — agent runs exited before any API call.',
      actions: [
        'Wait for the reset time quoted in the limit message, then reply "resume" in the thread.',
        'No code or plan state was lost; the workflow re-runs cleanly after the reset.',
        'If this recurs at the same hour daily, stagger heavy jobs away from interactive usage.',
      ],
    };
  }

  if (haystack.includes('spawn codex enoent') || haystack.includes('codex executable not found')) {
    return {
      errorKind: 'CODEX_BIN_NOT_FOUND',
      summary: 'Codex CLI could not be launched from the app runtime.',
      actions: [
        'Install Codex CLI and ensure it exists in a stable absolute path.',
        'Set CODEX_BIN in app launch environment if needed.',
        'Relaunch Watchtower from /Applications (not a mounted DMG).',
      ],
    };
  }

  if (haystack.includes('node_module_version') || haystack.includes('better-sqlite3')) {
    return {
      errorKind: 'NATIVE_MODULE_ABI_MISMATCH',
      summary: 'A native module ABI mismatch was detected for better-sqlite3.',
      actions: [
        'Rebuild sidecar dependencies against the active Node version.',
        'Prefer one Node runtime path for packaged execution.',
        'Reinstall the latest Watchtower build after rebuild.',
      ],
    };
  }

  if (
    codexParseFailureCount >= 2 ||
    (codexParseFailureCount >= 1 &&
      (haystack.includes('schema mismatch') ||
        haystack.includes('output schema') ||
        haystack.includes('not valid json')))
  ) {
    return {
      errorKind: 'CODEX_OUTPUT_SCHEMA',
      summary: 'Codex output repeatedly failed JSON/schema parsing.',
      actions: [
        'Tighten prompt output instructions to emit strict JSON only.',
        'Log and inspect the raw final message preview for malformed wrappers.',
        'Use fallback salvage parsing and retry only when parsed JSON is unavailable.',
      ],
    };
  }

  if (haystack.includes('enotfound slack.com') || haystack.includes('could not resolve github.com')) {
    return {
      errorKind: 'NETWORK_DNS',
      summary: 'Network/DNS resolution failed while contacting Slack or GitHub.',
      actions: [
        'Verify internet and DNS stability on the host.',
        'Retry the task once connectivity is restored.',
        'Consider adding a secondary DNS resolver for reliability.',
      ],
    };
  }

  const githubAuthOrApiError =
    /api\.github\.com[^\n]*(error|failed|forbidden|unauthorized|timed out|unreachable|refused|denied|401|403|404)/.test(
      haystack,
    ) ||
    /github(?:\s+auth|\s+authentication)?[^\n]*(failed|failure|error|invalid|denied|forbidden|unauthorized|missing|expired)/.test(
      haystack,
    ) ||
    /token[^\n]*(invalid|expired|missing|denied|forbidden|unauthorized|revoked|scope)/.test(haystack) ||
    haystack.includes('bad credentials') ||
    haystack.includes('resource not accessible by integration') ||
    haystack.includes('insufficient scope');

  if (githubAuthOrApiError) {
    return {
      errorKind: 'GITHUB_AUTH_OR_API',
      summary: 'GitHub API/auth failed during workflow execution.',
      actions: [
        'Check GitHub token scope/validity (repo + pull request access).',
        'Verify API connectivity from the host.',
        'Retry after refreshing credentials.',
      ],
    };
  }

  // --- Pipeline-specific error patterns (must come before generic timeout) ---

  if (haystack.includes('error_max_turns')) {
    return {
      errorKind: 'AGENT_MAX_TURNS',
      summary: 'The coder agent ran out of turns before finishing.',
      actions: [
        'The agent made progress but ran out of turns. Changes may be partially committed.',
        'Retry with a narrower task scope.',
        'Check the workspace for uncommitted changes.',
      ],
    };
  }

  if (haystack.includes('pipeline.abort') && haystack.includes('critical finding')) {
    // Mine the abort log entry for the verifier/reviewer's own `suggestion`
    // strings and surface those instead of the generic boilerplate. The
    // suggestions are the part users can actually act on.
    const abortLogs = input.logs.filter(entry => entry.stage === 'pipeline.abort');
    const verifierSuggestions: string[] = [];
    let abortingRole: string | undefined;
    for (const entry of abortLogs) {
      const data = entry.data as { role?: string; criticalFindings?: Array<Record<string, unknown>> } | undefined;
      if (!data) continue;
      if (!abortingRole && typeof data.role === 'string') abortingRole = data.role;
      const findings = Array.isArray(data.criticalFindings) ? data.criticalFindings : [];
      for (const f of findings) {
        const suggestion = typeof f.suggestion === 'string' ? f.suggestion.trim() : '';
        if (suggestion) verifierSuggestions.push(suggestion);
      }
    }

    const uniqueSuggestions = Array.from(new Set(verifierSuggestions));
    const actions =
      uniqueSuggestions.length > 0
        ? uniqueSuggestions
        : [
            'Review the critical findings in the pipeline results.',
            'Fix the identified issues before re-running the task.',
            'Set abortOnCriticalFinding to false if the finding is a false positive.',
          ];

    return {
      errorKind: 'PIPELINE_CRITICAL_FINDING',
      summary: abortingRole
        ? `The pipeline was aborted because the ${abortingRole} agent found a critical issue.`
        : 'The pipeline was aborted because an agent found a critical issue.',
      actions,
    };
  }

  if (haystack.includes('pipeline.timeout') || haystack.includes('pipeline total timeout')) {
    return {
      errorKind: 'PIPELINE_TOTAL_TIMEOUT',
      summary: 'The multi-agent pipeline exceeded its total execution timeout.',
      actions: [
        'Increase totalTimeoutMs in pipeline configuration.',
        'Reduce the number of agents in the pipeline.',
        'Narrow the task scope for faster agent execution.',
      ],
    };
  }

  if (haystack.includes('feedback_loop') && (haystack.includes('exhausted') || haystack.includes('max'))) {
    return {
      errorKind: 'REVIEWER_LOOP_EXHAUSTED',
      summary: 'The reviewer-coder feedback loop reached maximum retries without approval.',
      actions: [
        'Review the reviewer findings to understand recurring issues.',
        'Increase maxRetryLoops if the task is complex.',
        'Simplify the task scope to reduce iteration cycles.',
      ],
    };
  }

  const agentTimeoutCount = input.logs.filter(
    entry => entry.stage.includes('pipeline.agent') && entry.message.toLowerCase().includes('timeout'),
  ).length;

  if (agentTimeoutCount > 0) {
    return {
      errorKind: 'AGENT_TIMEOUT',
      summary: 'One or more pipeline agents timed out during execution.',
      actions: [
        'Increase perAgentTimeoutMs in pipeline configuration.',
        'Check if the agent task is too complex for the allocated time.',
        'Consider using a faster model profile for non-critical agents.',
      ],
    };
  }

  // --- Workspace / repository errors ---

  if (
    haystack.includes('not a git repository') ||
    haystack.includes('coder-empty-output') ||
    (haystack.includes('coder') && haystack.includes('empty_output'))
  ) {
    return {
      errorKind: 'REPO_NOT_FOUND',
      summary: 'Agents ran without a valid git repository — no code changes were possible.',
      actions: [
        'Check that the repo classifier resolved a valid repository (look for workflow.repo.classified in logs).',
        'Ensure the target repo path exists and is accessible.',
        'Retry and mention the repo name explicitly (e.g., "in newton-web" or "in newton-marketing-web").',
      ],
    };
  }

  // --- Generic error patterns ---

  if (haystack.includes('timeout') || haystack.includes('timed out')) {
    return {
      errorKind: 'WORKFLOW_TIMEOUT',
      summary: 'The workflow hit its execution timeout.',
      actions: [
        'Increase timeout in Settings for this workflow.',
        'Narrow the task scope (smaller PR/context).',
        'Retry after reducing external dependency latency.',
      ],
    };
  }

  if (haystack.includes('missing_scope')) {
    // Extract context about which API call triggered the missing_scope error
    const scopeLog = input.logs.find(
      entry => entry.message.toLowerCase().includes('missing_scope') || entry.stage.includes('user.resolve'),
    );
    const scopeContext = scopeLog?.stage ?? '';
    const isUserResolve = scopeContext.includes('user.resolve');
    const missingScope = isUserResolve ? 'users:read' : 'unknown';
    return {
      errorKind: 'SLACK_SCOPE',
      summary: `Slack scope is missing: likely \`${missingScope}\` (from ${scopeContext || 'unknown API call'}).`,
      actions: [
        `Add the missing scope (\`${missingScope}\`) to the Slack app.`,
        'Reinstall/re-authorize the app in the workspace after adding scopes.',
      ],
    };
  }

  if (haystack.includes('429') || haystack.includes('rate limit')) {
    return {
      errorKind: 'RATE_LIMIT',
      summary: 'Rate limiting was encountered while executing API operations.',
      actions: [
        'Retry with backoff and lower parallelism.',
        'Reduce redundant retries for non-critical follow-up actions.',
      ],
    };
  }

  return undefined;
}
