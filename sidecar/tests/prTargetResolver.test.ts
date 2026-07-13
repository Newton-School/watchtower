import { describe, expect, it } from 'vitest';
import { extractAllPrContexts, resolvePrReviewTargets, MAX_REVIEW_TARGETS } from '../src/router/prTargetResolver.js';

const API_PR = 'https://github.com/Newton-School/newton-api/pull/5781';
const WEB_PR = 'https://github.com/Newton-School/newton-web/pull/8652';
const MARKETING_PR = 'https://github.com/Newton-School/newton-marketing-web/pull/42';

// The issue #334 incident thread: parent lists the backend PR first, then the
// frontend PR. Every "first URL wins" regression reproduces against this.
const INCIDENT_THREAD = [
  `please review.\nAdd fill in the blanks sub-type for puzzle questions\n\nbackend : ${API_PR}\nfrontend : ${WEB_PR}`,
];

describe('extractAllPrContexts', () => {
  it('extracts every distinct PR with trigger URLs ranked first', () => {
    const targets = extractAllPrContexts({
      triggerText: `look at ${WEB_PR}`,
      threadTexts: [`${API_PR} and ${WEB_PR} again`],
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ repo: 'newton-web', number: 8652, source: 'trigger' });
    expect(targets[1]).toMatchObject({ repo: 'newton-api', number: 5781, source: 'thread' });
  });

  it('dedupes repeated URLs keeping the first occurrence', () => {
    const targets = extractAllPrContexts({ threadTexts: [API_PR, API_PR, WEB_PR] });
    expect(targets).toHaveLength(2);
    expect(targets.map(t => t.number)).toEqual([5781, 8652]);
  });

  it('returns empty for texts without PR URLs', () => {
    expect(extractAllPrContexts({ triggerText: 'no links', threadTexts: ['none here'] })).toEqual([]);
  });
});

