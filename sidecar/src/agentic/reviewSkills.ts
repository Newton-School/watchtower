import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrContext, WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';

/**
 * Repo-committed review skills ("skills lead the review"): target repos ship
 * their own PR-review playbooks under `.claude/skills/<name>/SKILL.md` (and,
 * for newton-web, `.codex/skills/`). Because PR review runs in a git worktree,
 * only COMMITTED skills are visible here — a scan needs no git verification.
 *
 * There is deliberately no naming convention (`newton-api-pr-review`,
 * `pr-review`, `frontend-pr-review` all exist), so review-relevance is decided
 * by a cheap classifier over names + descriptions, never by directory name.
 */

export type SkillSource = 'claude' | 'codex';

export interface RepoReviewSkill {
  /** Frontmatter `name:`, falling back to the skill directory name. */
  name: string;
  description: string;
  source: SkillSource;
  /** Absolute skill directory inside the worktree. */
  dir: string;
  /** Worktree-relative dir (e.g. `.claude/skills/pr-review`) — used in prompts. */
  relDir: string;
  skillFilePath: string;
  /** Markdown body after the frontmatter, capped at MAX_BODY_CHARS. */
  body: string;
  bodyTruncated: boolean;
  /** Flat scalar frontmatter keys (context, agent, allowed-tools, …). */
  frontmatter: Record<string, string>;
}

export interface DiscoveredReviewSkills {
  all: RepoReviewSkill[];
  /** Classifier-selected review skills, primary-playbook-first. */
  applicable: RepoReviewSkill[];
  classifierUsed: boolean;
}

export const EMPTY_DISCOVERY: DiscoveredReviewSkills = { all: [], applicable: [], classifierUsed: false };

/** `.claude` scanned first so it wins the by-name dedupe over `.codex` mirrors. */
const SKILL_ROOTS: ReadonlyArray<readonly [string, SkillSource]> = [
  ['.claude/skills', 'claude'],
  ['.codex/skills', 'codex'],
];
const MAX_SKILLS_SCANNED = 30;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_BODY_CHARS = 20_000;
const MAX_APPLICABLE = 3;
const MAX_CHANGED_PATHS = 40;
const CLASSIFY_TIMEOUT_MS = 30_000;

function skillsDisabled(): boolean {
  return process.env.WATCHTOWER_DISABLE_REPO_REVIEW_SKILLS === '1';
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } | undefined {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const frontmatter: Record<string, string> = {};
  for (const line of fmMatch[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  return { frontmatter, body: content.slice(fmMatch[0].length).trim() };
}

/**
 * Bounded sync scan of the worktree's committed skill trees. Malformed or
 * unreadable SKILL.md files are skipped (WARN) without failing the scan.
 */
export function scanRepoSkills(worktreePath: string, logStep?: WorkflowStepLogger): RepoReviewSkill[] {
  const byName = new Map<string, RepoReviewSkill>();
  let scanned = 0;

  for (const [root, source] of SKILL_ROOTS) {
    const rootPath = path.join(worktreePath, root);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue; // missing tree — normal for most repos
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || scanned >= MAX_SKILLS_SCANNED) continue;
      const dir = path.join(rootPath, entry.name);
      const skillFilePath = path.join(dir, 'SKILL.md');
      let content: string;
      try {
        const stat = fs.statSync(skillFilePath);
        if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) continue;
        content = fs.readFileSync(skillFilePath, 'utf8');
      } catch {
        continue; // no SKILL.md in this dir
      }
      scanned += 1;
      const parsed = parseFrontmatter(content);
      if (!parsed) {
        logStep?.({
          stage: 'agentic.pr_review.skills.malformed',
          level: 'WARN',
          message: `Skipping ${root}/${entry.name}/SKILL.md — no parseable frontmatter.`,
          data: { skillDir: `${root}/${entry.name}` },
        });
        continue;
      }
      const name = parsed.frontmatter.name?.trim() || entry.name;
      if (byName.has(name)) continue; // .claude copy wins over the .codex mirror
      const bodyTruncated = parsed.body.length > MAX_BODY_CHARS;
      byName.set(name, {
        name,
        description: parsed.frontmatter.description?.trim() ?? '',
        source,
        dir,
        relDir: `${root}/${entry.name}`,
        skillFilePath,
        body: bodyTruncated ? `${parsed.body.slice(0, MAX_BODY_CHARS)}\n\n[... skill body truncated]` : parsed.body,
        bodyTruncated,
        frontmatter: parsed.frontmatter,
      });
    }
  }

  return [...byName.values()];
}

/** Top-level changed paths from a unified diff, for classifier context. */
export function extractChangedPaths(diff: string, cap = MAX_CHANGED_PATHS): string[] {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+?) b\//gm)) {
    paths.add(match[1]);
    if (paths.size >= cap) break;
  }
  return [...paths];
}

function buildClassifierPrompt(params: {
  skills: RepoReviewSkill[];
  prContext: PrContext;
  prTitle?: string;
  changedPaths: string[];
}): string {
  const { skills, prContext, prTitle, changedPaths } = params;
  const skillLines = skills
    .map((skill, i) => `${i + 1}. ${skill.name} [${skill.source}] — ${skill.description || '(no description)'}`)
    .join('\n');
  const pathsBlock =
    changedPaths.length > 0 ? `\nChanged paths (sample):\n${changedPaths.map(p => `- ${p}`).join('\n')}\n` : '';

  return `You select which of a repository's committed agent skills should steer an automated PR review.

PR: ${prContext.owner}/${prContext.repo}#${prContext.number}${prTitle ? ` — "${prTitle}"` : ''}
${pathsBlock}
Skills committed in this repository (name [source] — description):
${skillLines}

Select ONLY skills whose primary purpose is reviewing pull requests / code changes — a review
playbook, checklist, or quality gate. EXCLUDE skills for: writing or fixing code, deploying,
posting or formatting comments (e.g. "*-commenter"), generating assets, image/asset pipelines,
or audits that require project tooling to be installed.
Order the selection primary-playbook-first for THIS PR (use the changed paths — e.g. a
page-specific review skill only when page files changed). Select at most ${MAX_APPLICABLE}.
Selecting none is a valid answer.

Reply with ONLY this JSON object (no prose, no code fences):
{ "applicable": ["<exact skill name>", ...], "reasoning": "<one sentence>" }`;
}

