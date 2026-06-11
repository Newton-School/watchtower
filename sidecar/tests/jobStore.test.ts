import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-store-')), 'watchtower.db');
}

describe('jobStore', () => {
  it('dedupes events and dedupe keys', () => {
    const dbPath = tempDbPath();
    const store = new JobStore(dbPath);

    expect(store.hasEvent('event-1')).toBe(false);
    store.recordEvent('event-1', 'C1', '123');
    expect(store.hasEvent('event-1')).toBe(true);

    expect(store.hasDedupeKey('C1:123:PR_REVIEW')).toBe(false);
    store.createJob({
      id: 'job-1',
      eventId: 'event-1',
      dedupeKey: 'C1:123:PR_REVIEW',
      workflow: 'PR_REVIEW',
      channelId: 'C1',
      threadTs: '123',
      payload: { foo: 'bar' },
    });
    expect(store.hasDedupeKey('C1:123:PR_REVIEW')).toBe(true);

    store.markJob('job-1', 'SUCCESS', {
      result: {
        prUrl: 'https://github.com/Newton-School/newton-web/pull/9999',
        prHeadSha: 'abc123',
      },
    });

    const previousHead = store.findLatestReviewedPrHeadSha({
      channelId: 'C1',
      threadTs: '123',
      prUrl: 'https://github.com/Newton-School/newton-web/pull/9999',
    });
    expect(previousHead?.prHeadSha).toBe('abc123');

    store.appendJobLog({
      jobId: 'job-1',
      stage: 'intake.received',
      message: 'Slack event accepted for processing.',
      data: { eventId: 'event-1' },
    });

    const logs = store.listJobLogs('job-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].stage).toBe('intake.received');
    expect(logs[0].level).toBe('INFO');

    const resolved = store.resolveJobId('job-');
    expect(resolved).toBe('job-1');

    const tail = store.listJobLogsTail('job-1', 5);
    expect(tail).toHaveLength(1);
    expect(tail[0].stage).toBe('intake.received');

    const jobSummary = store.getJobSummary('job-1');
    expect(jobSummary?.workflow).toBe('PR_REVIEW');
    expect(jobSummary?.status).toBe('SUCCESS');

    const latest = store.latestJobForThread('C1', '123');
    expect(latest?.workflow).toBe('PR_REVIEW');

    store.saveIntentCorrection({
      channelId: 'C1',
      userId: 'U1',
      phraseKey: 'review this pr again',
      correctedIntent: 'PR_REVIEW',
    });
    expect(
      store.findIntentCorrection({
        channelId: 'C1',
        userId: 'U1',
        phraseKey: 'review this pr again',
      }),
    ).toBe('PR_REVIEW');

    store.setPersonalityProfile({
      scope: 'user',
      scopeId: 'U1',
      mode: 'normal',
      source: 'test',
    });
    expect(
      store.getPersonalityMode({
        channelId: 'C1',
        userId: 'U1',
      }),
    ).toBe('normal');
    expect(
      store.getPersonalityProfile({
        scope: 'user',
        scopeId: 'U1',
      }),
    ).toBe('normal');

    store.recordLearningSignal({
      jobId: 'job-1',
      eventId: 'event-1',
      channelId: 'C1',
      userId: 'U1',
      workflow: 'PR_REVIEW',
      intent: 'PR_REVIEW',
      status: 'SUCCESS',
      correctionApplied: false,
    });

    const learning = store.getDevLearningSnapshot();
    expect(learning.signals24h).toBeGreaterThanOrEqual(1);
    expect(learning.personalityProfiles).toBeGreaterThanOrEqual(1);

    const heat = store.getDevChannelHeat(5);
    expect(heat.length).toBeGreaterThanOrEqual(1);
    expect(heat[0].channelId).toBe('C1');

    const mission = store.upsertMissionStart({
      channelId: 'C1',
      threadTs: '123',
      goal: 'stabilize checkout flow',
      ownerUserId: 'U1',
    });
    expect(mission.status).toBe('ACTIVE');

    const missionState = store.getMissionThread({
      channelId: 'C1',
      threadTs: '123',
    });
    expect(missionState?.goal).toBe('stabilize checkout flow');
    expect(missionState?.status).toBe('ACTIVE');

    const swarm = store.startMissionSwarmRun({
      channelId: 'C1',
      threadTs: '123',
      requestedBy: 'U1',
    });
    expect(swarm?.roles).toContain('planner');

    const missionAfterSwarm = store.getMissionThread({
      channelId: 'C1',
      threadTs: '123',
    });
    expect(missionAfterSwarm?.status).toBe('RUNNING');
    expect(missionAfterSwarm?.progress).toContain('Swarm');

    store.setTrustPolicy({
      targetType: 'channel',
      targetId: 'C1',
      trustLevel: 'execute',
      updatedBy: 'U1',
    });
    const trust = store.getTrustPolicy({
      targetType: 'channel',
      targetId: 'C1',
    });
    expect(trust?.trustLevel).toBe('execute');
    expect(trust?.updatedBy).toBe('U1');

    const replay = store.createReplayRequest({
      sourceJobId: 'job-1',
      mode: 'replay',
      requestedBy: 'U1',
      channelId: 'C1',
      threadTs: '123',
    });
    expect(replay.status).toBe('QUEUED');
    expect(replay.requestId.startsWith('replay:')).toBe(true);

    store.recordReactionFeedback({
      eventId: 'reaction-1',
      channelId: 'C1',
      threadTs: '123',
      userId: 'U2',
      reaction: 'thumbsup',
      sentiment: 1,
    });
    store.recordReactionFeedback({
      eventId: 'reaction-2',
      channelId: 'C1',
      threadTs: '123',
      userId: 'U3',
      reaction: 'thumbsdown',
      sentiment: -1,
    });
    const feedback = store.getReactionFeedbackSnapshot('C1');
    expect(feedback.positive).toBeGreaterThanOrEqual(1);
    expect(feedback.negative).toBeGreaterThanOrEqual(1);

    store.registerSkill({
      name: 'frontend-pr-review',
      path: '/tmp/skills/frontend-pr-review/SKILL.md',
      version: '2026-03-04T00:00:00.000Z',
    });
    const skill = store.getSkill('frontend-pr-review');
    expect(skill?.name).toBe('frontend-pr-review');

    store.setChannelSkill({
      channelId: 'C1',
      skillName: 'frontend-pr-review',
    });
    expect(store.getChannelSkill('C1')).toBe('frontend-pr-review');

    store.setOpsFeedSubscription({
      channelId: 'C1',
      enabled: true,
      updatedBy: 'U1',
    });
    expect(store.isOpsFeedEnabled('C1')).toBe(true);
    expect(store.listOpsFeedChannels()).toContain('C1');

    store.close();
  });
});

describe('activeJobForThread', () => {
  it('returns undefined when no jobs exist', () => {
    const store = new JobStore(tempDbPath());
    expect(store.activeJobForThread('C1', 'T1')).toBeUndefined();
    store.close();
  });

  it('returns the active job when status is RUNNING', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-run',
      eventId: 'e1',
      dedupeKey: 'C1:T1:e1:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T1',
      payload: {},
    });
    const active = store.activeJobForThread('C1', 'T1');
    expect(active).toBeDefined();
    expect(active?.id).toBe('job-run');
    expect(active?.status).toBe('RUNNING');
    expect(active?.workflow).toBe('IMPLEMENTATION');
    store.close();
  });

  it('does NOT return PAUSED jobs from activeJobForThread (slot is freed); pausedJobForThread returns it instead', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-pause',
      eventId: 'e2',
      dedupeKey: 'C1:T2:e2:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T2',
      payload: {},
    });
    store.markJob('job-pause', 'PAUSED');
    expect(store.activeJobForThread('C1', 'T2')).toBeUndefined();
    const paused = store.pausedJobForThread('C1', 'T2');
    expect(paused).toBeDefined();
    expect(paused?.id).toBe('job-pause');
    expect(paused?.workflow).toBe('IMPLEMENTATION');
    store.close();
  });

  it('returns undefined for terminal statuses', () => {
    const store = new JobStore(tempDbPath());
    const statuses = ['SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED'] as const;
    for (const [i, status] of statuses.entries()) {
      const jobId = `job-term-${i}`;
      const threadTs = `T-${i}`;
      store.createJob({
        id: jobId,
        eventId: `e-${i}`,
        dedupeKey: `C1:${threadTs}:e-${i}:IMPLEMENTATION`,
        workflow: 'IMPLEMENTATION',
        channelId: 'C1',
        threadTs,
        payload: {},
      });
      store.markJob(jobId, status);
      expect(store.activeJobForThread('C1', threadTs)).toBeUndefined();
    }
    store.close();
  });

  it('allows a new job for the same event_ts after a previous job was CANCELLED', () => {
    // CANCELLED is a user-driven terminal state, not a duplicate-prevention signal.
    // hasJobForEventTs must NOT treat CANCELLED jobs as active, so a follow-up
    // mention in the same thread can create a fresh job.
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-cancelled',
      eventId: 'e-cancel',
      dedupeKey: 'C1:T-cancel:e-cancel:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-cancel',
      payload: { eventTs: '111.22' },
    });
    store.markJob('job-cancelled', 'CANCELLED');

    expect(store.hasJobForEventTs('C1', '111.22')).toBe(false);
    expect(store.hasDedupeKey('C1:T-cancel:e-cancel:IMPLEMENTATION')).toBe(false);
    store.close();
  });

  it('returns undefined when job is stale beyond threshold', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-stale',
      eventId: 'e-stale',
      dedupeKey: 'C1:T-stale:e-stale:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-stale',
      payload: {},
    });
    // Manually backdate updated_at to 60 minutes ago
    store['db'].prepare("UPDATE jobs SET updated_at = datetime('now', '-60 minutes') WHERE id = ?").run('job-stale');
    expect(store.activeJobForThread('C1', 'T-stale')).toBeUndefined();
    // With a larger threshold it should still be found
    expect(store.activeJobForThread('C1', 'T-stale', 120)).toBeDefined();
    store.close();
  });

  it('returns the most recently updated job when multiple active jobs exist', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-old',
      eventId: 'e-old',
      dedupeKey: 'C1:T-multi:e-old:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-multi',
      payload: {},
    });
    store['db'].prepare("UPDATE jobs SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run('job-old');
    store.createJob({
      id: 'job-new',
      eventId: 'e-new',
      dedupeKey: 'C1:T-multi:e-new:IMPLEMENTATION',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: 'T-multi',
      payload: {},
    });
    const active = store.activeJobForThread('C1', 'T-multi');
    expect(active?.id).toBe('job-new');
    store.close();
  });
});

