import type { AgentFinding } from '../agents/types.js';
import type {
  AppConfig,
  CodexReasoningEffort,
  CodexRunResult,
  PrContext,
  WorkflowStepLogger,
} from '../types/contracts.js';
import type { PrMetadata } from '../github/prReviewSupport.js';
import { connectorsFor, withConnectors, type RunConnectors } from '../backends/connectors.js';
import { NEVER_POST_RULE, SEVERITY_RUBRIC, type PrReviewDeps } from './prReviewAgent.js';
import { STE_REVIEW_TEXT_RULE } from '../codex/replyStyle.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { getActiveBackendId } from '../codex/runCodex.js';
import { withAgentCallContext } from '../state/runContext.js';

/**
 * The behaviour pass of a PR review: does the change make the product do what
 * it was asked to do, for the user? The other passes read the code for bugs,
 * security and performance. This one reads what the change was meant to do
 * (the Jira ticket, else the PR description), traces each expected behaviour
 * through the code, and reports a checklist that is always posted in the
 * review body, plus findings for the gaps.
 */

export const BEHAVIOUR_PROMPT_MARKER = 'behaviour specialist';

/** Rows the table shows. Past this a checklist is a spec dump, not a review. */
export const MAX_CHECKLIST_ROWS = 15;
const MAX_TICKET_KEYS = 3;
const MAX_FIGMA_LINKS = 5;
const MAX_QUESTIONS = 5;

/** WATCHTOWER_PR_REVIEW_BEHAVIOUR=0 turns the pass off; the review is then as it was before it. */
export function behaviourReviewEnabled(): boolean {
  return (process.env.WATCHTOWER_PR_REVIEW_BEHAVIOUR ?? '1') !== '0';
}

// ---------------------------------------------------------------------------
// What the change was meant to do
// ---------------------------------------------------------------------------

/** Upper-case words that look like a ticket key and never are one ("UTF-8", "SHA-256"). */
const NOT_TICKET_PREFIXES = new Set([
  'AES',
  'CVE',
  'ES',
  'GPT',
  'HTTP',
  'ISO',
  'NODE',
  'OAUTH',
  'RFC',
  'RSA',
  'SHA',
  'SSL',
  'TLS',
  'UTF',
  'WCAG',
]);

const KEY_IN_TEXT_RE = /\b([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})\b/g;
const BROWSE_URL_RE = /https?:\/\/[^\s/<>|]+\/browse\/([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6})\b/gi;
/** Branch names are lower case as often as not: `feat/nmw-412-cart-empty-state`. */
const KEY_IN_BRANCH_RE = /(?:^|[/_-])([a-z][a-z0-9]{1,9}-[1-9]\d{0,6})(?=$|[/_-])/gi;
const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board|make)\/[^\s<>|)\]]+/gi;

function isTicketKey(key: string): boolean {
  const prefix = key.split('-')[0];
  return !NOT_TICKET_PREFIXES.has(prefix);
}

function collect(re: RegExp, text: string | undefined, into: string[]): void {
  if (!text) return;
  for (const match of text.matchAll(re)) {
    const key = match[1].toUpperCase();
    if (isTicketKey(key) && !into.includes(key)) into.push(key);
  }
}

/**
 * Jira keys the PR names, most trusted first: a Jira link anywhere, then the
 * title, the branch name and the description. A key that is not a real ticket
 * costs the pass one lookup that comes back empty; the table names only the
 * tickets it actually read.
 */
export function findTicketKeys(prMeta: Pick<PrMetadata, 'title' | 'body' | 'headRef'>): string[] {
  const keys: string[] = [];
  collect(BROWSE_URL_RE, `${prMeta.title ?? ''}\n${prMeta.body ?? ''}`, keys);
  collect(KEY_IN_TEXT_RE, prMeta.title, keys);
  collect(KEY_IN_BRANCH_RE, prMeta.headRef, keys);
  collect(KEY_IN_TEXT_RE, prMeta.body, keys);
  return keys.slice(0, MAX_TICKET_KEYS);
}

