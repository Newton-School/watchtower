import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The worktree root is `os.homedir()/.watchtower/workspaces`, computed at
// module load: point HOME at a sandbox before importing.
const ORIGINAL_HOME = process.env.HOME;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-followup-home-'));
process.env.HOME = TEST_HOME;

const { resolveWorkspace } = await import('../src/workspaces/workspaceManager.js');
const {
  __followUpDeps,
  checkoutFollowUpBranch,
  findFollowUpPr,
  followUpNoteFor,
  followUpPlannerBlock,
  FOLLOW_UP_DIFF_MAX_BYTES,
  originSlug,
  stagingShowsBranch,
  unfinishedFollowUpLine,
  unfinishedFollowUpSummary,
  whichPrQuestion,
} = await import('../src/workflows/shared/followUpPr.js');
const { NO_PUSH_TO_GITHUB_ENV } = await import('../src/github/noPush.js');
const {
  __followUpPushDeps,
  commentFollowUpOnPr,
  keepFollowUpOnSideBranch,
  pushFollowUpToPr,
  relandFollowUpAsNewPr,
  settleUnfinishedFollowUp,
} = await import('../src/github/postPipelinePr.js');
const { STAGING_STATE_KEY } = await import('../src/workflows/stagingDeployWorkflow.js');

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

afterAll(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  await rm(TEST_HOME, { recursive: true, force: true });
});

// Issue #730: a change asked in a thread whose earlier change run left an open
// PR goes onto that PR, not a second one.

const PR1 = 'https://github.com/Newton-School/newton-marketing-web/pull/1484';
const PR2 = 'https://github.com/Newton-School/newton-marketing-web/pull/1490';

function taskWith(text: string) {
  return {
    event: { eventId: 'Ev', channelId: 'C1', threadTs: '1.1', eventTs: '1.2', userId: 'UPM', text, rawEvent: {} },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION',
  } as never;
}

