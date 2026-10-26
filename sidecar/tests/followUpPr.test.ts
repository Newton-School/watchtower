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
  followUpPlannerBlock,
  stagingShowsBranch,
  whichPrQuestion,
} = await import('../src/workflows/shared/followUpPr.js');
const { __followUpPushDeps, pushFollowUpToPr } = await import('../src/github/postPipelinePr.js');
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
  afterEach(() => {
    __followUpDeps.viewPr = realView;
  });
  const storeWith = (urls: string[]) => ({ changeRunPrUrlsInThread: vi.fn(() => urls) });
  const views = (byUrl: Record<string, object>) => {
    __followUpDeps.viewPr = vi.fn(async (url: string) => {
      const view = byUrl[url];
      if (!view) throw new Error('gh: not found');
      return view;
    });
  };

  it('finds nothing in a thread with no earlier change run PR', async () => {
    views({});
    expect(await findFollowUpPr({ task: taskWith('also change the footer'), store: storeWith([]) })).toEqual({
      kind: 'none',
    });
  });

  it("follows up the thread's one open PR, with its branch and files", async () => {
    views({
      [PR1]: { state: 'OPEN', headRefName: 'pm/hero-copy', isCrossRepository: false, files: [{ path: 'src/a.ts' }] },
    });
    const found = await findFollowUpPr({ task: taskWith('also change the footer'), store: storeWith([PR1]) });
    expect(found).toEqual({
      kind: 'followup',
      pr: {
        url: PR1,
        owner: 'Newton-School',
        repo: 'newton-marketing-web',
        number: 1484,
        branch: 'pm/hero-copy',
        repoKey: 'newton-marketing-web',
        files: ['src/a.ts'],
      },
    });
  });

  it("never follows up a fork's PR or one GitHub can't read", async () => {
    views({ [PR1]: { state: 'OPEN', headRefName: 'x', isCrossRepository: true } });
    expect((await findFollowUpPr({ task: taskWith('more'), store: storeWith([PR1, PR2]) })).kind).toBe('none');
  });

  it('says when the earlier PR is already merged or closed', async () => {
    views({ [PR1]: { state: 'MERGED', headRefName: 'pm/hero-copy' } });
    expect(await findFollowUpPr({ task: taskWith('more'), store: storeWith([PR1]) })).toEqual({
      kind: 'ended',
      prUrl: PR1,
      state: 'MERGED',
    });
    views({ [PR1]: { state: 'CLOSED', headRefName: 'pm/hero-copy' } });
    expect(await findFollowUpPr({ task: taskWith('more'), store: storeWith([PR1]) })).toMatchObject({
      kind: 'ended',
      state: 'CLOSED',
    });
  });

  it('asks which when two are open, unless the message links one of them', async () => {
    views({
      [PR1]: { state: 'OPEN', headRefName: 'a', isCrossRepository: false },
      [PR2]: { state: 'OPEN', headRefName: 'b', isCrossRepository: false },
    });
    expect(await findFollowUpPr({ task: taskWith('change the footer too'), store: storeWith([PR2, PR1]) })).toEqual({
      kind: 'several',
      prUrls: [PR2, PR1],
    });
    const named = await findFollowUpPr({
      task: taskWith(`add this to <${PR1}|that PR>: change the footer`),
      store: storeWith([PR2, PR1]),
    });
    expect(named).toMatchObject({ kind: 'followup', pr: { number: 1484, branch: 'a' } });
  });

  it('a store that fails means no follow-up, never an error', async () => {
    const store = {
      changeRunPrUrlsInThread: () => {
        throw new Error('db locked');
      },
    };
    expect(await findFollowUpPr({ task: taskWith('x'), store })).toEqual({ kind: 'none' });
  });
});

describe('what people and the planner are told', () => {
  it('asks which PR, linking each', () => {
    expect(whichPrQuestion([PR1, PR2])).toBe(
      `This thread has 2 open pull requests I made: <${PR1}>, <${PR2}>. Mention me again with the link of the one this change belongs to, so I add it there.`,
    );
  });

  it('tells the planner to plan only the new change, on top of the branch', () => {
    const block = followUpPlannerBlock({
      url: PR1,
      owner: 'Newton-School',
      repo: 'newton-marketing-web',
      number: 1484,
      branch: 'pm/hero-copy',
      repoKey: 'newton-marketing-web',
      files: ['src/features/agentic/content.ts'],
    });
    expect(block).toContain(`opened ${PR1} (Newton-School/newton-marketing-web, branch \`pm/hero-copy\`)`);
    expect(block).toContain('It already changes `src/features/agentic/content.ts`.');
    expect(block).toContain('plan ONLY the new change');
    expect(block).toContain('If this request is for a different repository, plan it normally.');
  });

  it('knows when staging shows the branch', () => {
    const store = (value?: string) => ({ getState: (key: string) => (key === STAGING_STATE_KEY ? value : undefined) });
    expect(stagingShowsBranch(store(JSON.stringify({ branch: 'pm/hero-copy' })), 'pm/hero-copy')).toBe(true);
    expect(stagingShowsBranch(store(JSON.stringify({ branch: 'main' })), 'pm/hero-copy')).toBe(false);
    expect(stagingShowsBranch(store('not json'), 'pm/hero-copy')).toBe(false);
    expect(stagingShowsBranch(store(undefined), 'pm/hero-copy')).toBe(false);
    expect(stagingShowsBranch(undefined, 'pm/hero-copy')).toBe(false);
  });
});

