import { describe, expect, it } from 'vitest';
import { extractQaTargetUrl, isWebappQaRequest, isWebappQaOnPrRequest } from '../src/router/intentParser.js';
import { parseScreenshotManifest } from '../src/slack/imageUploader.js';
import { changedPathsFromDiff, classifyChangedPaths, findFreePort } from '../src/devServer/devServerManager.js';

const PR_URL = 'https://github.com/Newton-School/newton-web/pull/8399';

describe('extractQaTargetUrl', () => {
  it('returns a generic http(s) target URL', () => {
    expect(extractQaTargetUrl('QA the login flow on https://staging.example.com/login')).toBe(
      'https://staging.example.com/login',
    );
  });

  it('trims trailing punctuation', () => {
    expect(extractQaTargetUrl('check https://app.example.com/x.')).toBe('https://app.example.com/x');
    expect(extractQaTargetUrl('test (https://app.example.com/y)')).toBe('https://app.example.com/y');
  });

  it('skips GitHub PR URLs (those belong to PR_REVIEW)', () => {
    expect(extractQaTargetUrl('test this https://github.com/Newton-School/newton-web/pull/42')).toBeUndefined();
  });

  it('skips Metabase URLs (those belong to INFORMATIONAL)', () => {
    expect(extractQaTargetUrl('test https://metabase-abc.newtonschool.co/question/5')).toBeUndefined();
  });

  it('returns undefined when there is no URL', () => {
    expect(extractQaTargetUrl('QA the login flow please')).toBeUndefined();
  });
});

describe('isWebappQaRequest', () => {
  it('fires on a QA verb + a valid target URL', () => {
    expect(isWebappQaRequest('<@U1> QA the login flow on https://staging.example.com/login')).toBe(true);
    expect(isWebappQaRequest('smoke-test https://app.example.com/checkout')).toBe(true);
    expect(isWebappQaRequest('test the signup page on https://app.example.com/signup')).toBe(true);
  });

  it('does not fire without a URL', () => {
    expect(isWebappQaRequest('QA the login flow')).toBe(false);
  });

  it('does not fire without a QA verb', () => {
    expect(isWebappQaRequest('look at https://app.example.com/login')).toBe(false);
  });

  it('falls through when a build/ship verb muddies the ask', () => {
    expect(isWebappQaRequest('test then fix the login on https://app.example.com/login')).toBe(false);
    expect(isWebappQaRequest('implement and QA the form at https://app.example.com/form')).toBe(false);
  });

  it('does not fire on a bare PR URL paste', () => {
    expect(isWebappQaRequest('test this https://github.com/Newton-School/newton-web/pull/42')).toBe(false);
  });
});

describe('isWebappQaOnPrRequest', () => {
  it('fires on a QA verb + a GitHub PR URL', () => {
    expect(isWebappQaOnPrRequest(`<@U1> test this PR ${PR_URL}`)).toBe(true);
    expect(isWebappQaOnPrRequest(`QA ${PR_URL}`)).toBe(true);
    expect(isWebappQaOnPrRequest(`smoke-test ${PR_URL} on staging`)).toBe(true);
  });

  it('does NOT fire for a review request (stays PR_REVIEW)', () => {
    expect(isWebappQaOnPrRequest(`<@U1> review this PR ${PR_URL}`)).toBe(false);
    expect(isWebappQaOnPrRequest(`please re-review ${PR_URL}`)).toBe(false);
  });

  it('does NOT fire for a bare PR paste (no QA verb)', () => {
    expect(isWebappQaOnPrRequest(PR_URL)).toBe(false);
    expect(isWebappQaOnPrRequest(`<@U1> ${PR_URL}`)).toBe(false);
  });

  it('falls through when a build/ship verb muddies the ask', () => {
    expect(isWebappQaOnPrRequest(`test and fix this PR ${PR_URL}`)).toBe(false);
    expect(isWebappQaOnPrRequest(`test then merge ${PR_URL}`)).toBe(false);
  });

  it('requires a PR URL (a plain webapp URL is not QA-on-PR)', () => {
    expect(isWebappQaOnPrRequest('test the login flow on https://staging.example.com/login')).toBe(false);
  });
});

describe('changedPathsFromDiff', () => {
  it('extracts changed file paths from a unified diff', () => {
    const diff = [
      'diff --git a/src/pages/study-buddy.tsx b/src/pages/study-buddy.tsx',
      'index abc..def 100644',
      '--- a/src/pages/study-buddy.tsx',
      '+++ b/src/pages/study-buddy.tsx',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/components/Cta.tsx b/src/components/Cta.tsx',
      '--- a/src/components/Cta.tsx',
      '+++ b/src/components/Cta.tsx',
    ].join('\n');
    expect(changedPathsFromDiff(diff)).toEqual(['src/pages/study-buddy.tsx', 'src/components/Cta.tsx']);
  });

  it('returns an empty array for an empty diff', () => {
    expect(changedPathsFromDiff('')).toEqual([]);
  });
});