export function findFigmaLinks(text: string | undefined): string[] {
  if (!text) return [];
  const links = [...new Set([...text.matchAll(FIGMA_URL_RE)].map(match => match[0].replace(/[.,;:]+$/, '')))];
  return links.slice(0, MAX_FIGMA_LINKS);
}

// ---------------------------------------------------------------------------
// Whether the pass has anything to check
// ---------------------------------------------------------------------------

const NO_BEHAVIOUR_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
  '.nvmrc',
  '.node-version',
  '.npmrc',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  'Dockerfile',
  'Jenkinsfile',
  'CODEOWNERS',
  'LICENSE',
]);

const NO_BEHAVIOUR_PATTERNS: RegExp[] = [
  /\.(md|mdx|rst|txt)$/i,
  /^docs?\//,
  /^\.(github|circleci|husky|vscode|idea)\//,
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|playwright)\//,
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)(\.?eslint|\.?prettier|\.?stylelint|\.?lintstaged|jest|vitest|playwright|babel)[^/]*$/i,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /\.dockerfile$/,
  /\.tf(vars)?$/,
  /^(infra|terraform|helm|k8s|deploy)\//,
];

function changesNoBehaviour(path: string): boolean {
  const basename = path.split('/').pop() ?? path;
  return NO_BEHAVIOUR_BASENAMES.has(basename) || NO_BEHAVIOUR_PATTERNS.some(re => re.test(path));
}

/** True when some changed file can change what a user sees or gets: anything but docs, tests, CI, deps and tooling. */
export function changesUserBehaviour(changedPaths: string[]): boolean {
  return changedPaths.some(path => !changesNoBehaviour(path));
}

export type BehaviourPlan =
  | { kind: 'off' }
  | { kind: 'skip'; reason: string }
  | { kind: 'run'; ticketKeys: string[]; figmaLinks: string[]; connectors: RunConnectors };

