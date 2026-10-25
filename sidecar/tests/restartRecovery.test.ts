import { describe, expect, it } from 'vitest';
import { recoveryFor, RESTART_EVENT_PREFIX, type LostJob } from '../src/runtime/restartRecovery.js';
import { DEPLOY_OFFER_RESTART_NOTICE } from '../src/runtime/restartNotice.js';

// Issue #589: a PR review lost to a restart said nothing; its author told the
// admins they were still waiting. A plan held for 14 hours was dropped.
const review: LostJob = {
  id: 'd9e1b161-0000',
  channelId: 'C1',
  threadTs: '100.1',
  requestedBy: 'UAUTHOR',
  lastStage: 'agentic.pr_review.fanout.start',
  workflow: 'PR_REVIEW',
  eventId: 'Ev123',
  text: '<@UBOT> review https://github.com/o/r/pull/1362',
  eventTs: '200.2',
};

describe('a job lost to a restart', () => {
  it('runs a PR review again, as the original request, and says so', () => {
    const recovery = recoveryFor(review);

    expect(recovery.kind).toBe('review_rerun');
    expect(recovery.notice).toBe('I was restarted in the middle of this review, so I am running it again.');
    expect(recovery.requeue).toMatchObject({
      eventId: `${RESTART_EVENT_PREFIX}d9e1b161-0000`,
      channelId: 'C1',
      threadTs: '100.1',
      eventTs: '200.2',
      userId: 'UAUTHOR',
      text: review.text,
    });
  });

  it('runs a review again only once: a re-run lost to another restart asks for a mention', () => {
    const recovery = recoveryFor({ ...review, eventId: `${RESTART_EVENT_PREFIX}older-job` });

    expect(recovery.kind).toBe('lost');
    expect(recovery.requeue).toBeUndefined();
    expect(recovery.notice).toContain('<@UAUTHOR>, mention me to run it once more');
  });

  it('tells the thread of any other running job that the run was lost', () => {
    const recovery = recoveryFor({ ...review, workflow: 'INFORMATIONAL', lastStage: 'agent.spawned' });

    expect(recovery.kind).toBe('lost');
    expect(recovery.requeue).toBeUndefined();
    expect(recovery.notice).toBe(
      'I was restarted while working on this, so the run was lost. <@UAUTHOR>, mention me again to retry; anything already pushed is still on its branch.',
    );
  });

  it('keeps the existing notice for a job waiting on a person', () => {
    const recovery = recoveryFor({
      ...review,
      workflow: 'IMPLEMENTATION',
      lastStage: 'implementation.approval.waiting',
    });

    expect(recovery.kind).toBe('waiting');
    expect(recovery.notice).toContain('waiting for approval');
  });

  it('cannot re-run a review whose request was not recorded', () => {
    expect(recoveryFor({ ...review, text: undefined }).kind).toBe('lost');
  });
});

describe('a deploy offer lost to a restart (#703)', () => {
  const offerJob: LostJob = {
    id: 'job-offer',
    channelId: 'C1',
    threadTs: '400.1',
    requestedBy: 'UBUILDER',
    workflow: 'IMPLEMENTATION',
    // The offer goes on logging while it waits: staging went back to main after it went up.
    lastStage: 'staging.restore.done',
    openWait: { kind: 'confirm', promptTs: '500.1', expects: 'deploy it' },
  };

  it('is found from its open wait, whatever it logged last, says the offer is closed, and closes its message', () => {
    const recovery = recoveryFor(offerJob);

    expect(recovery.kind).toBe('waiting');
    expect(recovery.notice).toBe(DEPLOY_OFFER_RESTART_NOTICE);
    expect(recovery.notice).toContain('nothing was deployed');
    expect(recovery.closeDeployOffer).toEqual({ promptTs: '500.1' });
  });

  it('is found from its waiting stage when the open wait was not recorded', () => {
    const recovery = recoveryFor({ ...offerJob, openWait: undefined, lastStage: 'deploy_offer.waiting' });

    expect(recovery.notice).toBe(DEPLOY_OFFER_RESTART_NOTICE);
    expect(recovery.closeDeployOffer).toBeUndefined();
  });

  it('leaves other confirmations as they were', () => {
    const recovery = recoveryFor({
      ...offerJob,
      lastStage: 'deploy.confirm.waiting',
      openWait: { kind: 'confirm', promptTs: '500.1', expects: 'confirm deploy' },
    });

    expect(recovery.notice).toContain('waiting for a confirmation');
    expect(recovery.closeDeployOffer).toBeUndefined();
  });
});
