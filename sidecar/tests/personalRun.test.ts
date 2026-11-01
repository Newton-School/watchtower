import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { claudeCodeBackend, claudePermissionMode } from '../src/backends/claudeCodeBackend.js';
import { settingsProblem } from '../src/backends/personalSlack.js';
import { reportsConnectors } from '../src/codex/runCodex.js';
import { ownPrAsks } from '../src/personal/githubInventory.js';
import { isRunDue, latestRunTime, runWindow } from '../src/personal/schedule.js';
import { dirtyPaths, findUnfinishedSessions, readSession, unfinishedReasons } from '../src/personal/sessions.js';
import { standDownForMiniog } from '../src/personal/standDown.js';
import { itemPermalink, parseTriageReply, toPersonalItem } from '../src/personal/triage.js';
import { JobStore } from '../src/state/jobStore.js';
import { spendKey, type MiniogJob } from '../src/state/personalStore.js';

const execFileAsync = promisify(execFile);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-personal-'));
}

describe('the Slack triage agent can only read Slack', () => {
  const args = claudeCodeBackend.buildArgs(
    { cwd: tempDir(), prompt: 'triage', personalSlack: 'read' },
    path.join(tempDir(), 'out.json'),
  );
  const flagValues = (flag: string): string[] => {
    const start = args.indexOf(flag);
    if (start < 0) return [];
    const end = args.findIndex((arg, index) => index > start && arg.startsWith('--'));
    return args.slice(start + 1, end < 0 ? undefined : end);
  };

  it('never bypasses permissions', () => {
    expect(claudePermissionMode({ personalSlack: 'read' })).toBe('personal-slack');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(flagValues('--permission-mode')).toEqual(['dontAsk']);
  });

  it('leaves out the flags that took every tool away, Slack included', () => {
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--setting-sources');
    expect(flagValues('--allowedTools')).toContain('ToolSearch');
  });

  it('allows the Slack read tools and nothing that writes', () => {
    const allowed = flagValues('--allowedTools');
    expect(allowed).toContain('mcp__claude_ai_Slack__slack_read_thread');
    expect(allowed.filter(tool => /send|schedule|create|update|upload|reaction|record/.test(tool))).toEqual([]);
    expect(allowed.filter(tool => tool.startsWith('mcp__') && !tool.includes('lack'))).toEqual([]);
  });

  it('denies sending and drafting as him, and the shell, by rule as well', () => {
    const denied = flagValues('--disallowedTools');
    for (const tool of [
      'Bash',
      'Read',
      'Write',
      'mcp__claude_ai_Slack__slack_send_message',
      'mcp__claude_ai_Slack__slack_send_message_draft',
      'mcp__plugin_slack_slack__slack_send_message',
    ]) {
      expect(denied).toContain(tool);
    }
  });

  it('skips strict MCP, the only way his Slack connector loads', () => {
    expect(args).not.toContain('--strict-mcp-config');
  });

  it("doesn't alert about connectors this run only loaded by accident", () => {
    expect(reportsConnectors({ personalSlack: 'read' })).toBe(false);
    expect(reportsConnectors({})).toBe(true);
  });

  it('leaves every other run on strict MCP', () => {
    const other = claudeCodeBackend.buildArgs({ cwd: tempDir(), prompt: 'x' }, path.join(tempDir(), 'out.json'));
    expect(other).toContain('--strict-mcp-config');
  });
});

describe('settings that would widen the Slack run', () => {
  const settings = (content: unknown): string => {
    const file = path.join(tempDir(), 'settings.json');
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };

  it('catches another connector, or everything, being allowed', () => {
    expect(settingsProblem(settings({ permissions: { allow: ['mcp__claude_ai_Gmail__*'] } }))).toContain('Gmail');
    expect(settingsProblem(settings({ permissions: { allow: ['*'] } }))).toContain('*');
    expect(settingsProblem(settings({ permissions: { allow: ['mcp__figma'] } }))).toContain('figma');
  });

  it("lets through what can't widen it", () => {
    const allow = ['Bash(git status)', 'Read', 'mcp__claude_ai_Slack__slack_read_thread'];
    expect(settingsProblem(settings({ permissions: { allow } }))).toBeUndefined();
    expect(settingsProblem(settings({ model: 'opus' }))).toBeUndefined();
    expect(settingsProblem(path.join(tempDir(), 'missing.json'))).toBeUndefined();
  });
});

