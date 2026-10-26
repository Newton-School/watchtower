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
import { informationalSystemPrompt } from '../src/agentic/agenticEntry.js';
import type { AppConfig } from '../src/types/contracts.js';

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

const values = (text: string) => reportCandidates(text).map(candidate => `${candidate.kind}:${candidate.value}`);

describe('reportCandidates', () => {
  it('reads file paths, newtonschool.co page slugs and word runs, strongest first', () => {
    const list = values(
      '<@UBOT> the fee on <https://www.newtonschool.co/agentic-ai-course|the page> changed, see `src/features/x-y/content.ts`. The Agentic AI course page used to say 1.3L',
    );
    expect(list[0]).toBe('path:src/features/x-y/content.ts');
    expect(list[1]).toBe('link:agentic-ai-course');
    // Longer word runs come before shorter ones; the link's slug isn't repeated.
    expect(list.indexOf('words:the-agentic-ai-course')).toBeLessThan(list.indexOf('words:ai-course'));
    expect(list.filter(value => value.endsWith(':agentic-ai-course'))).toEqual(['link:agentic-ai-course']);
  });

  it('builds no word runs from the words of a path or a link', () => {
    const list = values(
      'see src/components/course-details/index.js and https://www.newtonschool.co/koyo-ai-interviewer',
    );
    expect(list).not.toContain('words:course-details');
    expect(list).not.toContain('words:koyo-ai-interviewer');
  });

  it('reads paths with brackets and route groups', () => {
    expect(values('see src/pages/course/[courseHash]/index.tsx failing')).toContain(
      'path:src/pages/course/[courseHash]/index.tsx',
    );
    expect(values('in src/app/(landing)/nst/page.tsx')).toContain('path:src/app/(landing)/nst/page.tsx');
  });

  it('takes only multi-word page slugs from newtonschool.co links', () => {
    const list = values(
      'see https://example.com/secret-page, https://django.newtonschool.co/admin/users/user/12/change/ and https://www.newtonschool.co/assets/images/hero.png and https://django.newtonschool.co/admin/video_sessions/videosession/9/change/',
    );
    expect(list.filter(value => value.startsWith('link:'))).toEqual(['link:video-sessions']);
  });
});