describe('working on the PR branch and pushing to it (real git)', () => {
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

  it('checks out the PR branch, detached at its latest commit, never the default branch', async () => {
    const checkout = await checkoutFollowUpBranch(ws, BRANCH);
    expect(checkout).toEqual({ ok: true, head: await branchHead() });
    expect(await readFile(path.join(ws, 'hero.txt'), 'utf8')).toBe('Learn at top companies\n');
    expect(await git(ws, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
  });

  it('refuses anything that is not one of its worktrees, and reports a missing branch', async () => {
    expect(await checkoutFollowUpBranch(repo, BRANCH)).toEqual({ ok: false, reason: 'not a miniOG worktree' });
    const missing = await checkoutFollowUpBranch(ws, 'no/such-branch');
    expect(missing.ok).toBe(false);
  });

  const push = (startHead: string) =>
    pushFollowUpToPr({
      repoPath: ws,
      branch: BRANCH,
      prUrl: PR1,
      startHead,
      threadTs: '730.1',
      summary: 'Change the footer copy',
    });

  it('commits what the coder left and fast-forwards the PR branch', async () => {
    const checkout = await checkoutFollowUpBranch(ws, BRANCH);
    if (!checkout.ok) throw new Error('checkout failed');
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');

    expect(await push(checkout.head)).toEqual({ kind: 'pushed' });
    const head = await branchHead();
    expect(await git(bare, ['rev-parse', `${head}^`])).toBe(checkout.head);
    expect(await git(bare, ['show', `${head}:footer.txt`])).toBe('New footer');
    expect(await git(bare, ['show', `${head}:hero.txt`])).toBe('Learn at top companies');
  });

  it("knows the coder already pushed, and pushes nothing when there's nothing new", async () => {
    const checkout = await checkoutFollowUpBranch(ws, BRANCH);
    if (!checkout.ok) throw new Error('checkout failed');
    expect(await push(checkout.head)).toEqual({ kind: 'nothing' });

    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    await git(ws, ['commit', '-aqm', 'coder: footer']);
    await git(ws, ['push', '-q', 'origin', `HEAD:${BRANCH}`]);
    const pushed = await branchHead();
    expect(await push(checkout.head)).toEqual({ kind: 'pushed' });
    expect(await branchHead()).toBe(pushed);
  });

  it('never pushes over a branch that moved: the change goes to its own PR into that branch', async () => {
    const checkout = await checkoutFollowUpBranch(ws, BRANCH);
    if (!checkout.ok) throw new Error('checkout failed');
    // Someone else pushes to the PR while the coder works.
    await git(seed, ['checkout', '-q', BRANCH]);
    await writeFile(path.join(seed, 'hero.txt'), 'Learn alongside top companies\n');
    await git(seed, ['commit', '-aqm', 'someone else']);
    await git(seed, ['push', '-q', 'origin', BRANCH]);
    const theirs = await branchHead();

    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    const createPullRequest = vi
      .spyOn(__followUpPushDeps, 'createPullRequest')
      .mockResolvedValue({ prUrl: 'https://github.com/Newton-School/newton-marketing-web/pull/1499' });

    expect(await push(checkout.head)).toEqual({
      kind: 'stacked',
      prUrl: 'https://github.com/Newton-School/newton-marketing-web/pull/1499',
    });
    // Their commit is still the branch head.
    expect(await branchHead()).toBe(theirs);
    const stacked = `${BRANCH}-followup-730.1`;
    expect(await git(bare, ['show', `${stacked}:footer.txt`])).toBe('New footer');
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ branch: stacked, baseBranch: BRANCH, labels: ['miniog'] }),
    );
  });

  it('fails without pushing anywhere when the branch is gone from GitHub', async () => {
    const checkout = await checkoutFollowUpBranch(ws, BRANCH);
    if (!checkout.ok) throw new Error('checkout failed');
    await git(bare, ['branch', '-D', BRANCH]);
    await writeFile(path.join(ws, 'footer.txt'), 'New footer\n');
    const result = await push(checkout.head);
    expect(result.kind).toBe('failed');
    expect(await git(bare, ['branch', '--list'])).not.toContain(BRANCH);
  });
});