describe('resolvePrReviewTargets (issue #334 bug A)', () => {
  it('incident case 1: "review the frontend PR" picks the newton-web PR, not the first URL', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: '<@UBOT> review the frontend PR and comment the findings directly in the PR.',
      threadTexts: INCIDENT_THREAD,
    });

    expect(resolution.mode).toBe('selector');
    expect(resolution.targets).toHaveLength(1);
    expect(resolution.targets[0]).toMatchObject({ repo: 'newton-web', number: 8652 });
  });

  it('incident case 2: "review both the PRs" targets both, never silently one', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: '<@UBOT> review both the PRs and comment the findings in the PR directly.',
      threadTexts: INCIDENT_THREAD,
    });

    expect(resolution.mode).toBe('selector');
    expect(resolution.targets.map(t => t.number).sort()).toEqual([5781, 8652]);
  });

  it('incident case 3: an explicit URL in the trigger wins outright', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: `<@UBOT> Please review ${WEB_PR}`,
      threadTexts: INCIDENT_THREAD,
    });

    expect(resolution.mode).toBe('trigger_urls');
    expect(resolution.targets).toHaveLength(1);
    expect(resolution.targets[0]).toMatchObject({ repo: 'newton-web', number: 8652, source: 'trigger' });
  });

  it('selects backend PRs via "backend"/"api" qualifiers', () => {
    for (const phrase of ['review the backend PR', 'review the api one']) {
      const resolution = resolvePrReviewTargets({ triggerText: phrase, threadTexts: INCIDENT_THREAD });
      expect(resolution.mode).toBe('selector');
      expect(resolution.targets[0]).toMatchObject({ repo: 'newton-api', number: 5781 });
    }
  });

  it('selects by #number', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review #8652 please',
      threadTexts: INCIDENT_THREAD,
    });

    expect(resolution.mode).toBe('selector');
    expect(resolution.targets[0]?.number).toBe(8652);
  });

  it('goes ambiguous when a #number matches nothing rather than guessing', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review #9999',
      threadTexts: INCIDENT_THREAD,
    });

    expect(resolution.mode).toBe('ambiguous');
    expect(resolution.targets).toEqual([]);
    expect(resolution.candidates).toHaveLength(2);
  });

  it('goes ambiguous when a repo qualifier matches no thread PR', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review the frontend PR',
      threadTexts: [`backend : ${API_PR}`],
    });

    expect(resolution.mode).toBe('ambiguous');
    expect(resolution.candidates).toHaveLength(1);
  });

  it('"review the marketing web PR" picks the marketing PR — \\bweb\\b must not leak (two frontends in thread)', () => {
    for (const phrase of ['review the marketing web PR', 'review the marketing PR', 'review the nmw PR']) {
      const resolution = resolvePrReviewTargets({
        triggerText: phrase,
        threadTexts: [`frontend : ${WEB_PR}\nmarketing : ${MARKETING_PR}`],
      });
      expect(resolution.mode).toBe('selector');
      expect(resolution.targets).toHaveLength(1);
      expect(resolution.targets[0]).toMatchObject({ repo: 'newton-marketing-web', number: 42 });
    }
  });

  it('"review the frontend PR" with only a marketing PR in the thread picks it (frontend family)', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review the frontend PR',
      threadTexts: [`marketing : ${MARKETING_PR}`],
    });
    expect(resolution.mode).toBe('selector');
    expect(resolution.targets[0]).toMatchObject({ repo: 'newton-marketing-web', number: 42 });
  });

  it('"review the web PR" with BOTH frontend PRs in the thread goes ambiguous — never guess between frontends', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review the web PR',
      threadTexts: [`frontend : ${WEB_PR}\nmarketing : ${MARKETING_PR}`],
    });
    expect(resolution.mode).toBe('ambiguous');
    expect(resolution.targets).toEqual([]);
    expect(resolution.candidates).toHaveLength(2);
  });

  it('"review the newton-web PR" stays exact even with a marketing PR present', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review the newton-web PR',
      threadTexts: [`frontend : ${WEB_PR}\nmarketing : ${MARKETING_PR}`],
    });
    expect(resolution.mode).toBe('selector');
    expect(resolution.targets[0]).toMatchObject({ repo: 'newton-web', number: 8652 });
  });

  it('a marketing PR URL alone never matches the web selector (slug contains "web")', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review the api PR',
      threadTexts: [`marketing : ${MARKETING_PR}\nbackend : ${API_PR}`],
    });
    expect(resolution.mode).toBe('selector');
    expect(resolution.targets[0]).toMatchObject({ repo: 'newton-api', number: 5781 });
  });

  it('resolves a single thread PR without qualifiers (the happy path)', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review this please',
      threadTexts: [`check out ${WEB_PR}`],
    });

    expect(resolution.mode).toBe('thread_single');
    expect(resolution.targets[0]?.number).toBe(8652);
  });

  it('goes ambiguous on multiple thread PRs with no selector — never first-URL-wins', () => {
    const resolution = resolvePrReviewTargets({
      triggerText: 'review the PR',
      threadTexts: INCIDENT_THREAD,
    });

    expect(resolution.mode).toBe('ambiguous');
    expect(resolution.targets).toEqual([]);
    expect(resolution.candidates?.map(t => t.number)).toEqual([5781, 8652]);
  });

  it('returns none when no PR exists anywhere (caller keeps the ask-for-URL pause)', () => {
    const resolution = resolvePrReviewTargets({ triggerText: 'review the PR', threadTexts: ['no links'] });
    expect(resolution.mode).toBe('none');
    expect(resolution.targets).toEqual([]);
  });

  it(`caps "all" at ${MAX_REVIEW_TARGETS} targets and reports the truncated remainder`, () => {
    const urls = [1, 2, 3, 4, 5].map(n => `https://github.com/Newton-School/newton-web/pull/${n}`);
    const resolution = resolvePrReviewTargets({
      triggerText: 'review all of these',
      threadTexts: [urls.join('\n')],
    });

    expect(resolution.targets).toHaveLength(MAX_REVIEW_TARGETS);
    expect(resolution.truncated).toHaveLength(urls.length - MAX_REVIEW_TARGETS);
  });
});
