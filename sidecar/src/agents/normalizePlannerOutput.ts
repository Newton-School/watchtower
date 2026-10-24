import type { AgentBackendId } from '../types/contracts.js';

export type PlanScope = 'small' | 'medium' | 'large';

/**
 * The five lines a plan opens with for the person who approves it (issue
 * #437). Plans ran to a median of 8,000 characters for a ten-line change and
 * were approved in under two minutes; what the approver needed (what changes
 * for users, and whether behaviour changes) was somewhere inside.
 */
export interface ApproverSummary {
  whatChanges: string;
  where: string;
  /** "none", or what will behave differently afterwards, in plain words. */
  behaviourChange: string;
  /** "none", or what the planner had to assume (a screenshot it could not see, a default it picked). */
  assumptions: string;
  /** "none", or what the plan changes outside the repository: a Figma design, an upload through Newton admin (issue #432). */
  outsideRepo: string;
  risk: 'low' | 'medium' | 'high' | null;
}

export interface NormalizedPlannerOutput {
  planMarkdown: string;
  scope: PlanScope;
  requiresCodeChanges: boolean;
  clarificationNeeded: string | null;
  affectedFiles: string[];
  /** Parsed from the plan's opening block. Null when the planner did not write one. */
  approverSummary: ApproverSummary | null;
}

function coerceScope(value: unknown): PlanScope {
  if (value === 'small' || value === 'medium' || value === 'large') return value;
  return 'medium';
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim())
    .filter(Boolean);
}

function coerceClarification(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function renderJsonPlanAsMarkdown(steps: string[], affectedFiles: string[]): string {
  const lines: string[] = [];
  if (steps.length > 0) {
    lines.push(...steps.map((step, i) => `${i + 1}. ${step}`));
  }
  if (affectedFiles.length > 0) {
    lines.push('');
    lines.push('**Affected files:**');
    lines.push(...affectedFiles.map(f => `- \`${f}\``));
  }
  return lines.join('\n').trim();
}

function extractScopeFromMarkdown(markdown: string): PlanScope {
  const match = markdown.match(/scope\s*[:=]\s*(small|medium|large)/i);
  if (match) {
    const tag = match[1].toLowerCase();
    if (tag === 'small' || tag === 'medium' || tag === 'large') return tag;
  }
  return 'medium';
}

/**
 * Reads the `Requires code changes: yes|no` tag the plan-mode planner is asked
 * to emit (see `buildPlannerPlanModePrompt`). Mirrors `extractScopeFromMarkdown`
 * and rides the same plan-markdown channel. Defaults to `true` when the marker
 * is absent so older plans / planners still run the full pipeline (#348 RC2).
 */
function extractRequiresCodeChangesFromMarkdown(markdown: string): boolean {
  const match = markdown.match(/requires?\s+code\s+changes?\s*[:=]\s*(yes|no|true|false)/i);
  if (match) {
    const value = match[1].toLowerCase();
    return value === 'yes' || value === 'true';
  }
  return true;
}

const FILE_EXTENSION_PATTERN =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|sass|less|html|htm|xml|yml|yaml|toml|ini|env|rs|go|py|rb|java|kt|swift|m|mm|c|cc|cpp|h|hpp|sh|bash|zsh|sql|prisma|graphql|gql|proto|tf|tfvars|vue|svelte|astro|lock|conf|cfg|gradle|properties)$/i;

const KNOWN_BASENAMES = new Set([
  'Dockerfile',
  'Makefile',
  'Procfile',
  'Gemfile',
  'Rakefile',
  'Justfile',
  'CHANGELOG',
  'LICENSE',
  'NOTICE',
  'README',
]);

const DOTFILE_PATTERN = /^\.[a-z][a-z0-9._-]*$/i;

