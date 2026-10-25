import { describe, expect, it } from 'vitest';
import {
  isMarketingStagingAsk,
  isSafeRef,
  isStagingTargetAnswer,
  mentionsProd,
  namesOtherApp,
  readStagingAsk,
} from '../src/router/stagingTarget.js';
import type { NormalizedTask, PrTarget } from '../src/types/contracts.js';

const pr = (n: number, source: PrTarget['source'], repo = 'newton-marketing-web'): PrTarget => ({
  url: `https://github.com/Newton-School/${repo}/pull/${n}`,
  owner: 'Newton-School',
  repo,
  number: n,
  source,
});
const task = (text: string, prContexts?: PrTarget[]): NormalizedTask => ({
  event: { eventId: 'E', channelId: 'C', threadTs: '1.1', eventTs: '1.1', userId: 'U', text, rawEvent: {} },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
  prContexts,
});

describe('readStagingAsk', () => {
  it('reads a branch named in the message', () => {
    expect(readStagingAsk('deploy marketing branch fix/hero-v2.1 to staging').explicitBranch).toBe('fix/hero-v2.1');
    expect(readStagingAsk('put `feat/nst-hire` on staging').explicitBranch).toBe('feat/nst-hire');
    expect(readStagingAsk('branch: fix/hero').explicitBranch).toBe('fix/hero');
    expect(readStagingAsk('deploy marketing to staging -- branch is feat/x').explicitBranch).toBe('feat/x');
    expect(readStagingAsk('deploy branch to marketing staging').explicitBranch).toBeUndefined();
    expect(readStagingAsk('put my branch on staging').explicitBranch).toBeUndefined();
  });

  it('keeps every slash word as a candidate, in order', () => {
    expect(readStagingAsk('the UI/UX fix is on feat/hero, give me a testing link').looseBranches).toEqual([
      'UI/UX',
      'feat/hero',
    ]);
    expect(readStagingAsk('this is and/or that, after 5/11').looseBranches).toEqual([]);
    expect(
      readStagingAsk('see https://github.com/Newton-School/newton-marketing-web/tree/fix/hero').looseBranches,
    ).toEqual([]);
  });

  it('reads main only when main is what goes on staging', () => {
    for (const text of [
      'deploy marketing main to staging',
      'put main back on staging',
      'push main to marketing staging',
      'restore staging to main',
      'reset the staging back to main',
      'staging back to main please',
      'main to staging',
      'deploy branch main to staging',
    ]) {
      expect(readStagingAsk(text).main, text).toBe(true);
    }
    for (const text of [
      'give me a testing link before I push to main',
      'give me a testing link, is main on staging?',
      'deploy this to staging, then ship to main',
      'push marketing to staging then reset to main',
      'deploy the main banner change to staging',
      'push the fix to main',
    ]) {
      expect(readStagingAsk(text).main, text).toBe(false);
    }
  });

  it('reads PR numbers only with "PR" or "pull request" in an ask', () => {
    expect(readStagingAsk('put PR #1484 on staging').prNumbers).toEqual([1484]);
    expect(readStagingAsk('staging for pull request 12 please').prNumbers).toEqual([12]);
    expect(readStagingAsk('give me a testing link for issue #702').prNumbers).toEqual([]);
    expect(readStagingAsk('test link pls, this fixes #12 and #13').prNumbers).toEqual([]);
    expect(readStagingAsk('make the button #ff0000 on staging').prNumbers).toEqual([]);
  });

  it('reads a bare name, number or #N as the answer to "which PR or branch?"', () => {
    const answer = (text: string) => readStagingAsk(text, { answeringWhich: true });
    expect(answer('1484').prNumbers).toEqual([1484]);
    expect(answer('#1484').prNumbers).toEqual([1484]);
    expect(answer('PR 1484').prNumbers).toEqual([1484]);
    expect(answer('fix-hero').explicitBranch).toBe('fix-hero');
    expect(answer('branch feat/x').explicitBranch).toBe('feat/x');
    expect(answer('main').main).toBe(true);
    expect(answer('yes')).toEqual({ main: false, looseBranches: [], prNumbers: [] });
  });
});

describe('isStagingTargetAnswer', () => {
  it('is true for a reply shaped like an answer', () => {
    for (const text of [
      'feat/hero',
      '1484',
      '#1484',
      'PR #1484',
      'main',
      'branch fix/hero',
      'https://github.com/Newton-School/newton-marketing-web/pull/1484',
      '<https://github.com/Newton-School/newton-marketing-web/pull/1484|#1484> this one',
    ]) {
      expect(isStagingTargetAnswer(text), text).toBe(true);
    }
  });

  it('is false for anything else, which goes to the router', () => {
    for (const text of [
      'never mind, review https://github.com/Newton-School/newton-web/pull/9040',
      'review PR 1484',
      'the hero one',
      'yes',
      'cancel that',
      '',
    ]) {
      expect(isStagingTargetAnswer(text), text).toBe(false);
    }
  });
});

describe('the other guards', () => {
  it('reads prod in the words, never in a link or its label', () => {
    expect(mentionsProd('deploy marketing main to prod')).toBe(true);
    expect(mentionsProd('a testing link before production')).toBe(true);
    expect(mentionsProd('testing link for <https://github.com/x/y/pull/1|fix production banner>')).toBe(false);
    expect(mentionsProd('ping <#C123|prod-alerts> with the staging link')).toBe(false);
  });

  it('reads another app named without the marketing site', () => {
    expect(namesOtherApp('deploy newton-web to staging')).toBe(true);
    expect(namesOtherApp('put the newton api fix on staging')).toBe(true);
    expect(namesOtherApp('the marketing copy of the newton web hero')).toBe(false);
    expect(namesOtherApp('deploy marketing to staging')).toBe(false);
  });

  it('only passes refs that are safe to hand to gh and show in Slack', () => {
    for (const ref of ['main', 'feat/hero', 'fix/hero-v2.1', 'a_b']) expect(isSafeRef(ref), ref).toBe(true);
    for (const ref of ['feat/`x`', 'a<b', 'a&b', '-x', 'a..b', 'a b', '']) expect(isSafeRef(ref), ref).toBe(false);
  });

  it('reads a marketing staging ask the router took for a production deploy', () => {
    expect(isMarketingStagingAsk(task('deploy marketing branch fix/hero to staging'), 'Newton-School')).toBe(true);
    expect(isMarketingStagingAsk(task('deploy this to staging', [pr(1484, 'thread')]), 'Newton-School')).toBe(true);
    expect(isMarketingStagingAsk(task('deploy newton-web to staging', [pr(1484, 'thread')]), 'Newton-School')).toBe(
      false,
    );
    expect(
      isMarketingStagingAsk(task('deploy this to staging', [pr(9040, 'trigger', 'newton-web')]), 'Newton-School'),
    ).toBe(false);
    expect(isMarketingStagingAsk(task('deploy this to staging'), 'Newton-School')).toBe(false);
    expect(isMarketingStagingAsk(task('deploy marketing to prod'), 'Newton-School')).toBe(false);
  });
});
