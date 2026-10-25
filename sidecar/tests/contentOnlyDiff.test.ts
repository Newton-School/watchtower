import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_ONLY_MAX_FILES,
  checkContentOnlyPr,
  differsOnlyInContent,
  globToRegExp,
  isContentPath,
} from '../src/github/contentOnlyDiff.js';
import { REPO_REGISTRY } from '../src/repos/registry.js';

// Issue #701: a PR that only changes copy, numbers and asset links may be
// merged by builders. "Only" is read from the files: the old and new versions
// must be the same program once content literals are masked.

const policy = REPO_REGISTRY['newton-marketing-web'].contentPolicy!;

const HERO = `'use client';
import Image from 'next/image';
import { track } from '@/lib/analytics';

/** The page's first screen. */
export function Hero({ arm }: { arm: string }) {
  if (arm === 'no_form') return null;
  return (
    <section className="p-4" data-section="hero">
      <h1 title="AI Engineering">Become an AI engineer</h1>
      <p>{'Fees from'} {formatFee(150000)}</p>
      <Image src="https://cdn.example.com/hero.png" alt="Students coding" width={640} height={360} />
      <a href="/apply" onClick={() => track('apply_click')}>Apply now</a>
    </section>
  );
}
`;

const CONTENT = `export const content = {
  title: 'AI Engineering Program',
  fee: 150000,
  phone: '+91 00000 00000',
  images: { hero: 'https://cdn.example.com/hero.png' },
  highlights: ['Live classes', 'Placement support'],
  formId: 'rcb-1',
  offset: -1,
} as const;

export const DEADLINE = '2027-01-15';
`;

async function same(before: string, after: string, fileName = 'hero.tsx') {
  return differsOnlyInContent(before, after, fileName);
}

describe('differsOnlyInContent', () => {
  it.each([
    ['page text', HERO.replace('Become an AI engineer', 'Become a GenAI engineer')],
    ['a copy attribute', HERO.replace('alt="Students coding"', 'alt="Learners coding"')],
    ['a string child expression', HERO.replace("{'Fees from'}", "{'Fee starts at'}")],
    ['an image link', HERO.replace('hero.png', 'hero-v2.png')],
    ['a link target', HERO.replace('href="/apply"', 'href="/apply-now"')],
    ['an image size', HERO.replace('width={640}', 'width={720}')],
    [
      'comments and formatting',
      HERO.replace("/** The page's first screen. */", '// first screen\n// (hero)').replace(
        '  return (',
        '  return  (',
      ),
    ],
  ])('counts a change of %s as content', async (_case, after) => {
    expect(await same(HERO, after)).toBe(true);
  });

  it.each([
    ['a number in a data object', CONTENT.replace('150000', '175000')],
    ['a negative number', CONTENT.replace('offset: -1', 'offset: -2')],
    ['a string in a data object', CONTENT.replace('+91 00000 00000', '+91 11111 11111')],
    [
      'an asset link in an object',
      CONTENT.replace("hero: 'https://cdn.example.com/hero.png'", "hero: 'https://cdn.example.com/hero-2.png'"),
    ],
    ['an array element', CONTENT.replace('Live classes', 'Live classes, weekly')],
    ['a constant', CONTENT.replace("'2027-01-15'", "'2027-01-20'")],
    [
      'a list breaking over lines',
      CONTENT.replace("['Live classes', 'Placement support']", "[\n    'Live classes',\n    'Placement support',\n  ]"),
    ],
  ])('counts a change of %s as content', async (_case, after) => {
    expect(await same(CONTENT, after, 'content.ts')).toBe(true);
  });

  it('ignores what a formatter adds when longer text no longer fits', async () => {
    const before = `export const A = () => <p>Short text <b>here</b></p>;\n`;
    const after = `export const A = () => (\n  <p>\n    A much longer text that wraps{' '}\n    <b>here</b>\n  </p>\n);\n`;
    expect(await same(before, after)).toBe(true);
  });

  it.each([
    ['a class name', HERO.replace('className="p-4"', 'className="p-8"')],
    ['a data attribute', HERO.replace('data-section="hero"', 'data-section="top"')],
    ['a compared string', HERO.replace("arm === 'no_form'", "arm === 'with_form'")],
    ['a call argument', HERO.replace("track('apply_click')", "track('apply_tap')")],
    ['a call wrapping a number', HERO.replace('formatFee(150000)', 'formatFee(175000)')],
    [
      'an added import',
      HERO.replace("import Image from 'next/image';", "import Image from 'next/image';\nimport Link from 'next/link';"),
    ],
    [
      'an added statement',
      HERO.replace(
        "  if (arm === 'no_form') return null;",
        "  if (arm === 'no_form') return null;\n  console.log(arm);",
      ),
    ],
    [
      'added markup',
      HERO.replace(
        '<h1 title="AI Engineering">Become an AI engineer</h1>',
        '<h1 title="AI Engineering">Become an <b>AI</b> engineer</h1>',
      ),
    ],
    ['a link that runs code', HERO.replace('href="/apply"', 'href="javascript:alert(1)"')],
    ['text that becomes a template', HERO.replace("{'Fees from'}", '{`Fees from ${city}`}')],
  ])('does not count a change of %s as content', async (_case, after) => {
    expect(await same(HERO, after)).toBe(false);
  });

  it.each([
    ['an id-like key', CONTENT.replace("'rcb-1'", "'rcb-2'")],
    ['a number turned into text', CONTENT.replace('fee: 150000', "fee: '₹1.5L'")],
    ['a reference in place of a literal', CONTENT.replace("'2027-01-15'", 'NEXT_DEADLINE')],
  ])('does not count a change of %s as content', async (_case, after) => {
    expect(await same(CONTENT, after, 'content.ts')).toBe(false);
  });

  it('treats the body of a <script> or <style> as code', async () => {
    const before = `export const A = () => <><style>{'.a { color: red }'}</style><script>{'run()'}</script></>;\n`;
    expect(await same(before, before.replace('run()', 'steal()'))).toBe(false);
    expect(await same(before, before.replace('red', 'blue'))).toBe(false);
  });

  it('treats a script source as code, not an asset', async () => {
    const before = `export const A = () => <script src="https://cdn.example.com/a.js" />;\n`;
    expect(await same(before, before.replace('a.js', 'b.js'))).toBe(false);
  });

  it('is undefined when a version does not parse', async () => {
    expect(await same(HERO, HERO.replace('</section>', '</sectio'))).toBeUndefined();
  });
});

