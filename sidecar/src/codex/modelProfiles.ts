import type { CodexReasoningEffort } from '../types/contracts.js';
import type { AgentRole } from '../agents/types.js';
import type { AgentBackendId } from '../backends/types.js';

export type CodexExecutionProfile = {
  model: string;
  reasoningEffort: CodexReasoningEffort;
};

function readOverride(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const LIGHTWEIGHT_CODEX_PROFILE: CodexExecutionProfile = {
  model: readOverride('WATCHTOWER_LIGHTWEIGHT_CODEX_MODEL') ?? 'gpt-5.2-codex',
  reasoningEffort: 'low',
};

export const HIGH_REASONING_CODEX_PROFILE: CodexExecutionProfile = {
  model: readOverride('WATCHTOWER_HIGH_REASONING_CODEX_MODEL') ?? 'gpt-5.4',
  reasoningEffort: 'xhigh',
};

// Escape hatches for the live backend, mirroring the codex pair above: model
// id only (never effort), read once at module load — a change requires a
// sidecar restart. An override id missing from pricing/modelPrices.ts records
// NULL cost silently; the price guard in modelProfiles.test.ts only covers
// the table defaults.
const CLAUDE_LIGHTWEIGHT_MODEL = readOverride('WATCHTOWER_CLAUDE_LIGHTWEIGHT_MODEL') ?? 'claude-sonnet-5-5';
const CLAUDE_HIGH_REASONING_MODEL = readOverride('WATCHTOWER_CLAUDE_HIGH_REASONING_MODEL') ?? 'claude-opus-5-5';

type BackendProfileTable = Record<'lightweight' | 'highReasoning', CodexExecutionProfile>;

const BACKEND_PROFILES: Record<AgentBackendId, BackendProfileTable> = {
  codex: {
    lightweight: LIGHTWEIGHT_CODEX_PROFILE,
    highReasoning: HIGH_REASONING_CODEX_PROFILE,
  },
  'claude-code': {
    lightweight: {
      model: CLAUDE_LIGHTWEIGHT_MODEL,
      reasoningEffort: 'low',
    },
    // high, not xhigh: Opus 5.5 thinks more per turn than Opus 5 at the same
    // level (most at xhigh), and Anthropic measured Opus 5.5 at medium above
    // Opus 5 at high — so this keeps Opus 5 @ xhigh quality without longer
    // turns on the uncapped planner/investigator runs.
    highReasoning: {
      model: CLAUDE_HIGH_REASONING_MODEL,
      reasoningEffort: 'high',
    },
  },
};

const ROLE_TIER: Record<AgentRole, 'lightweight' | 'highReasoning'> = {
  planner: 'lightweight',
  coder: 'highReasoning',
  reviewer: 'highReasoning',
  security: 'highReasoning',
  performance: 'lightweight',
  verifier: 'lightweight',
};

export function profileForAgentRole(role: AgentRole, backendId: AgentBackendId): CodexExecutionProfile {
  const backend = backendId;
  if (role === 'planner' && backend === 'claude-code') {
    // The high tier, never max: max is prone to overthinking with diminishing
    // returns, and this is the least-bounded call in the system (no timeout,
    // up to 3 runs per job). See docs/model-effort-audit.md.
    return BACKEND_PROFILES[backend].highReasoning;
  }
  if (role === 'verifier' && backend === 'claude-code') {
    // medium, not the tier's low: at low Sonnet 5.5 often reports a change as
    // checked without running the tests or build, and this is the last gate
    // before a PR opens.
    return {
      model: CLAUDE_LIGHTWEIGHT_MODEL,
      reasoningEffort: 'medium',
    };
  }
  const tier = ROLE_TIER[role];
  return BACKEND_PROFILES[backend][tier];
}

export function highReasoningProfile(backendId: AgentBackendId): CodexExecutionProfile {
  return BACKEND_PROFILES[backendId].highReasoning;
}

export function lightweightProfile(backendId: AgentBackendId): CodexExecutionProfile {
  return BACKEND_PROFILES[backendId].lightweight;
}