describe('pause / resume lifecycle', () => {
  function makePausedJob(store: JobStore, id: string, threadTs: string): void {
    store.createJob({
      id,
      eventId: `e-${id}`,
      dedupeKey: `C1:${threadTs}:e-${id}:IMPLEMENTATION`,
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs,
      payload: {},
    });
  }

  it('persists a resumeContext into result_json on PAUSED transition and reads it back via loadResumeContext', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-resume-1', 'T-r1');
    const ctx = {
      workflow: 'OWNER_AUTOPILOT' as const,
      stage: 'awaiting_approval' as const,
      iteration: 2,
      feedbackRounds: 1,
      planMarkdown: '1. step a\n2. step b',
      planAffectedFiles: ['src/foo.ts'],
      planScope: 'medium',
      plannerSessionId: 'sess-abc',
      plannerOutput: { plan: ['step a', 'step b'] },
      planMessageTs: '1700000000.000001',
      approvalPromptTs: '1700000010.000002',
      pipelineCwd: '/tmp/wt-workspace',
      pauseCount: 1,
    };
    store.markJob('job-resume-1', 'PAUSED', { result: ctx });
    const loaded = store.loadResumeContext('job-resume-1');
    expect(loaded).toBeDefined();
    if (loaded?.stage === 'awaiting_approval') {
      expect(loaded.iteration).toBe(2);
      expect(loaded.planMarkdown).toBe('1. step a\n2. step b');
      expect(loaded.plannerSessionId).toBe('sess-abc');
      expect(loaded.pauseCount).toBe(1);
    } else {
      throw new Error('expected awaiting_approval stage');
    }
    store.close();
  });

  it('returns undefined for loadResumeContext when result_json is malformed', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-resume-bad', 'T-bad');
    // Persist a non-resume payload (e.g. an old-style result without the discriminated stage)
    store.markJob('job-resume-bad', 'SUCCESS', { result: { prUrl: 'https://example.com/pr/1' } });
    expect(store.loadResumeContext('job-resume-bad')).toBeUndefined();
    store.close();
  });

  it('markJobRunning flips PAUSED -> RUNNING and clears result_json', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-flip', 'T-flip');
    store.markJob('job-flip', 'PAUSED', { result: { stage: 'awaiting_approval', dummy: true } });
    store.markJobRunning('job-flip');
    // After the flip the row should be RUNNING again, and resume context should be cleared.
    expect(store.activeJobForThread('C1', 'T-flip')?.id).toBe('job-flip');
    expect(store.loadResumeContext('job-flip')).toBeUndefined();
    store.close();
  });

  it('stalePausedJobs only returns paused rows older than the threshold', () => {
    const store = new JobStore(tempDbPath());
    makePausedJob(store, 'job-young', 'T-young');
    makePausedJob(store, 'job-old', 'T-old');
    store.markJob('job-young', 'PAUSED');
    store.markJob('job-old', 'PAUSED');
    // Backdate one of them well past the threshold.
    store['db'].prepare("UPDATE jobs SET updated_at = datetime('now', '-30 hours') WHERE id = ?").run('job-old');
    const stale = store.stalePausedJobs(24 * 60);
    const ids = stale.map(j => j.id);
    expect(ids).toContain('job-old');
    expect(ids).not.toContain('job-young');
    store.close();
  });
});

