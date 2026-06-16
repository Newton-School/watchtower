import type { AppConfig, NormalizedTask, PrContext, WorkflowIntent } from '../types/contracts.js';

export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'security' | 'performance' | 'verifier';
export type AgentStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface AgentFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface AgentStepResult {
  role: AgentRole;
  status: AgentStepStatus;
  output: Record<string, unknown>;
  findings: AgentFinding[];
  durationMs: number;
}

export interface AgentContext {
  workflowIntent: WorkflowIntent;
  task: NormalizedTask;
  config: AppConfig;
  repoPath: string;
  githubToken?: string;
  threadContext: string;
  prContext?: PrContext;
  previousSteps: AgentStepResult[];
  pipelineConfig: PipelineConfig;
  policyPack?: { packName: string; rules: string[] };
  imagePaths?: string[];
  requestedBy?: string;
  /**
   * The coder's actual changes (git diff vs the pre-coder base), captured by the
   * pipeline after the coder runs. Fed to the reviewer/verifier so they assess
   * the real diff against the approved plan rather than the coder's self-report (#388).
   */
  coderDiff?: { diff: string; truncated: boolean };
}

export interface PipelineConfig {
  agents: AgentRole[];
  maxRetryLoops: number;
  perAgentTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortOnCriticalFinding: boolean;
  slackProgressUpdates: boolean;
  requireApproval?: boolean;
}

export interface PipelineResult {
  steps: AgentStepResult[];
  finalStatus: 'passed' | 'failed' | 'aborted' | 'needs-input' | 'usage-limit';
  totalDurationMs: number;
  retryLoops: number;
  aggregatedFindings: AgentFinding[];
  needsInputQuestion?: string;
  /** Verbatim reset clause when finalStatus === 'usage-limit' (issue #342). */
  usageLimitResetsAt?: string;
}
