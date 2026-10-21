import { describe, expect, it } from 'vitest';
import {
  containsMetabaseUrl,
  detectMention,
  extractPrContext,
  isBarePrPaste,
  leadingDeployTarget,
  isPrReviewRequest,
  isReferenceMention,
  normalizeTask,
} from '../src/router/intentParser.js';
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

  it('routes "test this PR <url>" to WEBAPP_QA, beating the PR_REVIEW gate, with prContext set', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> test this PR https://github.com/Newton-School/newton-web/pull/123',
      },
      config,
      [],
    );

    // The QA-on-PR gate runs before isPrReviewRequest so a "test this PR"
    // ask drives a browser instead of a code review; prContext still resolves
    // so runWebappQa can check out the PR downstream.
    expect(task.intent).toBe('WEBAPP_QA');
    expect(task.prContext?.number).toBe(123);
  });

  it('keeps "review this PR <url>" on PR_REVIEW (QA gate must not steal it)', () => {
    const task = normalizeTask(
      {
        ...baseEvent,
        text: '<@UBOT1> review this PR https://github.com/Newton-School/newton-web/pull/123',
      },
      config,
      [],
    );
    expect(task.intent).toBe('PR_REVIEW');
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

describe('the review gate fires only on its explicit forms (issue #447)', () => {
  const PR = 'https://github.com/Newton-School/newton-api/pull/6436';
  const slackPr = `<${PR}|github.com/Newton-School/newton-api/pull/6436>`;
  const seed = (text: string, userId = 'U123') => normalizeTask({ ...baseEvent, userId, text }, config, []).intent;

  it('still fires on a review verb with the PR link', () => {
    expect(seed(`<@UBOT1> review ${PR}`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> please re-review ${slackPr}`)).toBe('PR_REVIEW');
  });

  it('fires on a review verb before a link in the form Slack delivers it', () => {
    // Slack wraps every link: <url> or <url|label>. This is what a real "review <PR>" looks like.
    expect(seed(`<@UBOT1> review <${PR}>`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> please review ${slackPr}`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> can you review <${PR}/changes> when you get a minute`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> review <${PR}> *Sent using* <@UCLAUDE>`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> review <${PR}>`, 'UOWNER1')).toBe('PR_REVIEW');
  });

  it('does not take a noun "review" beside a Slack link for a request', () => {
    expect(seed(`<@UBOT1> thanks for the review on ${slackPr}, is it live?`)).toBe('IMPLEMENTATION');
  });

  it('still fires on a bare paste: nothing but mentions and PR links', () => {
    expect(seed(`<@UBOT1> ${PR}`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> <@U999> ${slackPr}, ${PR}/changes`)).toBe('PR_REVIEW');
    // The footer Slack adds when a person sends through the Claude app is not words about the PR.
    expect(seed(`<@UBOT1> ${slackPr} *Sent using* <@UCLAUDE>`)).toBe('PR_REVIEW');
  });

  it('leaves a question that merely contains a PR link to the router', () => {
    // The incident: four questions about a merged PR got a 13-comment review.
    expect(
      seed(`<@UBOT1> Follow-up on the reminders. The devs implemented it in PR #6436 (${PR}). Is it deployed?`),
    ).toBe('IMPLEMENTATION');
    expect(seed(`<@UBOT1> is ${slackPr} live yet?`)).toBe('IMPLEMENTATION');
    expect(seed(`<@UBOT1> what does ${PR} change`, 'UOWNER1')).toBe('OWNER_AUTOPILOT');
  });

  it('leaves a PR link with a description and no review ask to the router', () => {
    expect(seed(`<@UBOT1> NS-14362: keep company playlists usable ${slackPr}`)).toBe('IMPLEMENTATION');
  });

  it('leaves the thread-URL tier as it was', () => {
    const intent = normalizeTask({ ...baseEvent, userId: 'U123', text: '<@UBOT1> review the frontend PR' }, config, [
      PR,
    ]).intent;
    expect(intent).toBe('PR_REVIEW');
  });

  it('is the only form of the gate: "no change verb" beside a PR link is not a review ask', () => {
    expect(isPrReviewRequest(`is ${PR} live yet?`)).toBe(false);
    expect(isPrReviewRequest(`review ${PR}`)).toBe(true);
  });
});

describe('isBarePrPaste', () => {
  const PR = 'https://github.com/Newton-School/newton-web/pull/9';

  it('accepts mentions, PR links in either Slack form, and punctuation between them', () => {
    expect(isBarePrPaste(`<@UBOT1> ${PR}`)).toBe(true);
    expect(isBarePrPaste(`<@UBOT1> <!subteam^S02|@core-dev> <${PR}|newton-web#9> • <${PR}/files>`)).toBe(true);
    expect(isBarePrPaste(`${PR}?diff=split#discussion_r1`)).toBe(true);
  });

  it('rejects any words around the link, and a message with no PR link', () => {
    expect(isBarePrPaste(`<@UBOT1> ${PR} thoughts?`)).toBe(false);
    expect(isBarePrPaste(`<@UBOT1> pls ${PR}`)).toBe(false);
    expect(isBarePrPaste('<@UBOT1>')).toBe(false);
    expect(isBarePrPaste('<@UBOT1> https://github.com/Newton-School/newton-web/issues/9')).toBe(false);
  });
});

describe('a mention made in passing (issue #448)', () => {
  const PR = 'https://github.com/Newton-School/newton-web/pull/9330';
  const isReference = (text: string) => isReferenceMention(text, 'UBOT1');

  it('recognises a possessive, a cue word, and a message that opens with someone else', () => {
    // The incident: written to the owner, about miniOG's review.
    expect(isReference("<@UOWNER1> - I've resolved <@UBOT1>'s comments can u pls take a look on priority?")).toBe(true);
    expect(isReference('resolved <@UBOT1>’s comments')).toBe(true);
    expect(isReference('cc: <@UBOT1>')).toBe(true);
    expect(isReference('done. cc <@U999>, <@U998> and <@UBOT1>')).toBe(true);
    expect(isReference('this was flagged by <@UBOT1> yesterday')).toBe(true);
    expect(isReference('the comments from <@UBOT1> are addressed')).toBe(true);
    expect(isReference('as <@UBOT1> said above, the query is fine')).toBe(true);
    expect(isReference('FYI <@UBOT1>')).toBe(true);
    expect(isReference('<!subteam^S02HXP05ZNJ> please check what <@UBOT1> posted')).toBe(true);
  });

  it('leaves a message addressed to the bot alone', () => {
    expect(isReference('<@UBOT1> review this PR')).toBe(false);
    expect(isReference('hey <@UBOT1> can you check the build?')).toBe(false);
    expect(isReference('<@UBOT1> cc <@U999> please fix the redirect')).toBe(false);
    expect(isReference("<@UBOT1> what did <@UBOT1>'s last review say?")).toBe(false);
    expect(isReference('standby <@UBOT1> fix it')).toBe(false);
    expect(isReference('no bot here')).toBe(false);
  });

  it('is reported by detectMention as a bot mention that is a reference, never in a DM', () => {
    expect(detectMention('cc: <@UBOT1>', config)).toEqual({ detected: true, type: 'bot', reference: true });
    expect(detectMention('<@UBOT1> review this', config)).toEqual({ detected: true, type: 'bot' });
    expect(detectMention('cc: <@UBOT1>', config, 'im')).toEqual({ detected: true, type: 'bot' });
  });

  it('is carried on the task', () => {
    const reference = normalizeTask({ ...baseEvent, userId: 'U123', text: 'cc: <@UBOT1>' }, config);
    expect(reference).toMatchObject({ mentionDetected: true, mentionType: 'bot', mentionReference: true });
    const direct = normalizeTask({ ...baseEvent, userId: 'U123', text: '<@UBOT1> hi' }, config);
    expect(direct).not.toHaveProperty('mentionReference');
  });

  it('fires no keyword gate: the router reads it first', () => {
    const text = `<@UOWNER1> I've resolved <@UBOT1>'s comments, please review ${PR}`;

    expect(normalizeTask({ ...baseEvent, userId: 'U123', text }, config, []).intent).toBe('IMPLEMENTATION');
  });

  it('never seeds a deploy from keywords (issue #428)', () => {
    const seed = (text: string) => normalizeTask({ ...baseEvent, userId: 'U123', text }, config, []).intent;

    // The router reads it first, and code checks its answer: the keywords are only a hint.
    expect(seed('<@UBOT1> deploy newton-web to production')).toBe('IMPLEMENTATION');
    expect(seed('<@UOWNER1> can you deploy newton-web to production? cc <@UBOT1>')).toBe('IMPLEMENTATION');
    expect(seed('<@UBOT1> ship prod')).toBe('IMPLEMENTATION');
  });
});

describe('leadingDeployTarget (issue #428)', () => {
  it('finds the target when the message leads with the deploy ask', () => {
    expect(leadingDeployTarget('<@UBOT1> deploy newton-web to production')).toBe('newton-web');
    expect(leadingDeployTarget('<@UBOT1> can you please ship the marketing site to prod? thanks')).toBe(
      'newton-marketing-web',
    );
    expect(leadingDeployTarget('<@UBOT1> deploy to prod')).toBe('newton-web');
  });

  it('finds none when the deploy words come after something else was asked', () => {
    // The message that started the production deploy workflow on 2026-10-02.
    expect(
      leadingDeployTarget(
        '<@UBOT1> could you review these two please? • newton-web <https://github.com/Newton-School/newton-web/pull/9276|#9276> *Deploy order:* #9276 → web',
      ),
    ).toBeNull();
    expect(leadingDeployTarget('<@UBOT1> what changed in newton-web?\nwe deploy to prod on Friday')).toBeNull();
  });

  it('finds none where there is no deploy target at all', () => {
    expect(leadingDeployTarget('<@UBOT1> ship it')).toBeNull();
    expect(leadingDeployTarget('<@UBOT1> review https://github.com/Newton-School/newton-web/pull/1')).toBeNull();
  });
});

describe('review asks that tag the owner (issue #430)', () => {
  const PR = 'https://github.com/Newton-School/newton-web/pull/9210';
  const link = `<${PR}|github.com/Newton-School/newton-web/pull/9210>`;
  const CORE_DEV = '<!subteam^S02HXP05ZNJ>';
  const seed = (text: string, threadTexts: string[] = []) =>
    normalizeTask({ ...baseEvent, userId: 'U123', text }, config, threadTexts).intent;

  it('seeds a review for the sentences that were reviewed, sent to the change pipeline or ignored at random', () => {
    expect(seed(`${CORE_DEV} <@UOWNER1> Please review, approve, merge. ${link}`)).toBe('PR_REVIEW');
    expect(seed(`${CORE_DEV} <@UOWNER1> Please review and merge ${link}`)).toBe('PR_REVIEW');
    expect(seed(`${CORE_DEV} <@UOWNER1> please review ${link}`)).toBe('PR_REVIEW');
    expect(seed(`<@UOWNER1> could you please review and merge this PR ? ${link}`)).toBe('PR_REVIEW');
  });

  it('seeds a review for a bare PR post: nothing but tags and links', () => {
    expect(seed(`${CORE_DEV} <@UOWNER1> ${link}`)).toBe('PR_REVIEW');
  });

  it('leaves everything else that tags the owner to the router', () => {
    // A link with its ticket title, a question about a PR, a merge ask with no review in it.
    expect(seed(`${CORE_DEV} <@UOWNER1> NS-14362: Map playlists to company ${link}`)).toBe('UNKNOWN');
    expect(seed(`<@UOWNER1> is ${link} live yet?`)).toBe('UNKNOWN');
    expect(seed(`<@UOWNER1> please merge on priority ${link}`)).toBe('UNKNOWN');
    // The link has to be in the message itself: no thread tier for a message written to a person.
    expect(seed('<@UOWNER1> please review', [PR])).toBe('UNKNOWN');
  });

  it('counts "review and merge" as a review ask for a direct mention too', () => {
    expect(seed(`<@UBOT1> review and merge ${link}`)).toBe('PR_REVIEW');
    expect(seed(`<@UBOT1> please review & approve <${PR}>`)).toBe('PR_REVIEW');
  });
});

describe('the line miniOG offers for deferred PRs routes as a review (issue #442)', () => {
  const thread = [9155, 9156, 9157, 9158, 9159, 9160].map(n => `https://github.com/Newton-School/newton-web/pull/${n}`);

  it('by the thread tier of the review gate', () => {
    const task = normalizeTask(
      { ...baseEvent, userId: 'U123', text: '<@UBOT1> review #9158 #9159 #9160' },
      config,
      thread,
    );

    expect(task.intent).toBe('PR_REVIEW');
  });
});

describe('mentionsStagingNotProd', () => {
  it('reads any staging mention without a prod word as staging, however it is phrased', async () => {
    const { mentionsStagingNotProd } = await import('../src/router/intentParser.js');
    for (const text of [
      '<@UBOT1> deploy marketing to staging',
      '<@UBOT1> deploy the marketing site to stg',
      '<@UBOT1> deploy marketing staging',
      '<@UBOT1> deploy marketing in staging',
      '<@UBOT1> deploy marketing (staging)',
      '<@UBOT1> deploy marketing. staging only',
      '<@UBOT1> deploy marketing branch fix/hero-v2.1 to staging',
      '<@UBOT1> deploy the marketing hero banner fix from PR 123 to staging',
      '<@UBOT1> deploy marketing &amp; blog changes to staging',
      '<@UBOT1> can you do a staging deploy of the marketing site',
      // Staging as context counts too: the cost is a re-ask that says prod.
      '<@UBOT1> deploy marketing, it looks good on staging',
    ]) {
      expect(mentionsStagingNotProd(text), text).toBe(true);
    }
  });

  it('does not read a prod ask, the word "stage", or words inside links and channel names as staging', async () => {
    const { mentionsStagingNotProd } = await import('../src/router/intentParser.js');
    for (const text of [
      '<@UBOT1> deploy marketing to prod, it was fine on staging',
      '<@UBOT1> deploy marketing to production',
      '<@UBOT1> ship marketing, last stage of the launch',
      '<@UBOT1> deploy marketing — checked <http://staging-marketing-web.newtonschool.co|staging-marketing-web.newtonschool.co>, looks good',
      '<@UBOT1> deploy marketing, see https://staging-marketing-web.newtonschool.co/x',
      '<@UBOT1> deploy marketing, details in <#C123|staging-notes>',
    ]) {
      expect(mentionsStagingNotProd(text), text).toBe(false);
    }
  });
});

describe('isMarketingStagingDeployAsk', () => {
  it('reads a message that is only an ask to deploy marketing to staging', async () => {
    const { isMarketingStagingDeployAsk } = await import('../src/router/intentParser.js');
    for (const text of [
      '<@UBOT1> deploy marketing to staging',
      '<@UBOT1> deploy marketing to staging *Sent using* <@UCLAUDE|Claude> [theOG <someone@example.com>]',
      '<@UBOT1> please deploy the marketing site to stg',
      '<@UBOT1> can you deploy marketing staging?',
      '<@UBOT1> deploy marketing branch fix/hero-v2.1 to staging',
      '<@UBOT1> deploy my branch fix/hero to marketing staging',
      '<@UBOT1> push my branch onto marketing staging please',
    ]) {
      expect(isMarketingStagingDeployAsk(text), text).toBe(true);
    }
  });

  it('leaves anything more than that to the router: reports, questions, second asks, prod, other repos', async () => {
    const { isMarketingStagingDeployAsk } = await import('../src/router/intentParser.js');
    for (const text of [
      '<@UBOT1> deploy marketing to staging failed, can you check why?',
      '<@UBOT1> deploy to marketing staging is stuck since morning',
      '<@UBOT1> deploy marketing to staging? why does it keep failing',
      '<@UBOT1> release notes for marketing staging?',
      '<@UBOT1> deploy marketing to staging and test the hero banner on mobile',
      '<@UBOT1> deploy marketing to staging and open a PR',
      '<@UBOT1> deploy marketing to staging\n\nalso the footer links 404 on /about, please look',
      '<@UBOT1> fix the hero typo and deploy it to marketing staging',
      '<@UBOT1> ship newton-marketing-web to staging so the PM can check it',
      '<@UBOT1> how do I deploy marketing to staging?',
      '<@UBOT1> deploy the cloudflare worker to staging',
      '<@UBOT1> deploy marketing to prod',
      '<@UBOT1> deploy newton-web to staging',
      '<@UBOT1> deploy to staging',
      '<@UBOT1> deploy marketing',
    ]) {
      expect(isMarketingStagingDeployAsk(text), text).toBe(false);
    }
  });
});

describe('namesStagingAsTarget', () => {
  it('reads staging named as where the deploy goes', async () => {
    const { namesStagingAsTarget } = await import('../src/router/intentParser.js');
    for (const text of [
      '<@UBOT1> deploy newton-web to staging',
      '<@UBOT1> deploy my branch to the marketing staging',
      '<@UBOT1> push it onto stg',
      '<@UBOT1> can you do a staging deploy of newton-web',
    ]) {
      expect(namesStagingAsTarget(text), text).toBe(true);
    }
  });

  it('does not read staging as context, prod asks, or words inside links', async () => {
    const { namesStagingAsTarget } = await import('../src/router/intentParser.js');
    for (const text of [
      '<@UBOT1> deploy newton-web, it has been on staging all week',
      '<@UBOT1> deploy newton-web to prod, it was fine on staging',
      '<@UBOT1> deploy newton-web — see <https://example.com/x|moved to staging>',
    ]) {
      expect(namesStagingAsTarget(text), text).toBe(false);
    }
  });
});
