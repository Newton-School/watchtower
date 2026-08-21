import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { normalizeTask, parseMiniogSubcommand } from '../src/router/intentParser.js';
import { runMiniogDossierWorkflow } from '../src/workflows/miniogDossierWorkflow.js';
import { buildHandoffBundle, handoffFileName } from '../src/egress/handoffBuilder.js';
import { GITHUB_EGRESS_SURFACE } from '../src/egress/githubPublisher.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask, SlackEventEnvelope } from '../src/types/contracts.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-handoff-')), 'watchtower.db');
}

// Realistic recent Slack epochs — quiet-window/recency logic compares against real now.
const NOW_EPOCH = Math.floor(Date.now() / 1000);

function slackTs(secondsAgo: number): string {
  return `${NOW_EPOCH - secondsAgo}.000100`;
}

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH', 'C02BUGS'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

const CHANNEL = 'C-HANDOFF';
const THREAD_TS = slackTs(3600);
const PERMALINK = 'https://newton.slack.com/archives/C-HANDOFF/p1787270000000100';
const GITHUB_URL = 'https://github.com/newton-school/miniog-brain/blob/main/threads/proj-ga4/2026-08/thread.md';

interface SlackStub {
  slack: WebClient;
  postMessage: ReturnType<typeof vi.fn>;
  getPermalink: ReturnType<typeof vi.fn>;
  replies: ReturnType<typeof vi.fn>;
  filesUploadV2: ReturnType<typeof vi.fn>;
}

function makeSlackStub(overrides?: {
  getPermalink?: ReturnType<typeof vi.fn>;
  replies?: ReturnType<typeof vi.fn>;
}): SlackStub {
  const postMessage = vi.fn(async () => ({ ok: true }));
  const getPermalink = overrides?.getPermalink ?? vi.fn(async () => ({ ok: true, permalink: PERMALINK }));
  const replies = overrides?.replies ?? vi.fn(async () => ({ ok: true, messages: [] }));
  const filesUploadV2 = vi.fn(async () => ({ ok: true }));
  const slack = {
    chat: { postMessage, getPermalink },
    conversations: { replies },
    filesUploadV2,
  } as unknown as WebClient;
  return { slack, postMessage, getPermalink, replies, filesUploadV2 };
}

function callArg(fn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const call = fn.mock.calls[index] as unknown[];
  return call[0] as Record<string, unknown>;
}

function callText(fn: ReturnType<typeof vi.fn>, index = 0): string {
  return callArg(fn, index).text as string;
}

function seedSynthesizedThread(store: JobStore, opts?: { withFence?: boolean }): number {
  const conversations = store.conversationStore();
  const messages = [
    {
      messageTs: slackTs(1800),
      userId: 'UPART1',
      displayName: 'Dipesh',
      isBot: false,
      text: 'Realtime export is lagging behind GA4 by ~40 minutes.',
    },
    {
      messageTs: slackTs(1740),
      userId: 'UBOT9',
      displayName: 'miniOG',
      isBot: true,
      text: 'Checked the job — the cron window is misaligned with the API flush.',
    },
    ...(opts?.withFence
      ? [
          {
            messageTs: slackTs(1680),
            userId: 'UPART1',
            displayName: 'Dipesh',
            isBot: false,
            text: 'Patch:\n```js\nfixWindow();\n```',
          },
        ]
      : []),
  ];
  const result = conversations.recordMessages({
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    channelType: 'channel',
    channelName: 'proj-ga4',
    // Store default is fail-closed 'private'; publishable seeds are 'org'.
    visibility: 'org',
    messages,
  });
  if ('skipped' in result) throw new Error('seed unexpectedly hit a forgotten tombstone');
  conversations.saveSynthesis(result.threadId, {
    title: 'GA4 realtime export lag',
    summary: 'The export cron window was misaligned with the GA4 API flush; realignment agreed.',
    decisions: ['Align the cron window to 5 minutes.'],
    actionItems: ['Dipesh to deploy the realignment fix.'],
    messageCount: messages.length,
  });
  return result.threadId;
}