describe('launchpad startup recovery', () => {
  it('reconciles RUNNING launchpad requests whose jobs were orphan-cleaned during restart', () => {
    // Regression for #283: a launchpad_request that reached RUNNING (job_id assigned)
    // before a sidecar restart stayed stuck forever. cleanupOrphanedRunningJobs flipped
    // the job to FAILED, but recoverStrandedLaunchpadRequests only handled CLAIMED/QUEUED
    // with job_id IS NULL, so the launchpad row never reached a terminal state and the
    // requester never received a final DM.
    const store = new JobStore(tempDbPath());

    store.createLaunchpadRequest({
      id: 'req-running',
      target: 'miniog',
      prompt: 'Ship the feature',
      ownerUserId: 'UOWNER1',
      status: 'CLAIMED',
    });
    store.createJob({
      id: 'job-running',
      eventId: 'launchpad:req-running:111.22',
      dedupeKey: 'D123:111.22:launchpad:req-running:111.22:OWNER_AUTOPILOT',
      workflow: 'OWNER_AUTOPILOT',
      channelId: 'D123',
      threadTs: '111.22',
      payload: { launchpadRequestId: 'req-running' },
    });
    store.markLaunchpadRequestRunning({ id: 'req-running', jobId: 'job-running' });

    // Sidecar restarts: orphan cleanup runs first and flips the job to FAILED.
    expect(store.cleanupOrphanedRunningJobs()).toBe(1);
    // recoverStrandedLaunchpadRequests does not touch RUNNING rows with job_id set.
    expect(store.recoverStrandedLaunchpadRequests()).toBe(0);
    // Reconciliation picks up the orphan-job → RUNNING-request link and marks it FAILED.
    expect(store.reconcileFailedOrphanedLaunchpadRequests()).toBe(1);

    const reconciled = store.getLaunchpadRequest('req-running');
    expect(reconciled?.status).toBe('FAILED');
    expect(reconciled?.errorMessage).toBe('Process lost during sidecar restart');
    store.close();
  });

  it('persists executed_workflow without overwriting jobs.workflow', () => {
    // Regression for #281: jobs.workflow stayed frozen at the pre-router intent
    // (e.g. OWNER_AUTOPILOT) even when the AI classifier reclassified to a
    // different workflow (e.g. PR_REVIEW). UI surfaces showed the stale label.
    // The fix: persist executed_workflow on terminal markJob calls, surface it
    // via COALESCE in listings, and leave jobs.workflow alone so pausedResume's
    // resume detection (which keys off the original intent) keeps working.
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-reclassified',
      eventId: 'Ev-reclass',
      dedupeKey: 'dk-reclass',
      workflow: 'OWNER_AUTOPILOT',
      channelId: 'C1',
      threadTs: '111.22',
      payload: {},
    });

    store.markJob('job-reclassified', 'SUCCESS', { executedWorkflow: 'PR_REVIEW' });

    // jobs.workflow is unchanged.
    const rawRow = store['db']
      .prepare('SELECT workflow, executed_workflow FROM jobs WHERE id = ?')
      .get('job-reclassified') as { workflow: string; executed_workflow: string | null };
    expect(rawRow.workflow).toBe('OWNER_AUTOPILOT');
    expect(rawRow.executed_workflow).toBe('PR_REVIEW');

    // listDevRuns surfaces the executed workflow via COALESCE.
    const runs = store.listDevRuns(10);
    const reclassified = runs.find(r => r.id === 'job-reclassified');
    expect(reclassified?.workflow).toBe('PR_REVIEW');
  });

  it('falls back to jobs.workflow when executed_workflow is null', () => {
    // Jobs created before the migration land here. listDevRuns must still return
    // a workflow value for them.
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-legacy',
      eventId: 'Ev-legacy',
      dedupeKey: 'dk-legacy',
      workflow: 'IMPLEMENTATION',
      channelId: 'C1',
      threadTs: '222.33',
      payload: {},
    });
    store.markJob('job-legacy', 'SUCCESS');

    const runs = store.listDevRuns(10);
    const legacy = runs.find(r => r.id === 'job-legacy');
    expect(legacy?.workflow).toBe('IMPLEMENTATION');
  });

  it('leaves healthy non-terminal launchpad requests alone', () => {
    // A launchpad request whose job is still RUNNING (no orphan cleanup) must not
    // be reconciled. Only requests linked to FAILED jobs should flip.
    const store = new JobStore(tempDbPath());

    store.createLaunchpadRequest({
      id: 'req-healthy',
      target: 'miniog',
      prompt: 'Healthy',
      ownerUserId: 'UOWNER1',
      status: 'CLAIMED',
    });
    store.createJob({
      id: 'job-healthy',
      eventId: 'launchpad:req-healthy:222.33',
      dedupeKey: 'D123:222.33:launchpad:req-healthy:222.33:OWNER_AUTOPILOT',
      workflow: 'OWNER_AUTOPILOT',
      channelId: 'D123',
      threadTs: '222.33',
      payload: { launchpadRequestId: 'req-healthy' },
    });
    store.markLaunchpadRequestRunning({ id: 'req-healthy', jobId: 'job-healthy' });

    // Job is still RUNNING — no orphan cleanup happened.
    expect(store.reconcileFailedOrphanedLaunchpadRequests()).toBe(0);
    const healthy = store.getLaunchpadRequest('req-healthy');
    expect(healthy?.status).toBe('RUNNING');
    store.close();
  });
});

