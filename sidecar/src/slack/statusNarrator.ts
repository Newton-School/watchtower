import type { WorkflowStepLog } from '../types/contracts.js';

/** Hard cap on a status line. Slack renders it inline; long text is unreadable. */
const MAX_STATUS_FRAGMENT = 80;

/**
 * Secret-shaped tokens that must never reach a Slack status line. Targeted
 * prefixes rather than a generic "long random string" rule, which would also
 * destroy legitimate paths, branch names, and SHAs.
 */
const SECRET_PATTERNS: RegExp[] = [
  /xox[abprs]-[A-Za-z0-9-]+/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /\b(?:token|secret|password|passwd|api[_-]?key|auth)\s*[=:]\s*\S+/gi,
];

/**
 * Shorten an absolute path to something readable that leaks no home directory
 * or worktree temp path: keep from `src/` when present, else the last two
 * segments. `/Users/dipesh/code/newton-web/src/nsat/config.ts` → `src/nsat/config.ts`.
 */
function shortenPath(value: string): string {
  if (!value.includes('/')) return value;
  const segments = value.split('/').filter(Boolean);
  const srcIndex = segments.lastIndexOf('src');
  if (srcIndex >= 0 && srcIndex < segments.length - 1) {
    return segments.slice(srcIndex).join('/');
  }
  return segments.slice(-2).join('/');
}

/**
 * Make an arbitrary agent-supplied string safe and short enough for a public
 * Slack channel: strip secrets, shorten absolute paths, collapse whitespace,
 * truncate.
 */
export function sanitizeStatusFragment(value: string, maxLength = MAX_STATUS_FRAGMENT): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  // Shorten absolute filesystem paths wherever they appear. Length is NOT the
  // trigger — `/Users/bob/x.ts` is short but still leaks a username. The
  // leading boundary group keeps URLs intact: the `//` in `https://host/path`
  // is preceded by `:`, so it never matches.
  out = out.replace(/(^|[\s'"([])(\/[^\s'"`)\]]+)/g, (_match, boundary: string, pathToken: string) => {
    return `${boundary}${shortenPath(pathToken)}`;
  });
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return out;
}

/**
 * Reduce a shell command to something glanceable: unwrap the `sh -c` / `zsh -lc`
 * wrapper Codex adds, then keep the binary plus one argument. Never emits a
 * full command line — those carry flags, paths, and occasionally credentials.
 */
