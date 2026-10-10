import { describe, expect, it, vi } from 'vitest';
import {
  buildRouterPrompt,
  decideTool,
  outcomeToLegacyIntent,
  parseRouterDecision,
  readToolRouterMode,
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

  it('does not offer the exact-syntax tools', () => {
    expect(prompt).not.toContain('- dev_assist:');
    expect(prompt).not.toContain('- dossier:');
  });

  it('carries the rules the misroutes came from', () => {
    expect(prompt).toContain('A link is not a request');
    expect(prompt).toContain('deploy only when this message itself tells you to deploy');
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

  it('carries the rules the replay of past mentions showed were missing', () => {
    // A review ask that tags the owner is work for miniOG, not people talking.
    expect(prompt).toContain('you act for the owner');
    expect(prompt).toContain('"Review and merge" and "review, approve, merge" are review_pr');
    expect(prompt).toContain('Metabase cannot be edited from here');
    expect(prompt).toContain('A question is never unsupported');
    expect(prompt).toContain("Pages on newtonschool.co are the team's own product");
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

  it('lets only an owner mention be met with silence', () => {
    expect(outcomeToLegacyIntent(decided('stay_silent'), 'owner_mention')).toBe('NONE');
    expect(outcomeToLegacyIntent(decided('stay_silent'), 'direct')).toBe('INFORMATIONAL');
  });

  it.each(['ask_user', 'unsupported', 'deploy', 'qa_webapp'])(
    'falls back as an invalid classification did for %s, which the classifier could not express',
    tool => {
      expect(outcomeToLegacyIntent(decided(tool), 'direct')).toBe('INFORMATIONAL');
      expect(outcomeToLegacyIntent(decided(tool), 'owner_mention')).toBe('NONE');
    },
  );

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

  it('passes a gate match as a hint and marks an owner mention', () => {
    expect(buildRouterFacts(task({ intent: 'DEPLOY' }), 'm').hints).toEqual(['deploy keywords matched']);
    expect(buildRouterFacts(task({ mentionType: 'owner' }), 'm')).toMatchObject({
      addressing: 'owner_mention',
      hints: [],
    });
  });
});

describe('readToolRouterMode', () => {
  it('defaults to shadow, and reads legacy and on from the store', () => {
    expect(readToolRouterMode(undefined)).toBe('shadow');
    expect(readToolRouterMode({})).toBe('shadow');
    expect(readToolRouterMode({ getState: () => 'legacy' })).toBe('legacy');
    expect(readToolRouterMode({ getState: () => 'on' })).toBe('on');
    expect(readToolRouterMode({ getState: () => 'nonsense' })).toBe('shadow');
  });

  it('falls back to shadow when the store throws', () => {
    expect(
      readToolRouterMode({
        getState: () => {
          throw new Error('db closed');
        },
      }),
    ).toBe('shadow');
  });
});