describe('findFollowUpPr', () => {
  const realView = __followUpDeps.viewPr;
  const realDiff = __followUpDeps.prDiff;
  beforeEach(() => {
    __followUpDeps.prDiff = vi.fn(async () => 'diff --git a/src/a.ts b/src/a.ts\n+new copy\n');
  });
  afterEach(() => {
    __followUpDeps.viewPr = realView;
    __followUpDeps.prDiff = realDiff;
  });
  const storeWith = (prs: Array<{ prUrl: string; requesterId?: string }>) => ({
    changeRunPrsInThread: vi.fn(() => prs),
  });
  const views = (byUrl: Record<string, object>) => {
    __followUpDeps.viewPr = vi.fn(async (url: string) => {
      const view = byUrl[url];
      if (!view) throw new Error('gh: not found');
      return view;
    });
  };
  const find = (prs: Array<{ prUrl: string; requesterId?: string }>, text = 'also change the footer', extra = {}) =>
    findFollowUpPr({
      task: taskWith(text),
      store: storeWith(prs),
      requesterId: 'UPM',
      mayAddToOthers: false,
      ...extra,
    });

  it('finds nothing in a thread with no earlier change run PR', async () => {
    views({});
    expect(await find([])).toEqual({ kind: 'none' });
  });

  it("follows up the requester's own open PR, with its branch, files and diff", async () => {
    views({
      [PR1]: { state: 'OPEN', headRefName: 'pm/hero-copy', isCrossRepository: false, files: [{ path: 'src/a.ts' }] },
    });
    expect(await find([{ prUrl: PR1, requesterId: 'UPM' }])).toEqual({
      kind: 'followup',
      pr: {
        url: PR1,
        owner: 'Newton-School',
        repo: 'newton-marketing-web',
        number: 1484,
        branch: 'pm/hero-copy',
        repoKey: 'newton-marketing-web',
        files: ['src/a.ts'],
        requesterId: 'UPM',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n+new copy\n',
      },
    });
  });

  it("gives someone else's change its own PR, unless they're the owner or an admin", async () => {
    views({ [PR1]: { state: 'OPEN', headRefName: 'pm/hero-copy', isCrossRepository: false } });
    const others = await find([{ prUrl: PR1, requesterId: 'UOTHERPM' }]);
    expect(others).toMatchObject({ kind: 'others', pr: { url: PR1 } });
    expect(followUpNoteFor(others)).toBe(
      `${PR1} was asked for by someone else, so this change is in its own pull request. Merging both may need a sync.`,
    );
    expect((await find([{ prUrl: PR1, requesterId: 'UOTHERPM' }], 'x', { mayAddToOthers: true })).kind).toBe(
      'followup',
    );
  });

  it('cuts a long diff for the planner and says so', async () => {
    views({ [PR1]: { state: 'OPEN', headRefName: 'b', isCrossRepository: false } });
    __followUpDeps.prDiff = vi.fn(async () => 'x'.repeat(FOLLOW_UP_DIFF_MAX_BYTES + 500));
    const found = await find([{ prUrl: PR1, requesterId: 'UPM' }]);
    if (found.kind !== 'followup') throw new Error(found.kind);
    expect(found.pr.diff?.length).toBeLessThan(FOLLOW_UP_DIFF_MAX_BYTES + 200);
    expect(found.pr.diff).toContain('[… the rest of the diff is cut');
  });

  it("never follows up a fork's PR; one GitHub can't read is logged and noted, not silently replaced", async () => {
    views({ [PR1]: { state: 'OPEN', headRefName: 'x', isCrossRepository: true } });
    expect((await find([{ prUrl: PR1 }])).kind).toBe('none');

    views({});
    const logStep = vi.fn();
    const unreadable = await find([{ prUrl: PR2 }], 'x', { logStep });
    expect(unreadable).toEqual({ kind: 'unreadable', prUrl: PR2 });
    expect(followUpNoteFor(unreadable)).toBe(
      `I couldn't check ${PR2} on GitHub, so this change is in a new pull request.`,
    );
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implementation.followup.lookup_failed', level: 'WARN' }),
    );
  });

  it('says when the earlier PR is already merged or closed', async () => {
    views({ [PR1]: { state: 'MERGED', headRefName: 'pm/hero-copy' } });
    expect(await find([{ prUrl: PR1 }])).toEqual({ kind: 'ended', prUrl: PR1, state: 'MERGED' });
    views({ [PR1]: { state: 'CLOSED', headRefName: 'pm/hero-copy' } });
    expect(await find([{ prUrl: PR1 }])).toMatchObject({ kind: 'ended', state: 'CLOSED' });
  });

  it('asks which when two are open, unless the message links one of them', async () => {
    views({
      [PR1]: { state: 'OPEN', headRefName: 'a', isCrossRepository: false },
      [PR2]: { state: 'OPEN', headRefName: 'b', isCrossRepository: false },
    });
    expect(await find([{ prUrl: PR2 }, { prUrl: PR1 }], 'change the footer too')).toEqual({
      kind: 'several',
      prUrls: [PR2, PR1],
    });
    const named = await find([{ prUrl: PR2 }, { prUrl: PR1 }], `add this to <${PR1}|that PR>: change the footer`);
    expect(named).toMatchObject({ kind: 'followup', pr: { number: 1484, branch: 'a' } });
  });

  it('a store that fails is logged and means no follow-up, never an error', async () => {
    const logStep = vi.fn();
    const store = {
      changeRunPrsInThread: () => {
        throw new Error('db locked');
      },
    };
    expect(
      await findFollowUpPr({ task: taskWith('x'), store, requesterId: 'UPM', mayAddToOthers: false, logStep }),
    ).toEqual({ kind: 'none' });
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'implementation.followup.lookup_failed' }));
  });
});

