import { describe, expect, it, vi } from 'vitest';
import {
  buildRouterPrompt,
  decideTool,
  mayDeploy,
  outcomeToLegacyIntent,
  parseRouterDecision,
  type RouterFacts,
  type RouterOutcome,
} from '../src/router/toolRouter.js';
import { buildRouterFacts, routerWouldRun } from '../src/router/routerShadow.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: () => 'claude-code',
}));

const facts: RouterFacts = {
  message: 'is this merged and deployed?',
  addressing: 'direct',
  prUrlInTrigger: true,
  prUrlInThread: false,
  hints: ['review gate matched'],
};

const decided = (tool: string, extra: Record<string, unknown> = {}): RouterOutcome => ({
  ok: true,
  decision: { tool, confidence: 0.9, reason: 'r', ...extra } as never,
  durationMs: 1,
});

describe('buildRouterPrompt', () => {
  const prompt = buildRouterPrompt(facts);

  it('offers the tools the router may name, with what each is for', () => {
    for (const tool of [
      'review_pr',
      'change_code',
      'investigate',
      'answer',
      'chat',
      'stay_silent',
      'deploy',
      'qa_webapp',
      'ask_user',
      'unsupported',
    ]) {
      expect(prompt).toContain(`- ${tool}: `);
    }
  });

  // Issue #451: "Fixed all reviews @miniOG" in a thread miniOG reviewed was read
  // as unclear (ask_user, 0.6) instead of as a request to look again.
  it('says whether miniOG already reviewed a pull request in the thread, and what that changes', () => {
    expect(prompt).toContain('You already reviewed a pull request in this thread: no');
    expect(buildRouterPrompt({ ...facts, reviewedPrInThread: true })).toContain(
      'You already reviewed a pull request in this thread: yes',
    );
    expect(prompt).toContain('a message saying your review comments are fixed, addressed or resolved');
  });

  it('does not offer the exact-syntax tools', () => {
    expect(prompt).not.toContain('- dev_assist:');
    expect(prompt).not.toContain('- dossier:');
  });

  it('carries the rules the misroutes came from', () => {
    expect(prompt).toContain('A link is not a request');
    expect(prompt).toContain('deploy only when this message itself tells you to deploy');
    // "deploy marketing to staging" once went to change_code and got a clarifying question.
    expect(prompt).toContain('asks only for a staging deploy is answer, not deploy or change_code');
    expect(prompt).toContain('A staging deploy asked for together with a change, a fix or a merge is that change.');
    expect(prompt).toContain(
      'Asked of the owner instead of you, a staging deploy is for the owner to do: stay_silent.',
    );
    expect(prompt).toContain('is ask_user, not a guess');
    expect(prompt).toContain('A message addressed to you directly is never stay_silent');
  });

  it('states the facts: who was addressed, links, hints, and the message', () => {
    expect(prompt).toContain('Addressed: directly to miniOG');
    expect(prompt).toContain('Pull-request link in this message: yes');
    expect(prompt).toContain('Keyword hints (may be coincidence): review gate matched');
    expect(prompt.endsWith('Message: "is this merged and deployed?"')).toBe(true);
  });

  it('says so when the message only tags the owner', () => {
    expect(buildRouterPrompt({ ...facts, addressing: 'owner_mention', hints: [] })).toContain(
      'Addressed: to the owner or the core-dev group, not to miniOG by name',
    );
  });

  it('says so when miniOG is only tagged in passing, and allows silence there (issue #448)', () => {
    const reference = buildRouterPrompt({ ...facts, addressing: 'reference', hints: [] });
    expect(reference).toContain('Addressed: miniOG is tagged only in passing');
    expect(reference).toContain('route the message if it asks you for something');
    expect(reference).toContain('without asking anything of you, choose stay_silent');
  });

  it('carries the rules the replay of past mentions showed were missing', () => {
    // A review ask that tags the owner is work for miniOG, not people talking.
    expect(prompt).toContain('you act for the owner');
    expect(prompt).toContain('"Review and merge" and "review, approve, merge" are review_pr');
    expect(prompt).toContain('Metabase cannot be edited from here');
    expect(prompt).toContain('A question is never unsupported');
    expect(prompt).toContain("Pages on newtonschool.co are the team's own product");
  });

  it('tells the model when the message replies to its own question, and that it may then drop it', () => {
    expect(prompt).not.toContain('You asked the requester a question');
    const answering = buildRouterPrompt({
      ...facts,
      message: 'the login redirect',
      answering: { question: 'What should I check?', askedText: 'check now' },
    });
    expect(answering).toContain('Their earlier message: "check now"');
    expect(answering).toContain('Your question: "What should I check?"');
    expect(answering).toContain('choose stay_silent: here that is allowed');
    expect(answering.endsWith('Message: "the login redirect"')).toBe(true);
  });

  it('includes thread context and the requester summary only when there is one', () => {
    expect(prompt).not.toContain('Thread so far:');
    const withContext = buildRouterPrompt({
      ...facts,
      threadContext: '[U1] earlier',
      userDossierSummary: 'frontend dev',
    });
    expect(withContext).toContain('Thread so far:\n[U1] earlier');
    expect(withContext).toContain('frontend dev');
  });
});