describe('when a run is due', () => {
  const at = (text: string) => new Date(`${text}:00`);
  const due = (now: string, extra: Partial<Parameters<typeof isRunDue>[0]> = {}) =>
    isRunDue({
      now: at(now),
      enabled: true,
      runTime: '22:00',
      enabledAt: undefined,
      lastStartedAt: undefined,
      ...extra,
    });

  it('fires once the time passes, and not again that night', () => {
    const before = { lastStartedAt: at('2026-11-01T22:00').toISOString() };
    expect(due('2026-11-02T21:59', before)).toBe(false);
    expect(due('2026-11-02T22:00', before)).toBe(true);
    expect(due('2026-11-02T23:30', { lastStartedAt: at('2026-11-02T22:00').toISOString() })).toBe(false);
  });

  it('fires a night the Mac slept through as soon as it wakes', () => {
    expect(due('2026-11-03T08:00', { lastStartedAt: at('2026-11-01T22:00').toISOString() })).toBe(true);
  });

  it('stays off when turned off', () => {
    expect(due('2026-11-02T23:00', { enabled: false })).toBe(false);
  });

  it("doesn't fire for a time that passed before it was turned on", () => {
    const enabledAt = at('2026-11-02T23:00').toISOString();
    expect(due('2026-11-02T23:01', { enabledAt })).toBe(false);
    expect(due('2026-11-03T22:00', { enabledAt })).toBe(true);
  });

  it('stays off for a time moved past tonight, or changed since', () => {
    const justRan = { lastStartedAt: at('2026-11-02T22:00').toISOString(), runTime: '23:30' };
    expect(due('2026-11-02T23:31', justRan)).toBe(false);
    const moved = { enabledAt: at('2026-11-02T15:00').toISOString(), runTime: '09:30' };
    expect(due('2026-11-02T15:01', moved)).toBe(false);
  });

  it('reads a bad time as the default', () => {
    expect(latestRunTime(at('2026-11-02T23:00'), 'soon').getHours()).toBe(22);
  });
});

describe('what a run covers', () => {
  const now = new Date('2026-11-02T22:00:00');

  it('starts where the last finished run ended, with an overlap', () => {
    const { start } = runWindow({ now, lastWindowEnd: new Date('2026-11-01T22:00:00').toISOString(), span: undefined });
    expect(start.toISOString()).toBe(new Date('2026-11-01T21:30:00').toISOString());
  });

  it('covers the last day with no run yet, or a last run over a week old', () => {
    const lastDay = new Date('2026-11-01T22:00:00').toISOString();
    expect(runWindow({ now, lastWindowEnd: undefined, span: undefined }).start.toISOString()).toBe(lastDay);
    const old = new Date('2026-10-01T22:00:00').toISOString();
    expect(runWindow({ now, lastWindowEnd: old, span: undefined }).start.toISOString()).toBe(lastDay);
  });

  it('never narrows with a span: the next run starts from this one', () => {
    const fiveDaysAgo = new Date('2026-10-28T22:00:00').toISOString();
    const usual = new Date('2026-10-28T21:30:00').toISOString();
    expect(runWindow({ now, lastWindowEnd: fiveDaysAgo, span: '0d' }).start.toISOString()).toBe(usual);
    expect(runWindow({ now, lastWindowEnd: fiveDaysAgo, span: '2026-11-02' }).start.toISOString()).toBe(usual);
  });

  it('widens to a span, and ignores one it cannot read', () => {
    const last = new Date('2026-11-01T22:00:00').toISOString();
    expect(runWindow({ now, lastWindowEnd: last, span: '3d' }).start.toISOString()).toBe(
      new Date('2026-10-30T00:00:00').toISOString(),
    );
    expect(runWindow({ now, lastWindowEnd: last, span: '2026-10-28' }).start.toISOString()).toBe(
      new Date('2026-10-28T00:00:00').toISOString(),
    );
    expect(runWindow({ now, lastWindowEnd: last, span: 'nope' }).start.toISOString()).toBe(
      new Date('2026-11-01T21:30:00').toISOString(),
    );
  });
});

