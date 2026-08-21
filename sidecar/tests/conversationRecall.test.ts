import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import {
  assembleConversationRecall,
  CONVERSATION_RECALL_BEGIN,
  CONVERSATION_RECALL_END,
} from '../src/conversation/conversationRecall.js';
import { assembleRecall } from '../src/codex/recallAssembler.js';
import type { CapturedMessage } from '../src/state/conversationStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-convrecall-')), 'watchtower.db');
}

// Realistic recent Slack epochs — recency decay in searchMessages compares against real now.
const NOW_EPOCH = Math.floor(Date.now() / 1000);

function slackTs(secondsAgo: number): string {
  return `${NOW_EPOCH - secondsAgo}.000100`;
}

interface SeedInput {
  channelId: string;
  threadTs: string;
  channelName?: string;
  visibility?: 'org' | 'private';
  messages: CapturedMessage[];
  synthesis?: { title: string; summary: string; decisions: string[]; actionItems?: string[] };
}

function seedThread(store: JobStore, input: SeedInput): number {
  const result = store.conversationStore().recordMessages({
    channelId: input.channelId,
    threadTs: input.threadTs,
    channelType: 'channel',
    channelName: input.channelName,
    // Store default is now fail-closed 'private'; seeds are public unless the
    // test says otherwise.
    visibility: input.visibility ?? 'org',
    messages: input.messages,
  });
  if ('skipped' in result) throw new Error('seed thread unexpectedly hit a forgotten tombstone');
  if (input.synthesis) {
    store.conversationStore().saveSynthesis(result.threadId, {
      title: input.synthesis.title,
      summary: input.synthesis.summary,
      decisions: input.synthesis.decisions,
      actionItems: input.synthesis.actionItems ?? [],
      messageCount: input.messages.length,
    });
  }
  return result.threadId;
}

function human(messageTs: string, text: string, displayName = 'Dipesh', userId = 'U1'): CapturedMessage {
  return { messageTs, userId, displayName, isBot: false, text };
}

function bot(messageTs: string, text: string): CapturedMessage {
  return { messageTs, userId: 'BMINIOG', displayName: 'watchtower-bot', isBot: true, text };
}

