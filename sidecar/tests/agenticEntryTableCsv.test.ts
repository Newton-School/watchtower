import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { informationalSystemPrompt, runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { JobStore } from '../src/state/jobStore.js';
import { CSV_NOTE_ONE } from '../src/slack/tableCsv.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

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

const TABLE = [
  '*Open requests per batch*',
  '| Batch | Open |',
  '|---|---|',
  ...Array.from({ length: 5 }, (_, i) => `| B${i + 1} | ${i} |`),
].join('\n');

// Issue #731: analysts ask for sheets; a lookup's table also comes as a CSV.
describe('runAgenticEntry attaches a lookup table as CSV', () => {
  let workDir: string;
  let store: JobStore;
  let posted: string[];
  let filesUploadV2: ReturnType<typeof vi.fn>;
  let slack: WebClient;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-table-csv-'));
    store = new JobStore(path.join(workDir, 'watchtower.db'));
    posted = [];
    filesUploadV2 = vi.fn(async () => ({ ok: true }));
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

  const replies = (reply: string) =>
    vi
      .mocked(runClaudeAgentic)
      .mockReset()
      .mockResolvedValue({ ok: true, reason: 'ok', reply } as never);
  const run = (mode: 'informational' | 'conversational', text: string) =>
    runAgenticEntry({ mode, task: taskSaying(text), config, slack, store });

  it('posts the answer, then the table as a CSV under it', async () => {
    replies(`5 batches have open requests.\n\n${TABLE}`);
    const result = await run('informational', 'open requests per batch?');

    expect(result.status).toBe('SUCCESS');
    expect(posted).toHaveLength(1);
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const args = filesUploadV2.mock.calls[0][0] as {
      channel_id: string;
      thread_ts: string;
      initial_comment: string;
      file_uploads: Array<{ filename: string; file: Buffer }>;
    };
    expect(args).toMatchObject({ channel_id: 'C123', thread_ts: '1791000000.000100', initial_comment: CSV_NOTE_ONE });
    expect(args.file_uploads[0].filename).toBe('open-requests-per-batch.csv');
    expect(args.file_uploads[0].file.toString('utf8')).toBe(
      `${String.fromCharCode(0xfeff)}Batch,Open\r\nB1,0\r\nB2,1\r\nB3,2\r\nB4,3\r\nB5,4\r\n`,
    );
  });

  it("doesn't add a CSV when the agent attached its own", async () => {
    const own = path.join(workDir, 'full.csv');
    fs.writeFileSync(own, 'Batch,Open\nB1,0\n');
    replies(`Preview below, full list attached.\n\n${TABLE}\n===FILES===\n${JSON.stringify([{ path: own }])}`);
    await run('informational', 'open requests per batch?');

    // One upload: the agent's file, not the table again.
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const args = filesUploadV2.mock.calls[0][0] as { file_uploads: Array<{ filename: string }> };
    expect(args.file_uploads.map(f => f.filename)).toEqual(['full.csv']);
  });

  it('adds nothing to a chat reply or a reply without a table', async () => {
    replies(TABLE);
    await run('conversational', 'hi');
    replies('No table here, just an answer.');
    await run('informational', 'where is X?');
    expect(filesUploadV2).not.toHaveBeenCalled();
  });

  it('a failed CSV upload leaves the answer a success', async () => {
    filesUploadV2.mockRejectedValue(new Error('missing_scope'));
    replies(TABLE);
    const result = await run('informational', 'open requests per batch?');
    expect(result.status).toBe('SUCCESS');
    expect(result.slackPosted).toBe(true);
  });

  it('tells the lookup agent the table becomes a CSV', () => {
    expect(informationalSystemPrompt(config)).toContain('is attached under it as a CSV automatically');
  });
});