/** Whether this review runs the behaviour pass, and with what. */
export function planBehaviourReview(params: {
  config: AppConfig;
  prMeta: PrMetadata;
  changedPaths: string[];
  /** The rest of the review runs in the classic mode, which this pass is not part of. */
  orchestrated: boolean;
}): BehaviourPlan {
  if (!params.orchestrated || !behaviourReviewEnabled()) return { kind: 'off' };
  if (!changesUserBehaviour(params.changedPaths)) {
    return {
      kind: 'skip',
      reason: 'This PR changes only docs, tests, CI, dependencies or tooling, so there is no user behaviour to check.',
    };
  }
  return {
    kind: 'run',
    ticketKeys: findTicketKeys(params.prMeta),
    figmaLinks: findFigmaLinks(params.prMeta.body),
    connectors: connectorsFor('pr_behaviour', params.config),
  };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export interface BehaviourPromptParams {
  recallBlock: string;
  prContext: PrContext;
  prMeta: PrMetadata;
  policyBlock: string;
  threadContext: string;
  diff: string;
  userFocusBlock?: string;
  checkoutDegraded?: boolean;
  buildStatusBlock?: string;
  /** Follow-up review: the earlier findings, not to be repeated. */
  priorReviewLensBlock?: string;
  ticketKeys: string[];
  figmaLinks: string[];
  /** The Jira connector could be given to this run. */
  jiraAvailable: boolean;
  /** No local clone: the diff is all there is. */
  oneShot: boolean;
}

function jiraInstruction(ticketKeys: string[], jiraAvailable: boolean): string {
  if (!jiraAvailable) {
    const named = ticketKeys.length > 0 ? ` The PR names ${ticketKeys.join(', ')}, but` : '';
    return `1. Jira:${named} Jira cannot be read in this run. Say so in "specNote" ("Jira could not be read"), and work from the PR description.`;
  }
  const read =
    ticketKeys.length > 0
      ? `The PR names ${ticketKeys.join(', ')}. Read each one with \`mcp__atlassian__get-jira-issue\`. A key that does not exist is not a ticket: leave it out.`
      : 'The PR title, branch and description name no Jira ticket. If the Slack thread below names one, read it with `mcp__atlassian__get-jira-issue`. If not, work from the PR description.';
  return `1. Jira. ${read}
   You may also read the parent or subtasks a ticket names when they define the behaviour, at most 5 tickets in all.
   Jira is read-only for you: never create, change or delete a ticket or a page.
   If the Jira tools are missing or return an error, say so in "specNote" ("Jira could not be read") and work from the PR description.`;
}

function figmaInstruction(figmaLinks: string[]): string {
  if (figmaLinks.length === 0) return '';
  return `
3. Figma: the PR links ${figmaLinks.join(', ')}. You cannot open Figma in this run. Do not guess what a design shows.
   Use the ticket and the PR description, and add "design not checked against Figma" to "specNote".`;
}

export function buildBehaviourLensPrompt(params: BehaviourPromptParams): string {
  const {
    recallBlock,
    prContext,
    prMeta,
    policyBlock,
    threadContext,
    diff,
    userFocusBlock,
    checkoutDegraded,
    buildStatusBlock,
    priorReviewLensBlock,
    ticketKeys,
    figmaLinks,
    jiraAvailable,
    oneShot,
  } = params;

  const toolGuidance = oneShot
    ? 'There is no copy of the repository in this run. Trace each behaviour through the diff below, and mark a row "unclear" when the diff alone cannot show it.'
    : `You are running inside a git worktree of ${prContext.repo} with PR #${prContext.number} checked out.
Use your Read/Grep/Glob tools to follow each flow beyond the diff: routes, pages, API handlers, serializers,
models, permissions, caches and the code that calls them. Do not mark a row "missing" before you search the repository for it.${
        checkoutDegraded
          ? `\nNOTE: the PR-head checkout FAILED — the worktree shows the DEFAULT branch, not this PR. Treat the
diff below as the only source for changed code; repository reads show the code before this PR.`
          : ''
      }`;

  return `${recallBlock}You are miniOG's PR ${BEHAVIOUR_PROMPT_MARKER}.

Your job: check that this PR makes the product behave the way it was asked to. Other specialists review code
quality, security and performance. You review what a user sees and does, and how data moves to and from them.

PR: ${prContext.url}
${prMeta.title ? `Title: ${prMeta.title}` : ''}
${prMeta.headRef ? `Branch: ${prMeta.headRef}` : ''}
Description: ${prMeta.body?.trim() ? prMeta.body : '(none)'}

Policy:
${policyBlock}

${userFocusBlock ? `${userFocusBlock}\n\n` : ''}${buildStatusBlock ? `${buildStatusBlock}\n\n` : ''}${priorReviewLensBlock ? `${priorReviewLensBlock}\n\n` : ''}Thread context:
${threadContext}

WHAT THIS PR WAS MEANT TO DO — sources, most trusted first:
${jiraInstruction(ticketKeys, jiraAvailable)}
2. The PR description and title. Claims the author makes there ("adds X", "behind flag Y", "removes Z") are expectations too.${figmaInstruction(figmaLinks)}
When there is no ticket and no description, take the expectations from the title and the diff, set "specSource" to "title",
and say in "specNote" that there was nothing else to check against.

${toolGuidance}

STEP 1. Write the checklist: each expected behaviour as one short line a product manager would recognise, saying who
does what and what they see or get. Take them from the ticket's acceptance criteria first, then its description, then
the PR description. Write 3 to 12 rows. Give each row its "source": the ticket key, "PR description" or "PR title".

STEP 2. Trace each row through the code: find its entry point (route, page, button, API endpoint, job), follow the
flow and the data, and give it a status:
- "done": the code does it. Set "where" to file:line.
- "partial": only some of it, for example the page hides the button but the API still accepts the request. Say what is missing in "note".
- "missing": nothing in the PR or the repository does it.
- "differs": the code does something other than what the source says. Say what it does in "note".
- "unclear": the source is ambiguous, or you could not trace it. Put the question in "questions".

STEP 3. While you trace, check the behaviour around each flow:
- Flow: entry points; the happy path step by step; what happens after success (redirect, message, refreshed list);
  back navigation; a refresh in the middle; opening a later step straight from a link; a double submit.
- States: loading, empty, error, partial data, disabled, no permission, first-time and returning user, very long text, many items.
- Data: where each value comes from and where it is written. Follow a form field to the request field to the stored
  field and check names, units, time zones and enum values (resolve each constant to its real value). Look for stale
  data after a change (a cache not invalidated, an optimistic update not rolled back), client and server validation
  that disagree, and null or missing values from the API.
- Roles: who can see and do this; the gate in the UI and in the API; what everyone else sees.
- Existing users and data: records made before this change; a migration or backfill the change needs.
- Flags: with the flag off, behaviour is as before; with it on, the flow is complete.
- Analytics: events the ticket asks for fire at the right step with the right properties; existing event names keep their names.

Rules:
- Every "missing", "differs" or "partial" row is also a finding. Its "message" starts by quoting the expectation and
  its source, for example: PROJ-12 says "only course leads can reassign a task". Then it says what the code does.
  Set "item" to the row number (1 for the first row).
- A problem you find in STEP 3 that has no row is a finding too, without "item".
- Do not report missing tests, naming, style or code structure: the lead reviewer covers them. Report only what a
  user would see or get wrong.
- Severity: code that contradicts the ticket, or breaks a user flow on a real path, is high. A missing state, a
  partial flow or a role gap on a narrower path is medium. Behaviour the sources do not mention is a question, never a finding.
- A source that can be read two ways is a question for the author in "questions", never a finding. At most ${MAX_QUESTIONS} questions.
- Findings MUST anchor to the diff: exact file path plus the "+"-side (new file) line number, at the place the behaviour
  is (or should be) implemented. A gap with no place in the diff has no file or line.
- Set "role": "behaviour" on every finding.
${SEVERITY_RUBRIC}
${NEVER_POST_RULE}
- Your final message must be ONLY this JSON object (no prose, no code fences):

{
  "findings": [{ "role": "behaviour", "severity": "critical"|"high"|"medium"|"low"|"info", "category": string, "message": string, "file"?: string, "line"?: number, "suggestion"?: string, "item"?: number }],
  "summaryNotes": string[],
  "summary": string,
  "specSource": "jira"|"description"|"title",
  "ticketsRead": string[],
  "specNote": string,
  "checklist": [{ "expectation": string, "source": string, "status": "done"|"partial"|"missing"|"differs"|"unclear", "where"?: string, "note"?: string }],
  "questions": string[]
}
// "ticketsRead": only the Jira keys you actually read. "specNote": one sentence about the sources, or "" when there is nothing to say.

${STE_REVIEW_TEXT_RULE}
- The same rules apply to "expectation", "note", "specNote" and each of "questions": they are posted to GitHub too.

PR Diff:
\`\`\`diff
${diff}
\`\`\``.trim();
}

// ---------------------------------------------------------------------------
// What the pass reports
// ---------------------------------------------------------------------------

export const CHECKLIST_STATUSES = ['done', 'partial', 'missing', 'differs', 'unclear'] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

export interface ChecklistRow {
  expectation: string;
  source: string;
  status: ChecklistStatus;
  where?: string;
  note?: string;
}

export type BehaviourReport =
  | {
      status: 'checked';
      specSource: 'jira' | 'description' | 'title';
      ticketsRead: string[];
      specNote?: string;
      checklist: ChecklistRow[];
      questions: string[];
    }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function readRow(value: unknown): ChecklistRow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const expectation = text(raw.expectation);
  if (!expectation) return undefined;
  const status = (CHECKLIST_STATUSES as readonly string[]).includes(String(raw.status))
    ? (raw.status as ChecklistStatus)
    : 'unclear';
  return {
    expectation,
    source: text(raw.source) ?? 'PR description',
    status,
    ...(text(raw.where) ? { where: text(raw.where) } : {}),
    ...(text(raw.note) ? { note: text(raw.note) } : {}),
  };
}