describe('what people and the planner are told', () => {
  it('asks for the PR link and the change in one message', () => {
    expect(whichPrQuestion([PR1, PR2])).toBe(
      `This thread has 2 open pull requests I made: <${PR1}>, <${PR2}>. Mention me again with the link of the one this change belongs to and the change, in one message, so I add it there.`,
    );
  });

  it('tells the planner to plan only the new change, with the diff and a capped file list', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const block = followUpPlannerBlock({
      url: PR1,
      owner: 'Newton-School',
      repo: 'newton-marketing-web',
      number: 1484,
      branch: 'pm/hero-copy',
      repoKey: 'newton-marketing-web',
      files,
      diff: '+Learn at top companies',
    });
    expect(block).toContain(`opened ${PR1} (Newton-School/newton-marketing-web, branch \`pm/hero-copy\`)`);
    expect(block).toContain('`src/f19.ts` and 5 more.');
    expect(block).not.toContain('src/f20.ts');
    expect(block).toContain('it belongs in Newton-School/newton-marketing-web: plan ONLY the new change');
    expect(block).toContain('```diff\n+Learn at top companies\n```');
  });

  it('knows when staging shows this PR, recently', () => {
    const now = 10_000_000;
    const pr = { branch: 'pm/hero-copy', url: PR1 };
    const store = (record?: object) => ({
      getState: (key: string) => (key === STAGING_STATE_KEY && record ? JSON.stringify(record) : undefined),
    });
    expect(stagingShowsBranch(store({ branch: 'pm/hero-copy', prUrl: PR1, atMs: now - 60_000 }), pr, now)).toBe(true);
    expect(stagingShowsBranch(store({ branch: 'pm/hero-copy', atMs: now - 60_000 }), pr, now)).toBe(true);
    expect(stagingShowsBranch(store({ branch: 'pm/hero-copy', prUrl: PR2, atMs: now - 60_000 }), pr, now)).toBe(false);
    expect(stagingShowsBranch(store({ branch: 'main', atMs: now - 60_000 }), pr, now)).toBe(false);
    expect(stagingShowsBranch(store({ branch: 'pm/hero-copy', atMs: now - 3 * 3_600_000 }), pr, now)).toBe(false);
    expect(stagingShowsBranch(store(), pr, now)).toBe(false);
    expect(stagingShowsBranch(undefined, pr, now)).toBe(false);
  });

  it('a failed follow-up says the PR is as it was instead of telling them to close it (M1)', () => {
    const steps = [
      { role: 'coder', status: 'passed', output: {}, findings: [], durationMs: 1 },
      {
        role: 'reviewer',
        status: 'failed',
        output: {},
        findings: [{ severity: 'high', category: 'layout', message: 'footer wraps on mobile' }],
        durationMs: 1,
      },
    ];
    const text = unfinishedFollowUpSummary(
      { finalStatus: 'failed', steps, retryLoops: 2, totalDurationMs: 1, aggregatedFindings: [] } as never,
      undefined,
      PR1,
      { prUntouched: true, landed: [], wipBranch: 'miniog/followup-wip-1-2' },
    );
    expect(text).toContain('The review still had open findings after 2 revisions.');
    expect(text).toContain(`Nothing was added to ${PR1}; it's as it was.`);
    expect(text).toContain('`miniog/followup-wip-1-2`');
    expect(text).toContain('footer wraps on mobile');
    expect(text).not.toContain('I did not open a PR');
    expect(text).not.toContain('close it');
  });

  it('says what an unfinished follow-up left on the PR, in plain words', () => {
    expect(
      unfinishedFollowUpLine(PR1, { prUntouched: true, landed: [], wipBranch: 'miniog/followup-wip-1-2-abc1234' }),
    ).toBe(
      `Nothing was added to ${PR1}; it's as it was. I saved the unfinished change on a side branch (\`miniog/followup-wip-1-2-abc1234\`), with no pull request.`,
    );
    expect(unfinishedFollowUpLine(PR1, { prUntouched: false, landed: ['abc123 someone else'], ours: false })).toBe(
      `${PR1} has new changes from someone else since I started (abc123 someone else).`,
    );
    // The coder got a push through before its checks passed.
    expect(unfinishedFollowUpLine(PR1, { prUntouched: false, landed: ['abc123 coder: footer'], ours: true })).toBe(
      `My unfinished change reached ${PR1} before its checks passed — don't merge it yet.`,
    );
    expect(unfinishedFollowUpLine(PR1, { landed: [] })).toBe(`I couldn't check ${PR1} on GitHub.`);
  });
});

