import type { AgentFinding, AgentStepResult, PipelineResult } from './types.js';

/**
 * What the thread is told when a change run did not pass (issue #333).
 *
 * It used to be "Pipeline finished with status: aborted. Not opening a PR."
 * while the coder had already opened one: five times in Sep–Oct 2026 the
 * requester was told no PR existed, and once the owner had to correct it by
 * hand. It now says why the run stopped, what happened to the PR the coder
 * opened, and which findings are still open.
 */

export interface RunPr {
  url: string;
  /** GitHub's state: OPEN, MERGED or CLOSED; UNKNOWN when it could not be read. */
  state: string;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
/** How each agent is named to the requester. */
const ROLE_NAME: Record<string, string> = {
  planner: 'planner',
  coder: 'coder',
  reviewer: 'reviewer',
  security: 'security check',
  performance: 'performance check',
  verifier: 'final check',
};
const MAX_OPEN_FINDINGS = 5;
const FINDING_CHARS = 200;

/** The PR URL the coder reported, from its latest pass that reported one. */
export function coderReportedPrUrl(steps: AgentStepResult[]): string | undefined {
  for (const step of [...steps].reverse()) {
    if (step.role !== 'coder') continue;
    const url = typeof step.output.prUrl === 'string' ? step.output.prUrl.trim() : '';
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return url;
  }
  return undefined;
}

function latestStep(steps: AgentStepResult[], role: string): AgentStepResult | undefined {
  return [...steps].reverse().find(step => step.role === role);
}

/** Findings of medium severity or higher from the latest review and final check, worst first. */
export function openFindings(steps: AgentStepResult[]): AgentFinding[] {
  const fromLatest = ['reviewer', 'security', 'verifier'].flatMap(role => latestStep(steps, role)?.findings ?? []);
  const seen = new Set<string>();
  return fromLatest
    .filter(finding => (SEVERITY_RANK[finding.severity] ?? 0) >= SEVERITY_RANK.medium)
    .filter(finding => {
      const key = `${finding.file ?? ''}:${finding.line ?? ''}:${finding.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

/** Why the run stopped, as a sentence. For a run that was interrupted, the caller already has one. */
export function unfinishedReason(result: PipelineResult): string {
  if (result.budgetExhausted) {
    const minutes = Math.round(result.budgetExhausted.limitMs / 60_000);
    return result.budgetExhausted.lastCoderPassUnreviewed
      ? `I stopped: this run's ${minutes}-minute time limit ran out right after the coder's latest pass, so those changes were not reviewed again.`
      : `I stopped: this run's ${minutes}-minute time limit ran out.`;
  }
  if (result.finalStatus === 'aborted') {
    const critical = [...result.steps]
      .reverse()
      .find(step => step.findings.some(finding => finding.severity === 'critical'));
    return critical
      ? `I stopped: the ${ROLE_NAME[critical.role] ?? critical.role} found a critical issue.`
      : 'I stopped before the checks finished.';
  }
  const failed = [...result.steps].reverse().find(step => step.status === 'failed');
  if (failed?.role === 'verifier') return 'The final check did not pass.';
  if (failed?.role === 'reviewer') {
    return result.retryLoops > 0
      ? `The review still had open findings after ${result.retryLoops} revision${result.retryLoops === 1 ? '' : 's'}.`
      : 'The review did not pass.';
  }
  if (failed?.role === 'coder') return "The coder's run failed.";
  return 'The checks did not pass.';
}

/** What happened to the coder's PR, or that there is none. */
export function prLine(pr: RunPr | undefined): string {
  if (!pr) return 'I did not open a PR.';
  if (pr.state === 'MERGED') return `The coder had already opened ${pr.url}, and it has since been merged.`;
  if (pr.state === 'CLOSED') return `The coder had opened ${pr.url}; it is closed now.`;
  return `The coder already opened ${pr.url}, but it has not passed the checks: review it before merging, or close it and mention me again.`;
}

function findingLine(finding: AgentFinding): string {
  const where = finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ''}\`` : '';
  const message =
    finding.message.length > FINDING_CHARS ? `${finding.message.slice(0, FINDING_CHARS).trim()}…` : finding.message;
  return `• *${finding.severity}*${where} — ${message}`;
}

/** The message for a run that did not pass. `reason` replaces the derived one (an interruption). */
export function buildUnfinishedRunMessage(params: { result: PipelineResult; pr?: RunPr; reason?: string }): string {
  const { result, pr } = params;
  const findings = openFindings(result.steps);
  const shown = findings.slice(0, MAX_OPEN_FINDINGS).map(findingLine);
  if (findings.length > MAX_OPEN_FINDINGS) shown.push(`• …and ${findings.length - MAX_OPEN_FINDINGS} more`);
  return [
    `${params.reason ?? unfinishedReason(result)} ${prLine(pr)}`,
    ...(shown.length > 0 ? [`Still open:\n${shown.join('\n')}`] : []),
  ].join('\n\n');
}