describe('parseMiniogSubcommand — handoff', () => {
  it('parses a bare "handoff" as format auto', () => {
    expect(parseMiniogSubcommand('handoff')).toEqual({ kind: 'handoff', format: 'auto' });
  });

  it('parses the explicit paste/file/link formats', () => {
    expect(parseMiniogSubcommand('handoff paste')).toEqual({ kind: 'handoff', format: 'paste' });
    expect(parseMiniogSubcommand('handoff file')).toEqual({ kind: 'handoff', format: 'file' });
    expect(parseMiniogSubcommand('handoff link')).toEqual({ kind: 'handoff', format: 'link' });
  });

  it('is case-insensitive on the verb and the format token', () => {
    expect(parseMiniogSubcommand('HANDOFF')).toEqual({ kind: 'handoff', format: 'auto' });
    expect(parseMiniogSubcommand('Handoff PASTE')).toEqual({ kind: 'handoff', format: 'paste' });
    expect(parseMiniogSubcommand('handoff File')).toEqual({ kind: 'handoff', format: 'file' });
    expect(parseMiniogSubcommand('handoff LINK')).toEqual({ kind: 'handoff', format: 'link' });
  });

  it('tolerates a leading bot mention', () => {
    expect(parseMiniogSubcommand('<@U123> handoff link')).toEqual({ kind: 'handoff', format: 'link' });
  });

  it('rejects extra tokens so natural sentences fall through to the classifier', () => {
    expect(parseMiniogSubcommand('handoff nonsense')).toBeNull();
  });

  it('normalizeTask routes a bot-mention "handoff" to MINIOG_DOSSIER', () => {
    const event: SlackEventEnvelope = {
      eventId: 'Ev-handoff-1',
      channelId: 'C01H25RNLJH',
      threadTs: '1755600000.000100',
      eventTs: '1755600100.000200',
      userId: 'URANDOM',
      text: '<@UBOT1> handoff link',
      rawEvent: {},
    };
    const task = normalizeTask(event, config, []);
    expect(task.mentionDetected).toBe(true);
    expect(task.intent).toBe('MINIOG_DOSSIER');
    expect(task.miniogSubcommand).toEqual({ kind: 'handoff', format: 'link' });
  });
});

