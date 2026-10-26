import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  __recentChangesGit,
  LOOKUP_RECENT_COMMITS_RULE,
  matchPathspecs,
  RECENT_COMMITS_RULE,
  recentChangesNear,
  reportCandidates,
} from '../src/workflows/shared/recentChanges.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { ...process.env, ...env } });
  return stdout.trim();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function commit(repo: string, file: string, content: string, message: string, ageDays: number): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), content);
  await git(repo, ['add', file]);
  const date = daysAgo(ageDays);
  await git(repo, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

describe('reportCandidates', () => {
  it('reads file paths, newtonschool.co page slugs and word runs from a report', () => {
    const { paths, slugs } = reportCandidates(
      '<@UBOT> the fee on <https://www.newtonschool.co/agentic-ai-course|the page> changed, see `src/features/agentic-ai-course/content.ts`. The Agentic AI course page used to say 1.3L',
    );
    expect(paths).toContain('src/features/agentic-ai-course/content.ts');
    expect(slugs).toContain('agentic-ai-course');
    // "Agentic AI course" in the words becomes the same slug.
    expect(slugs.filter(slug => slug === 'agentic-ai-course').length).toBe(1);
    expect(slugs).toContain('ai-course');
  });

  it('ignores links to other sites and generic segments', () => {
    const { slugs } = reportCandidates('see https://example.com/secret-page and https://www.newtonschool.co/courses');
    expect(slugs).not.toContain('secret-page');
    expect(slugs).not.toContain('courses');
  });
});

describe('matchPathspecs', () => {
  const files = [
    'src/features/agentic-ai-course/content.ts',
    'src/features/agentic-ai-course/sections/hero.tsx',
    'src/app/(landing)/agentic-ai-course/page.tsx',
    'src/lib/forms/rcb.ts',
    'README.md',
  ];

  it('maps a slug to every folder with that name, and a path to its file', () => {
    expect(matchPathspecs(files, { paths: [], slugs: ['agentic-ai-course'] })).toEqual([
      'src/app/(landing)/agentic-ai-course',
      'src/features/agentic-ai-course',
    ]);
    expect(matchPathspecs(files, { paths: ['forms/rcb.ts'], slugs: [] })).toEqual(['src/lib/forms/rcb.ts']);
  });

  it('drops a file already inside a chosen folder', () => {
    expect(matchPathspecs(files, { paths: ['agentic-ai-course/content.ts'], slugs: ['agentic-ai-course'] })).toEqual([
      'src/app/(landing)/agentic-ai-course',
      'src/features/agentic-ai-course',
    ]);
  });

  it('returns nothing when nothing matches, and at most three pathspecs', () => {
    expect(matchPathspecs(files, { paths: ['nope.ts'], slugs: ['no-such-folder'] })).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => `src/f${i}-x/a.ts`);
    expect(matchPathspecs(many, { paths: [], slugs: many.map((_, i) => `f${i}-x`) })).toHaveLength(3);
  });
});

describe('recentChangesNear', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'wt-recent-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await commit(repo, 'src/features/agentic-ai-course/content.ts', 'fee 1.3L\n', 'old fee copy', 40);
    await commit(repo, 'src/features/other-page/content.ts', 'x\n', 'other page change', 2);
    await commit(repo, 'src/features/agentic-ai-course/content.ts', 'fee 1.5L\n', 'fee 1.3L -> 1.5L (#1483)', 2);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('lists recent commits that touched what the report names, and only those', async () => {
    const block = await recentChangesNear({
      repos: [{ key: 'newton-marketing-web', path: repo }],
      reportText: 'the fee on the Agentic AI course page changed this week',
    });
    expect(block).toContain('Recent changes near what was reported');
    expect(block).toContain('newton-marketing-web (src/features/agentic-ai-course)');
    expect(block).toContain('fee 1.3L -> 1.5L (#1483)');
    // Older than the window, and another folder: neither is shown.
    expect(block).not.toContain('old fee copy');
    expect(block).not.toContain('other page change');
  });

  it('is empty when nothing in the report names a folder or file', async () => {
    expect(await recentChangesNear({ repos: [{ key: 'r', path: repo }], reportText: 'something looks off' })).toBe('');
  });

  it('caps the lines it returns', async () => {
    for (let i = 0; i < 5; i += 1) {
      await commit(repo, `src/features/agentic-ai-course/c${i}.ts`, `${i}\n`, `change ${i}`, 1);
    }
    const block = await recentChangesNear({
      repos: [{ key: 'r', path: repo }],
      reportText: 'agentic ai course',
      maxLines: 3,
    });
    expect(block.split('\n').filter(line => line.startsWith('- '))).toHaveLength(3);
  });

  it('leaves the block out when git fails, and keeps going to the next repo', async () => {
    const block = await recentChangesNear({
      repos: [
        { key: 'missing', path: path.join(repo, 'does-not-exist') },
        { key: 'newton-marketing-web', path: repo },
      ],
      reportText: 'agentic ai course fee',
    });
    expect(block).not.toContain('missing');
    expect(block).toContain('newton-marketing-web');
  });

  it('never throws when the git runner fails', async () => {
    const original = __recentChangesGit.run;
    __recentChangesGit.run = () => Promise.reject(new Error('boom'));
    try {
      expect(await recentChangesNear({ repos: [{ key: 'r', path: repo }], reportText: 'agentic ai course' })).toBe('');
    } finally {
      __recentChangesGit.run = original;
    }
  });
});

describe('recent-commit rules', () => {
  it('tells the investigator to read the history before "cannot reproduce", and how to report a fix', () => {
    expect(RECENT_COMMITS_RULE).toContain('do not conclude "cannot reproduce"');
    expect(RECENT_COMMITS_RULE).toContain('git log --since=');
    expect(RECENT_COMMITS_RULE).toContain('fixLocation "none"');
  });

  it('gives lookups the same check', () => {
    expect(LOOKUP_RECENT_COMMITS_RULE).toContain('git log --since=');
    expect(LOOKUP_RECENT_COMMITS_RULE).toContain('short sha, date and PR number');
  });
});
