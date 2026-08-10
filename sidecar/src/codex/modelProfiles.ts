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

type BackendProfileTable = Record<'lightweight' | 'highReasoning', CodexExecutionProfile>;

const BACKEND_PROFILES: Record<AgentBackendId, BackendProfileTable> = {
  codex: {
    lightweight: LIGHTWEIGHT_CODEX_PROFILE,
    highReasoning: HIGH_REASONING_CODEX_PROFILE,
  },
  'claude-code': {
    lightweight: {
      model: 'claude-sonnet-5',
      reasoningEffort: 'low',
    },
    highReasoning: {
      model: 'claude-opus-5',
      reasoningEffort: 'xhigh',
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

export function profileForAgentRole(role: AgentRole, backendId?: AgentBackendId): CodexExecutionProfile {
  const backend = backendId ?? 'codex';
  if (role === 'planner' && backend === 'claude-code') {
    // xhigh, not max: max is prone to overthinking with diminishing returns on
    // Opus 5, and this is the least-bounded call in the system (no timeout,
    // up to 3 runs per job). See docs/model-effort-audit.md.
    return {
      model: 'claude-opus-5',
      reasoningEffort: 'xhigh',
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