describe('parseRouterDecision', () => {
  it('accepts a known tool and clamps the confidence', () => {
    expect(parseRouterDecision({ tool: 'answer', confidence: 1.7, reason: 'a question' })).toEqual({
      tool: 'answer',
      confidence: 1,
      reason: 'a question',
    });
  });

  it('keeps the question only for ask_user', () => {
    expect(
      parseRouterDecision({ tool: 'ask_user', confidence: 0.8, reason: 'r', question: ' Which page? ' })?.question,
    ).toBe('Which page?');
    expect(
      parseRouterDecision({ tool: 'answer', confidence: 0.8, reason: 'r', question: 'x' })?.question,
    ).toBeUndefined();
  });

  it.each([null, 'answer', {}, { tool: 'PR_REVIEW' }, { tool: 'dev_assist' }, { tool: 'merge_pr', confidence: 1 }])(
    'treats %j as no decision',
    raw => {
      expect(parseRouterDecision(raw)).toBeUndefined();
    },
  );

  it('defaults a missing confidence to the middle', () => {
    expect(parseRouterDecision({ tool: 'chat' })?.confidence).toBe(0.5);
  });
});

describe('decideTool', () => {
  const agent = (result: Record<string, unknown>) => vi.fn().mockResolvedValue(result);

  it('runs one tool-less call and returns the decision', async () => {
    const runAgent = agent({
      ok: true,
      exitCode: 0,
      parsedJson: { tool: 'answer', confidence: 0.9, reason: 'a question' },
    });
    const outcome = await decideTool({ facts, runAgent: runAgent as never });

    expect(outcome).toMatchObject({ ok: true, decision: { tool: 'answer', confidence: 0.9 } });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0]).toMatchObject({ noTools: true, timeoutMs: 45_000 });
    expect(runAgent.mock.calls[0][0].prompt).toContain('Message: "is this merged and deployed?"');
  });

  it.each([
    ['the call fails', { ok: false, exitCode: 1 }],
    ['there is no JSON', { ok: true, exitCode: 0, parsedJson: undefined }],
    ['the tool is not one it was offered', { ok: true, exitCode: 0, parsedJson: { tool: 'DEPLOY_NOW' } }],
  ])('reports failure, not a guess, when %s', async (_label, result) => {
    const outcome = await decideTool({ facts, runAgent: agent(result) as never });
    expect(outcome.ok).toBe(false);
  });

  it('says when a failed call hit the usage limit, with the reset time (issue #592)', async () => {
    const outcome = await decideTool({
      facts,
      runAgent: agent({
        ok: false,
        exitCode: 1,
        errorKind: 'USAGE_LIMIT',
        limitResetsAtText: '4:50pm (Asia/Calcutta)',
      }) as never,
    });
    expect(outcome).toMatchObject({ ok: false, usageLimit: { resetsAtText: '4:50pm (Asia/Calcutta)' } });
    const plain = await decideTool({ facts, runAgent: agent({ ok: false, exitCode: 1 }) as never });
    expect(plain).not.toHaveProperty('usageLimit');
  });

  it('reports failure when the call throws', async () => {
    const outcome = await decideTool({ facts, runAgent: vi.fn().mockRejectedValue(new Error('boom')) as never });
    expect(outcome).toMatchObject({ ok: false, error: 'Error: boom' });
  });
});