/**
 * The checklist and questions from the pass's output. A run that returned no
 * checklist row did not do the job the table exists for: that is a failure,
 * reported as one, never an empty table.
 */
export function readBehaviourReport(parsedJson: Record<string, unknown> | undefined): BehaviourReport {
  const output = parsedJson ?? {};
  const checklist = (Array.isArray(output.checklist) ? output.checklist : [])
    .map(readRow)
    .filter((row): row is ChecklistRow => Boolean(row));
  if (checklist.length === 0) {
    return { status: 'failed', reason: 'The behaviour check returned no checklist.' };
  }
  const specSource = ['jira', 'description', 'title'].includes(String(output.specSource))
    ? (output.specSource as 'jira' | 'description' | 'title')
    : 'description';
  const ticketsRead = (Array.isArray(output.ticketsRead) ? output.ticketsRead : [])
    .map(key => text(key)?.toUpperCase())
    .filter((key): key is string => Boolean(key) && /^[A-Z][A-Z0-9]*-\d+$/.test(key as string));
  const questions = (Array.isArray(output.questions) ? output.questions : [])
    .map(text)
    .filter((question): question is string => Boolean(question))
    .slice(0, MAX_QUESTIONS);
  return {
    status: 'checked',
    // "jira" with no ticket read is not true; the table must not say it was.
    specSource: specSource === 'jira' && ticketsRead.length === 0 ? 'description' : specSource,
    ticketsRead: [...new Set(ticketsRead)],
    ...(text(output.specNote) ? { specNote: text(output.specNote) } : {}),
    checklist,
    questions,
  };
}

