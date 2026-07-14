import type { AgentBackendId, CodexRunRequest, CodexRunResult, TokenUsage } from '../types/contracts.js';

export type { AgentBackendId };

export type AgentRunRequest = CodexRunRequest;
export type AgentRunResult = CodexRunResult;

export interface ParseOutputOptions {
  /**
   * The run executed under `--permission-mode plan` (planner agent). Enables
   * plan-specific salvage (plan-file recovery, harness-meta stripping) that
   * must never touch ordinary runs (#408 review).
   */
  planMode?: boolean;
}

export interface ParsedBackendOutput {
  parsedJson?: Record<string, unknown>;
  strategy?: string;
  usage?: TokenUsage;
  costUsd?: number;
  sessionId?: string;
}

export interface AgentBackend {
  id: AgentBackendId;
  displayName: string;
  resolveBinary(): string;
  isAvailable(): boolean;
  supportsImages(): boolean;
  buildArgs(request: AgentRunRequest, outputPath: string): string[];
  buildEnv(request: AgentRunRequest, basePath: string): Record<string, string>;
  parseOutput(raw: string, opts?: ParseOutputOptions): ParsedBackendOutput;
  availableModels(): string[];
  defaultModel(): string;
}
