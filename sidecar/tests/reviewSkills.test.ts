/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DISCOVERY,
  classifyReviewSkills,
  discoverReviewSkills,
  extractChangedPaths,
  scanRepoSkills,
} from '../src/agentic/reviewSkills.js';
import type { PrContext } from '../src/types/contracts.js';

const PR: PrContext = {
  url: 'https://github.com/Newton-School/newton-api/pull/42',
  owner: 'Newton-School',
  repo: 'newton-api',
  number: 42,
};

const tempDirs: string[] = [];

function makeWorktree(skills: Array<{ root: string; dir: string; content: string }>): string {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-skills-'));
  tempDirs.push(worktree);
  for (const skill of skills) {
    const dir = path.join(worktree, skill.root, skill.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.content);
  }
  return worktree;
}

function skillMd(name: string, description: string, body = 'Do the review.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function classifierOk(applicable: string[]) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '{}',
    stderr: '',
    lastMessage: '',
    parsedJson: { applicable, reasoning: 'test' },
    durationMs: 5,
    backend: 'codex',
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('scanRepoSkills', () => {
  it('scans both .claude and .codex trees and reports source + relDir', () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'pr-review', content: skillMd('pr-review', 'Review PRs.') },
      { root: '.codex/skills', dir: 'frontend-pr-review', content: skillMd('frontend-pr-review', 'Frontend review.') },
    ]);

    const skills = scanRepoSkills(worktree);
    expect(skills.map(s => s.name).sort()).toEqual(['frontend-pr-review', 'pr-review']);
    const claude = skills.find(s => s.name === 'pr-review');
    expect(claude).toMatchObject({ source: 'claude', relDir: '.claude/skills/pr-review' });
    const codex = skills.find(s => s.name === 'frontend-pr-review');
    expect(codex).toMatchObject({ source: 'codex', relDir: '.codex/skills/frontend-pr-review' });
  });

  it('dedupes by name with the .claude copy winning over the .codex mirror', () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'pr-review', content: skillMd('pr-review', 'Rich claude copy.') },
      { root: '.codex/skills', dir: 'pr-review', content: skillMd('pr-review', 'Codex mirror.') },
    ]);

    const skills = scanRepoSkills(worktree);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ source: 'claude', description: 'Rich claude copy.' });
  });

  it('falls back to the directory name when frontmatter has no name', () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'page-review', content: '---\ndescription: Page depth.\n---\n\nBody.\n' },
    ]);

    const skills = scanRepoSkills(worktree);
    expect(skills[0].name).toBe('page-review');
  });

  it('skips a malformed SKILL.md (no frontmatter) but keeps its siblings', () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'broken', content: 'no frontmatter here' },
      { root: '.claude/skills', dir: 'pr-review', content: skillMd('pr-review', 'Review PRs.') },
    ]);
    const logStep = vi.fn();

    const skills = scanRepoSkills(worktree, logStep);
    expect(skills.map(s => s.name)).toEqual(['pr-review']);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.skills.malformed' }));
  });

  it('returns [] for a worktree with no skill trees at all', () => {
    const worktree = makeWorktree([]);
    expect(scanRepoSkills(worktree)).toEqual([]);
  });

  it('truncates oversized bodies with a marker', () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'big', content: skillMd('big', 'Huge skill.', 'x'.repeat(30_000)) },
    ]);

    const [skill] = scanRepoSkills(worktree);
    expect(skill.bodyTruncated).toBe(true);
    expect(skill.body).toContain('[... skill body truncated]');
    expect(skill.body.length).toBeLessThan(21_000);
  });
});

describe('extractChangedPaths', () => {
  it('parses distinct changed paths from diff headers, capped', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      'diff --git a/src/b.ts b/src/b.ts',
      'diff --git a/src/a.ts b/src/a.ts',
    ].join('\n');
    expect(extractChangedPaths(diff)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(extractChangedPaths(diff, 1)).toEqual(['src/a.ts']);
  });
});