describe('eventAnchorFor', () => {
  it('returns undefined when the job does not exist', () => {
    const store = new JobStore(tempDbPath());
    expect(store.eventAnchorFor('no-such-job')).toBeUndefined();
    store.close();
  });

  it('returns channelId + eventTs from the job row + payload', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-anchor',
      eventId: 'Ev123',
      dedupeKey: 'dk-anchor',
      workflow: 'PR_REVIEW',
      channelId: 'C0AHGMH2F1V',
      threadTs: '1778405776.426159',
      payload: { eventTs: '1778405776.426159', text: '<@bot> review' },
    });
    expect(store.eventAnchorFor('job-anchor')).toEqual({
      channelId: 'C0AHGMH2F1V',
      eventTs: '1778405776.426159',
    });
    store.close();
  });

  it('returns undefined when the payload is missing eventTs', () => {
    const store = new JobStore(tempDbPath());
    store.createJob({
      id: 'job-no-evt',
      eventId: 'Ev999',
      dedupeKey: 'dk-no-evt',
      workflow: 'PR_REVIEW',
      channelId: 'C0AHGMH2F1V',
      threadTs: '1778405776.426159',
      payload: { text: 'no eventTs in payload' },
    });
    expect(store.eventAnchorFor('job-no-evt')).toBeUndefined();
    store.close();
  });
});