describe('assembleConversationRecall', () => {
  let store: JobStore;

  beforeEach(() => {
    store = new JobStore(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  it('returns the empty result on an empty store', () => {
    const out = assembleConversationRecall({ query: 'vitest sidecar rollout', store });
    expect(out).toEqual({ promptBlock: '', body: '', estimatedTokens: 0, threadsMatched: 0 });
  });

  it('returns the empty result when nothing matches the query', () => {
    seedThread(store, {
      channelId: 'C100',
      threadTs: slackTs(7200),
      channelName: 'random',
      messages: [human(slackTs(7200), 'lunch menu updates for friday')],
      synthesis: { title: 'Lunch menu', summary: 'Friday menu chosen.', decisions: [] },
    });

    const out = assembleConversationRecall({ query: 'kubernetes ingress certificates', store });
    expect(out.promptBlock).toBe('');
    expect(out.body).toBe('');
    expect(out.threadsMatched).toBe(0);
  });

  it('renders a framed block: title, #channel, date, human participants, summary, decisions, snippets, slack ref', () => {
    const threadTs = slackTs(7200);
    seedThread(store, {
      channelId: 'C123',
      threadTs,
      channelName: 'eng-infra',
      messages: [
        human(threadTs, 'vitest rollout for the sidecar is blocked on flaky sockets'),
        bot(slackTs(7100), 'vitest rollout unblocked after pinning the socket dependency'),
      ],
      synthesis: {
        title: 'Vitest rollout',
        summary: 'Team agreed to roll out vitest across the sidecar test suites.',
        decisions: ['Pin vitest to 2.x', 'Migrate jobStore tests first'],
      },
    });

    const out = assembleConversationRecall({ query: 'what did we decide about the vitest rollout', store });

    expect(out.threadsMatched).toBe(1);
    expect(out.estimatedTokens).toBeGreaterThan(0);
    expect(out.promptBlock.startsWith(CONVERSATION_RECALL_BEGIN)).toBe(true);
    expect(out.promptBlock.endsWith(CONVERSATION_RECALL_END)).toBe(true);
    expect(out.promptBlock).toContain(out.body);

    // Header line: title — #channel, date (from last activity), with <humans only>.
    const expectedDate = new Date((NOW_EPOCH - 7100) * 1000).toISOString().slice(0, 10);
    expect(out.body).toContain(`• Vitest rollout — #eng-infra, ${expectedDate}, with Dipesh`);

    expect(out.body).toContain('Summary: Team agreed to roll out vitest across the sidecar test suites.');
    expect(out.body).toContain('Decision: Pin vitest to 2.x');
    expect(out.body).toContain('Decision: Migrate jobStore tests first');

    // Snippets carry speaker names; the bot is always labeled miniOG, never by its display name.
    expect(out.body).toMatch(/ Dipesh: .*vitest/);
    expect(out.body).toMatch(/ miniOG: .*vitest/);
    expect(out.body).not.toContain('watchtower-bot');

    expect(out.body).toContain(`Slack ref: channel C123, thread ${threadTs}`);
  });

  it('excludeThread removes the thread the query came from', () => {
    const threadTs = slackTs(7200);
    seedThread(store, {
      channelId: 'C200',
      threadTs,
      channelName: 'deploys',
      messages: [human(threadTs, 'deploy freeze starts monday for the billing release')],
      synthesis: { title: 'Deploy freeze', summary: 'Freeze agreed for billing release.', decisions: [] },
    });

    const included = assembleConversationRecall({ query: 'deploy freeze billing', store });
    expect(included.threadsMatched).toBe(1);

    const excluded = assembleConversationRecall({
      query: 'deploy freeze billing',
      store,
      excludeThread: { channelId: 'C200', threadTs },
    });
    expect(excluded.threadsMatched).toBe(0);
    expect(excluded.promptBlock).toBe('');
  });

  it('surfaces private-channel threads only when the query originates in that channel', () => {
    const threadTs = slackTs(7200);
    seedThread(store, {
      channelId: 'CPRIV',
      threadTs,
      channelName: 'secret-launch',
      visibility: 'private',
      messages: [human(threadTs, 'moonshot pricing tiers locked for the beta cohort')],
      synthesis: { title: 'Moonshot pricing', summary: 'Pricing tiers locked.', decisions: ['Lock beta pricing'] },
    });

    const crossChannel = assembleConversationRecall({ query: 'moonshot pricing tiers', store, channelId: 'COTHER' });
    expect(crossChannel.threadsMatched).toBe(0);

    const noChannel = assembleConversationRecall({ query: 'moonshot pricing tiers', store });
    expect(noChannel.threadsMatched).toBe(0);

    const sameChannel = assembleConversationRecall({ query: 'moonshot pricing tiers', store, channelId: 'CPRIV' });
    expect(sameChannel.threadsMatched).toBe(1);
    expect(sameChannel.body).toContain('#secret-launch');
  });

  it('clips to the token budget but always includes at least one thread', () => {
    const longSummary = 'gateway incident retro covering the timeline, paging gaps, and follow-ups in detail. '.repeat(
      8,
    );
    for (let i = 0; i < 3; i++) {
      seedThread(store, {
        channelId: `C30${i}`,
        threadTs: slackTs(7200 + i * 600),
        channelName: `retro-${i}`,
        messages: [human(slackTs(7200 + i * 600), `postmortem review for gateway incident ${i}`)],
        synthesis: { title: `Gateway incident ${i}`, summary: longSummary, decisions: ['Add gateway alerts'] },
      });
    }

    const unclipped = assembleConversationRecall({ query: 'gateway incident postmortem', store });
    expect(unclipped.threadsMatched).toBe(3);

    const clipped = assembleConversationRecall({ query: 'gateway incident postmortem', store, tokenBudget: 120 });
    expect(clipped.threadsMatched).toBeGreaterThanOrEqual(1);
    expect(clipped.threadsMatched).toBeLessThan(3);
    expect(clipped.promptBlock).toContain(CONVERSATION_RECALL_BEGIN);
  });
});

describe('assembleRecall — conversations source integration', () => {
  let store: JobStore;

  beforeEach(() => {
    store = new JobStore(tempDbPath());
  });

  afterEach(() => {
    store.close();
  });

  function seedSentryThread(): void {
    const threadTs = slackTs(7200);
    seedThread(store, {
      channelId: 'C123',
      threadTs,
      channelName: 'eng-infra',
      messages: [human(threadTs, 'sentry quota exhausted during the miniog launch window')],
      synthesis: {
        title: 'Sentry quota',
        summary: 'Quota exhausted; limit raised.',
        decisions: ['Raise sentry quota'],
      },
    });
  }

  it('includes conversations for a matching query even when the user has no dossier', async () => {
    seedSentryThread();

    const out = await assembleRecall({
      userId: 'UNOBODY',
      workflow: 'INFORMATIONAL',
      store,
      query: 'sentry quota exhausted',
      channelId: 'C123',
    });

    // No dossier, memories, signals, vault, or pinned facts — conversations alone survives.
    expect(out.sources).toEqual(['conversations']);
    expect(out.promptBlock).toContain('Related past conversations');
    expect(out.promptBlock).toContain('Sentry quota');
    expect(out.estimatedTokens).toBeGreaterThan(0);
  });

  it('never includes conversations when no query is passed', async () => {
    seedSentryThread();

    const out = await assembleRecall({ userId: 'UNOBODY', workflow: 'INFORMATIONAL', store });

    expect(out.sources).not.toContain('conversations');
    expect(out.sources).toEqual([]);
    expect(out.promptBlock).toBe('');
  });
});