describe('buildHandoffBundle', () => {
  let dbPath: string;
  let store: JobStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new JobStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('builds from the store for a captured+synthesized thread (no export → no githubUrl)', async () => {
    seedSynthesizedThread(store);
    const { slack, replies } = makeSlackStub();

    const bundle = await buildHandoffBundle({ slack, store, channelId: CHANNEL, threadTs: THREAD_TS });

    expect(bundle).not.toBeNull();
    expect(bundle?.source).toBe('store');
    expect(bundle?.title).toBe('GA4 realtime export lag');
    expect(bundle?.githubUrl).toBeUndefined();
    const md = bundle?.markdown ?? '';
    expect(md).toContain('# Continuing a Slack discussion: GA4 realtime export lag');
    expect(md).toContain('## Where we are (TL;DR)');
    expect(md).toContain('The export cron window was misaligned');
    expect(md).toContain('## Decisions made');
    expect(md).toContain('- Align the cron window to 5 minutes.');
    expect(md).toContain('## Transcript (condensed, oldest first)');
    expect(md).toContain('Dipesh:');
    expect(md).toContain('miniOG:');
    expect(md).toContain(PERMALINK);
    expect(md).not.toContain('Knowledge base:');
    expect(replies).not.toHaveBeenCalled();
  });

  it('surfaces the knowledge-base URL when a successful export row exists', async () => {
    seedSynthesizedThread(store);
    store.exportLog().recordSuccess({
      surface: GITHUB_EGRESS_SURFACE,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      targetPath: 'threads/proj-ga4/2026-08/thread.md',
      targetUrl: GITHUB_URL,
      contentHash: 'hash-1',
    });
    const { slack } = makeSlackStub();

    const bundle = await buildHandoffBundle({ slack, store, channelId: CHANNEL, threadTs: THREAD_TS });

    expect(bundle?.source).toBe('store');
    expect(bundle?.githubUrl).toBe(GITHUB_URL);
    expect(bundle?.markdown).toContain(`Knowledge base: ${GITHUB_URL}`);
  });

  it('omits the knowledge-base URL when the only export attempt FAILED', async () => {
    seedSynthesizedThread(store);
    store.exportLog().recordFailure({
      surface: GITHUB_EGRESS_SURFACE,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      error: 'git push exploded',
    });
    const { slack } = makeSlackStub();

    const bundle = await buildHandoffBundle({ slack, store, channelId: CHANNEL, threadTs: THREAD_TS });

    expect(bundle?.source).toBe('store');
    expect(bundle?.githubUrl).toBeUndefined();
    expect(bundle?.markdown).not.toContain('Knowledge base:');
  });

  it('falls back to a live Slack fetch for an uncaptured thread', async () => {
    const longAsk =
      '<@UBOT1> please help us debug the GA4 realtime export pipeline for the NSAT admissions dashboard rollout';
    const replies = vi.fn(async () => ({
      ok: true,
      messages: [
        { ts: THREAD_TS, user: 'UBOT1', text: 'Standup reminder for the analytics crew.' },
        { ts: slackTs(3540), user: 'UHUMAN1', text: longAsk },
        { ts: slackTs(3480), user: 'UBOT1', text: 'On it — checking the export job now.' },
      ],
    }));
    const { slack } = makeSlackStub({ replies });

    const bundle = await buildHandoffBundle({
      slack,
      store,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      botUserId: 'UBOT1',
    });

    expect(bundle?.source).toBe('live');
    // Title = first HUMAN message, mentions stripped, capped at 80 chars.
    expect(bundle?.title.startsWith('please help us debug the GA4 realtime export pipeline')).toBe(true);
    expect(bundle?.title).toHaveLength(80);
    expect(bundle?.title).not.toContain('<@');
    const md = bundle?.markdown ?? '';
    expect(md).toContain('## Transcript (condensed, oldest first)');
    expect(md).toContain('miniOG:'); // bot speaker labeled via botUserId
    expect(md).toContain('UHUMAN1:');
    expect(md).toContain('_No synthesis yet — the transcript below is the context._');
    expect(md).toContain(PERMALINK);
    expect(replies).toHaveBeenCalledWith(expect.objectContaining({ channel: CHANNEL, ts: THREAD_TS }));
  });

  it('returns null when nothing is captured and the live fetch fails', async () => {
    const replies = vi.fn(async () => {
      throw new Error('channel_not_found');
    });
    const getPermalink = vi.fn(async () => {
      throw new Error('permalink unavailable');
    });
    const { slack } = makeSlackStub({ replies, getPermalink });

    const bundle = await buildHandoffBundle({ slack, store, channelId: CHANNEL, threadTs: THREAD_TS });

    expect(bundle).toBeNull();
    expect(replies).toHaveBeenCalledTimes(1);
  });
});

