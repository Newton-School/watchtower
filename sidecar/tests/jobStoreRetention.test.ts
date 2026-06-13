import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-retention-')), 'watchtower.db');
}

const OLD_ISO = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago

function seedJob(store: JobStore, id: string, status: 'SUCCESS' | 'RUNNING' | 'PAUSED', threadTs: string): void {
  store.createJob({
    id,
    eventId: `e-${id}`,
    dedupeKey: `dk-${id}`,
    workflow: 'PR_REVIEW',
    channelId: 'C1',
    threadTs,
    payload: {},
  });
  if (status !== 'RUNNING') {
    store.markJob(id, status);
  }
}

describe('pruneOldRows retention sweep', () => {
  it('deletes rows older than the window, preserving recent rows and non-terminal jobs', () => {
    const store = new JobStore(tempDbPath());
    const db = store['db'];
    const count = (table: string): number =>
      Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);

    // --- recent rows (must survive) ---
    seedJob(store, 'job-recent', 'SUCCESS', 't-recent');
    store.appendJobLog({ jobId: 'job-recent', stage: 's', message: 'm' });
    store.recordLearningSignal({
      jobId: 'job-recent',
      eventId: 'ls-recent',
      channelId: 'C1',
      userId: 'U1',
      workflow: 'PR_REVIEW',
      intent: 'PR_REVIEW',
      status: 'SUCCESS',
      correctionApplied: false,
    });
    store.recordReactionFeedback({
      eventId: 'rf-recent',
      channelId: 'C1',
      threadTs: 't-recent',
      userId: 'U1',
      reaction: 'thumbsup',
      sentiment: 1,
    });
    store.recordEvent('ev-recent', 'C1', 't-recent');
    store.recordAgentCall({ jobId: 'job-recent', backend: 'claude-code', durationMs: 10, ok: true });

    // --- old rows ---
    seedJob(store, 'job-old-success', 'SUCCESS', 't-old1'); // terminal → pruned
    seedJob(store, 'job-old-running', 'RUNNING', 't-old2'); // non-terminal → preserved
    seedJob(store, 'job-old-paused', 'PAUSED', 't-old3'); // non-terminal → preserved
    store.appendJobLog({ jobId: 'job-old-success', stage: 's', message: 'm' });
    store.recordLearningSignal({
      jobId: 'job-old-success',
      eventId: 'ls-old',
      channelId: 'C1',
      userId: 'U1',
      workflow: 'PR_REVIEW',
      intent: 'PR_REVIEW',
      status: 'SUCCESS',
      correctionApplied: false,
    });
    store.recordReactionFeedback({
      eventId: 'rf-old',
      channelId: 'C1',
      threadTs: 't-old1',
      userId: 'U1',
      reaction: 'thumbsup',
      sentiment: 1,
    });
    store.recordEvent('ev-old', 'C1', 't-old1');
    store.recordAgentCall({
      jobId: 'job-old-success',
      backend: 'claude-code',
      durationMs: 10,
      ok: true,
      createdAt: OLD_ISO,
    });

    // Backdate created_at on the old rows (agent_calls already seeded with OLD_ISO).
    db.prepare("UPDATE jobs SET created_at = ? WHERE id LIKE 'job-old-%'").run(OLD_ISO);
    db.prepare("UPDATE job_logs SET created_at = ? WHERE job_id = 'job-old-success'").run(OLD_ISO);
    db.prepare("UPDATE learning_signals SET created_at = ? WHERE event_id = 'ls-old'").run(OLD_ISO);
    db.prepare("UPDATE reaction_feedback SET created_at = ? WHERE event_id = 'rf-old'").run(OLD_ISO);
    db.prepare("UPDATE events SET created_at = ? WHERE event_id = 'ev-old'").run(OLD_ISO);

    const pruned = store.pruneOldRows(30);

    expect(pruned).toEqual({
      jobLogs: 1,
      learningSignals: 1,
      agentCalls: 1,
      reactionFeedback: 1,
      events: 1,
      jobs: 1, // only the terminal old job
    });

    // Non-terminal old jobs survive even though they are past the cutoff.
    expect(store.getJobSummary('job-old-running')?.status).toBe('RUNNING');
    expect(store.getJobSummary('job-old-paused')?.status).toBe('PAUSED');
    expect(store.getJobSummary('job-old-success')).toBeUndefined();

    // Exactly the recent row remains in each pruned table.
    expect(store.getJobSummary('job-recent')?.status).toBe('SUCCESS');
    expect(count('job_logs')).toBe(1);
    expect(count('learning_signals')).toBe(1);
    expect(count('reaction_feedback')).toBe(1);
    expect(count('events')).toBe(1);
    expect(count('agent_calls')).toBe(1);

    store.close();
  });

  it('clamps retentionDays to >= 1 so a 0/negative window never wipes fresh rows', () => {
    const store = new JobStore(tempDbPath());
    seedJob(store, 'job-today', 'SUCCESS', 't-today');
    const pruned = store.pruneOldRows(0);
    expect(pruned.jobs).toBe(0);
    expect(store.getJobSummary('job-today')?.status).toBe('SUCCESS');
    store.close();
  });
});
