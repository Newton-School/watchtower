import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyLearning } from '../src/learning/selfLearning.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-learning-')), 'watchtower.db');
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
  allowedChannelsForBugFix: ['C01H25RNLJH'],
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

function buildTask(input: {
  text: string;
  intent?: NormalizedTask['intent'];
  userId?: string;
  channelId?: string;
  threadTs?: string;
}): NormalizedTask {
  return {
    event: {
      eventId: `Ev-${Math.random()}`,
      channelId: input.channelId ?? 'C01H25RNLJH',
      threadTs: input.threadTs ?? '111.22',
      eventTs: String(Date.now() / 1000),
      userId: input.userId ?? 'U123',
      text: input.text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: input.intent ?? 'UNKNOWN',
  };
}

describe('selfLearning', () => {
  it('learns and applies thread intent correction', () => {
    const dbPath = tempDbPath();
    const store = new JobStore(dbPath);

    store.createJob({
      id: 'job-prev',
      eventId: 'event-prev',
      dedupeKey: 'dedupe-prev',
      workflow: 'UNKNOWN',
      channelId: 'C01H25RNLJH',
      threadTs: '111.22',
      payload: {},
    });
    store.markJob('job-prev', 'SKIPPED');

    const task = buildTask({
      text: '<@UBOT1> actually review this PR again',
      intent: 'UNKNOWN',
      channelId: 'C01H25RNLJH',
      threadTs: '111.22',
      userId: 'U123',
    });

    const result = applyLearning({ task, config, store });

    expect(result.intent).toBe('PR_REVIEW');
    expect(result.correctionApplied).toBe(true);
    expect(result.notes.join(' ')).toContain('applied learned correction');

    store.close();
  });

  it('keeps reply mode normal by default', () => {
    const dbPath = tempDbPath();
    const store = new JobStore(dbPath);

    const directiveTask = buildTask({
      text: '<@UBOT1> keep replies professional in this channel',
      channelId: 'C99',
      userId: 'U777',
    });

    const directiveResult = applyLearning({ task: directiveTask, config, store });
    expect(directiveResult.personalityMode).toBe('normal');

    const nextUserTask = buildTask({
      text: '<@UBOT1> random ask',
      channelId: 'C99',
      userId: 'U222',
    });

    const nextUserResult = applyLearning({ task: nextUserTask, config, store });
    expect(nextUserResult.personalityMode).toBe('normal');

    store.close();
  });
});

describe('selfLearning with the tool-router on (issue #456)', () => {
  it('neither applies nor records a phrase correction: the router decides', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-prev',
      eventId: 'event-prev',
      dedupeKey: 'dedupe-prev',
      workflow: 'UNKNOWN',
      channelId: 'C01H25RNLJH',
      threadTs: '111.22',
      payload: {},
    });
    store.markJob('job-prev', 'SKIPPED');
    const task = () => buildTask({ text: '<@UBOT1> actually review this PR again', intent: 'UNKNOWN' });

    store.setState('tool_router_mode', 'on');
    const skipped = applyLearning({ task: task(), config, store });
    expect(skipped).toMatchObject({ intent: 'UNKNOWN', correctionApplied: false });

    // Nothing was learned while it was on: turning it off starts from a clean slate.
    store.setState('tool_router_mode', 'legacy');
    expect(
      store.findIntentCorrection({ channelId: 'C01H25RNLJH', userId: 'U123', phraseKey: 'actually review this again' }),
    ).toBeUndefined();
    expect(applyLearning({ task: task(), config, store }).intent).toBe('PR_REVIEW');

    store.close();
  });
});
