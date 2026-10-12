/**
 * What to tell a thread whose request was waiting on a person when the
 * sidecar restarted (issue #436). The wait lives in the process, so a
 * restart drops it; before this the job was failed without a word and the
 * requester's plan was simply gone.
 */
export type HumanGate = 'approval' | 'clarification' | 'repo_choice' | 'confirmation';

/** Last job_logs stage → the gate the job was parked at, if it was parked. */
const GATE_BY_STAGE: Record<string, HumanGate> = {
  'pipeline.approval.waiting': 'approval',
  'implementation.approval.waiting': 'approval',
  'pipeline.approval.unauthorized': 'approval',
  'pipeline.approval.ignored': 'approval',
  'pipeline.approval.reminder': 'approval',
  'pipeline.clarification.waiting': 'clarification',
  'pipeline.repo_choice.waiting': 'repo_choice',
  'pipeline.repo_choice.unclear': 'repo_choice',
  'deploy.confirm.waiting': 'confirmation',
  'deploy.confirm.unauthorized': 'confirmation',
  'implementation.quick_action.confirm.waiting': 'confirmation',
  'implementation.quick_action.confirm.unauthorized': 'confirmation',
};

export function humanGateForStage(stage: string | undefined): HumanGate | undefined {
  return stage ? GATE_BY_STAGE[stage] : undefined;
}

export function buildRestartNotice(params: { gate: HumanGate; requestedBy?: string }): string {
  const who = params.requestedBy ? `<@${params.requestedBy}>, ` : '';
  switch (params.gate) {
    case 'approval':
      return `I was restarted while this plan was waiting for approval, so I've dropped it. ${who}mention me again with the request and I'll plan it afresh.`;
    case 'confirmation':
      return `I was restarted while waiting for a confirmation here, so nothing was done. ${who}ask again if you still want it.`;
    default:
      return `I was restarted while waiting for a reply here, so I've dropped this request. ${who}mention me again to restart it.`;
  }
}
