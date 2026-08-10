import type { TokenUsage } from '../types/contracts.js';

/**
 * Price per 1,000 tokens in USD. Numbers reflect public list pricing at the
 * time of capture. Used as a fallback when the backend does not report
 * `cost_usd` directly. Update as providers change pricing.
 */
export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
  cacheReadPer1k?: number;
  cacheCreatePer1k?: number;
}

const PRICES: Record<string, ModelPricing> = {
  // Anthropic Claude
  'claude-opus-5': {
    inputPer1k: 0.005,
    outputPer1k: 0.025,
    cacheReadPer1k: 0.0005,
    cacheCreatePer1k: 0.00625,
  },
  'claude-sonnet-5': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cacheReadPer1k: 0.0003,
    cacheCreatePer1k: 0.00375,
  },
  // Opus 4.7 lists at $5/$25 per MTok — this previously carried legacy
  // Opus 4.0/4.1 rates ($15/$75), inflating every recorded cost ~3x.
  'claude-opus-4-7': {
    inputPer1k: 0.005,
    outputPer1k: 0.025,
    cacheReadPer1k: 0.0005,
    cacheCreatePer1k: 0.00625,
  },
  'claude-sonnet-4-6': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cacheReadPer1k: 0.0003,
    cacheCreatePer1k: 0.00375,
  },
  'claude-opus-4-20250514': {
    inputPer1k: 0.015,
    outputPer1k: 0.075,
    cacheReadPer1k: 0.0015,
    cacheCreatePer1k: 0.01875,
  },
  'claude-sonnet-4-20250514': {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cacheReadPer1k: 0.0003,
    cacheCreatePer1k: 0.00375,
  },
  // OpenAI Codex / GPT
  'gpt-5.4': {
    inputPer1k: 0.015,
    outputPer1k: 0.06,
  },
  'gpt-5.2-codex': {
    inputPer1k: 0.005,
    outputPer1k: 0.02,
  },
};

export function getModelPricing(modelId: string | undefined): ModelPricing | undefined {
  if (!modelId) return undefined;
  return PRICES[modelId];
}

/**
 * Compute USD cost from token usage and a model id. Returns undefined when
 * no pricing is known for the model or no usage is provided.
 */
export function computeCostUsd(usage: TokenUsage | undefined, modelId: string | undefined): number | undefined {
  if (!usage) return undefined;
  const pricing = getModelPricing(modelId);
  if (!pricing) return undefined;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreate = usage.cacheCreationTokens ?? 0;

  const cost =
    (input / 1000) * pricing.inputPer1k +
    (output / 1000) * pricing.outputPer1k +
    (cacheRead / 1000) * (pricing.cacheReadPer1k ?? 0) +
    (cacheCreate / 1000) * (pricing.cacheCreatePer1k ?? 0);

  return Number.isFinite(cost) ? cost : undefined;
}
