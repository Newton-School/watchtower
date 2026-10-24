import { describe, expect, it } from 'vitest';
import { readPrActionAsk } from '../src/router/prActionAsk.js';
import { mergeProtectionNote } from '../src/workflows/implementationWorkflow.js';
import type { PrTarget } from '../src/types/contracts.js';

// Issue #605: "merge the pr" ran a 3.5-minute planner before the merge. A
// message that is only an operation on one known pull request skips it.

const pr = (number: number, source: PrTarget['source'], repo = 'newton-marketing-web'): PrTarget => ({
  url: `https://github.com/Newton-School/${repo}/pull/${number}`,
  owner: 'Newton-School',
  repo,
  number,
  source,
});

const ask = (text: string, prContexts: PrTarget[] = [pr(1404, 'thread')]) =>
  readPrActionAsk({
    event: { eventId: 'Ev1', channelId: 'C1', threadTs: '1.1', eventTs: '1.2', userId: 'U1', text, rawEvent: {} },
    prContexts,
    prContext: prContexts[0],
  });

describe('readPrActionAsk', () => {
  it.each([
    ['<@UBOT1> merge the pr', 'merge'],
    ['<@UBOT1> can you merge this PR please?', 'merge'],
    ['<@UBOT1> lgtm, squash and merge it 🙏', 'merge'],
    ['<@UBOT1> go ahead and merge it into main, thanks!', 'merge'],
    ['<@UBOT1> sync it', 'sync'],
    ['<@UBOT1> sync the branch with master', 'sync'],
    ['<@UBOT1> close this PR', 'close'],
  ])('reads %s as only a %s', (text, action) => {
    expect(ask(text)).toEqual({
      action,
      pr: {
        url: 'https://github.com/Newton-School/newton-marketing-web/pull/1404',
        owner: 'Newton-School',
        repo: 'newton-marketing-web',
        number: 1404,
      },
    });
  });

  it.each([
    '<@UBOT1> merge it and also fix the typo in the title',
    '<@UBOT1> merge once CI is green',
    '<@UBOT1> should we merge this?',
    '<@UBOT1> is it merged?',
    "<@UBOT1> don't merge it yet",
    '<@UBOT1> merge and close',
    '<@UBOT1> merge and deploy it',
    '<@UBOT1> approve and merge',
    '<@UBOT1> revert this PR',
    '<@UBOT1> close the issue',
    '<@UBOT1> merge constructor',
    '<@UBOT1> merge toString',
    '<@UBOT1> thanks!',
  ])('leaves %s to the planner', text => {
    expect(ask(text)).toBeUndefined();
  });

  it('needs a pull request to act on', () => {
    expect(ask('<@UBOT1> merge it', [])).toBeUndefined();
  });

  it('takes the PR linked in the message over the ones earlier in the thread', () => {
    const linked = pr(1406, 'trigger');
    const result = ask(`<@UBOT1> merge <${linked.url}|#1406>`, [linked, pr(1404, 'thread')]);
    expect(result?.pr.number).toBe(1406);
  });

  it('does not guess between two PRs in the thread', () => {
    expect(ask('<@UBOT1> merge it', [pr(1404, 'thread'), pr(1406, 'thread')])).toBeUndefined();
    expect(ask('<@UBOT1> merge both', [pr(1404, 'trigger'), pr(1406, 'trigger')])).toBeUndefined();
  });

  it('takes the PR named by number, and only one the thread knows', () => {
    const thread = [pr(1404, 'thread'), pr(1406, 'thread')];
    expect(ask('<@UBOT1> merge #1406', thread)?.pr.number).toBe(1406);
    expect(ask('<@UBOT1> merge PR 1406 please', thread)?.pr.number).toBe(1406);
    expect(ask('<@UBOT1> merge #1500', thread)).toBeUndefined();
    expect(ask('<@UBOT1> merge 1404 and 1406', thread)).toBeUndefined();
    // The same number in two repos is two PRs.
    expect(ask('<@UBOT1> merge #1404', [pr(1404, 'thread'), pr(1404, 'thread', 'newton-web')])).toBeUndefined();
  });

  it('reads the ask, not the words inside a link or a forwarding footer', () => {
    const syncTool = pr(3, 'trigger', 'sync-tool');
    expect(ask(`<@UBOT1> merge <${syncTool.url}|sync-tool#3>`, [syncTool])).toMatchObject({ action: 'merge' });
    expect(ask(`<@UBOT1> merge ${syncTool.url}`, [syncTool])).toMatchObject({ action: 'merge' });
    expect(ask('merge it\n*Sent using* <@UOTHER>')).toMatchObject({ action: 'merge' });
  });
});

describe('mergeProtectionNote', () => {
  it('says a merge past a required review uses admin rights', () => {
    expect(mergeProtectionNote({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })).toBe(
      'It still needs an approving review, so merging now uses admin rights.',
    );
    expect(mergeProtectionNote({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' })).toBe(
      'A reviewer asked for changes, so merging now uses admin rights.',
    );
    expect(mergeProtectionNote({ reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' })).toBe(
      'Branch protection still blocks it, so merging now uses admin rights.',
    );
  });

  it('says nothing when nothing blocks the merge, or GitHub could not say', () => {
    expect(mergeProtectionNote({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })).toBe('');
    expect(mergeProtectionNote({ mergeStateStatus: 'CLEAN' })).toBe('');
    expect(mergeProtectionNote({ mergeStateStatus: 'UNKNOWN' })).toBe('');
    expect(mergeProtectionNote({})).toBe('');
  });
});
