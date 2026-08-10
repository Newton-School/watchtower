import { describe, expect, it } from 'vitest';
import {
  HIGH_REASONING_CODEX_PROFILE,
  LIGHTWEIGHT_CODEX_PROFILE,
  highReasoningProfile,
  lightweightProfile,
  profileForAgentRole,
} from '../src/codex/modelProfiles.js';
import { getModelPricing } from '../src/pricing/modelPrices.js';
import type { AgentRole } from '../src/agents/types.js';
import type { AgentBackendId } from '../src/backends/types.js';

// The claude-code column is the LIVE backend (app_settings.agent_backend), but
// until this file existed every model/effort assertion in the suite exercised
// the codex column only — a broken live tier shipped green. Pin it here.
describe('modelProfiles — claude-code column (live backend)', () => {
  it('lightweight tier is sonnet at low effort', () => {
    expect(lightweightProfile('claude-code')).toEqual({
      model: 'claude-sonnet-5',
      reasoningEffort: 'low',
    });
  });

  it('highReasoning tier is opus at xhigh effort', () => {
    expect(highReasoningProfile('claude-code')).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'xhigh',
    });
  });

  it('planner override runs opus at xhigh, not max', () => {
    expect(profileForAgentRole('planner', 'claude-code')).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'xhigh',
    });
  });

  it('coder/reviewer/security resolve to the high tier; performance/verifier to the light tier', () => {
    for (const role of ['coder', 'reviewer', 'security'] as const) {
      expect(profileForAgentRole(role, 'claude-code')).toEqual(highReasoningProfile('claude-code'));
    }
    for (const role of ['performance', 'verifier'] as const) {
      expect(profileForAgentRole(role, 'claude-code')).toEqual(lightweightProfile('claude-code'));
    }
  });
});

describe('modelProfiles — every producible model has a price entry', () => {
  // computeCostUsd silently records NULL cost for any model id missing from
  // PRICES (99.6% of live rows are cost_source='computed'), so a profile
  // pointing at an unpriced model under-reports spend with no warning.
  it('all profile-table models are priced', () => {
    const roles: AgentRole[] = ['planner', 'coder', 'reviewer', 'security', 'performance', 'verifier'];
    const backends: AgentBackendId[] = ['claude-code', 'codex'];
    const models = new Set<string>();
    for (const backend of backends) {
      models.add(lightweightProfile(backend).model);
      models.add(highReasoningProfile(backend).model);
      for (const role of roles) {
        models.add(profileForAgentRole(role, backend).model);
      }
    }
    models.add(LIGHTWEIGHT_CODEX_PROFILE.model);
    models.add(HIGH_REASONING_CODEX_PROFILE.model);
    for (const model of models) {
      expect(getModelPricing(model), `missing price entry for ${model}`).toBeDefined();
    }
  });

  // Pin the actual rates for the live tier so a fat-fingered decimal fails the
  // build — cost telemetry is computed from these on 99.6% of rows.
  it('live-tier prices match Anthropic list pricing', () => {
    expect(getModelPricing('claude-opus-5')).toEqual({
      inputPer1k: 0.005,
      outputPer1k: 0.025,
      cacheReadPer1k: 0.0005,
      cacheCreatePer1k: 0.00625,
    });
    expect(getModelPricing('claude-sonnet-5')).toEqual({
      inputPer1k: 0.003,
      outputPer1k: 0.015,
      cacheReadPer1k: 0.0003,
      cacheCreatePer1k: 0.00375,
    });
  });
});