describe('standing down for miniOG', () => {
  const ask = '1793000000.000100';
  const item = { state: 'needs_you' as const, channelId: 'C1', threadTs: ask, messageTs: ask };
  const job = (overrides: Partial<MiniogJob>): MiniogJob => ({
    id: 'job-1',
    workflow: 'PR_REVIEW',
    status: 'SUCCESS',
    channelId: 'C1',
    threadTs: ask,
    eventTs: ask,
    createdAt: new Date(1793000100 * 1000).toISOString(),
    ...overrides,
  });

  it('closes an ask its own run finished, linking the run', () => {
    expect(standDownForMiniog(item, [job({})])).toEqual({
      state: 'done',
      jobId: 'job-1',
      doneSummary: 'miniOG handled this.',
    });
  });

  it("leaves an ask alone when another run in the thread succeeded: it may be someone else's", () => {
    expect(standDownForMiniog(item, [job({ eventTs: '1793000500.000200' })]).state).toBe('needs_you');
  });

  it('matches a reply in a thread by the message, not the thread', () => {
    const reply = { ...item, messageTs: '1793000500.000200' };
    expect(standDownForMiniog(reply, [job({ eventTs: ask })]).state).toBe('needs_you');
    expect(standDownForMiniog(reply, [job({ eventTs: '1793000500.000200' })]).state).toBe('done');
  });

  it('waits on its run still going, whatever the router first guessed', () => {
    expect(standDownForMiniog(item, [job({ status: 'PAUSED', workflow: 'UNKNOWN' })])).toEqual({
      state: 'waiting',
      jobId: 'job-1',
    });
  });

  it('keeps an ask open when miniOG failed: that is a missed ask', () => {
    expect(standDownForMiniog(item, [job({ status: 'FAILED' })]).state).toBe('needs_you');
    expect(standDownForMiniog(item, [job({ status: 'CANCELLED' })]).state).toBe('needs_you');
  });

  it('ignores a finished run that decided nothing, and other channels', () => {
    expect(standDownForMiniog(item, [job({ workflow: 'NONE' })]).state).toBe('needs_you');
    expect(standDownForMiniog(item, [job({ channelId: 'C2' })]).state).toBe('needs_you');
  });

  it('never reopens an item already done', () => {
    expect(standDownForMiniog({ ...item, state: 'done' }, [job({ status: 'RUNNING' })]).state).toBe('done');
  });
});

describe("the triage agent's reply", () => {
  const good = { key: 'slack:C1:1793000000.000100', source: 'slack', state: 'ready', ask: 'Can you check this?' };

  it('reads JSON after a sentence or in a fence, with braces inside strings', () => {
    const body = JSON.stringify({ items: [{ ...good, ask: 'uses {curly} and "quotes"' }], gaps: ['one'] });
    const reply = parseTriageReply(`Here you go:\n\`\`\`json\n${body}\n\`\`\``);
    expect(reply.items[0].ask).toBe('uses {curly} and "quotes"');
    expect(reply.gaps).toEqual(['one']);
  });

  it('drops one bad item with a gap line, keeping the rest', () => {
    const reply = parseTriageReply(JSON.stringify({ items: [good, { key: 'x', state: 'nonsense' }] }));
    expect(reply.items).toHaveLength(1);
    expect(reply.gaps[0]).toContain('1 item');
  });

  it('refuses a key that could overwrite a session', () => {
    const reply = parseTriageReply(JSON.stringify({ items: [{ ...good, key: 'session:abc' }] }));
    expect(reply.items).toEqual([]);
    const github = { ...good, key: 'gh:o/r#12:review', source: 'github' };
    expect(parseTriageReply(JSON.stringify({ items: [github] })).items).toHaveLength(1);
  });

  it('treats an empty thread id as missing', () => {
    const triaged = { ...good, source: 'slack', state: 'ready', thread_ts: '', message_ts: '1793000000.000100' };
    expect(toPersonalItem(triaged as never, 'run').threadTs).toBe('1793000000.000100');
  });

  it("throws rather than report an empty inbox when it isn't the shape at all", () => {
    expect(() => parseTriageReply('SLACK_UNAVAILABLE: no tools')).toThrow(/SLACK_UNAVAILABLE: no tools/);
    expect(() => parseTriageReply('{"oops": true}')).toThrow();
  });

  it('builds links from ids, and refuses ids that are not Slack ids', () => {
    expect(itemPermalink('C01ABCDEF', '1793000000.000100', undefined)).toContain(
      '/archives/C01ABCDEF/p1793000000000100',
    );
    expect(itemPermalink('C01ABCDEF', '1793000000.000100', '1793000500.000200')).toContain(
      'p1793000500000200?thread_ts=1793000000.000100&cid=C01ABCDEF',
    );
    expect(itemPermalink('https://evil.example', '1793000000.000100', undefined)).toBeUndefined();
    expect(itemPermalink('C01ABCDEF', '../x', undefined)).toBeUndefined();
  });

  it('keeps only real GitHub PR links', () => {
    const item = toPersonalItem(
      {
        ...good,
        source: 'slack',
        state: 'ready',
        pr_urls: ['https://github.com/o/r/pull/1', 'https://evil.example/pull/1'],
      },
      'run-1',
    );
    expect(item.prUrls).toEqual(['https://github.com/o/r/pull/1']);
  });
});