// The parity mapping: the router standing in for the classifier must be able
// to return exactly what the classifier could, and fall back exactly as it did.
describe('outcomeToLegacyIntent', () => {
  it.each([
    ['review_pr', 'PR_REVIEW'],
    ['change_code', 'IMPLEMENTATION'],
    ['investigate', 'INVESTIGATION'],
    ['answer', 'INFORMATIONAL'],
    ['chat', 'CONVERSATIONAL'],
  ])('%s runs as %s for either kind of mention', (tool, intent) => {
    expect(outcomeToLegacyIntent(decided(tool), 'direct')).toBe(intent);
    expect(outcomeToLegacyIntent(decided(tool), 'owner_mention')).toBe(intent);
  });

  it('lets an owner mention and a mention in passing be met with silence, never a direct address', () => {
    expect(outcomeToLegacyIntent(decided('stay_silent'), 'owner_mention')).toBe('NONE');
    expect(outcomeToLegacyIntent(decided('stay_silent'), 'reference')).toBe('NONE');
    expect(outcomeToLegacyIntent(decided('stay_silent'), 'direct')).toBe('INFORMATIONAL');
  });

  it('still runs what a mention in passing asks for (issue #448)', () => {
    expect(outcomeToLegacyIntent(decided('review_pr'), 'reference')).toBe('PR_REVIEW');
    expect(outcomeToLegacyIntent(decided('answer'), 'reference')).toBe('INFORMATIONAL');
  });

  it('owes a mention in passing no answer when nothing fits or the router failed', () => {
    for (const tool of ['ask_user', 'unsupported', 'deploy', 'qa_webapp']) {
      expect(outcomeToLegacyIntent(decided(tool), 'reference')).toBe('NONE');
    }
    expect(outcomeToLegacyIntent({ ok: false, error: 'x', durationMs: 1 }, 'reference')).toBe('NONE');
  });

  it.each(['ask_user', 'unsupported', 'deploy', 'qa_webapp'])(
    'falls back as an invalid classification did for %s, which the classifier could not express',
    tool => {
      expect(outcomeToLegacyIntent(decided(tool), 'direct')).toBe('INFORMATIONAL');
      expect(outcomeToLegacyIntent(decided(tool), 'owner_mention')).toBe('NONE');
    },
  );

  it('runs a deploy only where the caller says code allows it (issue #428)', () => {
    expect(outcomeToLegacyIntent(decided('deploy'), 'direct', { allowDeploy: true })).toBe('DEPLOY');
    expect(outcomeToLegacyIntent(decided('deploy'), 'direct', { allowDeploy: false })).toBe('INFORMATIONAL');
    // allowDeploy lets `deploy` through and nothing else.
    expect(outcomeToLegacyIntent(decided('answer'), 'direct', { allowDeploy: true })).toBe('INFORMATIONAL');
  });

  it('falls back the same way when the router failed', () => {
    const failed: RouterOutcome = { ok: false, error: 'x', durationMs: 1 };
    expect(outcomeToLegacyIntent(failed, 'direct')).toBe('INFORMATIONAL');
    expect(outcomeToLegacyIntent(failed, 'owner_mention')).toBe('NONE');
  });
});

describe('routerWouldRun', () => {
  it('names deploy, QA, asking and unsupported as what they are', () => {
    expect(routerWouldRun(decided('deploy'))).toBe('DEPLOY');
    expect(routerWouldRun(decided('qa_webapp'))).toBe('WEBAPP_QA');
    expect(routerWouldRun(decided('ask_user'))).toBe('ASK_USER');
    expect(routerWouldRun(decided('unsupported'))).toBe('UNSUPPORTED');
    expect(routerWouldRun({ ok: false, error: 'x', durationMs: 0 })).toBe('FAILED');
  });
});