export function summarizeCommand(command: string): string {
  let inner = command.trim();
  // /bin/zsh -lc "sed -n '1,200p' a.txt"  →  sed -n '1,200p' a.txt
  const wrapped = inner.match(/^\S*(?:ba|z|)sh\s+-[a-z]*c\s+(['"])([\s\S]+)\1\s*$/);
  if (wrapped) inner = wrapped[2].trim();
  // Stop at the first command separator so only the leading command shows.
  inner = inner.split(/\s*(?:&&|\|\||[;|])\s*/)[0].trim();
  const tokens = inner.split(/\s+/).slice(0, 2);
  return sanitizeStatusFragment(tokens.join(' '), 40);
}

/**
 * Human phrasing for a tool invocation. Slack renders the status as
 * `miniOG <text>`, so every phrase is a verb continuation.
 *
 * `detail` is expected to already be sanitized by the stream decoder, but is
 * re-sanitized here so a direct caller cannot leak.
 */
function narrateTool(data: Record<string, unknown>): string | undefined {
  const tool = typeof data.tool === 'string' ? data.tool : undefined;
  if (!tool) return undefined;
  const rawDetail = typeof data.detail === 'string' ? data.detail : '';
  const detail = rawDetail ? sanitizeStatusFragment(rawDetail) : '';

  // MCP tools arrive as mcp__<server>__<tool>.
  const mcp = tool.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    const server = sanitizeStatusFragment(mcp[1].replace(/[-_]+/g, ' '), 30);
    return `is querying ${server}`;
  }

  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return detail ? `is reading ${detail}` : 'is reading the code';
    case 'Grep':
    case 'Glob':
      return detail ? `is searching for ${detail}` : 'is searching the codebase';
    case 'Bash':
    case 'BashOutput':
      return detail ? `is running \`${detail}\`` : 'is running a command';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return detail ? `is editing ${detail}` : 'is editing files';
    case 'Skill':
      return detail ? `is using the ${detail} skill` : 'is using a skill';
    // The CLI reports subagents as `Agent`; `Task` appears in the advertised
    // tool list and older builds emit it, so accept both.
    case 'Agent':
    case 'Task':
      return detail ? `is spawning a subagent — ${detail}` : 'is spawning a subagent';
    case 'WebSearch':
      return detail ? `is searching the web for ${detail}` : 'is searching the web';
    case 'WebFetch':
      return detail ? `is fetching ${detail}` : 'is fetching a page';
    case 'Workflow':
      return 'is running a workflow';
    case 'ExitPlanMode':
      return 'is finalizing the plan';
    // Bookkeeping tools say nothing useful about progress.
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'ToolSearch':
      return undefined;
    default:
      return `is using ${sanitizeStatusFragment(tool, 30)}`;
  }
}

interface StageRule {
  text: string;
  /**
   * Human-wait gate: show the text, then stop refreshing so the status expires
   * naturally instead of being pinned for hours.
   */
  suspend?: boolean;
}

/**
 * Exact-match stage → status text. Covers the high-signal stages across every
 * workflow; anything unmapped falls through to the prefix table, then to
 * `undefined` (no update) rather than echoing a raw dotted stage name at users.
 */
const STAGE_TEXT: Record<string, StageRule> = {
  // Agentic entry (informational / conversational / QA)
  'agentic.start': { text: 'is getting oriented…' },
  'agentic.done': { text: 'is writing the reply…' },

  // Investigation
  'investigation.start': { text: 'is starting the investigation…' },
  'investigation.saved': { text: 'is saving the findings…' },

  // Implementation + agent pipeline
  'implementation.start': { text: 'is sizing up the work…' },
  'pipeline.start': { text: 'is starting the agent pipeline…' },
  'pipeline.agent.planner.start': { text: 'is thinking through the approach…' },
  'pipeline.agent.coder.start': { text: 'is writing the code…' },
  'pipeline.agent.reviewer.start': { text: 'is reviewing the changes…' },
  'pipeline.agent.security.start': { text: 'is checking for security issues…' },
  'pipeline.agent.performance.start': { text: 'is checking performance…' },
  'pipeline.agent.verifier.start': { text: 'is running final checks…' },
  'workspace.resolved': { text: 'is preparing a workspace…' },
  'pr.creating': { text: 'is opening a PR…' },
  'pr.progress': { text: 'is opening a PR…' },

  // PR review
  'agentic.pr_review.start': { text: 'is starting the PR review…' },
  'agentic.pr_review.ack_posted': { text: 'is fetching the diff…' },
  'agentic.pr_review.pr.diff_fetched': { text: 'is reading the diff…' },
  'agentic.pr_review.fanout.start': { text: 'is running the review lenses…' },
  'agentic.pr_review.fanout.done': { text: 'is merging the lens findings…' },
  'agentic.pr_review.verify.start': { text: 'is verifying the findings…' },
  'agentic.pr_review.synth.done': { text: 'is writing the review…' },
  'pr_review.checkout.done': { text: 'is checking out the PR…' },

  // Webapp QA
  'qa.pr.worktree_ready': { text: 'is preparing the PR checkout…' },
  'qa.pr.build_gate.start': { text: 'is running the build gate…' },
  'qa.pr.dev_server_ready': { text: 'is booting a dev server…' },
  'qa.done': { text: 'is collecting the evidence…' },
  'qa.evidence.start': { text: 'is uploading screenshots…' },

  // Deploy
  'deploy.start': { text: 'is starting the deploy…' },
  'deploy.marketing.start': { text: 'is dispatching the deploy…' },

  // Agent process lifecycle
  'agent.spawned': { text: 'is thinking…' },
};

/**
 * Prefix rules, longest-match-wins. These catch whole families at once — every
 * approval / clarification gate suspends, every deploy poll reads the same.
 */
const STAGE_PREFIX: Array<[string, StageRule]> = [
  ['pipeline.approval', { text: 'is waiting for your approval', suspend: true }],
  ['pipeline.clarification', { text: 'is waiting for your answer', suspend: true }],
  ['pipeline.repo_choice', { text: 'is waiting for you to pick a repo', suspend: true }],
  ['planner.clarification', { text: 'is waiting for your answer', suspend: true }],
  ['awaiting_approval', { text: 'is waiting for your approval', suspend: true }],
  ['approval.waiting', { text: 'is waiting for your approval', suspend: true }],
  ['clarification.asking', { text: 'is waiting for your answer', suspend: true }],
  ['deploy.marketing.poll', { text: 'is waiting for the deploy to finish…' }],
  ['investigation.scope', { text: 'is scoping the investigation…' }],
  ['agentic.repo_refresh', { text: 'is refreshing the repo…' }],
];

export interface NarratedStatus {
  text: string;
  suspend?: boolean;
}

/**
 * Map a workflow step to a Slack status line.
 *
 * Returns `undefined` for steps that should not move the status — most of the
 * ~200 dotted stages are bookkeeping, and echoing them would make the line
 * strobe with text users cannot act on.
 */
export function narrateStep(step: WorkflowStepLog): NarratedStatus | undefined {
  const { stage, data } = step;

  // Tool-level events from the CLI stream carry their own detail.
  if (stage === 'agent.tool.use' && data) {
    const text = narrateTool(data);
    return text ? { text } : undefined;
  }

  const exact = STAGE_TEXT[stage];
  if (exact) return exact;

  let best: StageRule | undefined;
  let bestLength = -1;
  for (const [prefix, rule] of STAGE_PREFIX) {
    if (stage.startsWith(prefix) && prefix.length > bestLength) {
      best = rule;
      bestLength = prefix.length;
    }
  }
  return best;
}