/** How a finding is recognised after it has been through dedup and verification. */
export function findingKey(finding: Pick<AgentFinding, 'file' | 'line' | 'message'>): string {
  return `${finding.file ?? ''}:${finding.line ?? ''}:${finding.message.trim()}`;
}

/** Row number (1-based) each raw finding says it belongs to, by finding key. */
export function findingRows(parsedJson: Record<string, unknown> | undefined): Map<string, number> {
  const rows = new Map<string, number>();
  const raw = Array.isArray(parsedJson?.findings) ? parsedJson.findings : [];
  for (const finding of raw) {
    if (!finding || typeof finding !== 'object') continue;
    const { item, message, file, line } = finding as Record<string, unknown>;
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || typeof message !== 'string') continue;
    rows.set(
      findingKey({
        message,
        file: typeof file === 'string' && file.trim() ? file.trim() : undefined,
        line: typeof line === 'number' && line > 0 ? Math.trunc(line) : undefined,
      }),
      item,
    );
  }
  return rows;
}

/**
 * A gap whose every finding a verifier refuted is not shown as a gap: the
 * table must not say "missing" about code a second reading found doing it.
 */
export function withRefutedGapsCleared(
  report: BehaviourReport,
  rowsByFinding: Map<string, number>,
  refuted: Array<Pick<AgentFinding, 'file' | 'line' | 'message'>>,
  kept: Array<Pick<AgentFinding, 'file' | 'line' | 'message'>>,
): BehaviourReport {
  if (report.status !== 'checked' || refuted.length === 0) return report;
  const refutedRows = new Set(
    refuted.map(f => rowsByFinding.get(findingKey(f))).filter((row): row is number => row !== undefined),
  );
  const keptRows = new Set(
    kept.map(f => rowsByFinding.get(findingKey(f))).filter((row): row is number => row !== undefined),
  );
  if (refutedRows.size === 0) return report;
  return {
    ...report,
    checklist: report.checklist.map((row, index) =>
      refutedRows.has(index + 1) && !keptRows.has(index + 1) && row.status !== 'done'
        ? { ...row, status: 'unclear', note: 'A second check of the code did not confirm this gap.' }
        : row,
    ),
  };
}

export function behaviourGaps(report: BehaviourReport | undefined): number {
  if (report?.status !== 'checked') return 0;
  return report.checklist.filter(
    row => row.status === 'missing' || row.status === 'differs' || row.status === 'partial',
  ).length;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  done: '✅ Done',
  partial: '⚠️ Partial',
  missing: '❌ Missing',
  differs: '❌ Differs',
  unclear: '❓ Unclear',
};