describe('buildRouterFacts', () => {
  const task = (overrides: Record<string, unknown>) =>
    ({
      event: { eventId: 'e', channelId: 'C', threadTs: '1.1', eventTs: '1.1', userId: 'U', text: 't', rawEvent: {} },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent: 'IMPLEMENTATION',
      ...overrides,
    }) as never;

  it('carries what the job store knows about an earlier review, and only when there was one', () => {
    expect(buildRouterFacts(task({}), 'm', { reviewedPrInThread: true })).toMatchObject({ reviewedPrInThread: true });
    expect(buildRouterFacts(task({}), 'm', { reviewedPrInThread: false })).not.toHaveProperty('reviewedPrInThread');
    expect(buildRouterFacts(task({}), 'm')).not.toHaveProperty('reviewedPrInThread');
  });

  it('separates a link in the message from one earlier in the thread', () => {
    const pr = { url: 'u', owner: 'o', repo: 'r', number: 1 };
    expect(buildRouterFacts(task({ prContexts: [{ ...pr, source: 'trigger' }] }), 'm')).toMatchObject({
      prUrlInTrigger: true,
      prUrlInThread: false,
    });
    expect(buildRouterFacts(task({ prContexts: [{ ...pr, source: 'thread' }] }), 'm')).toMatchObject({
      prUrlInTrigger: false,
      prUrlInThread: true,
    });
  });

  it('marks a mention made in passing as a reference', () => {
    expect(buildRouterFacts(task({ mentionReference: true }), 'm').addressing).toBe('reference');
    // An owner mention stays an owner mention whatever else the message tags.
    expect(buildRouterFacts(task({ mentionType: 'owner', mentionReference: true }), 'm').addressing).toBe(
      'owner_mention',
    );
  });

  it('passes a gate match and the deploy keywords as hints, and marks an owner mention', () => {
    expect(buildRouterFacts(task({ intent: 'PR_REVIEW' }), 'm').hints).toEqual(['review gate matched']);
    // The deploy keywords seed nothing any more; the router is told they were there.
    const event = {
      eventId: 'e',
      channelId: 'C',
      threadTs: '1.1',
      eventTs: '1.1',
      userId: 'U',
      text: '<@UBOT1> deploy newton-web to production',
      rawEvent: {},
    };
    expect(buildRouterFacts(task({ event }), 'deploy newton-web to production').hints).toEqual([
      'deploy keywords matched',
    ]);
    expect(buildRouterFacts(task({ mentionType: 'owner' }), 'm')).toMatchObject({
      addressing: 'owner_mention',
      hints: [],
    });
  });

  it('carries the question a reply answers, and only then (issue #431)', () => {
    const clarification = { question: 'What should I check?', askedText: 'check now' };
    expect(buildRouterFacts(task({ clarification }), 'the login redirect').answering).toEqual(clarification);
    expect(buildRouterFacts(task(), 'm')).not.toHaveProperty('answering');
  });
});

describe('mayDeploy (issue #428)', () => {
  const ok = { addressing: 'direct' as const, deployTarget: 'newton-web' };

  it('needs a direct address and a target found by code', () => {
    expect(mayDeploy(ok)).toBe(true);
    expect(mayDeploy({ addressing: 'direct' })).toBe(false);
  });

  it('never deploys for an owner mention, a mention in passing, or a reply to a question', () => {
    expect(mayDeploy({ ...ok, addressing: 'owner_mention' })).toBe(false);
    expect(mayDeploy({ ...ok, addressing: 'reference' })).toBe(false);
    expect(mayDeploy({ ...ok, answering: { question: 'Which app?', askedText: 'ship it' } })).toBe(false);
  });
});

describe('buildRouterFacts and the deploy keywords (issue #428)', () => {
  const task = (text: string, intent = 'IMPLEMENTATION') =>
    ({
      event: { eventId: 'E', channelId: 'C', threadTs: '1.1', eventTs: '1.1', userId: 'U', text, rawEvent: {} },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: false,
      isCoreDevAuthor: false,
      intent,
    }) as never;

  it('finds the target in the message and passes the keyword match as a hint, with no DEPLOY seed', () => {
    const facts = buildRouterFacts(task('<@UBOT1> deploy newton-web to production'), 'deploy newton-web to production');
    expect(facts).toMatchObject({ deployTarget: 'newton-web', hints: ['deploy keywords matched'] });
  });

  it('finds no target in the message that nearly deployed, though its keywords still match', () => {
    // "newton-web" and "Deploy order" are both in the text, which is all the old gate needed.
    const text =
      '<@UBOT1> could you review these two please? • newton-web <https://github.com/Newton-School/newton-web/pull/9276|#9276> *Deploy order:* #9276 → web';
    const facts = buildRouterFacts(task(text), text);
    expect(facts).not.toHaveProperty('deployTarget');
    expect(facts.hints).toEqual(['deploy keywords matched']);
  });
});
