import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { botScopes } from '../src/slack/botScopes.js';
import { __connectors, currentConnectors } from '../src/backends/connectors.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask, NormalizedThreadMessage } from '../src/types/contracts.js';

const supportsImages = vi.hoisted(() => ({ value: true }));

// The downloader is real (fetch is stubbed); only the agent, git and the backend lookup are stubbed.
vi.mock('../src/agentic/runClaude.js', () => ({ runClaudeAgentic: vi.fn() }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  refreshSharedRepoToDefaultBranch: vi.fn(async () => ({ branch: 'master', head: 'abc1234', behind: 0 })),
}));
vi.mock('../src/backends/registry.js', () => ({
  getBackend: () => ({ isAvailable: () => true, supportsImages: () => supportsImages.value }),
}));

const config = {
  botUserId: 'UBOT',
  slackBotToken: 'xoxb-test',
  ownerSlackUserIds: [],
  repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' },
  miniOgRepoRoot: '/repos',
} as unknown as AppConfig;

const TRIGGER_TS = '1791000300.000100';

function slackFile(id: string, name: string, mimetype = 'image/png') {
  return { id, name, mimetype, url_private_download: `https://files.slack.example/${id}/${name}` };
}

function taskWith(text: string, threadMessages: NormalizedThreadMessage[]): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C123',
      threadTs: '1791000000.000100',
      eventTs: TRIGGER_TS,
      userId: 'U111',
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'INFORMATIONAL',
    threadMessages,
  };
}

// Issue #433: "pls remove this section from website [image.png]" was answered
// with "no screenshot, page, or section name came through". Only the
// code-change path ever downloaded attachments.
describe('runAgenticEntry and files people attach', () => {
  let dbDir: string;
  let store: JobStore;
  let slack: WebClient;
  let fetchStatus: number;

  const thread: NormalizedThreadMessage[] = [
    { text: 'the banner looks off', user: 'U111', ts: '1791000000.000100', files: [slackFile('FOLD', 'banner.png')] },
    { text: 'which section is this?', user: 'U111', ts: TRIGGER_TS, files: [slackFile('FNEW', 'section.png')] },
  ];

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-attach-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '2.2' })) },
    } as unknown as WebClient;
    fetchStatus = 200;
    supportsImages.value = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(fetchStatus === 200 ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : '', { status: fetchStatus }),
      ),
    );
    vi.mocked(runClaudeAgentic)
      .mockReset()
      .mockResolvedValue({ ok: true, reason: 'ok', reply: 'That is the hero banner.' } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    botScopes.setForTest(undefined);
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  const run = async (mode: 'informational' | 'conversational' | 'qa', text: string, messages = thread) => {
    await runAgenticEntry({ mode, task: taskWith(text, messages), config, slack, store, logStep: vi.fn() });
    return vi.mocked(runClaudeAgentic).mock.calls[0][0];
  };

  it('gives a lookup every image in the thread, the triggering message first', async () => {
    const request = await run('informational', 'which section is this?');

    expect(request.imagePaths?.map(p => path.basename(p))).toEqual(['FNEW-section.png.png', 'FOLD-banner.png.png']);
    for (const imagePath of request.imagePaths ?? []) {
      expect(fs.existsSync(imagePath)).toBe(true);
    }
    expect(request.userMessage).not.toContain('could NOT open');
  });

  it('gives a chat reply only the files on the message itself', async () => {
    const request = await run('conversational', 'which section is this?');

    expect(request.imagePaths?.map(p => path.basename(p))).toEqual(['FNEW-section.png.png']);
  });

  it('downloads nothing for a chat reply to a message without files', async () => {
    const request = await run('conversational', 'thanks!', [
      thread[0],
      { text: 'thanks!', user: 'U111', ts: TRIGGER_TS },
    ]);

    expect(request.imagePaths).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('tells the agent about a file it could not open instead of leaving it out', async () => {
    fetchStatus = 403;

    const request = await run('informational', 'pls remove this section from website');

    expect(request.imagePaths).toBeUndefined();
    expect(request.userMessage).toContain('section.png (download failed, HTTP 403)');
    expect(request.userMessage).toContain('never tell the user nothing was attached');
  });

  it('puts the text of an attached document in the prompt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('lecture ids: 11, 12, 13', { status: 200 })),
    );

    const request = await run('informational', 'timestamps of these lectures?', [
      {
        text: 'timestamps of these lectures?',
        user: 'U111',
        ts: TRIGGER_TS,
        files: [slackFile('FDOC', 'ids.txt', 'text/plain')],
      },
    ]);

    expect(request.imagePaths).toBeUndefined();
    expect(request.userMessage).toContain('Attached documents from thread:');
    expect(request.userMessage).toContain('lecture ids: 11, 12, 13');
  });

  it('says so when the backend cannot take images', async () => {
    supportsImages.value = false;

    const request = await run('informational', 'which section is this?');

    expect(request.imagePaths).toBeUndefined();
    expect(request.userMessage).toContain('2 image(s) attached in thread — this backend does not support image input');
  });

  it('reads the thread from Slack when intake did not carry it', async () => {
    vi.mocked(slack.conversations.replies).mockResolvedValue({
      messages: [
        { text: 'which section is this?', user: 'U111', ts: TRIGGER_TS, files: [slackFile('FLIVE', 'live.png')] },
      ],
    } as never);

    const request = await run('informational', 'which section is this?', []);

    expect(request.imagePaths?.map(p => path.basename(p))).toEqual(['FLIVE-live.png.png']);
  });

  it('gives a QA run the screenshots in the thread', async () => {
    const request = await run('qa', 'test https://example.test/checkout, the button in the screenshot is cut off');

    expect(request.forceBackend).toBe('claude-code');
    expect(request.imagePaths?.map(p => path.basename(p))).toEqual(['FNEW-section.png.png', 'FOLD-banner.png.png']);
  });
});