describe('runMiniogDossierWorkflow — handoff branch', () => {
  let dbPath: string;
  let store: JobStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new JobStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function makeHandoffTask(format: 'auto' | 'paste' | 'file' | 'link'): NormalizedTask {
    return {
      event: {
        eventId: 'Ev-handoff-wf',
        channelId: CHANNEL,
        threadTs: THREAD_TS,
        eventTs: slackTs(0),
        userId: 'UPART1',
        text: format === 'auto' ? '<@UBOT1> handoff' : `<@UBOT1> handoff ${format}`,
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'MINIOG_DOSSIER',
      miniogSubcommand: { kind: 'handoff', format },
    };
  }

  it('auto-delivers a short bundle as an in-thread paste with inner fences neutralized', async () => {
    seedSynthesizedThread(store, { withFence: true });
    const { slack, postMessage, filesUploadV2 } = makeSlackStub();

    const result = await runMiniogDossierWorkflow({ task: makeHandoffTask('auto'), slack, store, config });

    expect(result).toEqual({
      workflow: 'MINIOG_DOSSIER',
      status: 'SUCCESS',
      message: 'Handoff bundle posted.',
      notifyDesktop: false,
      slackPosted: true,
    });
    expect(filesUploadV2).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(callArg(postMessage)).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    const text = callText(postMessage);
    expect(text).toContain('Copy this into your own Claude');
    expect(text).toContain("'''js"); // the seeded ```js fence was neutralized
    expect((text.match(/```/g) ?? []).length).toBe(2); // only the outer wrapper survives
  });

  it("'file' uploads the bundle as a .md attachment named by handoffFileName", async () => {
    seedSynthesizedThread(store);
    const { slack, postMessage, filesUploadV2 } = makeSlackStub();

    const result = await runMiniogDossierWorkflow({ task: makeHandoffTask('file'), slack, store, config });

    expect(result.status).toBe('SUCCESS');
    expect(postMessage).not.toHaveBeenCalled();
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const upload = callArg(filesUploadV2) as {
      channel_id: string;
      thread_ts: string;
      file_uploads: Array<{ file: Buffer; filename: string; title: string }>;
    };
    expect(upload.channel_id).toBe(CHANNEL);
    expect(upload.thread_ts).toBe(THREAD_TS);
    expect(upload.file_uploads).toHaveLength(1);
    expect(upload.file_uploads[0].filename).toMatch(/^handoff-ga4-realtime-export-lag-\d{4}-\d{2}-\d{2}\.md$/);
    expect(upload.file_uploads[0].title).toBe('GA4 realtime export lag');
    expect(String(upload.file_uploads[0].file)).toContain('## Where we are (TL;DR)');
  });

  it("'link' posts the knowledge-base URL when the thread is published", async () => {
    seedSynthesizedThread(store);
    store.exportLog().recordSuccess({
      surface: GITHUB_EGRESS_SURFACE,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      targetPath: 'threads/proj-ga4/2026-08/thread.md',
      targetUrl: GITHUB_URL,
      contentHash: 'hash-1',
    });
    const { slack, postMessage, filesUploadV2 } = makeSlackStub();

    const result = await runMiniogDossierWorkflow({ task: makeHandoffTask('link'), slack, store, config });

    expect(result.status).toBe('SUCCESS');
    expect(filesUploadV2).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(callText(postMessage)).toContain(GITHUB_URL);
    expect(callText(postMessage)).toContain('GA4 realtime export lag');
  });

  it("'link' without an export row falls back to a file upload with an explanatory note", async () => {
    seedSynthesizedThread(store);
    const { slack, postMessage, filesUploadV2 } = makeSlackStub();

    const result = await runMiniogDossierWorkflow({ task: makeHandoffTask('link'), slack, store, config });

    expect(result.status).toBe('SUCCESS');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(callText(postMessage)).toContain("isn't published to the knowledge base");
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const upload = callArg(filesUploadV2) as { file_uploads: Array<{ filename: string }> };
    expect(upload.file_uploads[0].filename).toMatch(/\.md$/);
  });

  it('returns FAILED and posts an error reply when delivery throws', async () => {
    seedSynthesizedThread(store);
    const { slack, postMessage, filesUploadV2 } = makeSlackStub();
    filesUploadV2.mockRejectedValueOnce(new Error('upload exploded'));

    const result = await runMiniogDossierWorkflow({ task: makeHandoffTask('file'), slack, store, config });

    expect(result).toEqual({
      workflow: 'MINIOG_DOSSIER',
      status: 'FAILED',
      message: 'Handoff delivery failed.',
      notifyDesktop: false,
      slackPosted: true,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(callText(postMessage)).toContain("Couldn't deliver the handoff");
    expect(callText(postMessage)).toContain('upload exploded');
  });
});

describe('handoffFileName', () => {
  it('combines the slugified title, date, and .md extension', () => {
    expect(handoffFileName('GA4 Realtime Export!! Lag', new Date('2026-08-21T10:00:00Z'))).toBe(
      'handoff-ga4-realtime-export-lag-2026-08-21.md',
    );
  });

  it('caps the slug at 40 chars', () => {
    const name = handoffFileName('a'.repeat(60), new Date('2026-01-05T00:00:00Z'));
    expect(name).toBe(`handoff-${'a'.repeat(40)}-2026-01-05.md`);
  });
});