function basenameOf(s: string): string {
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function looksLikeFilePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 200) return false;
  if (/\s/.test(candidate)) return false;
  if (/^https?:\/\//i.test(candidate)) return false;
  // Harness bookkeeping paths are never repo files (#408): home-anchored
  // paths (`~/…`, `/Users/x/.claude/…`) and plan files anywhere. A
  // repo-RELATIVE `.claude/...` (e.g. `.claude/skills/x/SKILL.md`, which this
  // repo tracks) stays a legitimate affected file.
  if (candidate.startsWith('~/')) return false;
  if (/^\/.*\/\.claude\//.test(candidate)) return false;
  if (/(^|\/)\.claude\/plans\//.test(candidate)) return false;
  // Reject function-call-shaped tokens (`foo()`, `foo(arg)`) but allow path
  // segments with parens like Next.js route groups (`src/app/(marketing)/page.tsx`).
  if ((candidate.includes('(') || candidate.includes(')')) && !candidate.includes('/')) return false;
  // Reject schemeless URLs whose first segment is host-shaped (`github.com/org/repo`).
  // `./foo`, `../foo`, and dot-directories (`.claude/skills/x`, `.github/workflows/y`)
  // are allowed — hostnames never start with a dot.
  const slashIdx = candidate.indexOf('/');
  if (slashIdx > 0) {
    const firstSegment = candidate.slice(0, slashIdx);
    if (!firstSegment.startsWith('.') && firstSegment.includes('.')) return false;
  }
  const base = basenameOf(candidate);
  if (KNOWN_BASENAMES.has(base)) return true;
  if (DOTFILE_PATTERN.test(base)) return true;
  if (candidate.includes('/')) return true;
  return FILE_EXTENSION_PATTERN.test(candidate);
}

/**
 * Whether a path-shaped token names one file a change could edit. Stricter
 * than `looksLikeFilePath`, which accepts anything with a slash: the plan
 * header read "29 files affected" for a 3-file change because it counted
 * `origin/main`, `worker/**`, `../nsat/page`, URL paths and build output
 * (issue #437).
 */
function looksLikeEditableFile(candidate: string): boolean {
  if (!looksLikeFilePath(candidate)) return false;
  if (/[*?{}]/.test(candidate)) return false; // a glob is a set of files, or none
  if (candidate.startsWith('/')) return false; // a URL path or an absolute path, not repo-relative
  if (/^(origin|upstream|refs|heads)\//.test(candidate)) return false; // a git ref
  if (/^(out|dist|build|\.next|node_modules)\//.test(candidate)) return false; // build output
  const base = basenameOf(candidate);
  return KNOWN_BASENAMES.has(base) || DOTFILE_PATTERN.test(base) || FILE_EXTENSION_PATTERN.test(candidate);
}

function backtickedTokens(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /`([^`\n]{1,200})`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) tokens.push(match[1].trim());
  return tokens;
}

function extractAffectedFilesFromMarkdown(markdown: string): string[] {
  return [...new Set(backtickedTokens(markdown).filter(looksLikeEditableFile))];
}

const FILES_TO_CHANGE_HEADING_RE = /^#{1,6}\s*files?\s+to\s+(?:change|touch|modify|edit|update)\b/i;
const ANY_HEADING_RE = /^#{1,6}\s+\S/;

/** The lines of the plan's "Files to change" section: `[start, end)` over `lines`, or undefined. */
function filesToChangeSection(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex(line => FILES_TO_CHANGE_HEADING_RE.test(line.trim()));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADING_RE.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * The files the planner says it will edit: the first path on each bullet of
 * its "Files to change" section. Undefined when the plan has no such section,
 * so the caller can fall back to reading the whole plan.
 */
export function extractFilesToChange(markdown: string): string[] | undefined {
  const lines = markdown.split('\n');
  const section = filesToChangeSection(lines);
  if (!section) return undefined;
  const files = new Set<string>();
  for (const line of lines.slice(section.start + 1, section.end)) {
    const first = backtickedTokens(line).find(looksLikeEditableFile);
    if (first) files.add(first);
  }
  return [...files];
}

/**
 * Whether the plan lists the files it will edit (a "Files to change" section,
 * or the files block a JSON plan is rendered with), rather than leaving
 * `affectedFiles` to a guess from every path-shaped token in it.
 */
export function planListsFiles(markdown: string): boolean {
  return (extractFilesToChange(markdown)?.length ?? 0) > 0 || /^\*\*Affected files:\*\*$/m.test(markdown);
}

const APPROVER_HEADING_RE = /^#{1,6}\s*for\s+the\s+approver\b/i;
const APPROVER_LINE_RE =
  /^[\s>*-]*\**\s*(what changes|where|behaviou?r change|assumptions to confirm|outside the repo|risk)\s*\**\s*:\s*\**\s*(.*)$/i;
/** The approver block is the plan's opening: lines this far down are something else. */
const APPROVER_BLOCK_MAX_LINE = 40;

function approverLines(lines: string[]): Array<{ index: number; label: string; value: string }> {
  const found: Array<{ index: number; label: string; value: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(lines.length, APPROVER_BLOCK_MAX_LINE); i++) {
    const match = APPROVER_LINE_RE.exec(lines[i]);
    if (!match) continue;
    const label = match[1].toLowerCase().replace('behavior', 'behaviour');
    if (seen.has(label)) continue;
    seen.add(label);
    found.push({ index: i, label, value: match[2].replace(/\*+$/, '').trim() });
  }
  return found;
}

/** Reads the plan's opening block. Null unless it says both what changes and whether behaviour does. */
export function parseApproverSummary(markdown: string): ApproverSummary | null {
  const byLabel = new Map(approverLines(markdown.split('\n')).map(line => [line.label, line.value]));
  const whatChanges = byLabel.get('what changes') ?? '';
  const behaviourChange = byLabel.get('behaviour change') ?? '';
  if (!whatChanges || !behaviourChange) return null;
  const risk = (byLabel.get('risk') ?? '').toLowerCase().match(/\b(low|medium|high)\b/)?.[1] as
    | ApproverSummary['risk']
    | undefined;
  return {
    whatChanges,
    where: byLabel.get('where') ?? '',
    behaviourChange,
    assumptions: byLabel.get('assumptions to confirm') || 'none',
    outsideRepo: byLabel.get('outside the repo') || 'none',
    risk: risk ?? null,
  };
}

const NONE_LEAD_RE = /^(?:none|nothing|no|n\/a|na)(?=$|[.!,;:]|\s*[—–(-])/i;
/** Words that take a leading "none" back: "none, but the default becomes 0". */
const NONE_TAKEN_BACK_RE = /\b(?:but|however|except|although|though|unless|other than|apart from|aside from)\b/i;

/**
 * Whether an approver-block value says there is nothing to report.
 *
 * Planners rarely write a bare "none". The first live plan said "none. The
 * line is an HTML comment, so it does not render…", which a whole-value match
 * read as a behaviour change. So a value that leads with "none" and goes on
 * to explain counts as none, unless it then takes it back.
 */
export function isNone(value: string): boolean {
  const text = value.trim();
  if (text === '' || text === '-') return true;
  return NONE_LEAD_RE.test(text) && !NONE_TAKEN_BACK_RE.test(text);
}

/**
 * The plan without its approver block and its "Files to change" section, for
 * a message that has already shown both in its own words.
 */
export function planWithoutApproverParts(markdown: string): string {
  const lines = markdown.split('\n');
  const drop = new Set<number>(approverLines(lines).map(line => line.index));
  lines.forEach((line, index) => {
    if (index < APPROVER_BLOCK_MAX_LINE && APPROVER_HEADING_RE.test(line.trim())) drop.add(index);
  });
  const section = filesToChangeSection(lines);
  if (section) for (let i = section.start; i < section.end; i++) drop.add(i);
  return lines
    .filter((_, index) => !drop.has(index))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizePlannerOutput(raw: unknown, backendId: AgentBackendId): NormalizedPlannerOutput {
  if (backendId === 'claude-code') {
    // Prefer an already-normalized field (idempotent re-normalize), then the
    // Claude-Code envelope's `summary` (plain-text fallback path), then a bare
    // string. The markdown is what the ExitPlanMode tool emits.
    const rawObj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    const markdown =
      typeof rawObj?.planMarkdown === 'string'
        ? (rawObj.planMarkdown as string).trim()
        : typeof rawObj?.summary === 'string'
          ? (rawObj.summary as string).trim()
          : typeof raw === 'string'
            ? raw.trim()
            : '';
    // A plan that came back as JSON steps rather than markdown (an older
    // revision prompt asked for that) is rendered, never dropped: dropping it
    // kept the previous plan and the coder built that instead (issue #388).
    if (!markdown && Array.isArray(rawObj?.plan)) {
      return normalizePlannerOutput(raw, 'codex');
    }

    // What the planner listed as files to change wins over a guess from every
    // path-shaped token in the plan (issue #437).
    const carriedFiles = coerceStringArray(rawObj?.affectedFiles);
    const affectedFiles =
      carriedFiles.length > 0
        ? carriedFiles
        : (extractFilesToChange(markdown) ?? extractAffectedFilesFromMarkdown(markdown));
    return {
      approverSummary: parseApproverSummary(markdown),
      planMarkdown: markdown,
      scope: extractScopeFromMarkdown(markdown),
      // Prefer an already-normalized boolean (idempotent re-normalize), else
      // read the planner's `Requires code changes:` tag from the plan markdown.
      // Defaults to true when neither is present (#348 RC2 — was hardcoded true,
      // which destroyed the planner's "no code needed" verdict on this backend).
      requiresCodeChanges:
        typeof rawObj?.requiresCodeChanges === 'boolean'
          ? rawObj.requiresCodeChanges
          : extractRequiresCodeChangesFromMarkdown(markdown),
      clarificationNeeded: coerceClarification(rawObj?.clarificationNeeded),
      affectedFiles,
    };
  }

  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const steps = coerceStringArray(obj.plan);
  const affectedFiles = coerceStringArray(obj.affectedFiles);
  const scope = coerceScope(obj.scope);
  const requiresCodeChanges = typeof obj.requiresCodeChanges === 'boolean' ? obj.requiresCodeChanges : true;
  const clarificationNeeded = coerceClarification(obj.clarificationNeeded);

  return {
    planMarkdown: renderJsonPlanAsMarkdown(steps, affectedFiles),
    scope,
    requiresCodeChanges,
    clarificationNeeded,
    affectedFiles,
    approverSummary: null,
  };
}
