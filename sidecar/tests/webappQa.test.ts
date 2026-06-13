import { describe, expect, it } from 'vitest';
import { extractQaTargetUrl, isWebappQaRequest } from '../src/router/intentParser.js';
import { parseScreenshotManifest } from '../src/slack/imageUploader.js';

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