describe('asks on his own PRs', () => {
  const detail = (overrides: Record<string, unknown> = {}) => ({
    number: 1,
    title: 't',
    url: 'u',
    commits: { nodes: [{ commit: { committedDate: '2026-11-01T10:00:00Z' } }] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  });
  const comment = (login: string, body = 'please fix', createdAt = '2026-11-02T10:00:00Z') => ({
    author: { login },
    body,
    createdAt,
    url: 'c',
  });
  const thread = (...nodes: unknown[]) => ({ isResolved: false, path: 'a.ts', comments: { nodes } });

  it('counts a thread where someone else spoke last, and marks if it is new', () => {
    const asks = ownPrAsks(
      detail({ reviewThreads: { nodes: [thread(comment('me', 'x'), comment('rev'))] } }) as never,
      'me',
      '2026-11-02T00:00:00Z',
    );
    expect(asks).toMatchObject([{ kind: 'thread', author: 'rev', inWindow: true }]);
  });

  it('skips threads he answered last, and resolved ones', () => {
    const answered = thread(comment('rev'), comment('me'));
    const resolved = { ...thread(comment('rev')), isResolved: true };
    expect(ownPrAsks(detail({ reviewThreads: { nodes: [answered, resolved] } }) as never, 'me', '2026-11-02')).toEqual(
      [],
    );
  });

  it('counts an unanswered automated finding from his own account', () => {
    const finding = thread(comment('me', '**[SECURITY — HIGH]** leak'));
    expect(ownPrAsks(detail({ reviewThreads: { nodes: [finding] } }) as never, 'me', '2026-11-02')).toMatchObject([
      { kind: 'automated_finding' },
    ]);
  });

  it('keeps a request for changes when the reviewer later only commented', () => {
    const review = (state: string, submittedAt: string) => ({ author: { login: 'rev' }, state, submittedAt, url: 'r' });
    const reviews = [review('CHANGES_REQUESTED', '2026-11-02T00:00:00Z'), review('COMMENTED', '2026-11-02T01:00:00Z')];
    expect(ownPrAsks(detail({ reviews: { nodes: reviews } }) as never, 'me', '2026-11-01')).toMatchObject([
      { kind: 'changes_requested' },
    ]);
  });

  it('counts changes requested only after his last commit', () => {
    const review = (submittedAt: string) => ({
      author: { login: 'rev' },
      state: 'CHANGES_REQUESTED',
      submittedAt,
      url: 'r',
    });
    const after = detail({ reviews: { nodes: [review('2026-11-02T00:00:00Z')] } });
    const before = detail({ reviews: { nodes: [review('2026-10-30T00:00:00Z')] } });
    expect(ownPrAsks(after as never, 'me', '2026-11-01')).toMatchObject([{ kind: 'changes_requested' }]);
    expect(ownPrAsks(before as never, 'me', '2026-11-01')).toEqual([]);
  });
});

describe('sessions left unfinished', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
  const write = (lines: string[], name = id): { dir: string; file: string } => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'project'));
    const file = path.join(dir, 'project', `${name}.jsonl`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return { dir, file };
  };
  const prompt = (cwd: string, timestamp: string, entrypoint = 'cli') =>
    line({ type: 'user', timestamp, cwd, entrypoint, message: { content: 'please do it' } });
  const reply = (timestamp: string, text: string) =>
    line({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } });

  it('finds a session that ended on a question', async () => {
    const cwd = tempDir();
    const { dir, file } = write([
      prompt(cwd, '2026-11-02T10:00:00Z'),
      reply('2026-11-02T10:01:00Z', 'Want me to push it?'),
    ]);
    fs.utimesSync(file, new Date('2026-11-02T10:01:00Z'), new Date('2026-11-02T10:01:00Z'));
    const { unfinished } = await findUnfinishedSessions({ sinceIso: '2026-11-02T00:00:00Z', projectsDir: dir });
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].reasons[0]).toContain('question');
  });

  it('skips headless sessions, and sessions with no prompt in the window', async () => {
    const cwd = tempDir();
    const headless = write([prompt(cwd, '2026-11-02T10:00:00Z', 'sdk-cli')]);
    expect(await readSession(headless.file, '2026-11-02T00:00:00Z')).toBeUndefined();
    const old = write([prompt(cwd, '2026-10-01T10:00:00Z')]);
    expect(await readSession(old.file, '2026-11-02T00:00:00Z')).toBeUndefined();
  });

  it('counts only the files the session edited as its uncommitted work, where it ended up', async () => {
    const repo = fs.realpathSync(tempDir());
    await execFileAsync('git', ['init', '-q', repo]);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'a@example.com']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'a']);
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'one');
    fs.writeFileSync(path.join(repo, 'other.ts'), 'one');
    await execFileAsync('git', ['-C', repo, 'add', '.']);
    await execFileAsync('git', ['-C', repo, 'commit', '-qm', 'start']);
    fs.writeFileSync(path.join(repo, 'other.ts'), 'someone else');
    const facts = {
      sessionId: id,
      cwd: '/somewhere/else',
      workDir: repo,
      editedFiles: [path.join(repo, 'mine.ts')],
      title: 't',
      lastActivityAt: '',
      lastReply: '',
      endedOnQuestion: false,
    };
    expect(await unfinishedReasons(facts)).toEqual([]);
    fs.writeFileSync(path.join(repo, 'mine.ts'), 'changed');
    expect(await unfinishedReasons(facts)).toEqual([`1 uncommitted file in ${repo}.`]);
  });

  it('resumes where the session started, and checks where it ended up', async () => {
    const start = tempDir();
    const worktree = tempDir();
    const moved = line({
      type: 'user',
      timestamp: '2026-11-02T10:02:00Z',
      cwd: worktree,
      message: { content: 'go on' },
    });
    const { file } = write([prompt(start, '2026-11-02T10:00:00Z'), moved]);
    expect(await readSession(file, '2026-11-02T00:00:00Z')).toMatchObject({ cwd: start, workDir: worktree });
  });

  it("doesn't count a question he answered, and titles from the session's own title", async () => {
    const cwd = tempDir();
    const { file } = write([
      prompt(cwd, '2026-11-02T10:00:00Z'),
      reply('2026-11-02T10:01:00Z', 'Should I push?'),
      line({ type: 'ai-title', aiTitle: 'Fix the login', timestamp: '2026-11-02T10:01:30Z' }),
      prompt(cwd, '2026-11-02T10:02:00Z'),
    ]);
    expect(await readSession(file, '2026-11-02T00:00:00Z')).toMatchObject({
      endedOnQuestion: false,
      title: 'Fix the login',
    });
  });

  it('parses renames and quoted paths out of the status output', () => {
    expect(dirtyPaths(' M a.ts\nR  old.ts -> new.ts\n?? "with space.ts"\n', '/r')).toEqual([
      '/r/a.ts',
      '/r/new.ts',
      '/r/with space.ts',
    ]);
  });

  it('skips a file whose name is not a session id', async () => {
    const { file } = write([prompt(tempDir(), '2026-11-02T10:00:00Z')], 'not-a-session');
    expect(await readSession(file, '2026-11-02T00:00:00Z')).toBeUndefined();
  });

  it('rechecks an older session, and reports it finished when nothing is left', async () => {
    const cwd = tempDir();
    const { dir, file } = write([prompt(cwd, '2026-10-01T10:00:00Z'), reply('2026-10-01T10:01:00Z', 'All done.')]);
    fs.utimesSync(file, new Date('2026-10-01'), new Date('2026-10-01'));
    const { unfinished, finishedIds } = await findUnfinishedSessions({
      sinceIso: '2026-11-02T00:00:00Z',
      recheckIds: [id],
      projectsDir: dir,
    });
    expect(unfinished).toEqual([]);
    expect(finishedIds).toEqual([id]);
  });
});

