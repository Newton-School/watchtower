import { describe, expect, it } from 'vitest';
import { buildRestartNotice, humanGateForStage } from '../src/runtime/restartNotice.js';

// Issue #436: a plan waiting for approval vanished on a restart without a word.
describe('humanGateForStage', () => {
  it.each([
    ['implementation.approval.waiting', 'approval'],
    ['pipeline.approval.waiting', 'approval'],
    ['pipeline.approval.reminder', 'approval'],
    ['pipeline.approval.unauthorized', 'approval'],
    ['pipeline.clarification.waiting', 'clarification'],
    ['pipeline.repo_choice.waiting', 'repo_choice'],
    ['deploy.confirm.waiting', 'confirmation'],
    ['implementation.quick_action.confirm.waiting', 'confirmation'],
  ])('reads %s as parked at %s', (stage, gate) => {
    expect(humanGateForStage(stage)).toBe(gate);
  });

  it.each(['agent.spawned', 'pipeline.agent.coder.start', 'pipeline.approval.approved', 'job.created', undefined])(
    'does not treat %s as waiting on a person',
    stage => {
      expect(humanGateForStage(stage)).toBeUndefined();
    },
  );
});

describe('buildRestartNotice', () => {
  it('tells the requester their plan was dropped and how to get it back', () => {
    expect(buildRestartNotice({ gate: 'approval', requestedBy: 'UREQ' })).toBe(
      "I was restarted while this plan was waiting for approval, so I've dropped it. <@UREQ>, mention me again with the request and I'll plan it afresh.",
    );
  });

  it('says nothing was done when a confirmation was pending', () => {
    const text = buildRestartNotice({ gate: 'confirmation', requestedBy: 'UREQ' });
    expect(text).toContain('nothing was done');
    expect(text).toContain('<@UREQ>');
  });

  it('has a general form for the other waits, and reads fine without a requester', () => {
    const text = buildRestartNotice({ gate: 'repo_choice' });
    expect(text).toBe(
      "I was restarted while waiting for a reply here, so I've dropped this request. mention me again to restart it.",
    );
    expect(buildRestartNotice({ gate: 'clarification', requestedBy: 'U1' })).toContain('<@U1>, mention me again');
  });
});
