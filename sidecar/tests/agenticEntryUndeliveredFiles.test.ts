import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask, WorkflowStepLog } from '../src/types/contracts.js';

// The upload helpers are real here; only the agent, git and the backend check are stubbed.
vi.mock('../src/agentic/runClaude.js', () => ({ runClaudeAgentic: vi.fn() }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  refreshSharedRepoToDefaultBranch: vi.fn(async () => ({ branch: 'master', head: 'abc1234', behind: 0 })),
}));
vi.mock('../src/backends/registry.js', () => ({ getBackend: () => ({ isAvailable: () => true }) }));

const config = {
  botUserId: 'UBOT',
  ownerSlackUserIds: [],
  repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' },
  miniOgRepoRoot: '/repos',
} as unknown as AppConfig;

function taskSaying(text: string): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C123',
      threadTs: '1791000000.000100',
      eventTs: '1791000000.000100',
      userId: 'U111',
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'INFORMATIONAL',
  };
}

function missingScopeError(): Error {
  const err = new Error('An API error occurred: missing_scope') as Error & { data?: Record<string, unknown> };
  err.data = { ok: false, error: 'missing_scope', needed: 'files:write', provided: 'chat:write,channels:read' };
  return err;
}

// Issue #433: "Full spec is in the attached file", then "where is the attached
// file?", then "Did not receive any file again". The reply was posted before
// the upload was tried and nothing ever corrected it.
describe('runAgenticEntry when a listed file does not reach Slack', () => {
  let workDir: string;
  let store: JobStore;
  let posted: string[];
  let filesUploadV2: ReturnType<typeof vi.fn>;
  let slack: WebClient;
  let logs: WorkflowStepLog[];

  const write = (name: string, content: string | Buffer): string => {
    const filePath = path.join(workDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const agentReplies = (text: string, marker: string, files: Array<{ path: string; caption?: string }>): void => {
    vi.mocked(runClaudeAgentic)
      .mockReset()
      .mockResolvedValue({ ok: true, reason: 'ok', reply: `${text}\n${marker}\n${JSON.stringify(files)}` } as never);
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-files-'));
    store = new JobStore(path.join(workDir, 'watchtower.db'));
    posted = [];
    logs = [];
    filesUploadV2 = vi.fn(async () => {
      throw missingScopeError();
    });
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: {
        postMessage: vi.fn(async (args: { text: string }) => {
          posted.push(args.text);
          return { ok: true, ts: '2.2' };
        }),
      },
      filesUploadV2,
    } as unknown as WebClient;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const run = (mode: 'informational' | 'qa', text: string) =>
    runAgenticEntry({ mode, task: taskSaying(text), config, slack, store, logStep: entry => logs.push(entry) });

  it('follows the reply with the content of a small text file', async () => {
    const csv = write('lectures.csv', 'id,title\n1,Intro\n2,Arrays\n');
    agentReplies('18 lectures in the window. Full list attached.', '===FILES===', [{ path: csv }]);

    const result = await run('informational', 'timestamps of these lectures?');

    expect(posted).toHaveLength(2);
    expect(posted[0]).toBe('18 lectures in the window. Full list attached.');
    expect(posted[1]).toContain("`lectures.csv` didn't attach");
    expect(posted[1]).toContain('Here it is as text instead:\n```\nid,title\n1,Intro\n2,Arrays\n```');
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({ filesListed: 1, filesUploaded: 0, filesInlined: 1, filesLost: 0 });

    const followUp = logs.find(entry => entry.stage === 'agentic.files.follow_up');
    expect(followUp?.level).toBe('WARN');
    expect(followUp?.data).toMatchObject({
      inlined: ['lectures.csv'],
      lost: [],
      reasons: [{ filename: 'lectures.csv', reason: 'missing_scope' }],
    });
  });

  it('says so when the file cannot be pasted either', async () => {
    const pdf = write('how-xp-works.pdf', Buffer.alloc(2048, 1));
    agentReplies('XP explained in the attached PDF.', '===FILES===', [{ path: pdf }]);

    const result = await run('informational', 'how does xp work?');

    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("`how-xp-works.pdf` didn't attach");
    expect(posted[1]).toContain("it isn't something I can paste as text");
    expect(result.result).toEqual({ filesListed: 1, filesUploaded: 0, filesInlined: 0, filesLost: 1 });
  });

  it('corrects the reply for a file the agent listed but never wrote', async () => {
    filesUploadV2.mockImplementation(async () => ({ ok: true }));
    const csv = write('rows.csv', 'a,b\n1,2\n');
    agentReplies('Both files attached.', '===FILES===', [{ path: csv }, { path: path.join(workDir, 'missing.csv') }]);

    const result = await run('informational', 'give me both lists');

    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toBe(":warning: `missing.csv` didn't attach: the file wasn't there when I went to send it.");
    expect(result.result).toEqual({ filesListed: 2, filesUploaded: 1, filesInlined: 0, filesLost: 1 });
  });

  it('posts nothing extra when every file arrived', async () => {
    filesUploadV2.mockImplementation(async () => ({ ok: true }));
    const csv = write('rows.csv', 'a,b\n1,2\n');
    agentReplies('List attached.', '===FILES===', [{ path: csv }]);

    const result = await run('informational', 'give me the list');

    expect(posted).toEqual(['List attached.']);
    expect(result.result).toEqual({ filesListed: 1, filesUploaded: 1 });
    expect(logs.some(entry => entry.stage.includes('follow_up'))).toBe(false);
  });

  it('does not fail the run when the follow-up cannot be posted', async () => {
    const csv = write('rows.csv', 'a,b\n1,2\n');
    agentReplies('List attached.', '===FILES===', [{ path: csv }]);
    vi.mocked(slack.chat.postMessage)
      .mockImplementationOnce(async () => ({ ok: true, ts: '2.2' }) as never)
      .mockImplementationOnce(async () => {
        throw new Error('ratelimited');
      });

    const result = await run('informational', 'give me the list');

    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({ filesListed: 1, filesUploaded: 0, filesInlined: 0, filesLost: 1 });
    expect(logs.find(entry => entry.stage === 'agentic.files.follow_up_failed')?.level).toBe('ERROR');
  });

  it('tells a QA thread when its screenshots did not attach', async () => {
    const shot = write('checkout.png', Buffer.alloc(512, 7));
    agentReplies('Checkout renders; see the screenshot.', '===SCREENSHOTS===', [{ path: shot, caption: 'checkout' }]);

    const result = await run('qa', 'test https://example.test/checkout');

    expect(result.status).toBe('SUCCESS');
    // Acknowledgement, the report, then the correction.
    expect(posted).toHaveLength(3);
    expect(posted[1]).toBe('Checkout renders; see the screenshot.');
    expect(posted[2]).toContain("`checkout.png` didn't attach: Slack won't let me upload files yet");
    expect(posted[2]).toContain("it isn't something I can paste as text");
    expect(logs.find(entry => entry.stage === 'qa.evidence.follow_up')?.data).toMatchObject({ lost: ['checkout.png'] });
  });
});