describe('classifyChangedPaths', () => {
  it('flags a Node-version bump PR (.nvmrc + Dockerfile + package.json) as deps/infra-only', () => {
    const c = classifyChangedPaths(['.nvmrc', 'Dockerfile', 'package.json']);
    expect(c).toEqual({ depsChanged: true, runtimeChanged: true, appCodeChanged: false, depsOrInfraOnly: true });
  });

  it('does NOT flag deps/infra-only when app code also changed', () => {
    const c = classifyChangedPaths(['.nvmrc', 'src/app/page.tsx']);
    expect(c.appCodeChanged).toBe(true);
    expect(c.depsOrInfraOnly).toBe(false);
  });

  it('treats a lockfile-only PR as deps/infra-only', () => {
    const c = classifyChangedPaths(['package-lock.json']);
    expect(c.depsChanged).toBe(true);
    expect(c.depsOrInfraOnly).toBe(true);
  });

  it('detects runtime files nested in a subdirectory', () => {
    const c = classifyChangedPaths(['frontend/.nvmrc']);
    expect(c.runtimeChanged).toBe(true);
    expect(c.depsOrInfraOnly).toBe(true);
  });

  it('does NOT trigger the gate for a CI-only PR (no deps/runtime change)', () => {
    const c = classifyChangedPaths(['.github/workflows/ci.yml']);
    expect(c.appCodeChanged).toBe(false);
    expect(c.depsChanged).toBe(false);
    expect(c.runtimeChanged).toBe(false);
    expect(c.depsOrInfraOnly).toBe(false);
  });

  it('treats a mixed deps + app PR as app code (browser QA, not gate)', () => {
    const c = classifyChangedPaths(['package.json', 'components/Button.tsx']);
    expect(c.depsChanged).toBe(true);
    expect(c.appCodeChanged).toBe(true);
    expect(c.depsOrInfraOnly).toBe(false);
  });

  it('returns all-false for an empty changed set', () => {
    expect(classifyChangedPaths([])).toEqual({
      depsChanged: false,
      runtimeChanged: false,
      appCodeChanged: false,
      depsOrInfraOnly: false,
    });
  });
});

describe('findFreePort', () => {
  it('returns a usable port number', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe('parseScreenshotManifest', () => {
  it('splits the report text from a trailing screenshot manifest', () => {
    const reply = [
      '*Feature* — login flow',
      '*Coverage* — :white_check_mark: happy path',
      '',
      '===SCREENSHOTS===',
      '[{"path":"/tmp/qa/login.png","caption":"Login page"}]',
    ].join('\n');
    const { visibleText, screenshots } = parseScreenshotManifest(reply);
    expect(visibleText).toContain('*Feature* — login flow');
    expect(visibleText).not.toContain('===SCREENSHOTS===');
    expect(screenshots).toEqual([{ path: '/tmp/qa/login.png', caption: 'Login page' }]);
  });

  it('handles a fenced JSON manifest', () => {
    const reply = 'report\n===SCREENSHOTS===\n```json\n[{"path":"/tmp/a.png"}]\n```';
    const { visibleText, screenshots } = parseScreenshotManifest(reply);
    expect(visibleText).toBe('report');
    expect(screenshots).toEqual([{ path: '/tmp/a.png', caption: undefined }]);
  });

  it('returns the full text and no screenshots when the marker is absent', () => {
    const reply = 'just a report, no manifest';
    expect(parseScreenshotManifest(reply)).toEqual({ visibleText: 'just a report, no manifest', screenshots: [] });
  });

  it('drops a malformed manifest but keeps the report', () => {
    const reply = 'report body\n===SCREENSHOTS===\nnot json at all';
    const { visibleText, screenshots } = parseScreenshotManifest(reply);
    expect(visibleText).toBe('report body');
    expect(screenshots).toEqual([]);
  });

  it('ignores manifest entries without a string path', () => {
    const reply = 'r\n===SCREENSHOTS===\n[{"caption":"no path"},{"path":"/tmp/ok.png"}]';
    const { screenshots } = parseScreenshotManifest(reply);
    expect(screenshots).toEqual([{ path: '/tmp/ok.png', caption: undefined }]);
  });

  it('treats an empty array manifest as no screenshots', () => {
    const { visibleText, screenshots } = parseScreenshotManifest('done\n===SCREENSHOTS===\n[]');
    expect(visibleText).toBe('done');
    expect(screenshots).toEqual([]);
  });
});