/** One table cell: one line, no pipes to break the row, clipped. */
function cell(value: string | undefined, max: number): string {
  if (!value) return '—';
  const flat = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const MAX_WHERE_CHARS = 60;

/**
 * A file:line, clipped from the left: the file name and line are what a
 * reader looks for, and a long path cut at its end loses both.
 */
function whereCell(where: string | undefined): string {
  if (!where) return '—';
  const flat = where.replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '').trim();
  if (!flat) return '—';
  const clipped = flat.length > MAX_WHERE_CHARS ? `…${flat.slice(flat.length - (MAX_WHERE_CHARS - 1))}` : flat;
  return `\`${clipped}\``;
}

function sourcesLine(report: Extract<BehaviourReport, { status: 'checked' }>): string {
  const base =
    report.ticketsRead.length > 0
      ? `Checked against ${report.ticketsRead.join(', ')} (Jira) and the PR description.`
      : report.specSource === 'title'
        ? 'No Jira ticket and no PR description: checked against the PR title only.'
        : 'No Jira ticket found: checked against the PR description.';
  return report.specNote ? `${base} ${cell(report.specNote, 300)}` : base;
}

/** The "Behaviour check" section of the review body. Always present when the pass was planned. */
export function renderBehaviourSection(report: BehaviourReport): string {
  if (report.status !== 'checked') {
    return `### Behaviour check\n${report.status === 'skipped' ? 'Not run.' : 'Did not finish.'} ${report.reason}`;
  }
  const rows = report.checklist.slice(0, MAX_CHECKLIST_ROWS);
  const lines = [
    '### Behaviour check',
    sourcesLine(report),
    '',
    '| # | Expected behaviour | Source | Status | Where |',
    '|---|---|---|---|---|',
    ...rows.map((row, index) => {
      const status = row.note ? `${STATUS_LABEL[row.status]}: ${cell(row.note, 160)}` : STATUS_LABEL[row.status];
      return `| ${index + 1} | ${cell(row.expectation, 200)} | ${cell(row.source, 40)} | ${status} | ${whereCell(row.where)} |`;
    }),
  ];
  if (report.checklist.length > rows.length) {
    lines.push('', `…and ${report.checklist.length - rows.length} more row(s) left out.`);
  }
  if (report.questions.length > 0) {
    lines.push('', 'Questions for the author:', ...report.questions.map(question => `- ${cell(question, 300)}`));
  }
  return lines.join('\n');
}

/** One line for the Slack summary, or nothing when the pass did not run. */
export function behaviourSlackLine(report: BehaviourReport | undefined): string | undefined {
  if (!report || report.status === 'skipped') return undefined;
  if (report.status === 'failed') return '_The behaviour check did not finish; the review says so._';
  const total = report.checklist.length;
  const count = (status: ChecklistStatus) => report.checklist.filter(row => row.status === status).length;
  const against =
    report.ticketsRead.length > 0
      ? report.ticketsRead.join(', ')
      : report.specSource === 'title'
        ? 'the PR title'
        : 'the PR description';
  const parts = [`${count('done')} of ${total} done`];
  for (const status of ['partial', 'missing', 'differs', 'unclear'] as const) {
    if (count(status) > 0) parts.push(`${count(status)} ${status}`);
  }
  const questions = report.questions.length > 0 ? `, ${report.questions.length} question(s) for the author` : '';
  return `Behaviour check against ${against}: ${parts.join(', ')}${questions}.`;
}

// ---------------------------------------------------------------------------
// Running the pass
// ---------------------------------------------------------------------------

export type BehaviourLensPromptParams = Omit<
  BehaviourPromptParams,
  'ticketKeys' | 'figmaLinks' | 'jiraAvailable' | 'priorReviewLensBlock'
> & { priorReviewLensBlock?: string };

/**
 * Run the behaviour pass: the high tier at high effort, then once more at
 * medium. Never throws. Always returns a report, so the review body can say
 * what happened: the checklist, or that the check did not finish.
 */