// The agent was told it could attach files while the token could not upload,
// so it kept writing "attached".
describe('runAgenticEntry and what the agent is told about attaching files', () => {
  let dbDir: string;
  let store: JobStore;
  let slack: WebClient;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-attach-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '2.2' })) },
    } as unknown as WebClient;
    vi.mocked(runClaudeAgentic)
      .mockReset()
      .mockResolvedValue({ ok: true, reason: 'ok', reply: 'ok' } as never);
  });

  afterEach(() => {
    botScopes.setForTest(undefined);
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  const promptFor = async (mode: 'informational' | 'conversational') => {
    await runAgenticEntry({ mode, task: taskWith('full list please', []), config, slack, store, logStep: vi.fn() });
    return vi.mocked(runClaudeAgentic).mock.calls[0][0].systemPrompt;
  };

  it.each(['informational', 'conversational'] as const)(
    'says uploads work when nothing says otherwise (%s)',
    async mode => {
      const prompt = await promptFor(mode);

      expect(prompt).toContain('You CAN attach real files to your Slack reply.');
      expect(prompt).not.toContain('File uploads are NOT working');
    },
  );

  it.each(['informational', 'conversational'] as const)(
    'says what will really happen when the token cannot upload (%s)',
    async mode => {
      botScopes.setForTest(['chat:write', 'files:read']);

      const prompt = await promptFor(mode);

      expect(prompt).toContain('File uploads are NOT working right now');
      expect(prompt).toContain('Never say a file is "attached".');
      expect(prompt).toContain('pasted into the thread as text right under your reply');
      expect(prompt).toContain('At most 30,000 characters');
      expect(prompt).toContain('===FILES===');
      expect(prompt).not.toContain('You CAN attach real files');
    },
  );
});

// Issue #443: a lookup for a non-owner searched the owner's private Slack and
// read Drive files through connectors no lookup should have had.
describe('runAgenticEntry and connectors', () => {
  let dbDir: string;
  let store: JobStore;
  let slack: WebClient;
  const withMetabase = { ...config, metabaseMcpUrl: 'https://metabase.example/api/mcp' } as unknown as AppConfig;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-connectors-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '2.2' })) },
    } as unknown as WebClient;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  const connectorsSeenBy = async (mode: 'informational' | 'conversational' | 'qa', text: string) => {
    let seen: ReturnType<typeof currentConnectors> | undefined;
    vi.mocked(runClaudeAgentic)
      .mockReset()
      .mockImplementation(async () => {
        seen = currentConnectors();
        return { ok: true, reason: 'ok', reply: 'ok' } as never;
      });
    await runAgenticEntry({ mode, task: taskWith(text, []), config: withMetabase, slack, store, logStep: vi.fn() });
    return seen;
  };

  it('gives a lookup Metabase, read-only', async () => {
    const seen = await connectorsSeenBy('informational', 'how many students enrolled last week?');

    expect(Object.keys(seen?.mcpServers ?? {})).toEqual(['metabase']);
    expect(seen?.disallowedTools).toContain('mcp__metabase__update_*');
  });

  it('tells a lookup what it has, and to say so when the database is out of reach', async () => {
    await connectorsSeenBy('informational', 'how many students enrolled last week?');
    const prompt = vi.mocked(runClaudeAgentic).mock.calls[0][0].systemPrompt;

    expect(prompt).toContain('`mcp__metabase__*` (read-only): the database');
    expect(prompt).toContain("I can't reach <connector> right now; I've let the owner know.");
    expect(prompt).toContain('You have no other connectors');
    expect(prompt).not.toContain('mcp__openpanel__');
  });

  it('says nothing about a database to a chat reply', async () => {
    await connectorsSeenBy('conversational', 'thanks!');

    expect(vi.mocked(runClaudeAgentic).mock.calls[0][0].systemPrompt).not.toContain('mcp__metabase__');
  });

  it('adds OpenPanel when the host has it, and tells the lookup so', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-home-'));
    const realHome = __connectors.home;
    __connectors.home = () => home;
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { openpanel: { type: 'http', url: 'https://openpanel.example/mcp?token=t' } } }),
    );
    try {
      const seen = await connectorsSeenBy('informational', 'how many signups came from the banner last week?');
      const prompt = vi.mocked(runClaudeAgentic).mock.calls[0][0].systemPrompt;

      expect(Object.keys(seen?.mcpServers ?? {})).toEqual(['metabase', 'openpanel']);
      expect(seen?.disallowedTools).toContain('mcp__openpanel__update_*');
      expect(prompt).toContain('`mcp__openpanel__*` (read-only): product analytics');
      // The URL, which can carry a credential, is never put in the prompt.
      expect(prompt).not.toContain('openpanel.example');
    } finally {
      __connectors.home = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('gives a chat reply and a QA run none', async () => {
    expect((await connectorsSeenBy('conversational', 'thanks!'))?.mcpServers).toEqual({});
    expect((await connectorsSeenBy('qa', 'test https://example.test/checkout'))?.mcpServers).toEqual({});
  });
});