describe('isPausedAwaitingPrUrl', () => {
  function jobWith(store: JobStore, id: string, workflow: 'PR_REVIEW' | 'OWNER_AUTOPILOT' | 'IMPLEMENTATION'): void {
    store.createJob({
      id,
      eventId: `event-${id}`,
      dedupeKey: `dk-${id}`,
      workflow,
      channelId: 'C1',
      threadTs: 'T1',
      payload: {},
    });
  }

  it('returns false for a job that has no logs at all', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-empty', 'PR_REVIEW');
    expect(store.isPausedAwaitingPrUrl('job-empty')).toBe(false);
    store.close();
  });

  it('returns true for a PR_REVIEW job that logged pr_review.context.missing', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-prr', 'PR_REVIEW');
    store.appendJobLog({
      jobId: 'job-prr',
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });
    expect(store.isPausedAwaitingPrUrl('job-prr')).toBe(true);
    store.close();
  });

  it('returns true for an OWNER_AUTOPILOT-recorded job that paused as PR_REVIEW (the regression case from #207 follow-up)', () => {
    // Owner mentions land in jobs.workflow=OWNER_AUTOPILOT even when the
    // classifier later routed them to PR_REVIEW; pr_review.context.missing
    // still gets logged on the same job_id, so the helper must match on
    // the log entry rather than the workflow column.
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-owner', 'OWNER_AUTOPILOT');
    store.appendJobLog({
      jobId: 'job-owner',
      stage: 'router.classify.override',
      message: 'AI classifier resolved intent: OWNER_AUTOPILOT → PR_REVIEW.',
    });
    store.appendJobLog({
      jobId: 'job-owner',
      stage: 'pr_review.context.missing',
      message: 'PR context missing; asking for URL in thread and pausing.',
      level: 'WARN',
    });
    store.appendJobLog({
      jobId: 'job-owner',
      stage: 'job.attempt.result',
      message: 'Workflow attempt returned a result.',
    });
    expect(store.isPausedAwaitingPrUrl('job-owner')).toBe(true);
    store.close();
  });

  it('returns false for a job that paused for a different reason (e.g. implementation approval)', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-impl', 'IMPLEMENTATION');
    store.appendJobLog({
      jobId: 'job-impl',
      stage: 'implementation.approval.waiting',
      message: 'Awaiting plan approval.',
    });
    expect(store.isPausedAwaitingPrUrl('job-impl')).toBe(false);
    store.close();
  });

  it('does not leak state across jobs (per-job isolation)', () => {
    const store = new JobStore(tempDbPath());
    jobWith(store, 'job-a', 'PR_REVIEW');
    jobWith(store, 'job-b', 'PR_REVIEW');
    store.appendJobLog({
      jobId: 'job-a',
      stage: 'pr_review.context.missing',
      message: 'paused',
      level: 'WARN',
    });
    expect(store.isPausedAwaitingPrUrl('job-a')).toBe(true);
    expect(store.isPausedAwaitingPrUrl('job-b')).toBe(false);
    store.close();
  });
});

