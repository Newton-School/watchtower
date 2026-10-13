import { describe, expect, it } from 'vitest';
import { buildMentionSystemPrompt } from '../src/codex/mentionSystemPrompt.js';
import { STE_CORE_STYLE_BLOCK, STE_REPLY_STYLE_BLOCK } from '../src/codex/replyStyle.js';
import type { NormalizedTask } from '../src/types/contracts.js';

function makeTask(): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      threadTs: '123.45',
      eventTs: '123.45',
      userId: 'U1',
      text: '<@UBOT1> do something',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'UNKNOWN',
  };
}

describe('mentionSystemPrompt tone branches', () => {
  it('uses default natural wording when toneMode is normal or unset', () => {
    expect(buildMentionSystemPrompt({ task: makeTask(), workflow: 'IMPLEMENTATION' })).toContain(
      'Use plain, natural wording.',
    );
    expect(buildMentionSystemPrompt({ task: makeTask(), workflow: 'IMPLEMENTATION', toneMode: 'normal' })).toContain(
      'Use plain, natural wording.',
    );
  });

  it('emits a terse line when toneMode is terse', () => {
    const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'IMPLEMENTATION', toneMode: 'terse' });
    expect(prompt).toContain('Tone preference: terse');
    expect(prompt).not.toContain('Use plain, natural wording.');
  });

  it('emits a technical line when toneMode is technical', () => {
    const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'IMPLEMENTATION', toneMode: 'technical' });
    expect(prompt).toContain('Tone preference: technical');
  });

  it('emits a casual line when toneMode is casual', () => {
    const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'CONVERSATIONAL', toneMode: 'casual' });
    expect(prompt).toContain('Tone preference: casual');
  });
});

describe('mentionSystemPrompt STE writing style', () => {
  it('includes the STE block for every tone', () => {
    for (const toneMode of ['normal', 'terse', 'technical', 'casual'] as const) {
      const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'DEPLOY', toneMode });
      expect(prompt).toContain(STE_REPLY_STYLE_BLOCK);
    }
  });

  it('gives JSON and cleaned-summary workflows the sentence rules only', () => {
    for (const workflow of ['IMPLEMENTATION', 'INVESTIGATION'] as const) {
      const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow });
      expect(prompt).toContain(STE_CORE_STYLE_BLOCK);
      expect(prompt).not.toContain('Use bullet lists');
      expect(prompt).not.toContain('One topic per paragraph');
    }
  });

  it('leaves the STE rules out of the one-sentence UNKNOWN reply', () => {
    const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'UNKNOWN' });
    expect(prompt).not.toContain('ASD-STE100');
  });

  it('puts the STE block after the role guidance, at the end of the prompt', () => {
    const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'INVESTIGATION', dossierRole: 'pm' });
    const roleIndex = prompt.indexOf('The asker is a pm');
    expect(roleIndex).toBeGreaterThanOrEqual(0);
    expect(prompt.endsWith(STE_CORE_STYLE_BLOCK)).toBe(true);
    expect(roleIndex).toBeLessThan(prompt.indexOf(STE_CORE_STYLE_BLOCK));
  });
});