describe('isContentPath', () => {
  it.each([
    ['src/features/agentic-ai-course/content.ts', true],
    ['src/features/data-science-ns-v4/sections/hero.tsx', true],
    ['src/app/(landing)/courses/data-science/page.tsx', true],
    ['src/components/ui/card.tsx', true],
    ['src/lib/experiments/registry.ts', false],
    ['worker/paths.js', false],
    ['worker/index.ts', false],
    ['.github/workflows/deploy-prod.yml', false],
    ['src/features/data-science-ns-v4/forms/rcb-modal.tsx', false],
    ['src/features/agentic-ai-course/analytics.ts', false],
    ['src/features/data-science-ns-v4/experiment.ts', false],
    ['src/features/x/analytics/events.ts', false],
    ['src/features/x/sections/hero.test.tsx', false],
    ['src/features/x/content.json', false],
    ['src/features/x/types.d.ts', false],
    ['package.json', false],
  ])('%s → %s', (filePath, expected) => {
    expect(isContentPath(filePath, policy)).toBe(expected);
  });

  it('reads ** as any number of folders, none included', () => {
    expect(globToRegExp('**/forms/**').test('forms/a.tsx')).toBe(true);
    expect(globToRegExp('**/forms/**').test('src/x/forms/a.tsx')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});

describe('checkContentOnlyPr', () => {
  const api = 'https://api.github.com/repos/Newton-School/newton-marketing-web';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  /** GitHub as a map from URL to answer; anything else is a 404. */
  function github(routes: Record<string, () => Response>) {
    return vi.fn(async (url: string) => (routes[url] ?? (() => new Response('not found', { status: 404 })))());
  }
  const pr = () => json({ state: 'open', head: { sha: 'HEAD' }, base: { sha: 'BASE' } });
  const compare = () => json({ merge_base_commit: { sha: 'MB' } });
  const files =
    (...entries: Array<[string, string]>) =>
    () =>
      json(entries.map(([filename, status]) => ({ filename, status })));
  const raw = (text: string) => () => new Response(text);
  const check = (fetcher: ReturnType<typeof github>) =>
    checkContentOnlyPr({
      owner: 'Newton-School',
      repo: 'newton-marketing-web',
      number: 1490,
      githubToken: 'ghs_test',
      policy,
      fetcher,
    });

  it('passes a copy change, reading the file where the branch left its base and at its head', async () => {
    const path = 'src/features/agentic-ai-course/content.ts';
    const fetcher = github({
      [`${api}/pulls/1490`]: pr,
      [`${api}/pulls/1490/files?per_page=100`]: files([path, 'modified']),
      [`${api}/compare/BASE...HEAD`]: compare,
      [`${api}/contents/${path}?ref=MB`]: raw(CONTENT),
      [`${api}/contents/${path}?ref=HEAD`]: raw(CONTENT.replace('150000', '175000')),
    });

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [path], headSha: 'HEAD' });
    const headers = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghs_test');
  });

  it('names the file that changes code', async () => {
    const path = 'src/features/x/sections/hero.tsx';
    const fetcher = github({
      [`${api}/pulls/1490`]: pr,
      [`${api}/pulls/1490/files?per_page=100`]: files([path, 'modified']),
      [`${api}/compare/BASE...HEAD`]: compare,
      [`${api}/contents/${path}?ref=MB`]: raw(HERO),
      [`${api}/contents/${path}?ref=HEAD`]: raw(HERO.replace('className="p-4"', 'className="p-8"')),
    });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'not_content', offending: [path] });
  });

  it.each([
    ['an added file', ['src/features/x/content.ts', 'added']],
    ['a renamed file', ['src/features/x/content.ts', 'renamed']],
    ['a removed file', ['src/features/x/content.ts', 'removed']],
    ['a worker file', ['worker/paths.js', 'modified']],
    ['a denied path', ['src/lib/experiments/registry.ts', 'modified']],
  ] as Array<[string, [string, string]]>)('turns down %s without reading it', async (_case, entry) => {
    const fetcher = github({ [`${api}/pulls/1490`]: pr, [`${api}/pulls/1490/files?per_page=100`]: files(entry) });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'not_content', offending: [entry[0]] });
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/contents/'))).toBe(false);
  });

  it('turns down more files than a copy edit has', async () => {
    const many = Array.from(
      { length: CONTENT_ONLY_MAX_FILES + 1 },
      (_, i) => [`src/features/x/content-${i}.ts`, 'modified'] as [string, string],
    );
    const fetcher = github({ [`${api}/pulls/1490`]: pr, [`${api}/pulls/1490/files?per_page=100`]: files(...many) });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'too_many_files', fileCount: 21 });
  });

  it.each([
    ['the PR cannot be read', {}],
    [
      'the PR is closed',
      { [`${api}/pulls/1490`]: () => json({ state: 'closed', head: { sha: 'H' }, base: { sha: 'B' } }) },
    ],
    [
      'a file cannot be read',
      {
        [`${api}/pulls/1490`]: pr,
        [`${api}/pulls/1490/files?per_page=100`]: files(['src/features/x/content.ts', 'modified']),
        [`${api}/compare/BASE...HEAD`]: compare,
      },
    ],
    [
      'a file is too large',
      {
        [`${api}/pulls/1490`]: pr,
        [`${api}/pulls/1490/files?per_page=100`]: files(['src/features/x/content.ts', 'modified']),
        [`${api}/compare/BASE...HEAD`]: compare,
        [`${api}/contents/src/features/x/content.ts?ref=MB`]: raw(`export const a = '${'x'.repeat(250_000)}';`),
        [`${api}/contents/src/features/x/content.ts?ref=HEAD`]: raw(CONTENT),
      },
    ],
    [
      'a file does not parse',
      {
        [`${api}/pulls/1490`]: pr,
        [`${api}/pulls/1490/files?per_page=100`]: files(['src/features/x/content.ts', 'modified']),
        [`${api}/compare/BASE...HEAD`]: compare,
        [`${api}/contents/src/features/x/content.ts?ref=MB`]: raw(CONTENT),
        [`${api}/contents/src/features/x/content.ts?ref=HEAD`]: raw('export const = {'),
      },
    ],
  ] as Array<[string, Record<string, () => Response>]>)('is not content-only when %s', async (_case, routes) => {
    expect(await check(github(routes))).toMatchObject({ contentOnly: false, kind: 'unreadable' });
  });

  it('never throws, even when the network does', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await check(fetcher as never)).toMatchObject({ contentOnly: false, kind: 'unreadable' });
  });

  it('encodes route folders in a file path', async () => {
    const path = 'src/app/(landing)/courses/ai/page.tsx';
    const encoded = 'src/app/(landing)/courses/ai/page.tsx'.split('/').map(encodeURIComponent).join('/');
    const fetcher = github({
      [`${api}/pulls/1490`]: pr,
      [`${api}/pulls/1490/files?per_page=100`]: files([path, 'modified']),
      [`${api}/compare/BASE...HEAD`]: compare,
      [`${api}/contents/${encoded}?ref=MB`]: raw(HERO),
      [`${api}/contents/${encoded}?ref=HEAD`]: raw(HERO.replace('Apply now', 'Apply today')),
    });

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [path], headSha: 'HEAD' });
  });
});