/**
 * Cheap-model classification of which scanned skills apply to PR review
 * (repoClassifier precedent: lightweight profile, tmp cwd, strict JSON,
 * explicit fallback on any failure).
 */
export async function classifyReviewSkills(params: {
  skills: RepoReviewSkill[];
  prContext: PrContext;
  prTitle?: string;
  changedPaths?: string[];
  runAgent?: typeof runCodex;
  timeoutMs?: number;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ applicable: RepoReviewSkill[]; ok: boolean }> {
  const { skills, prContext, prTitle, changedPaths = [], logStep, signal } = params;
  const runAgent = params.runAgent ?? runCodex;
  if (skills.length === 0) return { applicable: [], ok: true };

  const failed = (detail: string): { applicable: RepoReviewSkill[]; ok: boolean } => {
    logStep?.({
      stage: 'agentic.pr_review.skills.classify_failed',
      level: 'WARN',
      message: `Skill classifier unavailable (${detail}) — running the standard review without repo skills.`,
      data: { prUrl: prContext.url },
    });
    return { applicable: [], ok: false };
  };

  let parsedJson: Record<string, unknown> | undefined;
  try {
    const profile = lightweightProfile(getActiveBackendId());
    const result = await runAgent({
      cwd: os.tmpdir(),
      prompt: buildClassifierPrompt({ skills, prContext, prTitle, changedPaths }),
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: params.timeoutMs ?? CLASSIFY_TIMEOUT_MS,
      onLog: logStep,
      signal,
    });
    if (!result.ok || !result.parsedJson) return failed(`exit ${result.exitCode}`);
    parsedJson = result.parsedJson;
  } catch (error) {
    return failed(String(error));
  }

  const rawNames = Array.isArray(parsedJson.applicable) ? parsedJson.applicable : [];
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const applicable: RepoReviewSkill[] = [];
  const dropped: string[] = [];
  for (const raw of rawNames) {
    if (applicable.length >= MAX_APPLICABLE) break;
    const skill = typeof raw === 'string' ? byName.get(raw.trim()) : undefined;
    if (skill && !applicable.includes(skill)) applicable.push(skill);
    else dropped.push(String(raw));
  }

  logStep?.({
    stage: 'agentic.pr_review.skills.classified',
    message: `Skill classifier selected ${applicable.length}/${skills.length} skill(s)${
      dropped.length > 0 ? ` (dropped ${dropped.length} unknown name(s))` : ''
    }.`,
    data: {
      prUrl: prContext.url,
      applicable: applicable.map(skill => skill.name),
      dropped,
      reasoning: typeof parsedJson.reasoning === 'string' ? parsedJson.reasoning : undefined,
    },
  });
  return { applicable, ok: true };
}

/**
 * Scan + classify in one call. Never throws — every failure mode degrades to
 * EMPTY_DISCOVERY (i.e. exactly today's standard review). Zero model calls
 * when the scan finds nothing.
 */
export async function discoverReviewSkills(params: {
  worktreePath: string;
  prContext: PrContext;
  prTitle?: string;
  changedPaths?: string[];
  runAgent?: typeof runCodex;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<DiscoveredReviewSkills> {
  const { worktreePath, prContext, logStep, signal } = params;

  const none = (reason: string): DiscoveredReviewSkills => {
    logStep?.({
      stage: 'agentic.pr_review.skills.none',
      message: `No repo review skills in play (${reason}).`,
      data: { prUrl: prContext.url, reason },
    });
    return EMPTY_DISCOVERY;
  };

  try {
    if (skillsDisabled()) return none('disabled');

    const all = scanRepoSkills(worktreePath, logStep);
    if (all.length === 0) return none('none_found');

    logStep?.({
      stage: 'agentic.pr_review.skills.discovered',
      message: `Found ${all.length} committed skill(s) in the worktree.`,
      data: {
        prUrl: prContext.url,
        count: all.length,
        names: all.map(skill => skill.name),
        sources: all.map(skill => skill.source),
        truncatedBodies: all.filter(skill => skill.bodyTruncated).length,
      },
    });

    if (signal?.aborted) return { all, applicable: [], classifierUsed: false };

    const { applicable } = await classifyReviewSkills({
      skills: all,
      prContext: params.prContext,
      prTitle: params.prTitle,
      changedPaths: params.changedPaths,
      runAgent: params.runAgent,
      logStep: params.logStep,
      signal: params.signal,
    });
    if (applicable.length === 0 && all.length > 0) {
      logStep?.({
        stage: 'agentic.pr_review.skills.none',
        message: 'No repo review skills in play (classifier_excluded_all).',
        data: { prUrl: prContext.url, reason: 'classifier_excluded_all' },
      });
    }
    return { all, applicable, classifierUsed: true };
  } catch (error) {
    logStep?.({
      stage: 'agentic.pr_review.skills.classify_failed',
      level: 'WARN',
      message: `Skill discovery threw (${String(error)}) — running the standard review without repo skills.`,
      data: { prUrl: prContext.url },
    });
    return EMPTY_DISCOVERY;
  }
}