describe('working on the PR branch and landing on it (real git)', () => {
  let bare: string;
  let seed: string;
  let repo: string;
  let ws: string;
  const BRANCH = 'pm/hero-copy';

  beforeEach(async () => {
    bare = await mkdtemp(path.join(os.tmpdir(), 'wt-fu-bare-'));
    await git(bare, ['init', '--bare', '-q', '-b', 'main']);
    seed = await mkdtemp(path.join(os.tmpdir(), 'wt-fu-seed-'));
    await git(seed, ['init', '-q', '-b', 'main']);
    await git(seed, ['config', 'user.email', 'test@example.com']);
    await git(seed, ['config', 'user.name', 'Test']);
    await writeFile(path.join(seed, 'hero.txt'), 'Learn from top companies\n');
    await writeFile(path.join(seed, 'footer.txt'), 'Old footer\n');
    await writeFile(path.join(seed, 'nav.txt'), 'Old nav\n');
    await writeFile(path.join(seed, '.gitignore'), 'node_modules/\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-q', '-m', 'main A']);
    await git(seed, ['remote', 'add', 'origin', bare]);
    await git(seed, ['push', '-q', '-u', 'origin', 'main']);
    // The first change run's PR branch.
    await git(seed, ['checkout', '-q', '-b', BRANCH]);
    await writeFile(path.join(seed, 'hero.txt'), 'Learn at top companies\n');
    await git(seed, ['commit', '-aqm', 'PR: hero copy']);
    await git(seed, ['push', '-q', 'origin', BRANCH]);
    await git(seed, ['checkout', '-q', 'main']);

    repo = await mkdtemp(path.join(os.tmpdir(), 'wt-fu-repo-'));
    await git(path.dirname(repo), ['clone', '-q', bare, repo]);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    ws = await resolveWorkspace(repo, '730.1');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([bare, seed, repo].map(dir => rm(dir, { recursive: true, force: true })));
    fs.rmSync(path.join(TEST_HOME, '.watchtower'), { recursive: true, force: true });
  });

  const branchHead = () => git(bare, ['rev-parse', BRANCH]);
  const remoteBranches = () => git(bare, ['branch', '--list']);
  const checkedOut = async () => {
    const checkout = await checkoutFollowUpBranch(ws, BRANCH);
    if (!checkout.ok) throw new Error(`checkout failed: ${checkout.reason}`);
    return checkout.head;
  };
  const pushAsOtherPerson = async (file: string, content: string, message: string) => {
    await git(seed, ['checkout', '-q', BRANCH]);
    await git(seed, ['pull', '-q', 'origin', BRANCH]);
    await writeFile(path.join(seed, file), content);
    await git(seed, ['commit', '-aqm', message]);
    await git(seed, ['push', '-q', 'origin', BRANCH]);
    await git(seed, ['checkout', '-q', 'main']);
    return branchHead();
  };
  const push = (startHead: string, uniqueTs = '730.5') =>
    pushFollowUpToPr({
      repoPath: ws,
      branch: BRANCH,
      prUrl: PR1,
      startHead,
      uniqueTs,
      threadTs: '730.1',
      summary: 'Change the footer copy',
    });

  it('checks out the PR branch, detached at its latest commit, never the default branch', async () => {
    const head = await checkedOut();
    expect(head).toBe(await branchHead());
    expect(await readFile(path.join(ws, 'hero.txt'), 'utf8')).toBe('Learn at top companies\n');
    expect(await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
  });

  it("reads the clone's origin, and refuses a path that isn't one of its worktrees", async () => {
    await git(ws, ['remote', 'set-url', 'origin', 'git@github.com:Newton-School/newton-marketing-web.git']);
    expect(await originSlug(ws)).toBe('newton-school/newton-marketing-web');
    await git(ws, ['remote', 'set-url', 'origin', bare]);
    expect(await checkoutFollowUpBranch(repo, BRANCH)).toEqual({ ok: false, reason: 'not a miniOG worktree' });
    expect((await checkoutFollowUpBranch(ws, 'no/such-branch')).ok).toBe(false);
  });

  it("commits what the coder left and fast-forwards the PR branch: the run's only push", async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');

    expect(await push(start)).toEqual({ kind: 'pushed', ontoNewerCommits: false });
    const head = await branchHead();
    expect(await git(bare, ['rev-parse', `${head}^`])).toBe(start);
    expect(await git(bare, ['show', `${head}:footer.txt`])).toBe('New footer');
    expect(await git(bare, ['show', `${head}:hero.txt`])).toBe('Learn at top companies');
  });

  it('pushes nothing when there is nothing new', async () => {
    const start = await checkedOut();
    expect(await push(start)).toEqual({ kind: 'nothing' });
    expect(await branchHead()).toBe(start);
  });

  const wipName = async () => `miniog/followup-wip-730-5-${await git(ws, ['rev-parse', '--short=7', 'HEAD'])}`;

  it('never pushes a rewritten history: the PR stays as it was (checked), the work goes to a side branch', async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await git(ws, ['commit', '-aq', '--amend', '--no-edit']);
    const wip = await wipName();

    const result = await push(start);
    expect(result).toEqual({
      kind: 'rewritten',
      wipBranch: wip,
      prState: { untouched: true, landed: [], ours: false },
    });
    expect(await branchHead()).toBe(start);
    expect(await git(bare, ['show', `${wip}:footer.txt`])).toBe('New footer');
  });

  it('an amend that was force-pushed anyway is reported as our unchecked change on the PR, not "as it was"', async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await git(ws, ['commit', '-aq', '--amend', '--no-edit']);
    // The coder got past the push block somehow.
    await git(ws, ['push', '-q', '--force', 'origin', `HEAD:${BRANCH}`]);

    const result = await push(start);
    expect(result).toMatchObject({ kind: 'rewritten', prState: { untouched: false, ours: true } });
  });

  it('a branch the owner rewound is replayed onto, never pushed back to with the dropped commit', async () => {
    // A second commit on the PR, which the owner later drops.
    await pushAsOtherPerson('nav.txt', 'Nav that gets dropped\n', 'PR: nav (dropped later)');
    const start = await checkedOut();
    await git(seed, ['checkout', '-q', BRANCH]);
    await git(seed, ['reset', '-q', '--hard', 'HEAD~1']);
    await git(seed, ['push', '-q', '--force', 'origin', BRANCH]);
    await git(seed, ['checkout', '-q', 'main']);
    const rewound = await branchHead();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');

    expect(await push(start)).toEqual({ kind: 'pushed', ontoNewerCommits: true });
    const head = await branchHead();
    expect(await git(bare, ['rev-parse', `${head}^`])).toBe(rewound);
    expect(await git(bare, ['show', `${head}:nav.txt`])).toBe('Old nav');
    expect(await git(bare, ['show', `${head}:footer.txt`])).toBe('New footer');
  });

  it('an unsafe leftover (.env) is set aside for the replay, not read as a clash', async () => {
    await git(seed, ['checkout', '-q', BRANCH]);
    await writeFile(path.join(seed, '.env'), 'A=1\n');
    await git(seed, ['add', '.env']);
    await git(seed, ['commit', '-qm', 'PR: env']);
    await git(seed, ['push', '-q', 'origin', BRANCH]);
    await git(seed, ['checkout', '-q', 'main']);
    const start = await checkedOut();
    await pushAsOtherPerson('nav.txt', 'New nav\n', 'someone else: nav');
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await writeFile(path.join(ws, '.env'), 'A=local-secret\n');

    expect(await push(start)).toEqual({ kind: 'pushed', ontoNewerCommits: true });
    const head = await branchHead();
    expect(await git(bare, ['show', `${head}:footer.txt`])).toBe('New footer');
    // Never committed, and still there for whoever left it.
    expect(await git(bare, ['show', `${head}:.env`])).toBe('A=1');
    expect(await readFile(path.join(ws, '.env'), 'utf8')).toBe('A=local-secret\n');
  });

  it('a rebase left half-done is aborted before the checkout, but never by the push', async () => {
    const start = await checkedOut();
    // Leave a conflicting rebase in progress in the worktree.
    await pushAsOtherPerson('footer.txt', 'Their footer\n', 'someone else: footer');
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await git(ws, ['commit', '-aqm', 'coder: footer']);
    await git(ws, ['fetch', '-q', 'origin']);
    await git(ws, ['rebase', `origin/${BRANCH}`]).catch(() => undefined);

    const refused = await push(start);
    expect(refused).toMatchObject({ kind: 'failed', reason: 'a rebase was left half-done in the working copy' });
    // Still in progress: the push didn't start it, so it didn't abort it.
    expect(fs.existsSync(path.join(await git(ws, ['rev-parse', '--absolute-git-dir']), 'rebase-merge'))).toBe(true);

    expect((await checkoutFollowUpBranch(ws, BRANCH)).ok).toBe(true);
    expect(fs.existsSync(path.join(await git(ws, ['rev-parse', '--absolute-git-dir']), 'rebase-merge'))).toBe(false);
  });

  it('replays our commit on top of what someone else pushed, and pushes normally', async () => {
    const start = await checkedOut();
    const theirs = await pushAsOtherPerson('nav.txt', 'New nav\n', 'someone else: nav');
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');

    expect(await push(start)).toEqual({ kind: 'pushed', ontoNewerCommits: true });
    const head = await branchHead();
    expect(await git(bare, ['rev-parse', `${head}^`])).toBe(theirs);
    expect(await git(bare, ['show', `${head}:footer.txt`])).toBe('New footer');
    expect(await git(bare, ['show', `${head}:nav.txt`])).toBe('New nav');
  });

  it('a clash with new commits on the PR keeps the change on a side branch: no stacked PR, nothing pushed over them', async () => {
    const start = await checkedOut();
    const theirs = await pushAsOtherPerson('footer.txt', 'Their footer\n', 'someone else: footer');
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    const createPullRequest = vi.spyOn(__followUpPushDeps, 'createPullRequest');

    const result = await push(start, '730.9');
    expect(result).toMatchObject({ kind: 'conflict', prState: { untouched: false, ours: false } });
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(await branchHead()).toBe(theirs);
    const wip = result.kind === 'conflict' ? result.wipBranch : undefined;
    expect(wip).toMatch(/^miniog\/followup-wip-730-9-[0-9a-f]{7}$/);
    expect(await git(bare, ['show', `${wip}:footer.txt`])).toBe('New footer');
    // The worktree is back where it was, not mid-rebase.
    expect(fs.existsSync(path.join(await git(ws, ['rev-parse', '--absolute-git-dir']), 'rebase-merge'))).toBe(false);
  });

  it('fails without touching the PR when its branch is gone, keeping the work', async () => {
    const start = await checkedOut();
    await git(bare, ['branch', '-D', BRANCH]);
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    const result = await push(start);
    expect(result).toMatchObject({ kind: 'failed', wipBranch: await wipName() });
    expect(await remoteBranches()).not.toContain(BRANCH);
  });

  it('a failed run leaves the PR untouched and keeps the unreviewed work on a side branch', async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'Half-done footer\n');
    await git(ws, ['commit', '-aqm', 'coder: footer (failed review)']);
    await writeFile(path.join(ws, 'nav.txt'), 'uncommitted\n');

    const settled = await settleUnfinishedFollowUp({
      repoPath: ws,
      branch: BRANCH,
      startHead: start,
      uniqueTs: '730.5',
    });
    const wip = await wipName();
    expect(settled).toEqual({ prUntouched: true, landed: [], wipBranch: wip });
    expect(await branchHead()).toBe(start);
    expect(await git(bare, ['show', `${wip}:footer.txt`])).toBe('Half-done footer');
    expect(await git(bare, ['show', `${wip}:nav.txt`])).toBe('uncommitted');
  });

  it("a failed run whose coder pushed anyway says it's our unchecked change on the PR", async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'Half-done footer\n');
    await git(ws, ['commit', '-aqm', 'coder: footer (failed review)']);
    await git(ws, ['push', '-q', 'origin', `HEAD:${BRANCH}`]);

    const settled = await settleUnfinishedFollowUp({
      repoPath: ws,
      branch: BRANCH,
      startHead: start,
      uniqueTs: '730.5',
    });
    expect(settled).toMatchObject({ prUntouched: false, ours: true });
    expect(unfinishedFollowUpLine(PR1, settled)).toContain("before its checks passed — don't merge it yet");
  });

  it('a failed run names commits that landed on the PR meanwhile', async () => {
    const start = await checkedOut();
    await pushAsOtherPerson('nav.txt', 'New nav\n', 'someone else: nav');
    const settled = await settleUnfinishedFollowUp({
      repoPath: ws,
      branch: BRANCH,
      startHead: start,
      uniqueTs: '730.5',
    });
    expect(settled.prUntouched).toBe(false);
    expect(settled.landed).toHaveLength(1);
    expect(settled.landed[0]).toMatch(/^[0-9a-f]+ someone else: nav$/);
    // Nothing of ours to keep.
    expect(settled.wipBranch).toBeUndefined();
  });

  it('a PR merged meanwhile gets the new commits as a fresh PR from main, never pushed to its dead branch', async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    // The PR is merged into main; its branch stays, as the marketing repo keeps them.
    await git(seed, ['checkout', '-q', 'main']);
    await git(seed, ['merge', '-q', '--ff-only', `origin/${BRANCH}`]).catch(async () => {
      await git(seed, ['fetch', '-q', 'origin']);
      await git(seed, ['merge', '-q', '--ff-only', `origin/${BRANCH}`]);
    });
    await git(seed, ['push', '-q', 'origin', 'main']);
    const createPullRequest = vi
      .spyOn(__followUpPushDeps, 'createPullRequest')
      .mockResolvedValue({ prUrl: 'https://github.com/Newton-School/newton-marketing-web/pull/1500' });

    const result = await relandFollowUpAsNewPr({
      repoPath: ws,
      startHead: start,
      uniqueTs: '730.5',
      threadTs: '730.1',
      summary: 'Change the footer copy',
      originalPrUrl: PR1,
      requestedBy: 'Raj',
    });
    expect(result).toEqual({
      kind: 'opened',
      prUrl: 'https://github.com/Newton-School/newton-marketing-web/pull/1500',
    });
    expect(await branchHead()).toBe(start);
    const fresh = 'raj/followup-730-5';
    expect(await git(bare, ['show', `${fresh}:footer.txt`])).toBe('New footer');
    expect(await git(bare, ['rev-parse', `${fresh}^`])).toBe(await git(bare, ['rev-parse', 'main']));
    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ branch: fresh, baseBranch: 'main' }));
    expect(createPullRequest.mock.calls[0][0].body).toContain(
      `Follow-up to ${PR1}, which was merged before this change was ready`,
    );
  });

  it('a merged PR whose main already has everything the follow-up does opens nothing ("already in main")', async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await git(ws, ['commit', '-aqm', 'coder: footer']);
    // Someone already made the same change on main (merging the PR and the same footer edit).
    await git(seed, ['fetch', '-q', 'origin']);
    await git(seed, ['checkout', '-q', 'main']);
    await git(seed, ['merge', '-q', '--ff-only', `origin/${BRANCH}`]);
    await writeFile(path.join(seed, 'footer.txt'), 'New footer\n');
    await git(seed, ['commit', '-aqm', 'main: same footer']);
    await git(seed, ['push', '-q', 'origin', 'main']);
    const createPullRequest = vi.spyOn(__followUpPushDeps, 'createPullRequest');

    expect(
      await relandFollowUpAsNewPr({
        repoPath: ws,
        startHead: start,
        uniqueTs: '730.5',
        threadTs: '730.1',
        summary: 'Change the footer copy',
        originalPrUrl: PR1,
      }),
    ).toEqual({ kind: 'already' });
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it('a closed PR is not revived: the checked change is kept on a side branch', async () => {
    const start = await checkedOut();
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    const kept = await keepFollowUpOnSideBranch({
      repoPath: ws,
      startHead: start,
      uniqueTs: '730.5',
      summary: 'footer',
    });
    expect(kept.nothing).toBe(false);
    expect(kept.wipBranch).toBe(await wipName());
    expect(await git(bare, ['show', `${kept.wipBranch}:footer.txt`])).toBe('New footer');
    expect(await branchHead()).toBe(start);
  });

  it("the coder's git can't push to GitHub in follow-up mode (real git push)", async () => {
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await git(ws, ['commit', '-aqm', 'coder: footer']);
    const pushWithEnv = (target: string) =>
      execFileAsync('git', ['push', '-q', target, 'HEAD:refs/heads/x'], {
        cwd: ws,
        env: { ...process.env, ...NO_PUSH_TO_GITHUB_ENV, GIT_TERMINAL_PROMPT: '0' },
      });
    for (const url of [
      'https://github.com/Newton-School/newton-marketing-web.git',
      'git@github.com:Newton-School/newton-marketing-web.git',
      'ssh://git@github.com/Newton-School/newton-marketing-web.git',
    ]) {
      await expect(pushWithEnv(url)).rejects.toThrow(/no-push/);
    }
    // A clone of a GitHub repo: a plain `git push` to origin is refused too.
    await git(ws, ['remote', 'set-url', 'origin', 'https://github.com/Newton-School/newton-marketing-web.git']);
    await expect(pushWithEnv('origin')).rejects.toThrow(/no-push/);
    // Only GitHub pushes are rewritten.
    await git(ws, ['remote', 'set-url', 'origin', bare]);
    await expect(pushWithEnv('origin')).resolves.toBeDefined();
  });

  it('posts the engineering account on the PR as a comment, and says when it could not', async () => {
    const comment = vi.spyOn(__followUpPushDeps, 'commentOnPr').mockResolvedValue();
    expect(
      await commentFollowUpOnPr({
        repoPath: ws,
        prUrl: PR1,
        summary: 'Changed the footer copy in footer.txt.',
        requestedBy: 'Raj',
        channelId: 'C1',
        threadTs: '730.1',
      }),
    ).toBe(true);
    expect(comment.mock.calls[0][1]).toBe(PR1);
    expect(comment.mock.calls[0][2]).toContain('**Follow-up added by miniOG** for Raj via Slack');
    expect(comment.mock.calls[0][2]).toContain('Changed the footer copy in footer.txt.');

    comment.mockRejectedValueOnce(new Error('gh: forbidden'));
    expect(
      await commentFollowUpOnPr({ repoPath: ws, prUrl: PR1, summary: 's', channelId: 'C1', threadTs: '730.1' }),
    ).toBe(false);
  });
});