describe('classifyReviewSkills', () => {
  const skills = (worktree: string) => scanRepoSkills(worktree);

  it('sends names, descriptions, changed paths, and the JSON contract to the classifier', async () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'pr-review', content: skillMd('pr-review', 'Review PRs before merge.') },
    ]);
    const runAgent = vi.fn().mockResolvedValue(classifierOk(['pr-review']));

    const result = await classifyReviewSkills({
      skills: skills(worktree),
      prContext: PR,
      prTitle: 'Add webhook',
      changedPaths: ['src/webhooks/handler.py'],
      runAgent: runAgent as any,
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.applicable.map(s => s.name)).toEqual(['pr-review']);
    const prompt = runAgent.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('pr-review [claude] — Review PRs before merge.');
    expect(prompt).toContain('src/webhooks/handler.py');
    expect(prompt).toContain('"applicable"');
    expect(prompt).toContain('Add webhook');
  });

  it('filters unknown names, preserves the classifier order, and caps at 3', async () => {
    const worktree = makeWorktree(
      ['a', 'b', 'c', 'd'].map(name => ({
        root: '.claude/skills',
        dir: name,
        content: skillMd(name, `Skill ${name}.`),
      })),
    );
    const runAgent = vi.fn().mockResolvedValue(classifierOk(['d', 'ghost', 'b', 'a', 'c']));

    const result = await classifyReviewSkills({ skills: skills(worktree), prContext: PR, runAgent: runAgent as any });
    expect(result.applicable.map(s => s.name)).toEqual(['d', 'b', 'a']);
  });

  it('fails safe to zero skills when the classifier dies', async () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'pr-review', content: skillMd('pr-review', 'Review PRs.') },
    ]);
    const runAgent = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const logStep = vi.fn();

    const result = await classifyReviewSkills({
      skills: skills(worktree),
      prContext: PR,
      runAgent: runAgent as any,
      logStep,
    });
    expect(result).toEqual({ applicable: [], ok: false });
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agentic.pr_review.skills.classify_failed' }),
    );
  });

  it('never calls the model when there are no skills', async () => {
    const runAgent = vi.fn();
    const result = await classifyReviewSkills({ skills: [], prContext: PR, runAgent: runAgent as any });
    expect(result).toEqual({ applicable: [], ok: true });
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe('discoverReviewSkills', () => {
  it('returns EMPTY_DISCOVERY with zero model calls when the worktree has no skills', async () => {
    const worktree = makeWorktree([]);
    const runAgent = vi.fn();
    const logStep = vi.fn();

    const result = await discoverReviewSkills({
      worktreePath: worktree,
      prContext: PR,
      runAgent: runAgent as any,
      logStep,
    });

    expect(result).toEqual(EMPTY_DISCOVERY);
    expect(runAgent).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.pr_review.skills.none',
        data: expect.objectContaining({ reason: 'none_found' }),
      }),
    );
  });

  it('kill switch WATCHTOWER_DISABLE_REPO_REVIEW_SKILLS=1 short-circuits discovery', async () => {
    vi.stubEnv('WATCHTOWER_DISABLE_REPO_REVIEW_SKILLS', '1');
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'pr-review', content: skillMd('pr-review', 'Review PRs.') },
    ]);
    const runAgent = vi.fn();
    const logStep = vi.fn();

    const result = await discoverReviewSkills({
      worktreePath: worktree,
      prContext: PR,
      runAgent: runAgent as any,
      logStep,
    });

    expect(result).toEqual(EMPTY_DISCOVERY);
    expect(runAgent).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.pr_review.skills.none',
        data: expect.objectContaining({ reason: 'disabled' }),
      }),
    );
  });

  it('discovers, classifies, and logs the classifier_excluded_all reason when nothing applies', async () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'deploy', content: skillMd('deploy', 'Deploy the app.') },
    ]);
    const runAgent = vi.fn().mockResolvedValue(classifierOk([]));
    const logStep = vi.fn();

    const result = await discoverReviewSkills({
      worktreePath: worktree,
      prContext: PR,
      runAgent: runAgent as any,
      logStep,
    });

    expect(result.all).toHaveLength(1);
    expect(result.applicable).toEqual([]);
    expect(result.classifierUsed).toBe(true);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.skills.discovered' }));
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.pr_review.skills.none',
        data: expect.objectContaining({ reason: 'classifier_excluded_all' }),
      }),
    );
  });

  it('returns the applicable skills when the classifier selects them', async () => {
    const worktree = makeWorktree([
      { root: '.claude/skills', dir: 'newton-api-pr-review', content: skillMd('newton-api-pr-review', 'Review.') },
    ]);
    const runAgent = vi.fn().mockResolvedValue(classifierOk(['newton-api-pr-review']));

    const result = await discoverReviewSkills({ worktreePath: worktree, prContext: PR, runAgent: runAgent as any });
    expect(result.applicable.map(s => s.name)).toEqual(['newton-api-pr-review']);
    expect(result.classifierUsed).toBe(true);
  });
});