describe('findLatestReviewedPrHeadSha (issue #334 bug E)', () => {
  const prUrl = 'https://github.com/Newton-School/newton-web/pull/8652';

  function makeStore() {
    return new JobStore(tempDbPath());
  }

  function seedJob(
    store: JobStore,
    id: string,
    opts: {
      workflow?: string;
      status: 'SUCCESS' | 'FAILED' | 'CANCELLED';
      executedWorkflow?: 'PR_REVIEW';
      result?: Record<string, unknown>;
    },
  ) {
    store.createJob({
      id,
      eventId: `event-${id}`,
      dedupeKey: `C1:777:${id}`,
      workflow: (opts.workflow ?? 'IMPLEMENTATION') as never,
      channelId: 'C1',
      threadTs: '777',
      payload: {},
    });
    store.markJob(id, opts.status, {
      result: opts.result,
      executedWorkflow: opts.executedWorkflow,
      errorMessage: opts.status === 'FAILED' ? 'boom' : undefined,
    });
  }

  it('matches jobs whose review ran post-override (workflow seed != PR_REVIEW)', () => {
    // The incident shape: jobs.workflow keeps the pre-classifier IMPLEMENTATION
    // seed; the AI override lands only in executed_workflow. The old query
    // filtered on the raw workflow column and never matched.
    const store = makeStore();
    seedJob(store, 'job-coalesce', {
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      executedWorkflow: 'PR_REVIEW',
      result: { prUrl, prHeadSha: 'dda9039' },
    });

    const hit = store.findLatestReviewedPrHeadSha({ channelId: 'C1', threadTs: '777', prUrl });
    expect(hit?.prHeadSha).toBe('dda9039');
    store.close();
  });

  it('matches historical FAILED rows that carry a prHeadSha (pre-#334 completed reviews)', () => {
    // Under the old status semantics, completed reviews with blocking findings
    // were mislabeled FAILED but still persisted prUrl + prHeadSha. Genuine
    // failures never persist a prHeadSha, so this cannot false-positive.
    const store = makeStore();
    seedJob(store, 'job-legacy-failed', {
      workflow: 'IMPLEMENTATION',
      status: 'FAILED',
      executedWorkflow: 'PR_REVIEW',
      result: { prUrl, prHeadSha: 'dda9039' },
    });

    const hit = store.findLatestReviewedPrHeadSha({ channelId: 'C1', threadTs: '777', prUrl });
    expect(hit?.prHeadSha).toBe('dda9039');
    store.close();
  });

  it('does not match genuinely failed jobs (no prHeadSha in result)', () => {
    const store = makeStore();
    seedJob(store, 'job-genuine-failure', {
      workflow: 'IMPLEMENTATION',
      status: 'FAILED',
      executedWorkflow: 'PR_REVIEW',
      result: undefined,
    });

    expect(store.findLatestReviewedPrHeadSha({ channelId: 'C1', threadTs: '777', prUrl })).toBeUndefined();
    store.close();
  });

  it('does not match jobs that executed a different workflow', () => {
    const store = makeStore();
    seedJob(store, 'job-impl', {
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      result: { prUrl, prHeadSha: 'dda9039' },
    });

    expect(store.findLatestReviewedPrHeadSha({ channelId: 'C1', threadTs: '777', prUrl })).toBeUndefined();
    store.close();
  });

  it('matches per-PR outcomes in the multi-PR result shape, including on partially-failed jobs', () => {
    const store = makeStore();
    const otherPrUrl = 'https://github.com/Newton-School/newton-api/pull/5781';
    seedJob(store, 'job-multi', {
      workflow: 'PR_REVIEW',
      status: 'FAILED', // PR 2 failed; PR 1 completed and must still dedup
      result: {
        outcomes: [
          { prUrl, status: 'SUCCESS', prHeadSha: 'feedface' },
          { prUrl: otherPrUrl, status: 'FAILED', error: 'agent exit 1' },
        ],
      },
    });

    const hit = store.findLatestReviewedPrHeadSha({ channelId: 'C1', threadTs: '777', prUrl });
    expect(hit?.prHeadSha).toBe('feedface');
    expect(store.findLatestReviewedPrHeadSha({ channelId: 'C1', threadTs: '777', prUrl: otherPrUrl })).toBeUndefined();
    store.close();
  });
});