describe('matchPathspecs', () => {
  const files = [
    'src/features/agentic-ai-course/content.ts',
    'src/features/agentic-ai-course/sections/hero.tsx',
    'src/app/(landing)/agentic-ai-course/page.tsx',
    'src/lib/forms/rcb.ts',
    'src/components/course-details/index.js',
    'src/containers/Dashboard/index.js',
    'public/assets/course-details/a.png',
    'src/akhaada/x/all-submissions/i.js',
    'src/features/koyo/_design/capture-data/notes.md',
    '.claude/skills/perf-improvement/SKILL.md',
    'tests/components/image-stream/a.test.js',
    'src/components/image-stream/index.js',
    'video_sessions/models.py',
    'README.md',
  ];
  const specs = (text: string) => matchPathspecs(files, reportCandidates(text)).map(match => match.pathspec);

  it('maps a slug to every folder with that name, and a path to its file', () => {
    expect(specs('the agentic ai course page')).toEqual([
      'src/app/(landing)/agentic-ai-course',
      'src/features/agentic-ai-course',
    ]);
    expect(specs('broken in forms/rcb.ts')).toEqual(['src/lib/forms/rcb.ts']);
  });

  it('keeps the files a report names ahead of folders matched by words', () => {
    expect(
      specs(
        'the bug is in src/components/course-details/index.js (see also src/containers/Dashboard/index.js and the all submissions tab)',
      ),
    ).toEqual([
      'src/components/course-details/index.js',
      'src/containers/Dashboard/index.js',
      'src/akhaada/x/all-submissions',
    ]);
  });

  it('drops a named file only when its folder is kept', () => {
    expect(specs('agentic-ai-course/content.ts on the agentic ai course page')).toEqual([
      'src/app/(landing)/agentic-ai-course',
      'src/features/agentic-ai-course',
    ]);
  });

  it('skips hidden, underscore, asset and test folders', () => {
    expect(specs('the form does not capture data anymore')).toEqual([]);
    expect(specs('any perf improvement lately?')).toEqual([]);
    expect(specs('camera error, the image stream stops')).toEqual(['src/components/image-stream']);
  });

  it('reads _ in a folder name as -', () => {
    expect(specs('the video sessions recording link is wrong')).toEqual(['video_sessions']);
  });

  it('returns nothing when nothing matches, and at most three pathspecs', () => {
    expect(specs('nope.ts and no such folder')).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => `src/f${i}-x/a.ts`);
    const text = many.map((_, i) => `f${i} x`).join(', ');
    expect(matchPathspecs(many, reportCandidates(text))).toHaveLength(3);
  });

  it('shows the phrase each match came from', () => {
    const [match] = matchPathspecs(files, reportCandidates('the Image Stream stops'));
    expect(match.candidate.phrase).toBe('image stream');
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

  it('lists recent commits that touched what the report names, marked as hints', async () => {
    const { block, matched } = await recentChangesNear({
      repos: [{ key: 'newton-marketing-web', path: repo }],
      reportText: 'the fee on the Agentic AI course page changed this week',
    });
    expect(block).toContain('unchecked hints');
    expect(block).toContain('newton-marketing-web: src/features/agentic-ai-course ("agentic ai course")');
    expect(block).toContain('fee 1.3L -> 1.5L (#1483)');
    // Older than the window, and another folder: neither is shown.
    expect(block).not.toContain('old fee copy');
    expect(block).not.toContain('other page change');
    expect(matched).toEqual([
      { repo: 'newton-marketing-web', pathspecs: ['src/features/agentic-ai-course'], commits: 1 },
    ]);
  });

  it('leaves merge commits out', async () => {
    await git(repo, ['checkout', '-q', '-b', 'feature']);
    await commit(repo, 'src/features/agentic-ai-course/hero.ts', 'h\n', 'hero copy on a branch', 1);
    await git(repo, ['checkout', '-q', 'main']);
    await git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #99 from feature', 'feature']);
    const { block } = await recentChangesNear({
      repos: [{ key: 'r', path: repo }],
      reportText: 'agentic ai course',
    });
    expect(block).toContain('hero copy on a branch');
    expect(block).not.toContain('Merge pull request #99');
  });

  it('reports a match with no recent commits for the log, and no block', async () => {
    await commit(repo, 'src/features/quiet-page/a.ts', 'q\n', 'quiet page', 60);
    const { block, matched } = await recentChangesNear({
      repos: [{ key: 'r', path: repo }],
      reportText: 'the quiet page looks wrong',
    });
    expect(block).toBe('');
    expect(matched).toEqual([{ repo: 'r', pathspecs: ['src/features/quiet-page'], commits: 0 }]);
  });

  it('is empty when nothing in the report names a folder or file', async () => {
    expect(await recentChangesNear({ repos: [{ key: 'r', path: repo }], reportText: 'something looks off' })).toEqual({
      block: '',
      matched: [],
    });
  });

  it('caps the lines it returns', async () => {
    for (let i = 0; i < 5; i += 1) {
      await commit(repo, `src/features/agentic-ai-course/c${i}.ts`, `${i}\n`, `change ${i}`, 1);
    }
    const { block } = await recentChangesNear({
      repos: [{ key: 'r', path: repo }],
      reportText: 'agentic ai course',
      maxLines: 3,
    });
    expect(block.split('\n').filter(line => line.startsWith('- '))).toHaveLength(3);
  });

  it('leaves a repo out when git fails, and keeps going to the next repo', async () => {
    const { block } = await recentChangesNear({
      repos: [
        { key: 'missing', path: path.join(repo, 'does-not-exist') },
        { key: 'newton-marketing-web', path: repo },
      ],
      reportText: 'agentic ai course fee',
    });
    expect(block).not.toContain('missing:');
    expect(block).toContain('newton-marketing-web:');
  });

  it('never throws when the git runner fails', async () => {
    const original = __recentChangesGit.run;
    __recentChangesGit.run = () => Promise.reject(new Error('boom'));
    try {
      expect(await recentChangesNear({ repos: [{ key: 'r', path: repo }], reportText: 'agentic ai course' })).toEqual({
        block: '',
        matched: [],
      });
    } finally {
      __recentChangesGit.run = original;
    }
  });

  it('reads the upstream branch when there is one', async () => {
    const calls: string[][] = [];
    const original = __recentChangesGit.run;
    __recentChangesGit.run = (args, cwd) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return Promise.resolve('abc123\n');
      return original(args, cwd);
    };
    try {
      await recentChangesNear({ repos: [{ key: 'r', path: repo }], reportText: 'agentic ai course' });
    } finally {
      __recentChangesGit.run = original;
    }
    const log = calls.find(args => args[0] === 'log');
    expect(log?.[1]).toBe('abc123');
    expect(log).toContain('--no-merges');
  });
});

describe('recent-commit rules', () => {
  it('tells the investigator to read the history before "cannot reproduce", with a verdict per case', () => {
    expect(RECENT_COMMITS_RULE).toContain('do not conclude "cannot reproduce"');
    expect(RECENT_COMMITS_RULE).toContain('already fixed the bug → fixLocation "none"');
    expect(RECENT_COMMITS_RULE).toContain('on purpose');
    expect(RECENT_COMMITS_RULE).toContain('works as intended');
    expect(RECENT_COMMITS_RULE).toContain('regression) → fixLocation "repo"');
    expect(RECENT_COMMITS_RULE).toContain('never invent one');
    expect(RECENT_COMMITS_RULE).toContain('live once deployed');
  });

  it('gives lookups the same check, in the lookup prompt', () => {
    expect(LOOKUP_RECENT_COMMITS_RULE).toContain('git log --since=');
    const config = { repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' } } as AppConfig;
    expect(informationalSystemPrompt(config)).toContain(LOOKUP_RECENT_COMMITS_RULE);
  });
});