export async function runBehaviourLens(params: {
  deps: Pick<PrReviewDeps, 'runAgent'>;
  cwd: string;
  plan: Extract<BehaviourPlan, { kind: 'run' }>;
  promptParams: BehaviourLensPromptParams;
  schemaPath: string;
  githubToken?: string;
  timeoutMs?: number;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ result?: CodexRunResult; report: BehaviourReport; rows: Map<string, number> }> {
  const { deps, cwd, plan, promptParams, schemaPath, githubToken, timeoutMs, logStep, signal } = params;
  const prUrl = promptParams.prContext.url;
  const jiraAvailable = Object.keys(plan.connectors.mcpServers).length > 0;
  const prompt = buildBehaviourLensPrompt({
    ...promptParams,
    ticketKeys: plan.ticketKeys,
    figmaLinks: plan.figmaLinks,
    jiraAvailable,
  });
  const profile = { ...highReasoningProfile(getActiveBackendId()), reasoningEffort: 'high' as CodexReasoningEffort };

  logStep?.({
    stage: 'agentic.pr_review.behaviour.start',
    message: `Behaviour check starting (${plan.ticketKeys.length > 0 ? `tickets ${plan.ticketKeys.join(', ')}` : 'no ticket named'}${jiraAvailable ? '' : ', Jira not available'}).`,
    data: { prUrl, ticketKeys: plan.ticketKeys, figmaLinks: plan.figmaLinks.length, jiraAvailable },
  });
  if (!jiraAvailable) {
    logStep?.({
      stage: 'agentic.pr_review.behaviour.jira_unavailable',
      level: 'WARN',
      message: 'No Atlassian MCP server is set up on this host; the behaviour check works from the PR description.',
      data: { prUrl, unavailable: plan.connectors.unavailable },
    });
  }

  // Only this run gets the Jira server: the other passes keep none.
  const run = (reasoningEffort: CodexReasoningEffort) =>
    withConnectors(plan.connectors, () =>
      withAgentCallContext({ role: 'behaviour' }, () =>
        deps.runAgent({
          cwd,
          prompt,
          outputSchemaPath: schemaPath,
          githubToken,
          ...profile,
          reasoningEffort,
          timeoutMs,
          onLog: logStep,
          signal,
        }),
      ),
    );

  let result: CodexRunResult | undefined;
  for (const effort of ['high', 'medium'] as CodexReasoningEffort[]) {
    if (signal?.aborted) break;
    try {
      result = await run(effort);
    } catch (error) {
      result = undefined;
      logStep?.({
        stage: 'agentic.pr_review.behaviour.threw',
        level: 'WARN',
        message: `Behaviour check threw at ${effort} effort: ${String(error)}`,
        data: { prUrl },
      });
    }
    if (result?.ok && result.parsedJson) break;
    if (effort === 'high') {
      logStep?.({
        stage: 'agentic.pr_review.behaviour.fallback_medium',
        level: 'WARN',
        message: 'Behaviour check failed — retrying at medium reasoning.',
        data: { prUrl, exitCode: result?.exitCode ?? null },
      });
    }
  }

  const ok = Boolean(result?.ok && result.parsedJson);
  const report: BehaviourReport = ok
    ? readBehaviourReport(result?.parsedJson)
    : { status: 'failed', reason: 'The behaviour check did not finish, so nothing was checked against the ticket.' };
  const rows = ok ? findingRows(result?.parsedJson) : new Map<string, number>();

  logStep?.({
    stage: 'agentic.pr_review.behaviour.done',
    level: report.status === 'checked' ? 'INFO' : 'WARN',
    message:
      report.status === 'checked'
        ? `Behaviour check: ${report.checklist.length} expectation(s), ${behaviourGaps(report)} gap(s), ${report.questions.length} question(s).`
        : `Behaviour check produced no checklist: ${report.reason}`,
    data: {
      prUrl,
      status: report.status,
      ...(report.status === 'checked'
        ? {
            specSource: report.specSource,
            ticketsRead: report.ticketsRead,
            statuses: report.checklist.map(row => row.status),
            questions: report.questions.length,
          }
        : {}),
    },
  });
  return { ...(ok && result ? { result } : {}), report, rows };
}
