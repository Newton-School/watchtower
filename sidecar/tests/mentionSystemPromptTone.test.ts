import { describe, expect, it } from 'vitest';
import { buildMentionSystemPrompt } from '../src/codex/mentionSystemPrompt.js';
import { STE_REPLY_STYLE_BLOCK } from '../src/codex/replyStyle.js';
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
  it('includes the ASD-STE100 block for every tone', () => {
    for (const toneMode of ['normal', 'terse', 'technical', 'casual'] as const) {
      const prompt = buildMentionSystemPrompt({ task: makeTask(), workflow: 'IMPLEMENTATION', toneMode });
      expect(prompt).toContain(STE_REPLY_STYLE_BLOCK);
    }
  });
});
