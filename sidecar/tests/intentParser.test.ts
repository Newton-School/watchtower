import { describe, expect, it } from 'vitest';
import { containsMetabaseUrl, detectMention, extractPrContext, normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

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

const baseEvent: SlackEventEnvelope = {
  eventId: 'Ev1',
  channelId: 'C01H25RNLJH',
  threadTs: '123.45',
  eventTs: '123.45',
  userId: 'U123',
  text: '',
  rawEvent: {},
};

describe('intentParser', () => {
  it('detects bot and owner mentions', () => {
    expect(detectMention('ping <@UBOT1>', config)).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('ping <@UOWNER1>', config)).toEqual({ detected: true, type: 'owner' });
    expect(detectMention('no mention', config)).toEqual({ detected: false, type: 'none' });
  });

  it('treats direct-message text as implicit bot mention', () => {
    expect(detectMention('can you do this?', config, 'im')).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('', config, 'im')).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('can you do this?', config, 'channel')).toEqual({ detected: false, type: 'none' });
  });

  it('extracts PR context from text', () => {
    const result = extractPrContext(['https://github.com/Newton-School/newton-web/pull/123']);
    expect(result?.owner).toBe('Newton-School');
    expect(result?.repo).toBe('newton-web');
    expect(result?.number).toBe(123);
  });

  it('routes review-verb + PR URL deterministically to PR_REVIEW (no classifier dependency)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> please review this PR https://github.com/Newton-School/newton-web/pull/123',
      },
      config,
      [],
    );

    // Deterministic gate (issue #334 bug B): a message carrying both the
    // review verb and the PR URL must never depend on the AI classifier CLI.
    expect(task.intent).toBe('PR_REVIEW');
    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.prContext?.repo).toBe('newton-web');
  });

  it('routes any bot-mentioned bug request from a non-owner to implementation', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(task.intent).toBe('IMPLEMENTATION');

    const otherChannel = normalizeTask(
      {
        ...baseEvent,
        channelId: 'COTHER',
        text: '<@UBOT1> fix this bug please',
      },
      config,
      [],
    );

    expect(otherChannel.intent).toBe('IMPLEMENTATION');
  });

  it('routes "review <url>" to PR_REVIEW deterministically in any channel', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        channelId: 'CANY123',
        text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/22',
      },
      config,
      [],
    );

    expect(task.intent).toBe('PR_REVIEW');
    expect(task.mentionDetected).toBe(true);
    expect(task.prContext?.number).toBe(22);
  });

  it('routes owner-authored bot mention to owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> fix this quickly and push',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes owner-authored DM to owner-autopilot without explicit mention markup', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        channelId: 'D12345',
        channelType: 'im',
        userId: 'UOWNER1',
        text: 'create a folder for me',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.mentionType).toBe('bot');
    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes explicit wt commands to dev-assist workflow', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> wt help',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('routes natural-language capability queries to dev-assist workflow', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> what did you learn?',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('keeps owner-autopilot routing for owner chatter that is not an alias', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> this queue is cursed today',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes prefixed unknown wt command to dev-assist instead of owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> wt policy import frontend',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('routes bare PR mention without review context to owner-autopilot', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> can you give me the PR link',
      },
      config,
      [],
    );

    expect(task.intent).toBe('OWNER_AUTOPILOT');
  });

  it('routes a bare PR URL paste to PR_REVIEW (implicit review ask, no conflicting verb)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> https://github.com/Newton-School/newton-web/pull/99',
      },
      config,
      [],
    );

    expect(task.intent).toBe('PR_REVIEW');
    expect(task.prContext?.number).toBe(99);
  });

  it('keeps PR-URL messages with change verbs on IMPLEMENTATION (AI refines in router)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> fix the failing checks on https://github.com/Newton-School/newton-web/pull/99',
      },
      config,
      [],
    );

    expect(task.intent).toBe('IMPLEMENTATION');
    expect(task.prContext?.number).toBe(99);
  });

  it('routes "review the frontend PR" to PR_REVIEW when the PR URLs live in the thread (incident shape)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> review the frontend PR and comment the findings directly in the PR.',
      },
      config,
      [
        'backend : https://github.com/Newton-School/newton-api/pull/5781\nfrontend : https://github.com/Newton-School/newton-web/pull/8652',
      ],
    );

    expect(task.intent).toBe('PR_REVIEW');
    expect(task.prContexts).toHaveLength(2);
    expect(task.prContexts?.every(t => t.source === 'thread')).toBe(true);
  });

  it('does not fire the review gate on review-verb messages with no PR anywhere', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> review my approach for the new caching layer',
      },
      config,
      ['just chatting', 'no links here'],
    );

    expect(task.intent).toBe('IMPLEMENTATION');
  });

  it('does not fire the review gate on mixed review+change asks with only thread URLs', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> review and fix the spacing bug',
      },
      config,
      ['https://github.com/Newton-School/newton-web/pull/8652'],
    );

    expect(task.intent).toBe('IMPLEMENTATION');
  });

  it('routes owner review asks to PR_REVIEW too (gate precedes OWNER_AUTOPILOT seeding)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/22',
      },
      config,
      [],
    );

    expect(task.intent).toBe('PR_REVIEW');
    expect(task.isOwnerAuthor).toBe(true);
  });

  it('does not fire the review gate on a noun "review" in banter even with a thread PR URL (RCA 2026-06-12)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> - <@U05EUC842KD> is undermining ur review - can u let that happen?',
      },
      config,
      ['https://github.com/Newton-School/newton-web/pull/8664'],
    );

    // Noun "review" must defer to the AI classifier (which calls this CONVERSATIONAL),
    // not hard-route to PR_REVIEW. The pre-classifier seed for a non-owner is IMPLEMENTATION.
    expect(task.intent).toBe('IMPLEMENTATION');
  });

  it.each([
    'thanks for the review',
    'great review',
    'ur thoughts on his review',
    "what's your review of this comment?",
    'the review process is slow',
  ])('does not fire the review gate on noun usage: "%s"', phrase => {
    const task = normalizeTask({ ...baseEvent, text: `<@UBOT1> ${phrase}` }, config, [
      'https://github.com/Newton-School/newton-web/pull/8652',
    ]);

    expect(task.intent).toBe('IMPLEMENTATION');
  });

  it.each(['pls review', 'can you review the PR', 'review again'])(
    'still fires the review gate on an imperative request: "%s"',
    phrase => {
      const task = normalizeTask({ ...baseEvent, text: `<@UBOT1> ${phrase}` }, config, [
        'https://github.com/Newton-School/newton-web/pull/8652',
      ]);

      expect(task.intent).toBe('PR_REVIEW');
    },
  );

  it('still fires on "re-review <url>" (Tier 1)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> re-review https://github.com/Newton-School/newton-web/pull/8652',
      },
      config,
      [],
    );

    expect(task.intent).toBe('PR_REVIEW');
  });

  it('defaults non-owner bot mentions to IMPLEMENTATION (no owner-implying label)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'URANDOM',
        text: '<@UBOT1> can you look into this?',
      },
      config,
      [],
    );

    expect(task.intent).toBe('IMPLEMENTATION');
    expect(task.isOwnerAuthor).toBe(false);
  });

  it('defaults owner bot mentions to OWNER_AUTOPILOT (preserves owner-only relaxed prompt path)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '<@UBOT1> ship it',
      },
      config,
      [],
    );

    expect(task.intent).toBe('OWNER_AUTOPILOT');
    expect(task.isOwnerAuthor).toBe(true);
  });

  it('routes numbered wt command from owner to dev-assist', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        userId: 'UOWNER1',
        text: '1. <@UBOT1> wt policy import frontend',
      },
      config,
      [],
    );

    expect(task.mentionDetected).toBe(true);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.intent).toBe('DEV_ASSIST');
  });

  it('sets isCoreDevAuthor true for owners (owners are always core-dev)', () => {
    const task = normalizeTask({ ...baseEvent, userId: 'UOWNER1', text: '<@UBOT1> do something' }, config, []);
    expect(task.isOwnerAuthor).toBe(true);
    expect(task.isCoreDevAuthor).toBe(true);
  });

  it('sets isCoreDevAuthor true for core-dev non-owner users', () => {
    const coreDevConfig = {
      ...config,
      coreDevSlackUserIds: ['UOWNER1', 'UCOREDEV1'],
    };
    const task = normalizeTask({ ...baseEvent, userId: 'UCOREDEV1', text: '<@UBOT1> do something' }, coreDevConfig, []);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.isCoreDevAuthor).toBe(true);
  });

  it('sets isCoreDevAuthor false for regular users', () => {
    const task = normalizeTask({ ...baseEvent, userId: 'URANDOM', text: '<@UBOT1> do something' }, config, []);
    expect(task.isOwnerAuthor).toBe(false);
    expect(task.isCoreDevAuthor).toBe(false);
  });

  describe('Metabase URL pre-classifier', () => {
    it('containsMetabaseUrl detects self-hosted and metabase.com hostnames', () => {
      expect(containsMetabaseUrl('https://metabase-lierhfgoeiwhr.newtonschool.co/question#abc')).toBe(true);
      expect(containsMetabaseUrl('https://metabase.com/dashboard/42')).toBe(true);
      expect(containsMetabaseUrl('https://app.metabase.com/q/123')).toBe(true);
      expect(containsMetabaseUrl('https://github.com/org/repo/pull/1')).toBe(false);
      expect(containsMetabaseUrl('no url here')).toBe(false);
      expect(containsMetabaseUrl(undefined)).toBe(false);
    });

    it('seeds non-owner Metabase-URL bot mentions as INFORMATIONAL', () => {
      const task = normalizeTask(
        {
          ...baseEvent,
          text: '<@UBOT1> explain this table https://metabase-lierhfgoeiwhr.newtonschool.co/question#eyJxIjoi',
        },
        config,
        [],
      );
      expect(task.intent).toBe('INFORMATIONAL');
      expect(task.isOwnerAuthor).toBe(false);
    });

    it('keeps owner Metabase-URL bot mentions on OWNER_AUTOPILOT (owner bypasses access)', () => {
      const task = normalizeTask(
        {
          ...baseEvent,
          userId: 'UOWNER1',
          text: '<@UBOT1> what is this https://metabase-lierhfgoeiwhr.newtonschool.co/question#abc',
        },
        config,
        [],
      );
      expect(task.intent).toBe('OWNER_AUTOPILOT');
    });

    it('seeds non-owner Metabase-URL message as INFORMATIONAL even with code-change verbs (AI classifier may upgrade)', () => {
      // The router-level guardrail only holds *downward* overrides at low
      // confidence. Upward overrides (INFORMATIONAL → IMPLEMENTATION) have no
      // floor, so a genuine code-change request seeded as INFORMATIONAL can
      // still upgrade. Seeding INFORMATIONAL is therefore safe here.
      const task = normalizeTask(
        {
          ...baseEvent,
          text: '<@UBOT1> fix the bug shown in this query https://metabase.com/question/123',
        },
        config,
        [],
      );
      expect(task.intent).toBe('INFORMATIONAL');
    });

    it('non-Metabase URLs from non-owners still seed as IMPLEMENTATION', () => {
      const task = normalizeTask(
        {
          ...baseEvent,
          text: '<@UBOT1> look at https://example.com/something',
        },
        config,
        [],
      );
      expect(task.intent).toBe('IMPLEMENTATION');
    });
  });
});
