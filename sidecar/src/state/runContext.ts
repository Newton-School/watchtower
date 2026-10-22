import { AsyncLocalStorage } from 'node:async_hooks';
import type { JobStore } from './jobStore.js';

export interface AgentCallContext {
  jobId: string;
  store: JobStore;
  pipelineRunId?: string;
  role?: string;
}

/**
 * AsyncLocalStorage that propagates the current job/pipeline context so that
 * runCodex can record agent_calls, and a gate can record that it waits on a
 * person, without every workflow having to plumb `store` and `jobId` through
 * its signature.
 *
 * Set once at the top of a workflow dispatch with `agentCallContext.run({
 * jobId, store }, () => ...)`. Pipeline stages may extend with their own role
 * and pipelineRunId via a nested `run`.
 */
export const agentCallContext = new AsyncLocalStorage<AgentCallContext>();

/**
 * Convenience to extend the current context with additional fields (typically
 * `role` and `pipelineRunId`) for the duration of `fn`.
 */
export function withAgentCallContext<T>(extras: Partial<AgentCallContext>, fn: () => Promise<T>): Promise<T> {
  const parent = agentCallContext.getStore();
  if (!parent) {
    // No parent context — running outside a workflow dispatch (e.g. intent
    // classifier). Nothing to extend; just run.
    return fn();
  }
  return agentCallContext.run({ ...parent, ...extras }, fn);
}