describe('the personal store', () => {
  const store = () => new JobStore(path.join(tempDir(), 'watchtower.db')).personalStore();
  const item = {
    key: 'slack:C1:1.2',
    source: 'slack' as const,
    state: 'needs_you' as const,
    ask: 'review #1',
    prUrls: ['https://github.com/o/r/pull/1'],
    lastRunId: 'run-1',
  };

  it('keeps when an item was first seen across nights', async () => {
    const personal = store();
    personal.upsertItem(item);
    const first = personal.openItems()[0].firstSeenAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    personal.upsertItem({ ...item, ask: 'review #1 again', lastRunId: 'run-2' });
    const [again] = personal.openItems();
    expect(again.firstSeenAt).toBe(first);
    expect(again.ask).toBe('review #1 again');
    expect(again.prUrls).toEqual(item.prUrls);
  });

  it('leaves done items and sessions out of what triage re-checks', () => {
    const personal = store();
    personal.upsertItem({ ...item, key: 'a', state: 'done' });
    personal.upsertItem({ ...item, key: 'session:x', source: 'session' });
    expect(personal.openItems()).toEqual([]);
    expect(personal.openSessionKeys()).toEqual(['session:x']);
  });

  it("doesn't move the window from a run that missed a source", () => {
    const personal = store();
    const window = { trigger: 'schedule' as const, windowStart: 'a', windowEnd: 'b' };
    const ok = personal.startRun(window);
    personal.finishRun(ok.id, { status: 'OK' });
    const partial = personal.startRun(window);
    personal.finishRun(partial.id, { status: 'PARTIAL', gaps: ['GitHub: down'] });
    expect(personal.lastFinishedRun()?.id).toBe(ok.id);
  });

  it('only moves the window from a run that finished', () => {
    const personal = store();
    const window = {
      trigger: 'schedule' as const,
      windowStart: '2026-11-01T00:00:00Z',
      windowEnd: '2026-11-02T00:00:00Z',
    };
    const ok = personal.startRun(window);
    personal.finishRun(ok.id, { status: 'OK' });
    const failed = personal.startRun({ ...window, windowEnd: '2026-11-03T00:00:00Z' });
    personal.finishRun(failed.id, { status: 'FAILED', error: 'boom' });
    expect(personal.lastFinishedRun()?.id).toBe(ok.id);
  });

  it('closes a run a restart left running, so the next is not blocked', () => {
    const personal = store();
    const run = personal.startRun({ trigger: 'manual', windowStart: 'a', windowEnd: 'b' });
    expect(personal.failInterruptedRuns('restart')).toBe(1);
    expect(personal.lastRun()).toMatchObject({ id: run.id, status: 'FAILED', error: 'restart' });
  });

  it('sums what a run cost from its telemetry key', () => {
    const job = new JobStore(path.join(tempDir(), 'watchtower.db'));
    expect(job.personalStore().runCostUsd('none')).toBe(0);
    expect(spendKey('r')).toBe('personal:r');
  });
});
