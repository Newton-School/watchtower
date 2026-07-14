import type { AgentBackendId } from '../types/contracts.js';

export type PlanScope = 'small' | 'medium' | 'large';

export interface NormalizedPlannerOutput {
  planMarkdown: string;
  scope: PlanScope;
  requiresCodeChanges: boolean;
  clarificationNeeded: string | null;
  affectedFiles: string[];
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
  // Harness bookkeeping paths (agent-written plan files, session artifacts
  // under ~/.claude or /Users/x/.claude) are never repo files (#408).
  if (/(^|\/)\.claude\//.test(candidate) || candidate.startsWith('~/')) return false;
  // Reject function-call-shaped tokens (`foo()`, `foo(arg)`) but allow path
  // segments with parens like Next.js route groups (`src/app/(marketing)/page.tsx`).
  if ((candidate.includes('(') || candidate.includes(')')) && !candidate.includes('/')) return false;
  // Reject schemeless URLs whose first segment is host-shaped (`github.com/org/repo`).
  // `./foo` and `../foo` are allowed (`.`/`..` aren't hosts).
  const slashIdx = candidate.indexOf('/');
  if (slashIdx > 0) {
    const firstSegment = candidate.slice(0, slashIdx);
    if (firstSegment !== '.' && firstSegment !== '..' && firstSegment.includes('.')) return false;
  }
  const base = basenameOf(candidate);
  if (KNOWN_BASENAMES.has(base)) return true;
  if (DOTFILE_PATTERN.test(base)) return true;
  if (candidate.includes('/')) return true;
  return FILE_EXTENSION_PATTERN.test(candidate);
}

function extractAffectedFilesFromMarkdown(markdown: string): string[] {
  const files = new Set<string>();
  const pattern = /`([^`\n]{1,200})`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const candidate = match[1].trim();
    if (looksLikeFilePath(candidate)) files.add(candidate);
  }
  return [...files];
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

    const carriedFiles = coerceStringArray(rawObj?.affectedFiles);
    const affectedFiles = carriedFiles.length > 0 ? carriedFiles : extractAffectedFilesFromMarkdown(markdown);
    return {
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
  };
}
